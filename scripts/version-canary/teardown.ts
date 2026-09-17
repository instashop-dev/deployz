/**
 * Teardown and leak audit — the product's own Disconnect + Purge first
 * (that is what a customer gets), then the canary-only leftovers a
 * customer would remove by hand (the bootstrap stack, its Lambda log
 * groups, the run's ECR tags, task definitions, the canary template
 * objects), then an independent look at the account.
 *
 * Every deletion is keyed on an identifier this run recorded at creation
 * time in run.json. There is no name-pattern or account-wide path.
 */
import {
  auditLeaks,
  bucketExists,
  describeRunningService,
  describeStack,
  disableRulesForStack,
  installationBuckets,
  installationDbInstance,
  installationSecretsByTag,
  invokeRelay,
  deleteEcrTags,
  deleteLogGroupIfExists,
  deleteS3Prefix,
  deleteSsmParameterIfExists,
  deleteStack,
  deleteTaskDefinitions,
  liveInstallationCache,
  liveStackElbResources,
  type InstallationSecret,
  type LeakAudit,
} from './aws.js';
import { describeDeployment, findJob, waitFor } from './control-plane.js';
import type { Canary } from './steps.js';
import { ECR_REPOSITORY } from './steps.js';

const MINUTE = 60_000;

/**
 * True for a live, tagged secret that is one of the retained database
 * credentials — identified by its CloudFormation logical id, never by a
 * stack-name prefix: the physical name is `<logicalId>-<random>` with no
 * stack name in it (BUG-002). AppConfigSecret is delete-by-design, so it is
 * not a retained-credential kind.
 */
export function isRetainedDatabaseSecret(secret: InstallationSecret): boolean {
  return !secret.deletedDate && /^Database(Secret|UrlSecret)/.test(secret.tags['aws:cloudformation:logical-id'] ?? '');
}

/**
 * True for a tagged secret that belongs to the connector (bootstrap stack)
 * rather than to the retained set — Purge never touches it, so it must be
 * excluded from the post-purge check by where it comes from, not by name.
 */
export function isConnectorSecret(secret: InstallationSecret, bootstrapStackName: string | null | undefined): boolean {
  return (
    (!!bootstrapStackName && secret.tags['aws:cloudformation:stack-name'] === bootstrapStackName) ||
    secret.tags['deployz:component'] === 'bootstrap'
  );
}


/**
 * Nudges the relay between polls while a teardown is in flight.
 *
 * Disconnect and Purge are executed inside the customer account by a relay
 * that runs on a 5-minute EventBridge schedule, and Purge sweeps one orphan
 * kind per poll — so most of a teardown's wall clock is waiting for the next
 * tick, not for AWS. An extra out-of-schedule tick costs nothing and changes
 * nothing about what runs: it is the same handler the schedule invokes.
 *
 * The invocation is synchronous (`RequestResponse`), so these nudges cannot
 * overlap each other. Only teardown is nudged — the deploy and rollback
 * ladder stays driven by the real schedule, so the canary keeps proving that
 * a scheduled poll delivers release work.
 *
 * Returns undefined when the run recorded no relay function, which is the
 * case for a run that never got that far.
 */
export function relayFunctionName(bootstrapLambdaNames: readonly string[] = []): string | undefined {
  return bootstrapLambdaNames.find((n) => n.includes('RelayFunction'));
}

function relayNudge(canary: Canary): (() => Promise<void>) | undefined {
  const name = relayFunctionName(canary.evidence.run.bootstrapLambdaNames ?? []);
  if (!name) return undefined;
  return async () => {
    try {
      await invokeRelay(canary.config.region, name);
    } catch {
      // The connector may already be gone, or the function mid-delete. The
      // schedule is still the mechanism of record; a failed nudge is not a
      // teardown failure.
    }
  };
}

