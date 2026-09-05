/**
 * B2–B6 for one repository against the deployed control plane and the test
 * AWS account — the product routes a vendor uses, the Quick Create a
 * customer runs, then an independent look at AWS and the live app.
 *
 * Every external call goes through `DeployDeps`, so the funnel's control
 * flow (ordering, stop conditions, cleanup in `finally`, classification)
 * is testable with fakes. The real wiring is `realDeps()` in index.ts.
 */
import { randomBytes } from 'node:crypto';

import { applicationStackNameForInstallation } from '@deployz/contracts';

import type { BenchmarkEntry } from '../repository-compatibility/manifest.js';
import type { Evidence } from '../version-canary/evidence.js';
import { ControlPlaneError, describeDeployment, waitFor, type DeploymentDetail } from '../version-canary/control-plane.js';
import { parseQuickCreateUrl } from '../version-canary/steps.js';
import { classifyFailure, type FailureEvidence, type FunnelPoint } from './classify.js';
import { APP_URL_TOKEN, appUrlKeys, providedKeys, secretFormat, secretKey, type RepositoryConfig, type SecretFormat } from './config.js';
import type { StoppedTask, TaskDefinitionEnv, DependencyPresence } from './evidence.js';
import { stageBRun } from './ledger.js';
import type { StageBResult } from './results.js';

const MINUTE = 60_000;

export interface Timeouts {
  analysisMs: number;
  buildMs: number;
  bootstrapMs: number;
  enrollMs: number;
  installMs: number;
  pointerMs: number;
  httpsMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  analysisMs: 10 * MINUTE,
  buildMs: 30 * MINUTE,
  bootstrapMs: 15 * MINUTE,
  enrollMs: 12 * MINUTE,
  installMs: 45 * MINUTE,
  pointerMs: 20 * MINUTE,
  httpsMs: 45 * MINUTE,
};

/** The vendor-side routes the funnel drives (a subset of the canary's ControlPlane). */
export interface ControlPlaneLike {
  request<T>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string>; allowStatus?: number[] }): Promise<{ status: number; body: T; headers: Headers }>;
  bindGithubInstallation(installationId: string): Promise<string>;
  createApplication(input: Record<string, unknown>): Promise<{ id: string }>;
  patchApplication(id: string, patch: Record<string, unknown>): Promise<void>;
  triggerAnalysis(id: string): Promise<void>;
  getReadiness(id: string): Promise<{ state: string; analysisStatus: string; findings: unknown[] }>;
  getApplication(id: string): Promise<Record<string, unknown>>;
  createRelease(applicationId: string, input: { version: string; gitSha: string; migrationCommand?: string }): Promise<{ id: string; version: string }>;
  listReleases(applicationId: string): Promise<{ id: string; version: string; status: string; failureReason: string | null }[]>;
  createCustomer(input: { name: string; email: string }): Promise<{ id: string }>;
  createDeployment(input: { applicationId: string; customerId: string; region: string }): Promise<{ id: string; installLinkId: string }>;
  getDeployment(id: string): Promise<DeploymentDetail>;
  getInstallInfo(installLinkId: string): Promise<{ quickCreateUrl: string | null; bootstrapStackName: string; deploymentId: string; alreadyInstalled: boolean }>;
  markInstallLaunched(installLinkId: string): Promise<{ state: string }>;
  events(deploymentId: string): Promise<{ eventType: string; jobId?: string | null }[]>;
  diagnostics(deploymentId: string): Promise<Record<string, unknown>>;
}

/** The customer-account reads and the one write (the customer's CreateStack). */
export interface AwsLike {
  createBootstrapStack(input: { stackName: string; templateUrl: string; parameters: Record<string, string>; runId: string }): Promise<string>;
  describeStack(stackName: string): Promise<{ status: string; statusReason: string | null; outputs: Record<string, string> } | null>;
  lambdaFunctionNames(stackName: string): Promise<string[]>;
  describeRunningService(stackName: string): Promise<{ desiredCount: number; runningCount: number; runningDigests: string[]; deployments: { status: string; rolloutState: string | null }[] } | null>;
  targetHealth(stackName: string): Promise<string[]>;
  albDnsName(stackName: string): Promise<string | null>;
  ecrDigestForTag(tag: string): Promise<string | null>;
  listStackResources(stackName: string): Promise<{ type: string; status: string; physicalId: string | null }[]>;
  describeStoppedTasks(stackName: string): Promise<StoppedTask[]>;
  tailApplicationLogs(stackName: string): Promise<string[]>;
  describeDependencies(stackName: string): Promise<DependencyPresence>;
  describeTaskDefinitionEnv(stackName: string): Promise<TaskDefinitionEnv | null>;
}

export interface Probe {
  (url: string): Promise<{ status: number | null; error?: string }>;
}

