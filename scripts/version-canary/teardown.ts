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
  deleteEcrTags,
  deleteLogGroupIfExists,
  deleteS3Prefix,
  deleteSsmParameterIfExists,
  deleteStack,
  deleteTaskDefinitions,
  describeStack,
  disableRulesForStack,
  type LeakAudit,
} from './aws.js';
import { describeDeployment, findJob, waitFor } from './control-plane.js';
import type { Canary } from './steps.js';
import { ECR_REPOSITORY } from './steps.js';

const MINUTE = 60_000;

export async function destroyThroughProduct(canary: Canary): Promise<void> {
  const { evidence, api } = canary;
  const deploymentId = evidence.run.deploymentId;
  if (!deploymentId) return;

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
      { timeoutMs: 80 * MINUTE, describe: describeDeployment },
    );
    const destroyJob = [...settled.jobs].reverse().find((j) => j.type === 'DESTROY');
    details['destroyJob'] = destroyJob ? { id: destroyJob.id, state: destroyJob.state, failureCode: destroyJob.failureCode, result: destroyJob.result } : null;
    details['cleanupState'] = settled.cleanupState;
    if (settled.state !== 'DELETED') {
      throw new Error(`destroy ended in ${settled.state}: ${JSON.stringify(destroyJob?.result).slice(0, 400)}`);
    }
  });

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
      { timeoutMs: 30 * MINUTE, describe: describeDeployment },
    );
    const purgeJob = [...settled.jobs].reverse().find((j) => j.type === 'PURGE');
    details['purgeJob'] = purgeJob ? { id: purgeJob.id, state: purgeJob.state, failureCode: purgeJob.failureCode, result: purgeJob.result } : null;
    details['cleanupState'] = settled.cleanupState;
    if (settled.cleanupState !== 'COMPLETE') {
      throw new Error(`purge left cleanupState ${settled.cleanupState}: ${JSON.stringify(purgeJob?.result).slice(0, 400)}`);
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
    const tags = Object.values(run.releases).map((r) => r.version);
    details['ecrTagsDeleted'] = await deleteEcrTags(config.region, ECR_REPOSITORY, tags);
    const shaTags = [...new Set(Object.values(run.releases).map((r) => r.gitSha))];
    // The build also tags the image with the git SHA (traceability). Those
    // tags are shared across runs of the same fixture commit — delete only
    // when the digest is one of this run's.
    const runDigests = new Set(Object.values(run.releases).flatMap((r) => (r.imageDigest ? [r.imageDigest] : [])));
    const { ecrDigestForTag } = await import('./aws.js');
    const shaTagsToDelete: string[] = [];
    for (const tag of shaTags) {
      const digest = await ecrDigestForTag(config.region, ECR_REPOSITORY, tag);
      if (digest && runDigests.has(digest)) shaTagsToDelete.push(tag);
    }
    details['shaTagsDeleted'] = await deleteEcrTags(config.region, ECR_REPOSITORY, shaTagsToDelete);

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
      ecrTags: Object.values(run.releases).map((r) => r.version),
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
      ...audit.installationTagged.filter(
        (arn) => !arn.includes(':cluster/') && !arn.includes(':task-definition/') && !arn.includes(':service/'),
      ),
    ];
    details['disposableLeft'] = disposable;
    if (disposable.length > 0) {
      throw new Error(`${disposable.length} resource(s) left after teardown:\n${disposable.join('\n')}`);
    }
    return audit;
  });
}