export async function destroyThroughProduct(canary: Canary): Promise<void> {
  const { evidence, api } = canary;
  const deploymentId = evidence.run.deploymentId;
  if (!deploymentId) return;

  const nudge = relayNudge(canary);
  await evidence.step('Disconnect (DESTROY) through the product', async (details) => {
    const current = await api.getDeployment(deploymentId);
    if (current.state === 'DELETED') {
      details['skipped'] = 'already DELETED';
      return;
    }
    if (current.state !== 'DELETING') {
      const response = await api.destroy(deploymentId);
      details['request'] = response;
    }
    const settled = await waitFor(
      'destroy',
      () => api.getDeployment(deploymentId),
      (d) => (d.state === 'DELETED' || d.state === 'FAILED' ? d : null),
      // A Disconnect that retains RDS goes DELETE_FAILED twice (the retained
      // instance's ENI blocks the subnet, then the security group) before the
      // relay's retain-resources retries finish it — observed at 45+ minutes.
      { timeoutMs: 80 * MINUTE, describe: describeDeployment, ...(nudge ? { onTick: nudge } : {}) },
    );
    const destroyJob = [...settled.jobs].reverse().find((j) => j.type === 'DESTROY');
    details['destroyJob'] = destroyJob ? { id: destroyJob.id, state: destroyJob.state, failureCode: destroyJob.failureCode, result: destroyJob.result } : null;
    details['cleanupState'] = settled.cleanupState;
    if (settled.state !== 'DELETED') {
      throw new Error(`destroy ended in ${settled.state}: ${JSON.stringify(destroyJob?.result).slice(0, 400)}`);
    }
  });

  await verifyRetainedState(canary, deploymentId);

  await evidence.step('Purge retained resources through the product', async (details) => {
    const current = await api.getDeployment(deploymentId);
    if (current.cleanupState === 'COMPLETE') {
      details['skipped'] = 'cleanupState already COMPLETE';
      return;
    }
    const response = await api.purge(deploymentId);
    details['request'] = response;
    const body = response.body as { jobId?: string } | null;
    const settled = await waitFor(
      'purge',
      () => api.getDeployment(deploymentId),
      (d) => {
        const job = body?.jobId ? findJob(d, body.jobId) : [...d.jobs].reverse().find((j) => j.type === 'PURGE');
        return job && (job.state === 'SUCCEEDED' || job.state === 'FAILED') ? d : null;
      },
      // A default-HTTPS install's purge sweeps one orphan kind per 5-minute
      // relay poll after the retained database is gone — observed at ~95
      // minutes end to end. Giving up earlier leaves the relay mid-sweep.
      { timeoutMs: 120 * MINUTE, describe: describeDeployment, ...(nudge ? { onTick: nudge } : {}) },
    );
    const purgeJob = [...settled.jobs].reverse().find((j) => j.type === 'PURGE');
    details['purgeJob'] = purgeJob ? { id: purgeJob.id, state: purgeJob.state, failureCode: purgeJob.failureCode, result: purgeJob.result } : null;
    details['cleanupState'] = settled.cleanupState;
    if (settled.cleanupState !== 'COMPLETE') {
      throw new Error(`purge left cleanupState ${settled.cleanupState}: ${JSON.stringify(purgeJob?.result).slice(0, 400)}`);
    }
  });

  await verifyPurgedRetainedState(canary, deploymentId);
}

/**
 * What a finished Disconnect must have left in the customer account, checked
 * between Disconnect and Purge — while the retained set still exists to
 * check. AWS is read directly (the canary's own view), and the control
 * plane's inventory endpoint must agree.
 *
 * The expected component kinds come from the endpoint's own manifest
 * comparison, so no profile is hardcoded here: a check runs only when the
 * deployment's manifest required that component.
 */
