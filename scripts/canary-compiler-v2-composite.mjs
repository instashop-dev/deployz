// Real-AWS composite canary for dynamic-compiler-v2: deploy the maximum-
// complexity composition (web + postgres + redis + storage + ingress +
// secrets), verify it reaches CREATE_COMPLETE, destroy it, prove the
// stateful resources were RETAINED, purge them, and prove cleanup.
//
// Usage: AWS_PROFILE=<profile> node scripts/canary-compiler-v2-composite.mjs
// Requires the compiler package to be built. Uses a public nginx image so no
// ECR/relay dependency is needed. Always cleans up (best effort), including
// on failure.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { compileDeployzInfrastructure } from '../packages/infrastructure-compiler/dist/index.js';
import { CAPABILITY_KEYS } from '../packages/contracts/dist/index.js';

function aws(args, { json = false } = {}) {
  const out = execFileSync('aws', args, { encoding: 'utf8' });
  return json ? JSON.parse(out) : out;
}

function compositeIr() {
  const resources = [
    {
      componentId: 'primary-db', capabilityKey: CAPABILITY_KEYS.RDS_POSTGRES, label: 'PostgreSQL database',
      quantity: 1, configuration: {}, lifecycle: 'retain', scope: 'REGIONAL', envBindings: [],
    },
    {
      componentId: 'cache', capabilityKey: CAPABILITY_KEYS.ELASTICACHE_VALKEY, label: 'Valkey cache',
      quantity: 1, configuration: {}, lifecycle: 'delete', scope: 'REGIONAL', envBindings: [],
    },
    {
      componentId: 'storage', capabilityKey: CAPABILITY_KEYS.S3, label: 'S3 bucket',
      quantity: 1, configuration: {}, lifecycle: 'retain', scope: 'REGIONAL', envBindings: [],
    },
    {
      componentId: 'endpoint', capabilityKey: CAPABILITY_KEYS.ALB, label: 'Application load balancer',
      quantity: 1, configuration: {}, lifecycle: 'delete', scope: 'REGIONAL', envBindings: [],
    },
  ];
  return {
    schemaVersion: 1,
    workloads: [{
      componentId: 'web', kind: 'web', label: 'Web service', buildArtifactId: 'app', command: null, port: 80,
      public: true, healthCheck: { path: '/', mode: 'explicit' }, desiredCount: 1,
      compute: { provider: 'aws', capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small', architecture: null },
      dependencyCapabilityKeys: [CAPABILITY_KEYS.RDS_POSTGRES, CAPABILITY_KEYS.ELASTICACHE_VALKEY, CAPABILITY_KEYS.S3],
    }],
    resources,
    bindings: [],
    ingress: { public: true, capabilityKey: CAPABILITY_KEYS.ALB, targetWorkloadIds: ['web'] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: { graphSchemaVersion: 1, capabilityRegistryVersion: 'phase1-2026-09-25', sizeProfileId: 'small-v1', region: 'us-east-1' },
  };
}

const REGION = 'us-east-1';
const STACK_NAME = `deployz-v2-composite-${randomBytes(4).toString('hex')}`;
const IMAGE = 'public.ecr.aws/nginx/nginx:1.27';

function describeStack() {
  try {
    return aws(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME, '--region', REGION], { json: true }).Stacks[0];
  } catch {
    return undefined;
  }
}

function waitFor(terminalStatuses, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stack = describeStack();
    if (stack && terminalStatuses.includes(stack.StackStatus)) return stack;
    if (stack && stack.StackStatus.includes('FAILED')) return stack;
    execFileSync('node', ['-e', 'setTimeout(()=>{},20000)']);
  }
  return describeStack();
}

// Collect the physical ids of the retained resources before destroy, so we
// can prove retention and purge them afterwards.
function retainedPhysicalIds() {
  const resources = aws(['cloudformation', 'list-stack-resources', '--stack-name', STACK_NAME, '--region', REGION], { json: true }).StackResourceSummaries;
  const byLogical = new Map(resources.map((r) => [r.LogicalResourceId, r.PhysicalResourceId]));
  return {
    dbInstance: byLogical.get('PrimaryDbInstance') ?? null,
    dbSecret: byLogical.get('PrimaryDbMasterSecret') ?? null,
    dbUrlSecret: byLogical.get('PrimaryDbUrlSecret') ?? null,
    bucket: byLogical.get('StorageBucket') ?? null,
  };
}

function rdsExists(id) {
  if (!id) return false;
  try {
    aws(['rds', 'describe-db-instances', '--db-instance-identifier', id, '--region', REGION]);
    return true;
  } catch {
    return false;
  }
}

function rdsInfo(id) {
  if (!id) return null;
  try {
    return aws(['rds', 'describe-db-instances', '--db-instance-identifier', id, '--region', REGION], { json: true }).DBInstances[0];
  } catch {
    return null;
  }
}

