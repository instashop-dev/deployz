/**
 * The canary's building blocks — each one drives the product exactly the
 * way a vendor or customer would (control-plane routes, the Quick Create
 * template, the live app), then verifies the outcome at four layers:
 * Deployz (state + pointers + job), the relay/job, AWS (CloudFormation /
 * ECS / ECR read directly), and the live application.
 *
 * Every step records what it saw into the run's evidence; a failing
 * assertion throws with the facts in the message.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { applicationStackNameForInstallation } from '@deployz/contracts';

import { probeLiveApp, readMarker, sampleLiveApp, writeMarker } from './app.js';
import {
  albDnsName,
  callerIdentity,
  createBootstrapStack,
  describeRunningService,
  describeStack,
  ecrDigestForTag,
  lambdaFunctionNames,
  targetHealth,
  templateBucketName,
} from './aws.js';
import { releaseVersionFor, type CanaryConfig } from './config.js';
import {
  ControlPlane,
  ControlPlaneError,
  describeDeployment,
  findJob,
  isTerminalJobState,
  sleep,
  waitFor,
  type DeploymentDetail,
} from './control-plane.js';
import type { Evidence } from './evidence.js';
import { FIXTURE_RELEASES, type FixtureRelease } from './fixture-repo.js';

export const ECR_REPOSITORY = 'deployz-images';

const MINUTE = 60_000;

export interface Canary {
  readonly config: CanaryConfig;
  readonly evidence: Evidence;
  readonly api: ControlPlane;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digestSuffix(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  return at >= 0 ? value.slice(at + 1) : value;
}

// ── Preflight ─────────────────────────────────────────────────────────────

export async function preflight(canary: Canary): Promise<void> {
  const { config, evidence, api } = canary;
  await evidence.step('Preflight: AWS identity, region, control plane, fixture repo', async (details) => {
    const identity = await callerIdentity();
    details['identity'] = identity;
    assert(
      identity.account === config.expectedAccountId,
      `AWS account ${identity.account} is not the expected test account ${config.expectedAccountId} — refusing to run`,
    );
    details['region'] = config.region;

    const health = await fetch(`${config.apiUrl}/health`);
    details['controlPlaneHealth'] = health.status;
    assert(health.status === 200, `control plane ${config.apiUrl}/health answered ${health.status}`);

    const bucket = await templateBucketName(config.region);
    details['templateBucket'] = bucket;
    evidence.run.templateBucket = bucket;

    const tags = resolveFixtureTags(config.fixtureRepo);
    details['fixtureTags'] = tags;
    evidence.run.fixtureTags = tags;
    for (const release of FIXTURE_RELEASES) {
      assert(tags[release.tag], `fixture repo ${config.fixtureRepo} has no tag ${release.tag} — run pnpm canary:fixture-repo`);
    }
    details['apiUrl'] = api.apiUrl;
  });
}

/** Resolves every fixture tag to its commit and content commit (`<tag>^`). */
export function resolveFixtureTags(repo: string): Record<string, { sha: string; contentSha: string }> {
  const out: Record<string, { sha: string; contentSha: string }> = {};
  const refs = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`], {
    encoding: 'utf8',
  });
  const shaByTag = new Map<string, string>();
  for (const line of refs.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    const match = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
    if (match?.[1]) shaByTag.set(match[1], sha);
  }
  for (const release of FIXTURE_RELEASES) {
    const sha = shaByTag.get(release.tag);
    if (!sha) continue;
    const parent = gh<{ parents: { sha: string }[] }>(`repos/${repo}/commits/${sha}`).parents[0]?.sha ?? '';
    out[release.tag] = { sha, contentSha: parent };
  }
  return out;
}

function gh<T>(path: string): T {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })) as T;
}

// ── Vendor + application ───────────────────────────────────────────────────

export async function setUpVendorAndApplication(canary: Canary): Promise<string> {
  const { config, evidence, api } = canary;
  const applicationId = await evidence.step('Vendor sign-up, GitHub binding, application', async (details) => {
    const email = `canary-${config.runId.toLowerCase()}@deployz-canary.example.com`;
    const password = `Canary-${config.runId}-${Math.random().toString(36).slice(2, 10)}`;
    await api.signUp({ name: `Canary ${config.runId}`, email, password });
    evidence.run.vendor = { email, password };
    details['vendorEmail'] = email;

    await api.bindGithubInstallation(config.githubInstallationId);
    const installations = await api.listGithubInstallations();
    details['installations'] = installations;
    assert(
      installations.some((i) => i.id === config.githubInstallationId),
      `installation ${config.githubInstallationId} not bound to the canary org`,
    );

    const application = await api.createApplication({
      name: `deployz-canary-${config.runId}`,
      githubInstallationId: config.githubInstallationId,
      repoFullName: config.fixtureRepo,
      repoUrl: `https://github.com/${config.fixtureRepo}`,
      defaultBranch: 'main',
      containerPort: 3000,
      healthPath: '/health',
      databaseRequired: true,
    });
    evidence.run.applicationId = application.id;
    details['applicationId'] = application.id;
    return application.id;
  });

  await evidence.step('Application analysis reaches a deployable manifest', async (details) => {
    // The analyser is asynchronous (worker Lambda). Vendor overrides are a
    // product feature; the canary sets the three fields the readiness gate
    // hard-fails on plus the health path, exactly as the dashboard's
    // Configuration form would, then waits for the readiness report.
    await api.patchApplication(applicationId, {
      containerPort: 3000,
      healthPath: '/health',
      dockerfilePath: 'Dockerfile',
      startCommand: 'node dist/server.js',
      databaseRequired: true,
    });
    const readiness = await waitFor(
      'application readiness',
      () => api.getReadiness(applicationId),
      (r) => (r.analysisStatus === 'COMPLETE' || r.analysisStatus === 'FAILED' ? r : null),
      { timeoutMs: 10 * MINUTE, intervalMs: 15_000, describe: (r) => `${r.analysisStatus}/${r.state}` },
    );
    details['readiness'] = readiness;
    assert(readiness.analysisStatus === 'COMPLETE', `analysis ended ${readiness.analysisStatus}`);
    assert(
      readiness.state === 'READY' || readiness.state === 'ALMOST_READY',
      `readiness state ${readiness.state}: ${JSON.stringify(readiness.findings).slice(0, 800)}`,
    );
  });

  return applicationId;
}