async function verifyRetainedState(canary: Canary, deploymentId: string): Promise<void> {
  const { config, evidence, api } = canary;
  await evidence.step('Verify retained state between Disconnect and Purge', async (details) => {
    const current = await api.getDeployment(deploymentId);
    if (current.cleanupState === 'COMPLETE') {
      details['skipped'] = 'cleanupState already COMPLETE — the retained set was purged in an earlier run';
      return;
    }
    const run = evidence.run;
    if (!run.installationId || !run.applicationStackName) {
      details['skipped'] = 'no installation recorded — nothing retained to verify';
      return;
    }
    const installationId = run.installationId;
    const applicationStackName = run.applicationStackName;

    const inventory = await api.infrastructure(deploymentId);
    details['expectations'] = inventory.expectations;
    const expectations = inventory.expectations;
    if (!expectations) {
      throw new Error('the infrastructure endpoint reports no expectations for this deployment (no stored manifest?)');
    }
    const expects = (kind: string) => expectations.components.find((c) => c.kind === kind)?.expected === true;
    details['expectedKinds'] = expectations.components.filter((c) => c.expected).map((c) => c.kind);

    // The application stack is gone.
    const appStack = await describeStack(config.region, applicationStackName);
    details['applicationStack'] = appStack?.status ?? 'absent from CloudFormation';
    if (appStack && appStack.status !== 'DELETE_COMPLETE') {
      throw new Error(`application stack ${applicationStackName} is ${appStack.status} after Disconnect — expected DELETE_COMPLETE`);
    }

    // The database stayed: present, available, deletion-protected.
    if (expects('database')) {
      const db = await installationDbInstance(config.region, installationId);
      details['rds'] = db;
      if (!db) throw new Error(`no RDS instance tagged deployz:installation=${installationId} — the retained database is gone`);
      if (db.status !== 'available') throw new Error(`retained RDS instance ${db.identifier} is ${db.status}, expected available`);
      if (!db.deletionProtection) throw new Error(`retained RDS instance ${db.identifier} has no deletion protection`);
    }

    // The storage bucket stayed.
    if (expects('storage')) {
      const buckets = await installationBuckets(config.region, installationId);
      details['buckets'] = buckets;
      if (buckets.length === 0) throw new Error(`no S3 bucket tagged deployz:installation=${installationId} — the retained storage is gone`);
      for (const bucket of buckets) {
        if (!(await bucketExists(bucket))) throw new Error(`retained bucket ${bucket} does not answer head-bucket`);
      }
    }

    // The retained database credentials stayed: installation-tagged secrets
    // whose CloudFormation logical id names them (the physical names are
    // generated and carry no stack name). AppConfigSecret is delete-by-design
    // — it dies with the stack — so it is not required here. Nothing found
    // may sit in the deletion recovery window.
    if (expects('database')) {
      const secrets = await installationSecretsByTag(config.region, installationId);
      details['secrets'] = secrets.map((s) => ({
        name: s.name,
        logicalId: s.tags['aws:cloudformation:logical-id'] ?? null,
        deletedDate: s.deletedDate,
      }));
      const retained = secrets.filter(isRetainedDatabaseSecret);
      if (retained.length === 0) {
        throw new Error(
          `no live secret tagged deployz:installation=${installationId} with a DatabaseSecret/DatabaseUrlSecret logical id survived Disconnect — ` +
            `the retained database credentials are gone; tag-based discovery found: ${JSON.stringify(details['secrets'])}`,
        );
      }
      const scheduled = secrets.filter((s) => s.deletedDate);
      if (scheduled.length > 0) {
        throw new Error(
          `secret(s) tagged deployz:installation=${installationId} are scheduled for deletion — Disconnect must retain them: ` +
            scheduled.map((s) => `${s.name} at ${s.deletedDate}`).join(', '),
        );
      }
    }

    // The cache is gone (the tag index lags deletion; the cache service does not).
    if (expects('cache')) {
      const cache = await liveInstallationCache(config.region, installationId);
      details['liveCache'] = cache;
      if (cache.length > 0) throw new Error(`ElastiCache still live for this installation: ${cache.join(', ')}`);
    }

    // The ECS service and the ALB / target group are gone. The stack's own
    // resource list still names them after DeleteStack, so ask the services
    // whether those physical ids still exist.
    if (appStack) {
      let servicePresent: boolean;
      try {
        servicePresent = (await describeRunningService(config.region, applicationStackName)) !== null;
      } catch (error) {
        if (!/ClusterNotFound|ServiceNotFound/.test(String(error))) throw error;
        servicePresent = false;
      }
      details['ecsService'] = servicePresent ? 'still present' : 'gone';
      if (servicePresent) throw new Error(`the ECS service from ${applicationStackName} is still present after Disconnect`);

      const liveElb = await liveStackElbResources(config.region, applicationStackName);
      details['liveElb'] = liveElb;
      if (liveElb.length > 0) throw new Error(`load balancer / target group from ${applicationStackName} still present: ${liveElb.join(', ')}`);
    } else {
      details['ecsService'] = 'stack absent from CloudFormation — not checkable';
      details['liveElb'] = 'stack absent from CloudFormation — not checkable';
    }

    // The connector (bootstrap) stack is the customer's to delete, after Purge.
    if (!run.bootstrapStackName) throw new Error('no bootstrap stack recorded — cannot verify the connector is still in place');
    const bootstrapStack = await describeStack(config.region, run.bootstrapStackName);
    details['bootstrapStack'] = bootstrapStack?.status ?? 'absent';
    if (!bootstrapStack || bootstrapStack.status.startsWith('DELETE')) {
      throw new Error(`bootstrap (connector) stack ${run.bootstrapStackName} is ${bootstrapStack?.status ?? 'gone'} — only the customer removes it, after Purge`);
    }

    // The control plane's own inventory agrees: nothing missing, nothing
    // unexpected, retain-lifecycle components still retained and
    // delete-lifecycle components removed.
    const problems: string[] = [];
    if (expectations.missing.length > 0) problems.push(`missing components: ${expectations.missing.join(', ')}`);
    if (expectations.unexpected.length > 0) problems.push(`unexpected components: ${expectations.unexpected.join(', ')}`);
    for (const expected of expectations.components.filter((c) => c.expected)) {
      const component = inventory.components.find((c) => c.kind === expected.kind);
      if (!component) {
        problems.push(`expected component ${expected.kind} has no inventory rows`);
      } else if (component.lifecycle === 'retain') {
        if (component.status !== 'retained') problems.push(`${expected.kind} is ${component.status}, expected retained`);
      } else if (component.lifecycle === 'delete') {
        if (component.status !== 'removed') problems.push(`${expected.kind} is ${component.status}, expected removed`);
      } else {
        problems.push(`${expected.kind} has lifecycle ${component.lifecycle} — no rule to verify it`);
      }
    }
    details['componentStatus'] = inventory.components.map((c) => `${c.kind}:${c.status}(${c.lifecycle})`);
    if (problems.length > 0) {
      throw new Error(`infrastructure endpoint disagrees with the Disconnect outcome:\n- ${problems.join('\n- ')}`);
    }
  });
}

