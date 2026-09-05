import {
  evaluateManifestReadiness,
  generatedEnvKeys,
  normalizeDeploymentManifest,
  type ReadinessReport,
} from '@deployz/analysis';
import type { DeploymentManifest, ManifestReadinessFinding } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';

import { listProvidedConfigKeys } from './config.js';
import { ApiError } from './errors.js';
import { effectiveReadinessReport } from './fix-instructions.js';
import { applicationToManifestOverrides, readStoredManifest, type ManifestApplicationRow } from './manifest.js';

// Pre-deployment preflight (AI MVP Phase 5) — the one gate every path into
// AWS provisioning runs: deployment creation, the install-link and
// deploy-link launches, and relay registration. It combines the deployment
// manifest gate (unsupported architecture, container setup, port, start
// command, required env vars against the values THIS customer has), the
// readiness report's remaining findings as warnings, and lists every check
// so the vendor sees what passed, not only what failed. Deterministic: no
// AI call, nothing fetched — it reads what analysis and configuration
// already persisted.

export type PreflightState = 'READY' | 'READY_WITH_WARNINGS' | 'ACTION_REQUIRED' | 'UNSUPPORTED';

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'passed' | 'warning' | 'blocked';
  /** One short line: what was found, or what is missing. Null when the label says it all. */
  detail: string | null;
}

export interface PreflightResult {
  state: PreflightState;
  /** True when provisioning may start — warnings never block. */
  ready: boolean;
  blockers: ManifestReadinessFinding[];
  warnings: ManifestReadinessFinding[];
  checks: PreflightCheck[];
}

export interface PreflightInput {
  manifest: DeploymentManifest;
  /** Env keys with a saved value for the scope being evaluated. */
  providedEnvKeys: string[];
  /** The application's effective readiness report, when the caller has it. */
  readiness: ReadinessReport | null;
}

/** Readiness findings the manifest gate already reports as blockers or warnings. */
const COVERED_READINESS_FINDINGS = new Set([
  'container-setup',
  'port-unresolved',
  'start-command-missing',
  'database-migrations',
  'health-check',
]);

/** Readiness findings that name a repository change the deployment can still proceed without. */
function readinessWarnings(readiness: ReadinessReport | null): ManifestReadinessFinding[] {
  if (!readiness) return [];
  return readiness.findings
    .filter((finding) => !finding.blocking && !COVERED_READINESS_FINDINGS.has(finding.id))
    .map((finding) => ({
      id: finding.id,
      category: finding.category,
      severity: 'warning' as const,
      message: `${finding.title} — ${finding.plainEnglishExplanation}`,
    }));
}

function requiredCustomerKeys(manifest: DeploymentManifest, providedEnvKeys: string[]): { required: string[]; missing: string[] } {
  const generated = new Set(generatedEnvKeys(manifest));
  const provided = new Set(providedEnvKeys);
  const required = manifest.environment.variables
    .filter(
      (variable) =>
        variable.classification === 'customer_required' ||
        (variable.classification === undefined && variable.required),
    )
    .map((variable) => variable.key)
    .filter((key) => !generated.has(key));
  return { required, missing: required.filter((key) => !provided.has(key)) };
}

/**
 * Evaluate the preflight. Pure — the same manifest, provided keys and
 * readiness report always give the same result.
 */