// ── Releases ───────────────────────────────────────────────────────────────

export async function buildRelease(canary: Canary, fixtureTag: string): Promise<{ id: string; digest: string }> {
  const { config, evidence, api } = canary;
  const release = FIXTURE_RELEASES.find((r) => r.tag === fixtureTag);
  assert(release, `unknown fixture tag ${fixtureTag}`);
  const applicationId = evidence.run.applicationId;
  assert(applicationId, 'no application yet');
  const tagInfo = evidence.run.fixtureTags?.[fixtureTag];
  assert(tagInfo, `fixture tag ${fixtureTag} unresolved`);

  return evidence.step(`Build release ${fixtureTag}`, async (details) => {
    const version = releaseVersionFor(config.runId, fixtureTag);
    const created = await api.createRelease(applicationId, {
      version,
      gitSha: tagInfo.sha,
      ...(release.migrationCommand ? { migrationCommand: release.migrationCommand } : {}),
    });
    evidence.run.releases[fixtureTag] = { id: created.id, version, gitSha: tagInfo.sha };
    evidence.save();
    details['releaseId'] = created.id;
    details['version'] = version;
    details['gitSha'] = tagInfo.sha;

    const ready = await waitFor(
      `release ${version} build`,
      async () => (await api.listReleases(applicationId)).find((r) => r.id === created.id),
      (r) => (r && r.status !== 'BUILDING' ? r : null),
      { timeoutMs: 20 * MINUTE, intervalMs: 20_000, describe: (r) => r?.status ?? 'missing' },
    );
    details['buildStatus'] = ready.status;
    assert(ready.status === 'READY', `release ${version} build ${ready.status}: ${ready.failureReason ?? ''}`);

    const digest = await ecrDigestForTag(config.region, ECR_REPOSITORY, version);
    assert(digest, `ECR has no image tagged ${version}`);
    details['ecrDigest'] = digest;
    evidence.run.releases[fixtureTag]!.imageDigest = digest;
    evidence.save();
    return { id: created.id, digest };
  });
}