/**
 * What a finished Purge must have left: nothing of the retained set. Runs
 * before the canary-only leftovers are removed, so the connector's own
 * secrets (deleted with the bootstrap stack later) are excluded here — the
 * leak audit stays the final net over the account.
 */
async function verifyPurgedRetainedState(canary: Canary, deploymentId: string): Promise<void> {
  const { config, evidence, api } = canary;
  await evidence.step('Verify the retained set is gone after Purge', async (details) => {
    const run = evidence.run;
    if (!run.installationId || !run.applicationStackName) {
      details['skipped'] = 'no installation recorded — nothing retained to verify';
      return;
    }
    const current = await api.getDeployment(deploymentId);
    details['deployment'] = { state: current.state, cleanupState: current.cleanupState };
    if (current.state !== 'DELETED' || current.cleanupState !== 'COMPLETE') {
      throw new Error(`deployment is ${current.state}/${current.cleanupState} after Purge — expected DELETED/COMPLETE`);
    }

    const db = await installationDbInstance(config.region, run.installationId);
    details['rds'] = db;
    if (db) throw new Error(`RDS instance ${db.identifier} survived the Purge (${db.status})`);

    const taggedBuckets = await installationBuckets(config.region, run.installationId);
    const headBucket: Record<string, boolean> = {};
    for (const bucket of taggedBuckets) headBucket[bucket] = await bucketExists(bucket);
    details['buckets'] = { tagged: taggedBuckets, headBucket };
    const liveBuckets = Object.entries(headBucket).filter(([, exists]) => exists).map(([name]) => name);
    if (liveBuckets.length > 0) throw new Error(`bucket(s) survived the Purge: ${liveBuckets.join(', ')}`);

    // The Purge force-deletes without recovery, so nothing tagged for this
    // installation may remain — not even in the recovery window. The
    // connector's own credential secret is the exception: the Purge never
    // touches it (the customer deletes the bootstrap stack later), so it is
    // excluded by its bootstrap stack, not by a name prefix.
    const secrets = (await installationSecretsByTag(config.region, run.installationId)).filter(
      (s) => !isConnectorSecret(s, run.bootstrapStackName),
    );
    details['secretsLeft'] = secrets.map((s) => ({
      name: s.name,
      logicalId: s.tags['aws:cloudformation:logical-id'] ?? null,
      deletedDate: s.deletedDate,
    }));
    if (secrets.length > 0) {
      throw new Error(
        `secret(s) tagged deployz:installation=${run.installationId} survived the Purge — force-delete leaves nothing behind: ` +
          secrets.map((s) => `${s.name}${s.deletedDate ? ` (planned deletion ${s.deletedDate})` : ''}`).join(', '),
      );
    }

    const inventory = await api.infrastructure(deploymentId);
    details['expectations'] = inventory.expectations;
    if (!inventory.expectations) {
      throw new Error('the infrastructure endpoint reports no expectations for this deployment (no stored manifest?)');
    }
    if (inventory.expectations.missing.length > 0 || inventory.expectations.unexpected.length > 0) {
      throw new Error(
        `infrastructure endpoint still reports missing=[${inventory.expectations.missing.join(', ')}] unexpected=[${inventory.expectations.unexpected.join(', ')}] after Purge`,
      );
    }
  });
}

