/**
 * Suite runner — orchestrates the full integration flow:
 *
 *   synth → publish → deploy bootstrap → wait first contact →
 *   deploy application → verify Healthy → teardown
 *
 * Every AWS call flows through the injectable `AwsClients` interface (the KEY
 * seam — the whole runner is testable with mocks and zero AWS). The synth and
 * publish steps are also injectable functions: synth produces the bootstrap +
 * application templates, publish uploads them (todo 10's `BootstrapPublisher`
 * with its `S3Client` seam wires these in for the real run).
 *
 * The runner returns a structured, inspectable result — not just a boolean —
 * so the future real-AWS run can report per-phase. Teardown is guaranteed via
 * `runWithTeardown` (finally block), and a failure is classified into a §61
 * code (SCP denials → `AWS_SCP_BLOCKED`).
 */

import { isScpBlocked } from './scp-blocked.js';
import { CleanupRegistry, runWithTeardown, type TeardownResult } from './teardown.js';
import type { AwsClients, CloudFormationClient, StackInfo, StackStatus } from './aws-clients.js';
import type { PublishResult, SynthOutput } from '../quick-create/index.js';

// ── Phases and results ────────────────────────────────────────────────────

export type SuitePhase =
  | 'synth'
  | 'publish'
  | 'deploy-bootstrap'
  | 'wait-first-contact'
  | 'deploy-application'
  | 'verify-healthy'
  | 'teardown';

export interface PhaseResult {
  readonly phase: SuitePhase;
  readonly status: 'passed' | 'failed';
  readonly detail?: string | undefined;
}

/** §61 failure codes the runner recognizes (SCP denials are classified). */
export type SuiteFailureCode = 'AWS_SCP_BLOCKED' | 'UNKNOWN';

export interface SuiteResult {
  readonly passed: boolean;
  /** The last phase reached before completion or failure. */
  readonly phase: SuitePhase;
  /** Every phase's outcome, in execution order. */
  readonly phases: readonly PhaseResult[];
  /** Present only when `passed` is false. */
  readonly error?: string | undefined;
  /** Present only when a recognized §61 failure signature was matched. */
  readonly failureCode?: SuiteFailureCode | undefined;
  readonly teardown: TeardownResult;
}

/** The synthesized bootstrap + application templates. */
export interface SuiteTemplates {
  readonly bootstrap: SynthOutput;
  readonly application: SynthOutput;
}

/** Dependencies injected into the runner (all AWS-free in unit tests). */
export interface SuiteDeps {
  readonly aws: AwsClients;
  /** Synthesizes both templates. Stub in tests; real CDK synth in the AWS run. */
  readonly synth: () => Promise<SuiteTemplates>;
  /** Publishes the templates (repack + upload). Stub in tests. */
  readonly publish: (templates: SuiteTemplates) => Promise<PublishResult>;
}

export interface SuiteConfig {
  readonly region: string;
  readonly bootstrapStackName: string;
  readonly applicationStackName: string;
  /** Verification targets (resolved from the application stack outputs). */
  readonly clusterName: string;
  readonly serviceName: string;
  readonly targetGroupArn: string;
  /** Wait/poll options for the "wait first contact" + "verify" phases. */
  readonly wait?: WaitOptions | undefined;
}

/** Poll options for `waitForStackStatus`. */
export interface WaitOptions {
  readonly pollIntervalMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

/** Verification targets for `verifyHealthy`. */
export interface VerifyTargets {
  readonly cluster: string;
  readonly serviceName: string;
  readonly targetGroupArn: string;
  readonly region: string;
}

/** IAM capabilities required to create stacks that provision roles. */
const CAPABILITIES = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'] as const;

/** Terminal-failure statuses that halt a wait immediately. */
const FAILED_STATUSES = new Set<StackStatus>([
  'CREATE_FAILED',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'DELETE_FAILED',
  'UPDATE_FAILED',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
]);

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Polls `describeStacks` until the named stack reaches `desired`, fails, or
 * the attempt budget is exhausted. Returns the final `StackInfo`.
 */
export async function waitForStackStatus(
  cfn: CloudFormationClient,
  stackName: string,
  region: string,
  desired: StackStatus,
  options: WaitOptions = {},
): Promise<StackInfo> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxAttempts = options.maxAttempts ?? 30;

  let last: StackInfo | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await cfn.describeStacks({ stackName, region });
    if (last.status === desired) {
      return last;
    }
    if (FAILED_STATUSES.has(last.status)) {
      throw new Error(`stack "${stackName}" reached terminal failure: ${last.status}`);
    }
    if (pollIntervalMs > 0) {
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `stack "${stackName}" did not reach "${desired}" after ${maxAttempts} attempts ` +
      `(last status: ${last?.status ?? 'unknown'})`,
  );
}

/**
 * Verifies the deployed application reached Healthy: the ECS service is
 * running its full desired count AND every ALB target is healthy.
 */