// ── Canary application template ────────────────────────────────────────────

export async function publishCanaryTemplate(canary: Canary, pinnedTag: string): Promise<string> {
  const { config, evidence } = canary;
  return evidence.step(`Publish canary application template pinned to ${pinnedTag}`, async (details) => {
    const release = evidence.run.releases[pinnedTag];
    assert(release?.imageDigest, `release ${pinnedTag} has no digest yet`);
    const keyPrefix = `application/canary-${config.runId}`;
    const identity = await callerIdentity();
    const repository = `${identity.account}.dkr.ecr.${config.region}.amazonaws.com/${ECR_REPOSITORY}`;
    const output = execFileSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@deployz/cdk', 'run', 'publish:application'],
      {
        cwd: resolve(process.cwd()),
        encoding: 'utf8',
        env: {
          ...process.env,
          AWS_REGION: config.region,
          APP_IMAGE_REPOSITORY: repository,
          APP_IMAGE_DIGEST: release.imageDigest,
          APPLICATION_KEY_PREFIX: keyPrefix,
        },
        shell: process.platform === 'win32',
      },
    );
    const match = /template\s+(https:\/\/\S+)/.exec(output);
    assert(match?.[1], `publish:application printed no template URL:\n${output}`);
    evidence.run.canaryTemplateUrl = match[1];
    evidence.run.canaryTemplateKeyPrefix = keyPrefix;
    evidence.save();
    details['templateUrl'] = match[1];
    details['keyPrefix'] = keyPrefix;
    details['pinnedDigest'] = release.imageDigest;
    return match[1];
  });
}

// ── Install ────────────────────────────────────────────────────────────────