function secretExists(id) {
  if (!id) return false;
  try {
    aws(['secretsmanager', 'describe-secret', '--secret-id', id, '--region', REGION]);
    return true;
  } catch {
    return false;
  }
}

function bucketExists(name) {
  if (!name) return false;
  try {
    aws(['s3api', 'head-bucket', '--bucket', name]);
    return true;
  } catch {
    return false;
  }
}

/** Polls `check()` until it returns false (the resource is gone) or the
 *  timeout expires. Returns whether the resource is gone. RDS deletion is
 *  async, so a purge that only REQUESTED the delete is not done yet. */
function waitForGone(check, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!check()) return true;
    execFileSync('node', ['-e', 'setTimeout(()=>{},30000)']);
  }
  return !check();
}

async function main() {
  const { template } = compileDeployzInfrastructure({ ir: compositeIr(), region: REGION });
  const body = JSON.stringify(template);
  console.log(`INSTALL: creating stack ${STACK_NAME} (template ${body.length} bytes, ${template.Resources ? Object.keys(template.Resources).length : '?'} resources)`);

  try {
    aws(['cloudformation', 'create-stack',
      '--stack-name', STACK_NAME,
      '--region', REGION,
      '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM',
      '--template-body', body,
      '--parameters',
      `ParameterKey=paramImageReference,ParameterValue=${IMAGE}`,
      'ParameterKey=paramContainerPort,ParameterValue=80',
      'ParameterKey=paramHealthCheckPath,ParameterValue=/',
    ]);
  } catch (e) {
    console.error(`INSTALL failed: ${e.stdout || e.stderr || e}`);
  }

  const created = waitFor(['CREATE_COMPLETE', 'ROLLBACK_COMPLETE'], 40 * 60 * 1000);
  const status = created?.StackStatus ?? 'UNKNOWN';
  console.log(`VERIFY: stack status = ${status}`);
  if (status === 'CREATE_COMPLETE') {
    for (const o of created.Outputs ?? []) {
      console.log(`VERIFY: ${o.OutputKey} = ${o.OutputValue}`);
    }
  } else {
    console.error(`RESULT: INSTALL FAILED (${status})`);
    // Still attempt cleanup of whatever was created.
  }

  const retained = retainedPhysicalIds();
  console.log('RETAINED (physical ids):', JSON.stringify(retained));

  console.log('DESTROY: deleting stack (stateful resources should be RETAINED)');
  aws(['cloudformation', 'delete-stack', '--stack-name', STACK_NAME, '--region', REGION]);
  let deleted = waitFor(['DELETE_COMPLETE'], 30 * 60 * 1000);
  let deleteStatus = deleted?.StackStatus ?? 'UNKNOWN';
  // The relay's data-preserving recovery (packages/relay/src/destroy.ts):
  // on DELETE_FAILED, retain exactly the resources CloudFormation itself
  // reports DELETE_FAILED for — the retained database (its deletion
  // protection fails the delete) and the security group / subnet its ENI
  // pins stay in the account holding their data — and let the stack
  // deletion finish. Nothing holding data is ever deleted here.
  let retainRetry = false;
  if (deleteStatus === 'DELETE_FAILED') {
    const blockers = aws(
      ['cloudformation', 'list-stack-resources', '--stack-name', STACK_NAME, '--region', REGION],
      { json: true },
    ).StackResourceSummaries.filter((r) => r.ResourceStatus === 'DELETE_FAILED').map((r) => r.LogicalResourceId);
    if (blockers.length === 0) {
      console.error('DESTROY: DELETE_FAILED with no identifiable blocker — the relay would fail here too');
    } else {
      console.log(`DESTROY: DELETE_FAILED — retrying with --retain-resources ${blockers.join(' ')}`);
      aws([
        'cloudformation', 'delete-stack',
        '--stack-name', STACK_NAME,
        '--region', REGION,
        '--retain-resources', ...blockers,
      ]);
      retainRetry = true;
      deleted = waitFor(['DELETE_COMPLETE'], 30 * 60 * 1000);
      deleteStatus = deleted?.StackStatus ?? 'UNKNOWN';
    }
  }
  console.log(`DESTROY: final status = ${deleteStatus}`);

  // Prove retention: the RDS instance survived WITH its deletion protection,
  // both credential secrets and the bucket are still there.
  const dbInfo = rdsInfo(retained.dbInstance);
  const dbRetained = dbInfo !== null;
  const dbDeletionProtected = dbInfo?.DeletionProtection === true;
  const secretRetained = secretExists(retained.dbSecret);
  const urlSecretRetained = secretExists(retained.dbUrlSecret);
  const bucketRetained = bucketExists(retained.bucket);
  console.log(`RETENTION CHECK: db=${dbRetained} deletionProtected=${dbDeletionProtected} masterSecret=${secretRetained} urlSecret=${urlSecretRetained} bucket=${bucketRetained}`);

  // The purge is destructive by design — it must never run against a stack
  // whose delete did not complete (the same failed-purge invariant the
  // control plane holds: a failed destroy never reaches into the account).
  if (deleteStatus !== 'DELETE_COMPLETE') {
    console.error(`RESULT: COMPOSITE CANARY INCOMPLETE (destroy=${deleteStatus}) — skipping purge of a not-deleted stack`);
    process.exit(1);
  }

  // PURGE: delete retained resources, mirroring the relay's purge executor.
  console.log('PURGE: deleting retained resources');
  if (retained.dbInstance && dbRetained) {
    try {
      // Deletion protection is on; disable it first (mirrors the relay's
      // purge executor), then delete without a final snapshot.
      aws(['rds', 'modify-db-instance', '--db-instance-identifier', retained.dbInstance, '--no-deletion-protection', '--apply-immediately', '--region', REGION]);
      console.log('PURGE: RDS deletion protection disabled');
      for (let i = 0; i < 20; i++) {
        const inst = aws(['rds', 'describe-db-instances', '--db-instance-identifier', retained.dbInstance, '--region', REGION], { json: true }).DBInstances[0];
        if (!inst || inst.DeletionProtection === false) break;
        execFileSync('node', ['-e', 'setTimeout(()=>{},30000)']);
      }
      aws(['rds', 'delete-db-instance', '--db-instance-identifier', retained.dbInstance, '--skip-final-snapshot', '--region', REGION]);
      console.log('PURGE: RDS delete requested');
    } catch (e) {
      console.error(`PURGE: RDS delete failed: ${e.stdout || e.stderr || e}`);
    }
  }
  for (const [name, id] of [['master-secret', retained.dbSecret], ['url-secret', retained.dbUrlSecret]]) {
    if (id && secretExists(id)) {
      try {
        aws(['secretsmanager', 'delete-secret', '--secret-id', id, '--force-delete-without-recovery', '--region', REGION]);
        console.log(`PURGE: ${name} delete requested`);
      } catch (e) {
        console.error(`PURGE: ${name} delete failed: ${e.stdout || e.stderr || e}`);
      }
    }
  }
  if (retained.bucket && bucketRetained) {
    try {
      aws(['s3', 'rb', `s3://${retained.bucket}`, '--force']);
      console.log('PURGE: bucket delete requested');
    } catch (e) {
      console.error(`PURGE: bucket delete failed: ${e.stdout || e.stderr || e}`);
    }
  }

  // Prove the purge actually removed everything (bounded — RDS deletion is
  // the slow one; the force-deleted secrets and the emptied bucket clear
  // within the same window).
  const dbGone = waitForGone(() => rdsExists(retained.dbInstance), 30 * 60 * 1000);
  const secretGone = waitForGone(() => secretExists(retained.dbSecret), 10 * 60 * 1000);
  const urlSecretGone = waitForGone(() => secretExists(retained.dbUrlSecret), 10 * 60 * 1000);
  const bucketGone = waitForGone(() => bucketExists(retained.bucket), 10 * 60 * 1000);
  console.log(`PURGE CHECK: dbGone=${dbGone} masterSecretGone=${secretGone} urlSecretGone=${urlSecretGone} bucketGone=${bucketGone}`);

  // Summarize. PASS requires the full story: create succeeded, the delete
  // reached DELETE_COMPLETE VIA the retain-retry (the raw delete alone is
  // exactly the bug this canary exists to catch), every retained resource
  // was present with its data between DESTROY and PURGE, and the purge
  // removed them all.
  const ok =
    status === 'CREATE_COMPLETE' &&
    retainRetry &&
    deleteStatus === 'DELETE_COMPLETE' &&
    dbRetained && dbDeletionProtected && secretRetained && urlSecretRetained && bucketRetained &&
    dbGone && secretGone && urlSecretGone && bucketGone;
  console.log(
    `RESULT: ${ok ? 'COMPOSITE CANARY PASS' : 'COMPOSITE CANARY INCOMPLETE'} ` +
      `(create=${status}, destroy=${deleteStatus} via retain-retry=${retainRetry}, ` +
      `retained db=${dbRetained}/deletionProtected=${dbDeletionProtected}/masterSecret=${secretRetained}/urlSecret=${urlSecretRetained}/bucket=${bucketRetained}, ` +
      `purged dbGone=${dbGone}/masterSecretGone=${secretGone}/urlSecretGone=${urlSecretGone}/bucketGone=${bucketGone})`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('canary crashed:', e);
  // Best-effort cleanup of the stack if it still exists.
  try {
    if (describeStack()) {
      aws(['cloudformation', 'delete-stack', '--stack-name', STACK_NAME, '--region', REGION]);
      console.log('CLEANUP: stack delete requested after crash');
    }
  } catch {
    /* ignore */
  }
  process.exit(1);
});