export interface DeployDeps {
  api: ControlPlaneLike;
  aws: AwsLike;
  probe: Probe;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  region: string;
  githubInstallationId: string;
  /** The application template URL to hand the bootstrap stack, or null for the production default. */
  templateUrl: string | null;
  templateSource: 'production-default' | 'stage-b-generic' | 'stage-b-pinned';
  /** Publishes a template pinned to the release digest (stage-b-pinned mode). */
  publishPinnedTemplate?: ((imageDigest: string, keyPrefix: string) => Promise<string>) | undefined;
  timeouts: Timeouts;
  /** Leaves the environment in place after verification (debugging only). */
  keep: boolean;
  generateSecret?: ((format: SecretFormat) => string) | undefined;
  pollIntervalMs?: number | undefined;
}

export interface RepositoryAttemptInput {
  benchmark: BenchmarkEntry;
  config: RepositoryConfig;
  repositoryUsed: string;
  repositoryForm: 'original' | 'fork';
  evidence: Evidence;
  /** The result document to fill; the caller persists it. */
  result: StageBResult;
}

export class FunnelStop extends Error {
  constructor(
    readonly point: FunnelPoint,
    message: string,
    readonly extra: Partial<FailureEvidence> = {},
  ) {
    super(message);
  }
}

function assert(condition: unknown, point: FunnelPoint, message: string, extra: Partial<FailureEvidence> = {}): asserts condition {
  if (!condition) throw new FunnelStop(point, message, extra);
}

function digestSuffix(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  return at >= 0 ? value.slice(at + 1) : value;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /^Timed out after/.test(error.message);
}