export async function createDeploymentAndInstall(canary: Canary): Promise<string> {
  const { config, evidence, api } = canary;
  const applicationId = evidence.run.applicationId;
  assert(applicationId, 'no application yet');
  const templateUrl = evidence.run.canaryTemplateUrl;
  assert(templateUrl, 'no canary application template yet');

  const deploymentId = await evidence.step('Create customer deployment and launch the install', async (details) => {
    const customer = await api.createCustomer({
      name: `Canary customer ${config.runId}`,
      email: `customer-${config.runId.toLowerCase()}@deployz-canary.example.com`,
    });
    evidence.run.customerId = customer.id;
    const deployment = await api.createDeployment({ applicationId, customerId: customer.id, region: config.region });
    evidence.run.deploymentId = deployment.id;
    evidence.run.installLinkId = deployment.installLinkId;
    evidence.save();
    details['deploymentId'] = deployment.id;

    const info = await api.getInstallInfo(deployment.installLinkId);
    assert(info.quickCreateUrl, 'install link carries no Quick Create URL (bootstrap template unpublished?)');
    const quick = parseQuickCreateUrl(info.quickCreateUrl);
    details['quickCreate'] = { templateUrl: quick.templateUrl, stackName: quick.stackName, parameters: Object.keys(quick.parameters) };

    // What the browser does when the customer presses "Deploy to AWS".
    const launched = await api.markInstallLaunched(deployment.installLinkId);
    assert(launched.state === 'WAITING_FOR_RELAY', `launched -> ${launched.state}`);

    // What the customer's console does on "Create stack" — plus the canary
    // template override (the bootstrap template's ApplicationTemplateUrl
    // parameter) and the canary tags.
    const stackId = await createBootstrapStack(config.region, {
      stackName: quick.stackName,
      templateUrl: quick.templateUrl,
      parameters: { ...quick.parameters, ApplicationTemplateUrl: templateUrl },
      runId: config.runId,
    });
    evidence.run.bootstrapStackName = quick.stackName;
    evidence.save();
    details['bootstrapStackId'] = stackId;
    return deployment.id;
  });

  await evidence.step('Bootstrap stack creates and the connector enrolls', async (details) => {
    const stackName = evidence.run.bootstrapStackName!;
    const stack = await waitFor(
      `bootstrap stack ${stackName}`,
      () => describeStack(config.region, stackName),
      (s) => (s && !s.status.endsWith('IN_PROGRESS') ? s : null),
      { timeoutMs: 15 * MINUTE, describe: (s) => s?.status ?? 'absent' },
    );
    details['bootstrapStackStatus'] = stack.status;
    assert(stack.status === 'CREATE_COMPLETE', `bootstrap stack ${stack.status}: ${stack.statusReason ?? ''}`);
    const installationId = stack.outputs['InstallationId'];
    assert(installationId, 'bootstrap stack has no InstallationId output');
    evidence.run.installationId = installationId;
    evidence.run.applicationStackName = applicationStackNameForInstallation(installationId);
    evidence.run.bootstrapLambdaNames = await lambdaFunctionNames(config.region, stackName);
    evidence.save();
    details['installationId'] = installationId;
    details['applicationStackName'] = evidence.run.applicationStackName;
    details['bootstrapLambdaNames'] = evidence.run.bootstrapLambdaNames;

    const enrolled = await waitFor(
      'relay enrollment',
      () => api.getDeployment(deploymentId),
      (d) => (d.installationId ? d : null),
      { timeoutMs: 12 * MINUTE, describe: describeDeployment },
    );
    assert(enrolled.installationId === installationId, `control plane bound installation ${enrolled.installationId}`);
  });

  await evidence.step('Install reaches HEALTHY with a verified runtime', async (details) => {
    const detail = await waitFor(
      'install',
      () => api.getDeployment(deploymentId),
      (d) => (d.state === 'HEALTHY' || d.state === 'UPDATE_AVAILABLE' || d.state === 'FAILED' ? d : null),
      { timeoutMs: 45 * MINUTE, describe: describeDeployment },
    );
    details['deployment'] = summarizeDeployment(detail);
    assert(detail.state !== 'FAILED', `install FAILED: ${JSON.stringify(detail.deploymentStatus.failure)}`);
    const installJob = detail.jobs.find((j) => j.type === 'INSTALL');
    assert(installJob && (installJob.state === 'SUCCEEDED' || installJob.state === 'SUCCESS'), 'INSTALL job not settled successfully');
    recordJob(canary, installJob.id, 'INSTALL');

    const appStack = await describeStack(config.region, evidence.run.applicationStackName!);
    assert(appStack?.status === 'CREATE_COMPLETE', `application stack ${appStack?.status ?? 'absent'}`);
    details['applicationStackStatus'] = appStack.status;
    const alb = await albDnsName(config.region, evidence.run.applicationStackName!);
    assert(alb, 'application stack has no load balancer');
    evidence.run.albEndpoint = `http://${alb}`;
    evidence.save();
    details['albEndpoint'] = evidence.run.albEndpoint;
    details['apiAppUrl'] = detail.appUrl;
  });

  return deploymentId;
}

export function parseQuickCreateUrl(url: string): {
  templateUrl: string;
  stackName: string;
  parameters: Record<string, string>;
} {
  const hash = url.split('#')[1] ?? '';
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  const templateUrl = query.get('templateURL');
  const stackName = query.get('stackName');
  assert(templateUrl && stackName, `Quick Create URL lacks templateURL/stackName: ${url}`);
  const parameters: Record<string, string> = {};
  for (const [key, value] of query) {
    if (key.startsWith('param_')) parameters[key.slice('param_'.length)] = value;
  }
  return { templateUrl, stackName, parameters };
}

// ── Version assertions ─────────────────────────────────────────────────────

