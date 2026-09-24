/**
 * Best-effort, read-only failure diagnostics — captured when an
 * install/deploy/destroy step fails, so a postmortem does not need to
 * re-run the canary to see what CloudFormation, the failed release's build
 * and the control plane's own view of the deployment looked like at the
 * moment of failure. Attached to the failing step's own evidence file
 * (`steps/NN-*.json`, `details.diagnostics`) by `withDiagnosticsOnFailure`
 * in steps.ts/teardown.ts — never written on its own.
 *
 * Every read goes through the same `aws.ts`/`ControlPlane` seams the rest
 * of the canary uses; nothing here mutates anything, and a failure to
 * capture one piece of diagnostics never masks the original error (each
 * piece is independently best-effort).
 */
import { describeStack, stackFailureEvents, type StackFailureEvent } from './aws.js';
import type { CanaryConfig } from './config.js';
import type { ControlPlane, DeploymentDetail } from './control-plane.js';
import type { Evidence } from './evidence.js';

/** The minimal shape diagnostics capture needs — deliberately not `Canary`
 * from steps.ts, so this module has no dependency on it (steps.ts depends
 * on this one, not the other way round). */
export interface DiagnosticsContext {
  readonly config: CanaryConfig;
  readonly evidence: Evidence;
  readonly api: ControlPlane;
}

export interface StackDiagnostics {
  readonly status: string | null;
  readonly failedEvents: StackFailureEvent[];
}

export interface DeploymentDiagnostics {
  readonly state: string;
  readonly relayStatus: string;
  readonly healthStatus: string;
  readonly cleanupState: string | null;
  readonly deploymentStatus: DeploymentDetail['deploymentStatus'];
  readonly lastJob: DeploymentDetail['jobs'][number] | null;
}

export interface FailureDiagnostics {
  bootstrapStack?: StackDiagnostics;
  bootstrapStackError?: string;
  applicationStack?: StackDiagnostics;
  applicationStackError?: string;
  deployment?: DeploymentDiagnostics;
  deploymentError?: string;
  controlPlaneDiagnostics?: unknown;
  release?: { id: string; version: string; status: string; failureReason: string | null };
  releaseBuildFailure?: unknown;
  releaseError?: string;
}

async function stackDiagnostics(region: string, stackName: string): Promise<StackDiagnostics> {
  const stack = await describeStack(region, stackName);
  return { status: stack?.status ?? null, failedEvents: await stackFailureEvents(region, stackName) };
}

export async function captureFailureDiagnostics(canary: DiagnosticsContext): Promise<FailureDiagnostics> {
  const { config, evidence, api } = canary;
  const run = evidence.run;
  const out: FailureDiagnostics = {};

  if (run.bootstrapStackName) {
    try {
      out.bootstrapStack = await stackDiagnostics(config.region, run.bootstrapStackName);
    } catch (error) {
      out.bootstrapStackError = String(error);
    }
  }

  if (run.applicationStackName) {
    try {
      out.applicationStack = await stackDiagnostics(config.region, run.applicationStackName);
    } catch (error) {
      out.applicationStackError = String(error);
    }
  }

  if (run.deploymentId) {
    try {
      const detail = await api.getDeployment(run.deploymentId);
      out.deployment = {
        state: detail.state,
        relayStatus: detail.relayStatus,
        healthStatus: detail.healthStatus,
        cleanupState: detail.cleanupState,
        deploymentStatus: detail.deploymentStatus,
        lastJob: detail.jobs.at(-1) ?? null,
      };
    } catch (error) {
      out.deploymentError = String(error);
    }
    try {
      out.controlPlaneDiagnostics = await api.diagnostics(run.deploymentId);
    } catch (error) {
      out.controlPlaneDiagnostics = `unavailable: ${String(error)}`;
    }
  }

  if (run.applicationId) {
    try {
      const releases = await api.listReleases(run.applicationId);
      const failed = releases.find((r) => r.status === 'FAILED');
      if (failed) {
        out.release = { id: failed.id, version: failed.version, status: failed.status, failureReason: failed.failureReason };
        try {
          out.releaseBuildFailure = await api.buildFailure(run.applicationId, failed.id);
        } catch (error) {
          out.releaseBuildFailure = `unavailable: ${String(error)}`;
        }
      }
    } catch (error) {
      out.releaseError = String(error);
    }
  }

  return out;
}

/**
 * Runs `fn`; on failure, attaches a best-effort `captureFailureDiagnostics`
 * snapshot to `details['diagnostics']` before rethrowing the original error
 * unchanged. A diagnostics-capture failure is recorded alongside it, never
 * thrown in its place.
 */
export async function withDiagnosticsOnFailure<T>(
  canary: DiagnosticsContext,
  details: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    try {
      details['diagnostics'] = await captureFailureDiagnostics(canary);
    } catch (diagnosticsError) {
      details['diagnosticsError'] = String(diagnosticsError);
    }
    throw error;
  }
}