export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const { manifest } = input;
  const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: input.providedEnvKeys });
  const blockers = gate.findings.filter((finding) => finding.severity === 'error');
  const gateWarnings = gate.findings.filter((finding) => finding.severity === 'warning');
  const warnings = [...gateWarnings, ...readinessWarnings(input.readiness)];
  const blockedIds = new Set(blockers.map((finding) => finding.id));
  const checks: PreflightCheck[] = [];

  if (manifest.unsupported.length > 0) {
    checks.push({
      id: 'compatibility',
      label: 'Supported architecture',
      status: 'blocked',
      detail: manifest.unsupported.join(' '),
    });
  } else {
    checks.push({ id: 'compatibility', label: 'Supported architecture', status: 'passed', detail: null });
  }

  checks.push({
    id: 'container',
    label: 'Application build configuration',
    status: blockedIds.has('dockerfile-missing') ? 'blocked' : 'passed',
    detail: manifest.application.dockerfilePath ?? 'No container build instructions were found.',
  });
  checks.push({
    id: 'start',
    label: 'Start command',
    status: blockedIds.has('start-command-missing') ? 'blocked' : 'passed',
    detail: manifest.web.command ?? 'No start command was found.',
  });
  checks.push({
    id: 'port',
    label: 'Application port',
    status: blockedIds.has('port-missing') ? 'blocked' : 'passed',
    detail: manifest.web.port !== null ? String(manifest.web.port) : 'The port the app listens on is unknown.',
  });
  checks.push({
    id: 'database',
    label: 'Database',
    status: 'passed',
    detail: manifest.database.postgres ? 'PostgreSQL — Deployz provides a managed database' : 'No database required',
  });
  checks.push({
    id: 'redis',
    label: 'Cache',
    status: 'passed',
    detail: manifest.redis.required ? 'Redis — provisioned automatically' : 'No cache required',
  });
  checks.push({
    id: 'storage',
    label: 'File storage',
    status: 'passed',
    detail: manifest.storage.required ? 'Object storage — Deployz provides a bucket' : 'No file storage required',
  });

  const managedCount = manifest.environment.variables.filter(
    (variable) => variable.classification === 'deployz_managed' || variable.classification === 'deployz_generated',
  ).length;
  checks.push({
    id: 'managed-variables',
    label: 'Deployz-managed variables',
    status: 'passed',
    detail:
      managedCount > 0
        ? `${managedCount} ${managedCount === 1 ? 'variable' : 'variables'} configured automatically`
        : 'Set at installation',
  });

  const customerKeys = requiredCustomerKeys(manifest, input.providedEnvKeys);
  checks.push({
    id: 'customer-variables',
    label: 'Required customer variables',
    status: customerKeys.missing.length > 0 ? 'blocked' : 'passed',
    detail:
      customerKeys.required.length === 0
        ? 'Nothing for you to provide'
        : customerKeys.missing.length > 0
          ? `Missing: ${customerKeys.missing.join(', ')}`
          : `${customerKeys.required.length} ${customerKeys.required.length === 1 ? 'value' : 'values'} provided`,
  });

  const healthMissing = input.readiness?.findings.some((finding) => finding.id === 'health-check') === true;
  checks.push({
    id: 'health',
    label: 'Health configuration',
    status: healthMissing ? 'warning' : 'passed',
    detail: healthMissing
      ? `No dedicated health endpoint detected — Deployz will probe ${manifest.health.path}`
      : `Health check at ${manifest.health.path}`,
  });
  if (healthMissing) {
    const finding = input.readiness?.findings.find((entry) => entry.id === 'health-check');
    if (finding) {
      warnings.push({
        id: finding.id,
        category: finding.category,
        severity: 'warning',
        message: `${finding.title} — ${finding.plainEnglishExplanation}`,
      });
    }
  }

  if (manifest.database.postgres) {
    const migrationMissing = gateWarnings.some((finding) => finding.id === 'migration-command-missing');
    checks.push({
      id: 'migrations',
      label: 'Database migrations',
      status: migrationMissing ? 'warning' : 'passed',
      detail: migrationMissing ? 'No migration command — schema updates will not run on deploy' : manifest.migration.command,
    });
  }

  for (const warning of readinessWarnings(input.readiness)) {
    checks.push({ id: warning.id, label: warning.message.split(' — ')[0] ?? warning.id, status: 'warning', detail: warning.message });
  }

  const state: PreflightState =
    gate.state === 'NOT_COMPATIBLE'
      ? 'UNSUPPORTED'
      : blockers.length > 0
        ? 'ACTION_REQUIRED'
        : warnings.length > 0
          ? 'READY_WITH_WARNINGS'
          : 'READY';

  return { state, ready: state === 'READY' || state === 'READY_WITH_WARNINGS', blockers, warnings, checks };
}

/** The application row slice the preflight reads. */
export type PreflightApplicationRow = ManifestApplicationRow & { id: string };

/**
 * Preflight for an application before a deployment exists: the manifest is
 * built fresh from the analysis and the vendor's overrides, provided keys
 * are the vendor defaults plus this customer's overrides when a customer is
 * named.
 */
export async function runApplicationPreflight(
  db: RuntimeDb,
  application: PreflightApplicationRow,
  customerId: string | null,
): Promise<{ manifest: DeploymentManifest; result: PreflightResult }> {
  const manifest = normalizeDeploymentManifest(
    { metadata: application.detectedMetadata ?? {} },
    applicationToManifestOverrides(application),
  );
  const providedEnvKeys = await listProvidedConfigKeys(db, application.id, customerId);
  const result = evaluatePreflight({
    manifest,
    providedEnvKeys,
    readiness: effectiveReadinessReport(application),
  });
  return { manifest, result };
}

/**
 * Preflight for a deployment that exists but has not provisioned yet: the
 * stored manifest (the contract the deployment was created with) against
 * the configuration this customer has now.
 */
export async function runDeploymentPreflight(
  db: RuntimeDb,
  deployment: { applicationId: string; customerId: string; desiredState: Record<string, unknown> | null },
  application: PreflightApplicationRow | null,
): Promise<PreflightResult> {
  const manifest = readStoredManifest(deployment.desiredState);
  if (!manifest) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
    );
  }
  const providedEnvKeys = await listProvidedConfigKeys(db, deployment.applicationId, deployment.customerId);
  return evaluatePreflight({
    manifest,
    providedEnvKeys,
    readiness: application ? effectiveReadinessReport(application) : null,
  });
}

/**
 * Refuse to move toward provisioning unless the preflight is ready. The
 * error codes are the ones every client already handles; `details.findings`
 * carries blockers first, then warnings.
 */
export function requirePreflightReady(result: PreflightResult): void {
  if (result.state === 'UNSUPPORTED') {
    throw new ApiError(422, 'MANIFEST_NOT_COMPATIBLE', 'This application cannot be deployed with Deployz as configured.', {
      findings: [...result.blockers, ...result.warnings],
      state: result.state,
    });
  }
  if (!result.ready) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'This application is missing configuration required for deployment. Run analysis or correct it in the application settings first.',
      { findings: [...result.blockers, ...result.warnings], state: result.state },
    );
  }
}