export interface ExpectedState {
  /** The fixture tag that must be serving (live /version) and be currentReleaseId. */
  readonly serving: string;
  readonly previous?: string | null;
  readonly deploymentState?: string[];
  readonly failureCode?: string | null;
}

/** Waits for the release pointer to name `tag`, then verifies all four layers. */
export async function waitForPointer(canary: Canary, tag: string, timeoutMs = 12 * MINUTE): Promise<DeploymentDetail> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release, `no release for ${tag}`);
  return waitFor(
    `release pointer → ${tag}`,
    () => api.getDeployment(evidence.run.deploymentId!),
    (d) => (d.currentReleaseId === release.id ? d : null),
    { timeoutMs, describe: describeDeployment },
  );
}

export async function assertServing(canary: Canary, expected: ExpectedState, details: Record<string, unknown>): Promise<DeploymentDetail> {
  const { config, evidence, api } = canary;
  const release = evidence.run.releases[expected.serving];
  assert(release?.imageDigest, `no built release for ${expected.serving}`);
  const detail = await api.getDeployment(evidence.run.deploymentId!);
  details['deployment'] = summarizeDeployment(detail);

  // Deployz layer.
  assert(detail.currentReleaseId === release.id, `currentReleaseId=${detail.currentReleaseId} (${detail.version}), expected ${expected.serving} (${release.id})`);
  if (expected.previous !== undefined) {
    const previousId = expected.previous ? evidence.run.releases[expected.previous]?.id ?? null : null;
    assert(detail.previousReleaseId === previousId, `previousReleaseId=${detail.previousReleaseId}, expected ${expected.previous} (${previousId})`);
  }
  if (expected.deploymentState) {
    assert(expected.deploymentState.includes(detail.state), `deployment state ${detail.state}, expected one of ${expected.deploymentState.join('/')}`);
  }
  if (expected.failureCode !== undefined) {
    const code = detail.deploymentStatus.failure?.code ?? null;
    assert(code === expected.failureCode, `deploymentStatus.failure.code=${code}, expected ${expected.failureCode}`);
  }
  assert(detail.deploymentStatus.stage !== 'FAILED', `stage is FAILED while ${expected.serving} should be serving`);

  // AWS layer: what ECS is actually running.
  const service = await describeRunningService(config.region, evidence.run.applicationStackName!);
  assert(service, 'no ECS service in the application stack');
  details['ecs'] = service;
  assert(service.runningDigests.length === 1, `ECS runs ${service.runningDigests.length} distinct digests: ${service.runningDigests.join(', ')}`);
  assert(
    service.runningDigests[0] === digestSuffix(release.imageDigest),
    `running digest ${service.runningDigests[0]} != release ${expected.serving} digest ${release.imageDigest}`,
  );
  const ecr = await ecrDigestForTag(config.region, ECR_REPOSITORY, release.version);
  assert(ecr === digestSuffix(release.imageDigest), `ECR digest for ${release.version} is ${ecr}, release row says ${release.imageDigest}`);
  assert(
    digestSuffix(detail.runningImageDigest) === digestSuffix(release.imageDigest),
    `control plane observed digest ${detail.runningImageDigest}, expected ${release.imageDigest}`,
  );
  const targets = await targetHealth(config.region, evidence.run.applicationStackName!);
  details['targetHealth'] = targets;
  assert(targets.length > 0 && targets.every((t) => t === 'healthy'), `ALB targets: ${targets.join(', ')}`);

  // Live layer.
  const live = await sampleLiveApp(evidence.run.albEndpoint!);
  details['live'] = { versions: live.versions, healthStatuses: live.healthStatuses };
  assert(live.versions.length === 1 && live.versions[0] === expected.serving, `live /version answered ${live.versions.join(', ')}, expected ${expected.serving}`);
  assert(live.healthStatuses.length === 1 && live.healthStatuses[0] === 200, `live /health answered ${live.healthStatuses.join(', ')}`);
  const expectedCommit = evidence.run.fixtureTags?.[expected.serving]?.contentSha;
  const probe = live.probes[0];
  if (expectedCommit && probe?.version) {
    assert(probe.version.commit === expectedCommit, `live /version.commit ${probe.version.commit} != ${expectedCommit} (content commit of ${expected.serving})`);
  }
  return detail;
}