/** Runs one funnel step, translating a timeout into a FunnelStop at that point. */
async function step<T>(point: FunnelPoint, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof FunnelStop) throw error;
    if (isTimeout(error)) throw new FunnelStop(point, error instanceof Error ? error.message : String(error), { timedOut: true });
    if (error instanceof ControlPlaneError) throw new FunnelStop(point, error.message, {});
    throw new FunnelStop('harness', error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

/** The health path to probe and where it came from (README "Health-path precedence"). */
export function resolveHealthPath(config: RepositoryConfig, manifestPath: string | null, manifestMode: string | null, benchmarkNotesPath: string | undefined): { path: string; source: NonNullable<StageBResult['runtime']['healthPathSource']> } {
  const configured = config.verify?.healthPath ?? config.overrides?.healthPath;
  if (configured) return { path: configured, source: 'stage-b' };
  if (manifestPath && manifestMode !== 'vendor_required') return { path: manifestPath, source: 'manifest' };
  if (benchmarkNotesPath) return { path: benchmarkNotesPath, source: 'repository-evidence' };
  return { path: '/', source: 'fallback' };
}

/**
 * The whole funnel for one repository. Never throws for a product outcome:
 * the result carries the classification. Throws only when the harness
 * itself cannot continue (after recording TEST_HARNESS_ERROR).
 */
export async function runRepositoryAttempt(deps: DeployDeps, input: RepositoryAttemptInput): Promise<StageBResult> {
  const { benchmark, config, evidence, result } = input;
  const run = stageBRun(evidence);
  const started = deps.now();
  result.timing.startedAt = new Date(started).toISOString();
  result.repositoryUsed = input.repositoryUsed;
  result.repositoryForm = input.repositoryForm;
  result.deployment.templateSource = deps.templateSource;
  result.deployment.templateUrl = deps.templateUrl;
  run.stageB.templateSource = deps.templateSource;
  if (deps.templateUrl) run.stageB.templateUrl = deps.templateUrl;
  evidence.save();

  const interval = deps.pollIntervalMs ?? 20_000;
  let point: FunnelPoint = 'gate';

  try {
    // ── Application + analysis ──────────────────────────────────────────
    const applicationId = await step('gate', () =>
      evidence.step('Application and analysis', async (details) => {
        await deps.api.bindGithubInstallation(deps.githubInstallationId);
        const created = await deps.api.createApplication({
          name: `stage-b-${benchmark.id}`,
          githubInstallationId: deps.githubInstallationId,
          repoFullName: input.repositoryUsed,
          repoUrl: `https://github.com/${input.repositoryUsed}`,
          defaultBranch: benchmark.commit,
        });
        run.applicationId = created.id;
        evidence.save();
        details['applicationId'] = created.id;
        if (config.overrides && Object.keys(config.overrides).length > 0) {
          await deps.api.patchApplication(created.id, config.overrides);
          details['overrides'] = config.overrides;
        }
        await deps.api.triggerAnalysis(created.id);
        const readiness = await waitFor(
          'analysis',
          () => deps.api.getReadiness(created.id),
          (r) => (r.analysisStatus === 'COMPLETE' || r.analysisStatus === 'FAILED' ? r : null),
          { timeoutMs: deps.timeouts.analysisMs, intervalMs: Math.min(interval, 15_000), describe: (r) => `${r.analysisStatus}/${r.state}` },
        );
        details['readiness'] = { state: readiness.state, analysisStatus: readiness.analysisStatus, findings: readiness.findings.length };
        assert(readiness.analysisStatus === 'COMPLETE', 'gate', `analysis ended ${readiness.analysisStatus}`);
        result.gate.source = result.gate.source === 'in-process' ? 'both' : 'control-plane';
        return created.id;
      }),
    );

    // ── Configuration ───────────────────────────────────────────────────
    point = 'configuration';
    const keys = providedKeys(config);
    const generated = (config.secrets ?? []).map(secretKey);
    result.configuration.overrides = { ...(config.overrides ?? {}) };
    result.configuration.keys = keys;
    result.configuration.generatedKeys = generated;
    run.stageB.keys = keys;
    run.stageB.generatedKeys = generated;
    evidence.save();
    const preflight = await step('configuration', () =>
      evidence.step('Vendor configuration and preflight', async (details) => {
        const entries = [
          ...(config.config ?? []).map((value) => ({ key: value.key, value: value.value.replaceAll(APP_URL_TOKEN, APP_URL_PLACEHOLDER), isSecret: false })),
          ...(config.secrets ?? []).map((spec) => ({ key: secretKey(spec), value: (deps.generateSecret ?? generateSecret)(secretFormat(spec)), isSecret: true })),
        ];
        if (entries.length > 0) {
          await deps.api.request('PUT', `/api/applications/${applicationId}/config`, { entries });
          details['keys'] = keys;
        }
        const { body } = await deps.api.request<{ state: string; ready: boolean; blockers: { id: string; message: string }[]; warnings: { id: string }[] }>(
          'GET',
          `/api/applications/${applicationId}/preflight`,
        );
        details['preflight'] = { state: body.state, ready: body.ready, blockers: body.blockers.map((b) => b.id), warnings: body.warnings.map((w) => w.id) };
        return body;
      }),
    );
    const expectedDeployable = result.expectedDeployable;
    if (!preflight.ready) {
      const verdict = (preflight.state as 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE' | null) ?? null;
      const blockers = preflight.blockers.map((b) => `${b.id}: ${b.message}`).join('; ');
      if (verdict === 'NOT_COMPATIBLE' || !expectedDeployable) {
        throw new FunnelStop('gate', `the control plane's gate refuses: ${blockers}`, { gateVerdict: verdict });
      }
      throw new FunnelStop('configuration', `the control plane's gate still needs configuration: ${blockers}`, { gateVerdict: verdict });
    }
    result.configuration.status = 'PASS';
    result.gate.status = result.gate.status === 'NOT_ATTEMPTED' ? 'PASS' : result.gate.status;
    if (!expectedDeployable) {
      // A false acceptance: the funnel stops here — no AWS resources for an expected-unsupported repository.
      throw new FunnelStop('gate', 'the control plane accepted an expected-unsupported repository', { gateVerdict: (preflight.state as 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE' | null) ?? null });
    }

    // ── Build ───────────────────────────────────────────────────────────
    point = 'build';
    const buildStarted = deps.now();
    const release = await step('build', () =>
      evidence.step('Release build through CodeBuild', async (details) => {
        const version = `${benchmark.id}-${run.runId.slice('stage-b-'.length + benchmark.id.length + 1)}`;
        const created = await deps.api.createRelease(applicationId, {
          version,
          gitSha: benchmark.commit,
          ...(config.overrides?.migrationCommand ? { migrationCommand: config.overrides.migrationCommand } : {}),
        });
        run.releases['release'] = { id: created.id, version, gitSha: benchmark.commit };
        evidence.save();
        result.build.releaseId = created.id;
        result.build.version = version;
        result.build.gitSha = benchmark.commit;
        const application = await deps.api.getApplication(applicationId);
        const metadata = (application['detectedMetadata'] ?? {}) as Record<string, unknown>;
        const overrides = (metadata['manifestOverrides'] ?? {}) as Record<string, unknown>;
        result.build.dockerfilePath = (overrides['dockerfilePath'] as string | undefined) ?? (metadata['dockerfilePath'] as string | undefined) ?? 'Dockerfile';
        result.build.buildContext = (overrides['buildContext'] as string | undefined) ?? null;
        details['release'] = { id: created.id, version, dockerfilePath: result.build.dockerfilePath, buildContext: result.build.buildContext };
        const settled = await waitFor(
          `release ${version} build`,
          async () => (await deps.api.listReleases(applicationId)).find((r) => r.id === created.id),
          (r) => (r && r.status !== 'BUILDING' ? r : null),
          { timeoutMs: deps.timeouts.buildMs, intervalMs: interval, describe: (r) => r?.status ?? 'missing' },
        );
        details['buildStatus'] = settled.status;
        details['failureReason'] = settled.failureReason;
        result.build.durationMs = deps.now() - buildStarted;
        assert(settled.status === 'READY', 'build', `release build ${settled.status}: ${settled.failureReason ?? ''}`, { releaseFailure: settled.failureReason });
        const digest = await deps.aws.ecrDigestForTag(version);
        assert(digest, 'build', `ECR has no image tagged ${version}`, { releaseFailure: 'image missing after a READY build' });
        run.releases['release']!.imageDigest = digest;
        evidence.save();
        result.build.imageDigest = digest;
        details['imageDigest'] = digest;
        return { id: created.id, version, digest };
      }),
    );
    result.build.status = 'PASS';

    // ── Template (pinned mode publishes per repository) ────────────────
    let templateUrl = deps.templateUrl;
    if (deps.templateSource === 'stage-b-pinned') {
      templateUrl = await step('install', () =>
        evidence.step('Publish the Stage B application template pinned to the release', async (details) => {
          assert(deps.publishPinnedTemplate, 'harness', 'pinned template mode needs a publisher');
          const keyPrefix = `application/stage-b/${run.runId}`;
          const url = await deps.publishPinnedTemplate(release.digest, keyPrefix);
          run.canaryTemplateKeyPrefix = keyPrefix;
          run.stageB.templateUrl = url;
          evidence.save();
          result.deployment.templateUrl = url;
          details['templateUrl'] = url;
          return url;
        }),
      );
    }

    // ── Deployment + install ────────────────────────────────────────────
    point = 'install';
    const installStarted = deps.now();
    const deploymentId = await step('install', () =>
      evidence.step('Customer deployment, install link and the customer Quick Create', async (details) => {
        const customer = await deps.api.createCustomer({
          name: `Stage B ${benchmark.id}`,
          email: `customer-${run.runId.toLowerCase()}@deployz-stage-b.example.com`,
        });
        run.customerId = customer.id;
        evidence.save();
        let deployment: { id: string; installLinkId: string };
        try {
          deployment = await deps.api.createDeployment({ applicationId, customerId: customer.id, region: deps.region });
        } catch (error) {
          if (error instanceof ControlPlaneError && error.status === 422) {
            const code = error.code ?? '';
            throw new FunnelStop(code === 'MANIFEST_NOT_COMPATIBLE' ? 'gate' : 'configuration', error.message, {
              gateVerdict: code === 'MANIFEST_NOT_COMPATIBLE' ? 'NOT_COMPATIBLE' : 'NEEDS_CONFIGURATION',
            });
          }
          throw error;
        }
        run.deploymentId = deployment.id;
        run.installLinkId = deployment.installLinkId;
        run.stageB.cleanupNeeded = true;
        evidence.save();
        result.deployment.deploymentId = deployment.id;
        details['deploymentId'] = deployment.id;

        // Values that carry the deployment's own address are written at the
        // customer scope now that the permanent hostname is known — what a
        // vendor does after creating the deployment and reading its URL.
        const urlKeys = appUrlKeys(config);
        if (urlKeys.length > 0) {
          const appUrl = defaultDeploymentUrl(deployment.id);
          await deps.api.request('PUT', `/api/applications/${applicationId}/config`, {
            customerId: customer.id,
            entries: (config.config ?? [])
              .filter((value) => urlKeys.includes(value.key))
              .map((value) => ({ key: value.key, value: value.value.replaceAll(APP_URL_TOKEN, appUrl), isSecret: false })),
          });
          details['appUrlKeys'] = urlKeys;
        }

        const info = await deps.api.getInstallInfo(deployment.installLinkId);
        assert(info.quickCreateUrl, 'harness', 'install link carries no Quick Create URL (bootstrap template unpublished?)');
        const quick = parseQuickCreateUrl(info.quickCreateUrl);
        details['quickCreate'] = { templateUrl: quick.templateUrl, stackName: quick.stackName, parameters: Object.keys(quick.parameters) };
        const launched = await deps.api.markInstallLaunched(deployment.installLinkId);
        assert(launched.state === 'WAITING_FOR_RELAY', 'harness', `launched -> ${launched.state}`);
        const stackId = await deps.aws.createBootstrapStack({
          stackName: quick.stackName,
          templateUrl: quick.templateUrl,
          parameters: { ...quick.parameters, ...(templateUrl ? { ApplicationTemplateUrl: templateUrl } : {}) },
          runId: run.runId,
        });
        run.bootstrapStackName = quick.stackName;
        evidence.save();
        result.deployment.bootstrapStack = quick.stackName;
        details['bootstrapStackId'] = stackId;
        return deployment.id;
      }),
    );

    await step('install', () =>
      evidence.step('Bootstrap stack creates and the connector enrolls', async (details) => {
        const stackName = run.bootstrapStackName!;
        const stack = await waitFor(
          `bootstrap stack ${stackName}`,
          () => deps.aws.describeStack(stackName),
          (s) => (s && !s.status.endsWith('IN_PROGRESS') ? s : null),
          { timeoutMs: deps.timeouts.bootstrapMs, intervalMs: interval, describe: (s) => s?.status ?? 'absent' },
        );
        details['bootstrapStackStatus'] = stack.status;
        assert(stack.status === 'CREATE_COMPLETE', 'install', `bootstrap stack ${stack.status}: ${stack.statusReason ?? ''}`, { stackStatus: stack.status });
        const installationId = stack.outputs['InstallationId'];
        assert(installationId, 'harness', 'bootstrap stack has no InstallationId output');
        run.installationId = installationId;
        run.applicationStackName = applicationStackNameForInstallation(installationId);
        run.bootstrapLambdaNames = await deps.aws.lambdaFunctionNames(stackName);
        evidence.save();
        result.deployment.installationId = installationId;
        result.deployment.applicationStack = run.applicationStackName;
        details['installationId'] = installationId;
        const enrolled = await waitFor(
          'relay enrollment',
          () => deps.api.getDeployment(deploymentId),
          (d) => (d.installationId ? d : null),
          { timeoutMs: deps.timeouts.enrollMs, intervalMs: interval, describe: describeDeployment },
        );
        assert(enrolled.installationId === installationId, 'harness', `control plane bound installation ${enrolled.installationId}`);
      }),
    );

    const installed = await step('install', () =>
      evidence.step('INSTALL provisions the application stack', async (details) => {
        const detail = await waitFor(
          'install',
          () => deps.api.getDeployment(deploymentId),
          (d) => (d.state === 'HEALTHY' || d.state === 'UPDATE_AVAILABLE' || d.state === 'FAILED' ? d : null),
          { timeoutMs: deps.timeouts.installMs, intervalMs: interval, describe: describeDeployment },
        );
        const installJob = detail.jobs.find((j) => j.type === 'INSTALL');
        result.deployment.installJobState = installJob?.state ?? null;
        result.deployment.failureCode = detail.deploymentStatus.failure?.code ?? null;
        details['deployment'] = summarize(detail);
        const appStack = await deps.aws.describeStack(run.applicationStackName!);
        result.deployment.stackStatus = appStack?.status ?? null;
        details['applicationStackStatus'] = appStack?.status ?? 'absent';
        assert(detail.state !== 'FAILED', 'install', `install FAILED: ${detail.deploymentStatus.failure?.message ?? detail.deploymentStatus.failure?.code ?? 'no reason'}`, {
          failureCode: detail.deploymentStatus.failure?.code ?? null,
          stackStatus: appStack?.status ?? null,
        });
        assert(appStack?.status === 'CREATE_COMPLETE' || appStack?.status === 'UPDATE_COMPLETE', 'install', `application stack ${appStack?.status ?? 'absent'}`, { stackStatus: appStack?.status ?? null });
        const resources = await deps.aws.listStackResources(run.applicationStackName!);
        result.deployment.resourceCount = resources.length;
        result.deployment.durationMs = deps.now() - installStarted;
        return detail;
      }),
    );
    result.deployment.status = 'PASS';

    // ── The release becomes the serving image ──────────────────────────
    point = 'auto-deploy';
    await step('auto-deploy', () =>
      evidence.step('The built release is the serving image', async (details) => {
        const detail = await waitFor(
          'release pointer',
          () => deps.api.getDeployment(deploymentId),
          (d) => (d.currentReleaseId === release.id || d.state === 'FAILED' ? d : null),
          { timeoutMs: deps.timeouts.pointerMs, intervalMs: interval, describe: describeDeployment },
        );
        details['deployment'] = summarize(detail);
        const deployJob = [...detail.jobs].reverse().find((j) => j.type === 'DEPLOY_RELEASE');
        if (deployJob) details['deployJob'] = { id: deployJob.id, state: deployJob.state, failureCode: deployJob.failureCode };
        const failedJob = deployJob && deployJob.state === 'FAILED';
        assert(!failedJob && detail.state !== 'FAILED', 'auto-deploy', `deploy of the release ${deployJob?.state ?? detail.state}: ${detail.deploymentStatus.failure?.message ?? ''}`, {
          failureCode: deployJob?.failureCode ?? detail.deploymentStatus.failure?.code ?? null,
          migrationFailed: deployJob?.failureCode === 'MIGRATION_FAILED',
        });
        assert(detail.currentReleaseId === release.id, 'auto-deploy', `currentReleaseId is ${detail.currentReleaseId}, expected ${release.id}`);
        result.runtime.runningImageDigest = detail.runningImageDigest;
        result.runtime.releaseServing = digestSuffix(detail.runningImageDigest) === digestSuffix(release.digest);
        assert(result.runtime.releaseServing, 'auto-deploy', `control plane observed digest ${detail.runningImageDigest}, expected ${release.digest}`);
        const service = await deps.aws.describeRunningService(run.applicationStackName!);
        details['ecs'] = service;
        assert(service && service.runningDigests.length === 1 && service.runningDigests[0] === digestSuffix(release.digest), 'auto-deploy', `ECS runs ${service?.runningDigests.join(', ') ?? 'nothing'}, expected the release digest`);
        if (deployJob) result.dependencies.migration = deployJob.failureCode === 'MIGRATION_FAILED' ? 'FAIL' : result.dependencies.migration;
      }),
    );
    void installed;

    // ── Runtime health + HTTPS + observation ───────────────────────────
    point = 'runtime';
    const application = await deps.api.getApplication(applicationId);
    const manifestHealthPath = (application['healthPath'] as string | null | undefined) ?? null;
    const metadata = (application['detectedMetadata'] ?? {}) as Record<string, unknown>;
    const healthMode = typeof metadata['healthMode'] === 'string' ? metadata['healthMode'] : null;
    const health = resolveHealthPath(config, manifestHealthPath, healthMode, undefined);
    result.runtime.healthPath = health.path;
    result.runtime.healthPathSource = health.source;
    const alb = await deps.aws.albDnsName(run.applicationStackName!);
    assert(alb, 'harness', 'application stack has no load balancer');
    run.albEndpoint = `http://${alb}`;
    evidence.save();

    await step('runtime', () =>
      evidence.step('ECS and ALB report healthy, the health path answers over HTTP', async (details) => {
        const service = await deps.aws.describeRunningService(run.applicationStackName!);
        result.runtime.ecs = service && service.runningCount >= service.desiredCount && service.desiredCount > 0 && service.deployments.every((d) => d.rolloutState !== 'FAILED') ? 'HEALTHY' : 'UNHEALTHY';
        const targets = await deps.aws.targetHealth(run.applicationStackName!);
        result.runtime.alb = targets.length > 0 && targets.every((t) => t === 'healthy') ? 'HEALTHY' : 'UNHEALTHY';
        details['ecs'] = service;
        details['targets'] = targets;
        const probe = await deps.probe(`${run.albEndpoint}${health.path}`);
        details['httpHealth'] = probe;
        assert(result.runtime.ecs === 'HEALTHY', 'runtime', `ECS not healthy: ${JSON.stringify(service)}`, { targetHealth: targets, healthStatuses: [probe.status] });
        assert(result.runtime.alb === 'HEALTHY', 'runtime', `ALB targets: ${targets.join(', ')}`, { targetHealth: targets, healthStatuses: [probe.status] });
        assert(probe.status !== null && probe.status < 500, 'runtime', `health path ${health.path} answered ${probe.status ?? probe.error} over HTTP`, { healthStatuses: [probe.status] });
      }),
    );

    point = 'https';
    const appUrl = await step('https', () =>
      evidence.step('Default HTTPS becomes ACTIVE', async (details) => {
        const detail = await waitFor(
          'default HTTPS',
          () => deps.api.getDeployment(deploymentId),
          (d) => {
            const https = (d as unknown as { defaultHttps?: { status?: string; hostname?: string } | null }).defaultHttps;
            return https?.status === 'ACTIVE' || https?.status === 'ERROR' ? d : null;
          },
          { timeoutMs: deps.timeouts.httpsMs, intervalMs: interval, describe: (d) => `${(d as unknown as { defaultHttps?: { status?: string } | null }).defaultHttps?.status ?? 'none'} ${describeDeployment(d)}` },
        );
        const https = (detail as unknown as { defaultHttps?: { status?: string; hostname?: string; lastError?: string | null } | null }).defaultHttps;
        details['defaultHttps'] = https;
        assert(https?.status === 'ACTIVE', 'https', `default HTTPS ${https?.status ?? 'none'}: ${https?.lastError ?? ''}`, { httpsStatus: https?.status ?? null });
        const url = `https://${https.hostname}`;
        assert(appUrlKeys(config).length === 0 || url === defaultDeploymentUrl(deploymentId), 'harness', `the configured app URL ${defaultDeploymentUrl(deploymentId)} differs from the issued hostname ${url}`);
        result.runtime.appUrl = url;
        details['appUrl'] = url;
        const probe = await deps.probe(`${url}${health.path}`);
        details['httpsHealth'] = probe;
        assert(probe.status !== null, 'https', `HTTPS probe failed: ${probe.error ?? 'no response'}`, { httpsStatus: https.status });
        return url;
      }),
    );
    result.runtime.https = 'PASS';

    point = 'runtime';
    await step('runtime', () =>
      evidence.step('The application stays healthy through the observation window', async (details) => {
        const seconds = config.verify?.observationSeconds ?? 180;
        const appPath = config.verify?.appPath ?? '/';
        const accept = config.verify?.appStatus ?? null;
        const samples = Math.max(3, Math.floor(seconds / 30));
        const healthStatuses: (number | null)[] = [];
        const appStatuses: (number | null)[] = [];
        const httpsHealthStatuses: (number | null)[] = [];
        for (let i = 0; i < samples; i++) {
          if (i > 0) await deps.sleep((seconds * 1000) / samples);
          healthStatuses.push((await deps.probe(`${run.albEndpoint}${health.path}`)).status);
          httpsHealthStatuses.push((await deps.probe(`${appUrl}${health.path}`)).status);
          appStatuses.push((await deps.probe(`${appUrl}${appPath}`)).status);
        }
        result.runtime.observation = { seconds, samples, healthStatuses, appStatuses, httpsHealthStatuses };
        details['observation'] = result.runtime.observation;
        const detail = await deps.api.getDeployment(deploymentId);
        details['deployment'] = summarize(detail);
        const service = await deps.aws.describeRunningService(run.applicationStackName!);
        const targets = await deps.aws.targetHealth(run.applicationStackName!);
        details['ecs'] = service;
        details['targets'] = targets;
        const stopped = await deps.aws.describeStoppedTasks(run.applicationStackName!);
        details['stoppedTasks'] = stopped.length;
        const okHealth = (s: number | null) => s !== null && s < 500;
        const okApp = (s: number | null) => s !== null && (accept ? accept.includes(s) : s < 500);
        assert(healthStatuses.every(okHealth) && httpsHealthStatuses.every(okHealth), 'runtime', `health path unstable: http ${healthStatuses.join('/')} https ${httpsHealthStatuses.join('/')}`, { healthStatuses: [...healthStatuses, ...httpsHealthStatuses], targetHealth: targets });
        assert(appStatuses.every(okApp), 'runtime', `application path ${appPath} answered ${appStatuses.join('/')}`, { appStatuses, targetHealth: targets });
        assert(detail.state === 'HEALTHY' || detail.state === 'UPDATE_AVAILABLE', 'runtime', `deployment state ${detail.state} after the window`, { failureCode: detail.deploymentStatus.failure?.code ?? null });
        assert(targets.length > 0 && targets.every((t) => t === 'healthy'), 'runtime', `ALB targets after the window: ${targets.join(', ')}`, { targetHealth: targets });
        const crashLoop = stopped.filter((t) => t.containers.some((c) => c.exitCode !== null && c.exitCode !== 0)).length;
        assert(crashLoop < 3, 'runtime', `${crashLoop} tasks exited non-zero during the run`, { stoppedTasks: stopped.map((t) => ({ exitCode: t.containers[0]?.exitCode ?? null, reason: t.containers[0]?.reason ?? null, stoppedReason: t.stoppedReason })) });
      }),
    );

    // ── Dependencies ────────────────────────────────────────────────────
    point = 'dependencies';
    await step('dependencies', () =>
      evidence.step('Provisioned dependencies are bound and used', async (details) => {
        const manifest = ((application['detectedMetadata'] as Record<string, unknown> | null)?.['manifest'] ?? null) as Record<string, unknown> | null;
        const needs = {
          postgres: application['databaseRequired'] === true,
          redis: application['redisRequired'] === true,
          storage: application['storageRequired'] === true,
        };
        const presence = await deps.aws.describeDependencies(run.applicationStackName!);
        const env = await deps.aws.describeTaskDefinitionEnv(run.applicationStackName!);
        details['presence'] = presence;
        details['taskEnv'] = env;
        details['needs'] = needs;
        const bound = new Set([...(env?.environment ?? []), ...(env?.secrets ?? [])]);
        const check = (kind: 'postgres' | 'redis' | 'storage', present: boolean, names: string[]): StageBResult['dependencies']['postgres'] => {
          if (!needs[kind]) return 'NOT_REQUIRED';
          if (config.dependencies?.[kind] === 'skip') return 'NOT_VERIFIED';
          if (!present) return 'FAIL';
          return names.some((name) => bound.has(name)) ? 'PASS' : 'FAIL';
        };
        result.dependencies.postgres = check('postgres', presence.rds !== null, ['DATABASE_URL', 'DATABASE_HOST']);
        result.dependencies.redis = check('redis', presence.cache !== null, ['REDIS_URL', 'REDIS_HOST']);
        result.dependencies.storage = check('storage', presence.bucket !== null, ['AWS_S3_BUCKET', 'S3_BUCKET', 'STORAGE_BUCKET']);
        if (result.dependencies.migration === 'NOT_ATTEMPTED') {
          const migrationCommand = config.overrides?.migrationCommand ?? (application['migrationCommand'] as string | null | undefined) ?? null;
          result.dependencies.migration = migrationCommand ? 'PASS' : 'NOT_REQUIRED';
        }
        void manifest;
        const failed = (['postgres', 'redis', 'storage'] as const).filter((k) => result.dependencies[k] === 'FAIL');
        assert(failed.length === 0, 'dependencies', `dependency binding failed: ${failed.join(', ')} (bound: ${[...bound].join(', ')})`);
      }),
    );

    result.classification = 'PASS';
    result.failureStage = null;
    result.rootCause = null;
    result.rootCauseEvidence = null;
  } catch (error) {
    const stop = error instanceof FunnelStop ? error : new FunnelStop('harness', error instanceof Error ? (error.stack ?? error.message) : String(error));
    await recordFailure(deps, input, stop, point);
  } finally {
    result.timing.finishedAt = new Date(deps.now()).toISOString();
    result.timing.totalMs = deps.now() - started;
    evidence.save();
  }
  return result;
}

/** A fresh secret in the shape the application validates; never logged, never recorded. */
export function generateSecret(format: SecretFormat): string {
  switch (format) {
    case 'hex32':
      return randomBytes(16).toString('hex');
    case 'hex64':
      return randomBytes(32).toString('hex');
    case 'password':
      return `Sb-${randomBytes(12).toString('base64url')}-1`;
    default:
      return randomBytes(32).toString('base64url');
  }
}

const APP_URL_PLACEHOLDER = 'https://pending.deployz.dev';

/** The deployment's permanent default-HTTPS address (`d-<id>.deployz.dev`), checked against the API once HTTPS is ACTIVE. */
export function defaultDeploymentUrl(deploymentId: string): string {
  return `https://d-${deploymentId.toLowerCase()}.deployz.dev`;
}

function summarize(detail: DeploymentDetail): Record<string, unknown> {
  return {
    state: detail.state,
    stage: detail.deploymentStatus.stage,
    currentReleaseId: detail.currentReleaseId,
    healthStatus: detail.healthStatus,
    relayStatus: detail.relayStatus,
    runningImageDigest: detail.runningImageDigest,
    appUrl: detail.appUrl,
    failure: detail.deploymentStatus.failure,
    lastJob: detail.jobs.at(-1) ? { type: detail.jobs.at(-1)!.type, state: detail.jobs.at(-1)!.state, failureCode: detail.jobs.at(-1)!.failureCode } : null,
  };
}

/** Collects what the failure needs for diagnosis, classifies it, and marks the stages. */
async function recordFailure(deps: DeployDeps, input: RepositoryAttemptInput, stop: FunnelStop, point: FunnelPoint): Promise<void> {
  const { evidence, result } = input;
  const run = stageBRun(evidence);
  const failurePoint = stop.point === 'harness' ? 'harness' : stop.point;
  const evidenceIn: FailureEvidence = {
    point: failurePoint,
    expectedDeployable: result.expectedDeployable,
    message: stop.message,
    healthPathSource: result.runtime.healthPathSource,
    manifestHealthPath: null,
    probedHealthPath: result.runtime.healthPath,
    ...stop.extra,
  };
  const collected: Record<string, unknown> = { point, message: stop.message.slice(0, 2000) };
  let extra: Partial<FailureEvidence> = {};
  if (run.applicationStackName && (failurePoint === 'install' || failurePoint === 'auto-deploy' || failurePoint === 'runtime' || failurePoint === 'https' || failurePoint === 'dependencies')) {
    try {
      const stopped = await deps.aws.describeStoppedTasks(run.applicationStackName);
      const logs = await deps.aws.tailApplicationLogs(run.applicationStackName);
      const resources = await deps.aws.listStackResources(run.applicationStackName).catch(() => []);
      const stackReasons = resources.filter((r) => /FAILED/.test(r.status)).map((r) => `${r.type} ${r.status}`);
      const targets = await deps.aws.targetHealth(run.applicationStackName).catch(() => []);
      collected['stoppedTasks'] = stopped;
      collected['logTail'] = logs;
      collected['stackFailures'] = stackReasons;
      collected['targetHealth'] = targets;
      extra = {
        stoppedTasks: stopped.map((t) => ({ exitCode: t.containers[0]?.exitCode ?? null, reason: t.containers[0]?.reason ?? null, stoppedReason: t.stoppedReason })),
        logTail: logs,
        stackReasons,
        targetHealth: targets,
      };
    } catch (error) {
      collected['evidenceError'] = error instanceof Error ? error.message : String(error);
    }
    if (run.deploymentId) {
      try {
        collected['diagnostics'] = await deps.api.diagnostics(run.deploymentId);
      } catch {
        // Diagnostics exist only for failed deployments; absence is fine.
      }
    }
  }
  const classified = classifyFailure({ ...evidenceIn, ...extra, ...stop.extra });
  result.classification = classified.failureStage;
  result.failureStage = classified.failureStage;
  result.rootCause = classified.rootCause;
  result.rootCauseEvidence = classified.rootCauseEvidence;
  result.evidence = { ...result.evidence, failure: collected };

  const markFail = (section: { status: StageBResult['gate']['status']; detail: string | null }) => {
    if (section.status === 'NOT_ATTEMPTED') {
      section.status = 'FAIL';
      section.detail = stop.message.slice(0, 500);
    }
  };
  switch (failurePoint) {
    case 'gate':
      if (result.expectedDeployable || classified.failureStage !== 'EXPECTED_UNSUPPORTED') markFail(result.gate);
      else {
        result.gate.status = 'PASS';
        result.gate.detail = stop.message.slice(0, 500);
      }
      break;
    case 'configuration':
      markFail(result.configuration);
      break;
    case 'build':
      markFail(result.build);
      break;
    case 'install':
      markFail(result.deployment);
      break;
    case 'auto-deploy':
    case 'runtime':
      if (result.runtime.ecs === 'NOT_ATTEMPTED') result.runtime.ecs = 'UNKNOWN';
      if (result.runtime.alb === 'NOT_ATTEMPTED') result.runtime.alb = 'UNKNOWN';
      if (result.runtime.https === 'NOT_ATTEMPTED') result.runtime.https = 'NOT_ATTEMPTED';
      result.runtime.detail = stop.message.slice(0, 500);
      break;
    case 'https':
      result.runtime.https = 'FAIL';
      result.runtime.detail = stop.message.slice(0, 500);
      break;
    case 'dependencies':
      result.dependencies.detail = stop.message.slice(0, 500);
      break;
    default:
      break;
  }
}