export async function verifyHealthy(
  aws: AwsClients,
  targets: VerifyTargets,
): Promise<boolean> {
  const services = await aws.ecs.describeServices({
    cluster: targets.cluster,
    serviceNames: [targets.serviceName],
    region: targets.region,
  });
  const service = services[0];
  if (!service || !service.healthy) {
    return false;
  }

  const { targets: tgTargets } = await aws.elb.describeTargetHealth({
    targetGroupArn: targets.targetGroupArn,
    region: targets.region,
  });

  return tgTargets.length > 0 && tgTargets.every((t) => t.state === 'healthy');
}

/**
 * Classifies a thrown error into a §61 failure code. SCP denials map to
 * `AWS_SCP_BLOCKED`; everything else is `UNKNOWN` (the full classifier
 * pipeline is todo 27).
 */
export function classifyFailure(error: unknown): SuiteFailureCode {
  return isScpBlocked(error) ? 'AWS_SCP_BLOCKED' : 'UNKNOWN';
}

// ── The runner ────────────────────────────────────────────────────────────

/**
 * Runs the integration suite end-to-end and returns a structured result.
 *
 * Guaranteed teardown: the deploy phases register each created stack in the
 * cleanup registry, and `runWithTeardown` runs teardown in a `finally` block —
 * whether the run succeeds or any phase throws, the stacks are deleted.
 */
export async function runSuite(
  deps: SuiteDeps,
  config: SuiteConfig,
): Promise<SuiteResult> {
  const { aws, synth, publish } = deps;
  const registry = new CleanupRegistry();
  const phases: PhaseResult[] = [];
  let lastPhase: SuitePhase = 'synth';

  const record = (
    phase: SuitePhase,
    status: PhaseResult['status'],
    detail?: string,
  ): void => {
    phases.push({ phase, status, ...(detail !== undefined ? { detail } : {}) });
  };

  try {
    await runWithTeardown(registry, async (reg) => {
      // 1. synth
      lastPhase = 'synth';
      const templates = await synth();
      record('synth', 'passed');

      // 2. publish
      lastPhase = 'publish';
      const published = await publish(templates);
      record('publish', 'passed', published.templateUrl);

      // 3. deploy bootstrap stack
      lastPhase = 'deploy-bootstrap';
      await aws.cloudFormation.createStack({
        stackName: config.bootstrapStackName,
        region: config.region,
        templateBody: JSON.stringify(templates.bootstrap.template),
        capabilities: [...CAPABILITIES],
      });
      reg.register('cloudformation-stack', config.bootstrapStackName, () =>
        aws.cloudFormation.deleteStack({
          stackName: config.bootstrapStackName,
          region: config.region,
        }),
      );
      record('deploy-bootstrap', 'passed');

      // 4. wait first contact (bootstrap reaches CREATE_COMPLETE)
      lastPhase = 'wait-first-contact';
      await waitForStackStatus(
        aws.cloudFormation,
        config.bootstrapStackName,
        config.region,
        'CREATE_COMPLETE',
        config.wait,
      );
      record('wait-first-contact', 'passed');

      // 5. deploy application stack
      lastPhase = 'deploy-application';
      await aws.cloudFormation.createStack({
        stackName: config.applicationStackName,
        region: config.region,
        templateBody: JSON.stringify(templates.application.template),
        capabilities: [...CAPABILITIES],
      });
      reg.register('cloudformation-stack', config.applicationStackName, () =>
        aws.cloudFormation.deleteStack({
          stackName: config.applicationStackName,
          region: config.region,
        }),
      );
      record('deploy-application', 'passed');

      // 6. verify Healthy
      lastPhase = 'verify-healthy';
      const healthy = await verifyHealthy(aws, {
        cluster: config.clusterName,
        serviceName: config.serviceName,
        targetGroupArn: config.targetGroupArn,
        region: config.region,
      });
      if (!healthy) {
        throw new Error('application did not reach Healthy (ECS/ELB check failed)');
      }
      record('verify-healthy', 'passed');
    });

    // Success path — teardown already ran in the finally block.
    const teardown = registry.lastResult ?? emptyTeardown();
    lastPhase = 'teardown';
    record('teardown', teardown.failed === 0 ? 'passed' : 'failed');

    return {
      passed: true,
      phase: 'teardown',
      phases,
      teardown,
    };
  } catch (error) {
    // Teardown already ran in the finally block (guaranteed).
    const teardown = registry.lastResult ?? emptyTeardown();
    const message = toMessage(error);
    record(lastPhase, 'failed', message);
    record('teardown', teardown.failed === 0 ? 'passed' : 'failed');

    return {
      passed: false,
      phase: lastPhase,
      phases,
      error: message,
      failureCode: classifyFailure(error),
      teardown,
    };
  }
}

function emptyTeardown(): TeardownResult {
  return { attempted: 0, succeeded: 0, failed: 0, errors: [], order: [] };
}