// ── Operations ─────────────────────────────────────────────────────────────

function recordJob(canary: Canary, jobId: string, type: string, releaseTag?: string): void {
  const { evidence } = canary;
  if (!evidence.run.jobs.some((j) => j.id === jobId)) {
    evidence.run.jobs.push({ id: jobId, type, ...(releaseTag ? { releaseTag } : {}) });
  }
  evidence.save();
}

function settleJobRecord(canary: Canary, detail: DeploymentDetail, jobId: string): void {
  const job = findJob(detail, jobId);
  const record = canary.evidence.run.jobs.find((j) => j.id === jobId);
  if (job && record) {
    record.state = job.state;
    record.failureCode = job.failureCode;
    canary.evidence.save();
  }
}

export async function waitForJob(canary: Canary, jobId: string, timeoutMs: number): Promise<DeploymentDetail> {
  const { evidence, api } = canary;
  const detail = await waitFor(
    `job ${jobId.slice(0, 8)}`,
    () => api.getDeployment(evidence.run.deploymentId!),
    (d) => {
      const job = findJob(d, jobId);
      return job && isTerminalJobState(job.state) ? d : null;
    },
    { timeoutMs, describe: (d) => `${findJob(d, jobId)?.state ?? '?'} ${describeDeployment(d)}` },
  );
  settleJobRecord(canary, detail, jobId);
  return detail;
}

export function summarizeDeployment(detail: DeploymentDetail): Record<string, unknown> {
  return {
    state: detail.state,
    stage: detail.deploymentStatus.stage,
    currentActivity: detail.deploymentStatus.currentActivity,
    currentReleaseId: detail.currentReleaseId,
    previousReleaseId: detail.previousReleaseId,
    version: detail.version,
    healthStatus: detail.healthStatus,
    relayStatus: detail.relayStatus,
    runningImageDigest: detail.runningImageDigest,
    appUrl: detail.appUrl,
    failure: detail.deploymentStatus.failure,
    lastJob: detail.jobs.at(-1) ? { id: detail.jobs.at(-1)!.id, type: detail.jobs.at(-1)!.type, state: detail.jobs.at(-1)!.state } : null,
  };
}