/** The canary-only leftovers, by recorded id. Safe to rerun. */
export async function removeCanaryLeftovers(canary: Canary): Promise<void> {
  const { config, evidence } = canary;
  const run = evidence.run;

  await evidence.step('Remove the connector (bootstrap) stack and its log groups', async (details) => {
    if (!run.bootstrapStackName) {
      details['skipped'] = 'no bootstrap stack recorded';
      return;
    }
    const appStack = run.applicationStackName ? await describeStack(config.region, run.applicationStackName) : null;
    details['applicationStackStatus'] = appStack?.status ?? 'absent';
    if (appStack && appStack.status !== 'DELETE_COMPLETE') {
      // The application stack's DeleteStack reuses the execution role that
      // lives in the bootstrap stack; deleting the bootstrap first would
      // strand it. Refuse rather than orphan.
      throw new Error(`application stack ${run.applicationStackName} is still ${appStack.status}; not deleting the bootstrap stack`);
    }
    const stack = await describeStack(config.region, run.bootstrapStackName);
    if (stack && stack.status !== 'DELETE_COMPLETE') {
      if (run.deploymentId && run.installationId) {
        // The purge runs inside the connector's relay: deleting the connector
        // before the product reports cleanupState COMPLETE — including while
        // a PURGE job is still active, or while cleanupState is
        // SKIPPED_RELAY_OFFLINE/PURGE_FAILED (those need an operator, not a
        // rerun) — strands the sweep half-way and leaks whatever it had not
        // reached yet (observed: a VPC and its NAT gateway). Keyed on the
        // deploymentId/installationId and the product's own state, never on
        // `run.vendor` — a Stage B ledger never sets it, and this guard must
        // hold there too. Skipped entirely when no installationId was ever
        // recorded (DEPLOY-023 early-failure path): no application stack was
        // ever created, so there is nothing retained to purge, and such a
        // deployment can only be force-completed to SKIPPED_RELAY_OFFLINE.
        const current = await canary.api.getDeployment(run.deploymentId);
        const purge = [...current.jobs].reverse().find((j) => j.type === 'PURGE');
        details['cleanupState'] = current.cleanupState;
        details['purgeState'] = purge?.state ?? null;
        if (current.cleanupState !== 'COMPLETE') {
          details['refused'] = `cleanupState is ${current.cleanupState}, expected COMPLETE`;
          throw new Error(`cleanupState is ${current.cleanupState} (expected COMPLETE); not deleting the connector stack (rerun cleanup once Purge completes)`);
        }
        if (purge && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(purge.state)) {
          details['refused'] = `purge job ${purge.id} is still ${purge.state}`;
          throw new Error(`purge job ${purge.id} is still ${purge.state}; not deleting the connector stack (rerun cleanup once it settles)`);
        }
      } else if (run.deploymentId) {
        details['skipped'] = 'no installationId recorded — no application stack was ever created, nothing retained to purge';
      }
      details['rulesDisabled'] = await disableRulesForStack(config.region, run.bootstrapStackName);
      await deleteStack(config.region, run.bootstrapStackName);
      const gone = await waitFor(
        `bootstrap stack ${run.bootstrapStackName} deletion`,
        () => describeStack(config.region, run.bootstrapStackName!),
        (s) => (s === null || s.status === 'DELETE_COMPLETE' || s.status === 'DELETE_FAILED' ? (s ?? { status: 'DELETE_COMPLETE' }) : null),
        { timeoutMs: 15 * MINUTE, describe: (s) => s?.status ?? 'absent' },
      );
      details['bootstrapStackFinal'] = gone.status;
      if (gone.status === 'DELETE_FAILED') throw new Error(`bootstrap stack DELETE_FAILED: ${(gone as { statusReason?: string | null }).statusReason ?? ''}`);
    } else {
      details['bootstrapStack'] = 'already gone';
    }
    const deleted: string[] = [];
    for (const name of run.bootstrapLambdaNames ?? []) {
      if (await deleteLogGroupIfExists(config.region, `/aws/lambda/${name}`)) deleted.push(`/aws/lambda/${name}`);
    }
    details['logGroupsDeleted'] = deleted;
    if (run.installationId) {
      details['ssmDeleted'] = await deleteSsmParameterIfExists(config.region, `/deployz/${run.installationId}/pending-command`);
    }
  });

  await evidence.step('Remove run-scoped images, task definitions and template objects', async (details) => {
    const tags = Object.values(run.releases).map((r) => r.imageTag ?? r.version);
    details['ecrTagsDeleted'] = await deleteEcrTags(config.controlPlaneRegion, ECR_REPOSITORY, tags);
    const shaTags = [...new Set(Object.values(run.releases).map((r) => r.gitSha))];
    // The build also tags the image with the git SHA (traceability). Those
    // tags are shared across runs of the same fixture commit — delete only
    // when the digest is one of this run's.
    const runDigests = new Set(Object.values(run.releases).flatMap((r) => (r.imageDigest ? [r.imageDigest] : [])));
    const { ecrDigestForTag } = await import('./aws.js');
    const shaTagsToDelete: string[] = [];
    for (const tag of shaTags) {
      const digest = await ecrDigestForTag(config.controlPlaneRegion, ECR_REPOSITORY, tag);
      if (digest && runDigests.has(digest)) shaTagsToDelete.push(tag);
    }
    details['shaTagsDeleted'] = await deleteEcrTags(config.controlPlaneRegion, ECR_REPOSITORY, shaTagsToDelete);

    if (run.installationId) {
      const { resourcesTagged } = await import('./aws.js');
      const taskDefinitions = (await resourcesTagged(config.region, 'deployz:installation', run.installationId)).filter((arn) =>
        arn.includes(':task-definition/'),
      );
      await deleteTaskDefinitions(config.region, taskDefinitions);
      details['taskDefinitionsDeleted'] = taskDefinitions;
    }

    if (run.templateBucket && run.canaryTemplateKeyPrefix) {
      details['templateObjectsDeleted'] = await deleteS3Prefix(run.templateBucket, `${run.canaryTemplateKeyPrefix}/`);
    }
  });
}