/** Deploys `tag`, expecting success; verifies the pointer and all four layers. */
export async function deployAndVerify(canary: Canary, tag: string, expectedPrevious: string | null): Promise<void> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release?.imageDigest, `release ${tag} not built`);
  await evidence.step(`Deploy ${tag} succeeds and becomes the serving release`, async (details) => {
    const requested = await api.deploy(evidence.run.deploymentId!, release.id);
    details['request'] = requested;
    assert(requested.status === 202, `deploy ${tag} -> ${requested.status} (expected 202, a new attempt)`);
    recordJob(canary, requested.jobId, 'DEPLOY_RELEASE', tag);
    const settled = await waitForJob(canary, requested.jobId, 30 * MINUTE);
    const job = findJob(settled, requested.jobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode, payloadDigest: job.payload?.['imageDigest'], result: job.result };
    assert(job.state === 'SUCCEEDED', `deploy ${tag} job ${job.state} (${job.failureCode ?? 'no code'}): ${JSON.stringify(job.result).slice(0, 400)}`);
    assert(job.payload?.['imageDigest'] === digestSuffix(release.imageDigest), `job payload digest ${job.payload?.['imageDigest']} != release ${release.imageDigest}`);
    await waitForPointer(canary, tag);
    await assertServing(canary, { serving: tag, previous: expectedPrevious, deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
    const events = await api.events(evidence.run.deploymentId!);
    assert(events.some((e) => e.eventType === 'deploy.completed' && e.jobId === requested.jobId), 'no deploy.completed event for this job');
  });
}

/** Rolls back to `tag` through the product route; verifies the immutable digest chain. */
export async function rollbackAndVerify(canary: Canary, tag: string, expectedPrevious: string): Promise<void> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release?.imageDigest, `release ${tag} not built`);
  await evidence.step(`Rollback to ${tag} restores the original artifact`, async (details) => {
    const before = await api.getDeployment(evidence.run.deploymentId!);
    details['before'] = summarizeDeployment(before);
    const requested = await api.rollback(evidence.run.deploymentId!, release.id);
    details['request'] = requested;
    assert(requested.status === 202, `rollback -> ${requested.status} (expected 202, a new attempt)`);
    recordJob(canary, requested.jobId, 'ROLLBACK', tag);
    const settled = await waitForJob(canary, requested.jobId, 30 * MINUTE);
    const job = findJob(settled, requested.jobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode, payloadDigest: job.payload?.['imageDigest'], result: job.result };
    assert(job.state === 'SUCCEEDED', `rollback job ${job.state} (${job.failureCode ?? 'no code'}): ${JSON.stringify(job.result).slice(0, 400)}`);
    // The digest chain: original release digest == rollback payload digest == running digest (checked in assertServing).
    assert(job.payload?.['imageDigest'] === digestSuffix(release.imageDigest), `rollback payload digest ${job.payload?.['imageDigest']} != original ${release.imageDigest}`);
    await waitForPointer(canary, tag);
    await assertServing(canary, { serving: tag, previous: expectedPrevious, deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
    const events = await api.events(evidence.run.deploymentId!);
    assert(events.some((e) => e.eventType === 'rollback.requested' && e.jobId === requested.jobId), 'no rollback.requested event');
    assert(events.some((e) => e.eventType === 'rollback.completed' && e.jobId === requested.jobId), 'no rollback.completed event');
    // History, not rewriting: the earlier deploy jobs are still there.
    assert(settled.jobs.length >= before.jobs.length + 1, 'rollback did not add a deployment attempt');
  });
}

/** Deploys a release expected to FAIL; the previous release must keep serving. */
export async function deployExpectingFailure(canary: Canary, tag: string, stillServing: string, expectedPrevious: string | null): Promise<void> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release?.imageDigest, `release ${tag} not built`);
  await evidence.step(`Deploy ${tag} fails and ${stillServing} keeps serving`, async (details) => {
    const requested = await api.deploy(evidence.run.deploymentId!, release.id);
    details['request'] = requested;
    assert(requested.status === 202, `deploy ${tag} -> ${requested.status}`);
    recordJob(canary, requested.jobId, 'DEPLOY_RELEASE', tag);
    // Circuit breaker needs several task launches to fail; allow well beyond
    // the relay's runtime bound so a watchdog re-offer is observed too.
    const settled = await waitForJob(canary, requested.jobId, 50 * MINUTE);
    const job = findJob(settled, requested.jobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode, result: job.result, reconcileCount: (job as unknown as { reconcileCount?: number }).reconcileCount };
    assert(job.state === 'FAILED', `deploy ${tag} job ${job.state}, expected FAILED`);
    assert(job.failureCode === 'ECS_DEPLOYMENT_FAILED' || job.failureCode === 'IMAGE_HEALTH_CHECK_FAILED', `failureCode ${job.failureCode}`);
    // Give the heartbeat a cycle to report the restored digest, then verify.
    await sleep(30_000);
    await assertServing(
      canary,
      { serving: stillServing, previous: expectedPrevious, deploymentState: ['UPDATE_AVAILABLE', 'HEALTHY'], failureCode: job.failureCode },
      details,
    );
    const stillFailedRelease = (await api.listReleases(evidence.run.applicationId!)).find((r) => r.id === release.id);
    details['failedReleaseStatus'] = stillFailedRelease?.status;
    const events = await api.events(evidence.run.deploymentId!);
    assert(events.some((e) => e.eventType === 'deploy.failed' && e.jobId === requested.jobId), 'no deploy.failed event');
    assert(!events.some((e) => e.eventType === 'deploy.completed' && e.jobId === requested.jobId), 'a failed deploy emitted deploy.completed');
  });
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function seedMarker(canary: Canary, name: string): Promise<string> {
  const { config, evidence } = canary;
  const key = `${name}_${config.runId}`;
  await evidence.step(`Seed persistent data ${key} through the running application`, async (details) => {
    const live = await probeLiveApp(evidence.run.albEndpoint!);
    const written = await writeMarker(evidence.run.albEndpoint!, key, live.version?.version ?? 'unknown');
    details['written'] = written;
    const read = await readMarker(evidence.run.albEndpoint!, key);
    details['read'] = read;
    assert(read && read['key'] === key, `marker ${key} not readable after write`);
    evidence.run.markers.push(key);
    evidence.save();
  });
  return key;
}

export async function assertMarkers(canary: Canary, details: Record<string, unknown>): Promise<void> {
  const { evidence } = canary;
  const found: Record<string, unknown> = {};
  for (const key of evidence.run.markers) {
    const record = await readMarker(evidence.run.albEndpoint!, key);
    assert(record, `persistent marker ${key} is gone`);
    found[key] = record;
  }
  details['markers'] = found;
}

// ── Infrastructure ─────────────────────────────────────────────────────────

export interface InfraSnapshot {
  readonly stackResourceCount: number;
  readonly rdsCount: number;
  readonly albCount: number;
  readonly targetGroupCount: number;
  readonly serviceCount: number;
  readonly bucketCount: number;
  readonly securityGroupCount: number;
  readonly stackStatus: string | null;
}

export async function snapshotInfrastructure(canary: Canary): Promise<InfraSnapshot> {
  const { config, evidence } = canary;
  const stackName = evidence.run.applicationStackName!;
  const stack = await describeStack(config.region, stackName);
  const { listStackResources } = await import('./aws.js');
  const resources = await listStackResources(config.region, stackName);
  const count = (type: string) => resources.filter((r) => r.type === type).length;
  return {
    stackResourceCount: resources.length,
    rdsCount: count('AWS::RDS::DBInstance'),
    albCount: count('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    targetGroupCount: count('AWS::ElasticLoadBalancingV2::TargetGroup'),
    serviceCount: count('AWS::ECS::Service'),
    bucketCount: count('AWS::S3::Bucket'),
    securityGroupCount: count('AWS::EC2::SecurityGroup'),
    stackStatus: stack?.status ?? null,
  };
}

export function assertSameInfrastructure(before: InfraSnapshot, after: InfraSnapshot): void {
  for (const key of Object.keys(before) as (keyof InfraSnapshot)[]) {
    if (key === 'stackStatus') continue;
    assert(before[key] === after[key], `infrastructure changed: ${key} ${before[key]} → ${after[key]}`);
  }
  assert(after.stackStatus === 'CREATE_COMPLETE' || after.stackStatus === 'UPDATE_COMPLETE', `application stack now ${after.stackStatus}`);
}

// ── Idempotency helpers ────────────────────────────────────────────────────

export async function expectBusyOrReplay(
  canary: Canary,
  action: () => Promise<{ status: number; jobId: string }>,
  activeJobId: string,
  details: Record<string, unknown>,
  label: string,
): Promise<'replayed' | 'busy'> {
  try {
    const response = await action();
    details[label] = response;
    assert(response.status === 200 && response.jobId === activeJobId, `${label}: ${response.status} job ${response.jobId} — a second mutation was created`);
    return 'replayed';
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 409 && error.code === 'DEPLOYMENT_BUSY') {
      details[label] = { status: 409, code: error.code };
      return 'busy';
    }
    throw error;
  }
}

export function fixtureRelease(tag: string): FixtureRelease {
  const release = FIXTURE_RELEASES.find((r) => r.tag === tag);
  assert(release, `unknown fixture tag ${tag}`);
  return release;
}