/** Independent look at the account. Fails the step when anything disposable is left. */
export async function leakAudit(canary: Canary): Promise<LeakAudit> {
  const { config, evidence } = canary;
  const run = evidence.run;
  return evidence.step('AWS leak audit', async (details) => {
    const audit = await auditLeaks(config.region, {
      installationId: run.installationId ?? null,
      runId: run.runId,
      bootstrapStackName: run.bootstrapStackName ?? null,
      applicationStackName: run.applicationStackName ?? null,
      bootstrapLambdaNames: run.bootstrapLambdaNames ?? [],
      deploymentId: run.deploymentId ?? null,
      ecrRepository: ECR_REPOSITORY,
      ecrTags: Object.values(run.releases).map((r) => r.imageTag ?? r.version),
      ecrRegion: config.controlPlaneRegion,
    });
    details['audit'] = audit;
    // INACTIVE ECS clusters/task definitions linger in the tagging API after
    // deletion and cost nothing (documented in aws-full-product-canary.md).
    const disposable = [
      ...audit.stacks.map((s) => `stack ${s.name} ${s.status}`),
      ...audit.rdsInstances.map((r) => `rds ${r}`),
      ...audit.loadBalancers.map((l) => `alb ${l}`),
      ...audit.buckets.map((b) => `bucket ${b}`),
      ...audit.secrets.map((s) => `secret ${s}`),
      ...audit.logGroups.map((l) => `log-group ${l}`),
      ...audit.ssmParameters.map((p) => `ssm ${p}`),
      ...audit.certificates.map((c) => `acm ${c}`),
      ...audit.ecrTags.map((t) => `ecr ${t}`),
      // A NAT gateway lingers in the tagging index after deletion too, but it
      // is the one costly resource here, so it is checked against EC2 rather
      // than excluded outright.
      ...audit.natGateways.map((n) => `nat ${n}`),
      ...audit.installationTagged.filter(
        (arn) =>
          !arn.includes(':cluster/') &&
          !arn.includes(':task-definition/') &&
          !arn.includes(':service/') &&
          !arn.includes(':natgateway/'),
      ),
    ];
    details['disposableLeft'] = disposable;
    if (disposable.length > 0) {
      throw new Error(`${disposable.length} resource(s) left after teardown:\n${disposable.join('\n')}`);
    }
    return audit;
  });
}
