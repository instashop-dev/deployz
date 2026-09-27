// Real-AWS composite canary for dynamic-compiler-v2: deploy the maximum-
// complexity composition (web + postgres + redis + storage + ingress +
// secrets), verify it reaches CREATE_COMPLETE, destroy it, prove the
// stateful resources were RETAINED, purge them, and prove cleanup.
//
// Usage: AWS_PROFILE=<profile> node scripts/canary-compiler-v2-composite.mjs
// Cleanup of a leftover run (retained-data recovery + full purge, including
// the retained network island):
//   node scripts/canary-compiler-v2-composite.mjs --cleanup <stackName>
//
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

function sleep(ms) {
  execFileSync('node', ['-e', `setTimeout(()=>{},${ms})`]);
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
let STACK_NAME = `deployz-v2-composite-${randomBytes(4).toString('hex')}`;
const IMAGE = 'public.ecr.aws/nginx/nginx:1.27';

function describeStack(stackName = STACK_NAME) {
  try {
    return aws(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', REGION], { json: true }).Stacks[0];
  } catch {
    return undefined;
  }
}

function waitFor(terminalStatuses, timeoutMs, stackName = STACK_NAME, missingMeans = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stack = describeStack(stackName);
    if (stack && terminalStatuses.includes(stack.StackStatus)) return stack;
    if (stack && stack.StackStatus.includes('FAILED')) return stack;
    // A fully deleted stack deregisters; in the destroy flow that IS the
    // terminal state (its retained resources stay in the account).
    if (!stack && missingMeans) return { StackStatus: missingMeans };
    sleep(20000);
  }
  return describeStack(stackName);
}

function stackResources(stackName = STACK_NAME) {
  try {
    return aws(['cloudformation', 'list-stack-resources', '--stack-name', stackName, '--region', REGION], { json: true }).StackResourceSummaries;
  } catch {
    return [];
  }
}

// Collect the physical ids of the retained resources before destroy, so we
// can prove retention and purge them afterwards.
function retainedPhysicalIds(stackName = STACK_NAME) {
  const byLogical = new Map(stackResources(stackName).map((r) => [r.LogicalResourceId, r.PhysicalResourceId]));
  return {
    dbInstance: byLogical.get('PrimaryDbInstance') ?? null,
    dbSecret: byLogical.get('PrimaryDbMasterSecret') ?? null,
    dbUrlSecret: byLogical.get('PrimaryDbUrlSecret') ?? null,
    bucket: byLogical.get('StorageBucket') ?? null,
  };
}

// The network objects the retained database pins: even after the retain-
// recovery finishes the stack, the DB subnet group, its security group, the
// private subnet and the VPC around them survive (the relay's purge phase 2
// removes them). Discovery is by CloudFormation resource type, not by name.
function retainedNetworkIds(stackName = STACK_NAME) {
  const pick = (type) => stackResources(stackName)
    .filter((r) => r.ResourceType === type && r.PhysicalResourceId)
    .map((r) => r.PhysicalResourceId);
  return {
    dbSubnetGroups: pick('AWS::RDS::DBSubnetGroup'),
    securityGroups: pick('AWS::EC2::SecurityGroup'),
    subnets: pick('AWS::EC2::Subnet'),
    routeTables: pick('AWS::EC2::RouteTable'),
    internetGateways: pick('AWS::EC2::InternetGateway'),
    vpc: pick('AWS::EC2::VPC')[0] ?? null,
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

function dbSubnetGroupExists(name) {
  if (!name) return false;
  try {
    aws(['rds', 'describe-db-subnet-groups', '--db-subnet-group-name', name, '--region', REGION]);
    return true;
  } catch {
    return false;
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

function vpcExists(id) {
  if (!id) return false;
  try {
    aws(['ec2', 'describe-vpcs', '--vpc-ids', id, '--region', REGION], { json: true });
    return true;
  } catch {
    return false;
  }
}

function subnetExists(id) {
  if (!id) return false;
  try {
    aws(['ec2', 'describe-subnets', '--subnet-ids', id, '--region', REGION], { json: true });
    return true;
  } catch {
    return false;
  }
}

function securityGroupExists(id) {
  if (!id) return false;
  try {
    aws(['ec2', 'describe-security-groups', '--group-ids', id, '--region', REGION], { json: true });
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
    sleep(30000);
  }
  return !check();
}

// The relay's data-preserving recovery (packages/relay/src/destroy.ts): on
// DELETE_FAILED, retain exactly the resources CloudFormation itself reports
// DELETE_FAILED for — the retained database (its deletion protection fails
// the delete) and the security group / subnet its ENI pins stay in the
// account holding their data — and let the stack deletion finish. Nothing
// holding data is ever deleted here. The database fails its delete long
// after the network objects it pins, so the stack can report DELETE_FAILED
// more than once: the relay converges by re-running this recovery on every
// resumer pass; mirror it with a bounded loop.
function deleteStackWithRetainRecovery(stackName = STACK_NAME) {
  aws(['cloudformation', 'delete-stack', '--stack-name', stackName, '--region', REGION]);
  // The deletion-protected RDS instance keeps the first delete in
  // DELETE_IN_PROGRESS for 45+ minutes before CloudFormation reports
  // DELETE_FAILED (same pacing the product Disconnect shows).
  let deleted = waitFor(['DELETE_COMPLETE'], 75 * 60 * 1000, stackName, 'DELETE_COMPLETE');
  let deleteStatus = deleted?.StackStatus ?? 'UNKNOWN';
  let retainRetry = false;
  for (let pass = 0; deleteStatus === 'DELETE_FAILED' && pass < 3; pass += 1) {
    const blockers = stackResources(stackName)
      .filter((r) => r.ResourceStatus === 'DELETE_FAILED')
      .map((r) => r.LogicalResourceId);
    if (blockers.length === 0) {
      console.error('DESTROY: DELETE_FAILED with no identifiable blocker — the relay would fail here too');
      break;
    }
    console.log(`DESTROY: DELETE_FAILED (pass ${pass + 1}) — retrying with --retain-resources ${blockers.join(' ')}`);
    aws([
      'cloudformation', 'delete-stack',
      '--stack-name', stackName,
      '--region', REGION,
      '--retain-resources', ...blockers,
    ]);
    retainRetry = true;
    deleted = waitFor(['DELETE_COMPLETE'], 75 * 60 * 1000, stackName, 'DELETE_COMPLETE');
    deleteStatus = deleted?.StackStatus ?? 'UNKNOWN';
  }
  console.log(`DESTROY: final status = ${deleteStatus}`);
  return { deleteStatus, retainRetry };
}

// PURGE: delete retained resources, mirroring the relay's purge executor —
// the database, both credential secrets, the bucket, then the retained
// network island (DB subnet group, security groups, subnets, route tables,
// internet gateway, VPC). Every step tolerates an already-gone resource.
function purgeRetained(retained, network) {
  console.log('PURGE: deleting retained resources');
  if (retained.dbInstance && rdsExists(retained.dbInstance)) {
    try {
      // Deletion protection is on; disable it first (mirrors the relay's
      // purge executor), then delete without a final snapshot.
      aws(['rds', 'modify-db-instance', '--db-instance-identifier', retained.dbInstance, '--no-deletion-protection', '--apply-immediately', '--region', REGION]);
      console.log('PURGE: RDS deletion protection disabled');
      for (let i = 0; i < 20; i++) {
        const inst = rdsInfo(retained.dbInstance);
        if (!inst || inst.DeletionProtection === false) break;
        sleep(30000);
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
  if (retained.bucket && bucketExists(retained.bucket)) {
    try {
      aws(['s3', 'rb', `s3://${retained.bucket}`, '--force']);
      console.log('PURGE: bucket delete requested');
    } catch (e) {
      console.error(`PURGE: bucket delete failed: ${e.stdout || e.stderr || e}`);
    }
  }
  for (const group of network.dbSubnetGroups) {
    if (!dbSubnetGroupExists(group)) continue;
    try {
      aws(['rds', 'delete-db-subnet-group', '--db-subnet-group-name', group, '--region', REGION]);
      console.log(`PURGE: DB subnet group ${group} delete requested`);
    } catch (e) {
      console.error(`PURGE: DB subnet group delete failed: ${e.stdout || e.stderr || e}`);
    }
  }
  // The security groups can only go once the database ENI is gone, so the
  // caller re-runs this function while the RDS delete is still in flight.
  for (const sg of network.securityGroups) {
    if (!securityGroupExists(sg)) continue;
    try {
      aws(['ec2', 'delete-security-group', '--group-id', sg, '--region', REGION]);
      console.log(`PURGE: security group ${sg} delete requested`);
    } catch (e) {
      console.error(`PURGE: security group delete failed: ${e.stdout || e.stderr || e}`);
    }
  }
  for (const subnet of network.subnets) {
    if (!subnetExists(subnet)) continue;
    try {
      aws(['ec2', 'delete-subnet', '--subnet-id', subnet, '--region', REGION]);
      console.log(`PURGE: subnet ${subnet} delete requested`);
    } catch (e) {
      console.error(`PURGE: subnet delete failed: ${e.stdout || e.stderr || e}`);
    }
  }
  for (const routeTable of network.routeTables) {
    try {
      aws(['ec2', 'delete-route-table', '--route-table-id', routeTable, '--region', REGION]);
      console.log(`PURGE: route table ${routeTable} delete requested`);
    } catch {
      // The main route table cannot be deleted directly; it dies with the VPC.
    }
  }
  for (const igw of network.internetGateways) {
    try {
      if (network.vpc) {
        aws(['ec2', 'detach-internet-gateway', '--internet-gateway-id', igw, '--vpc-id', network.vpc, '--region', REGION]);
      }
      aws(['ec2', 'delete-internet-gateway', '--internet-gateway-id', igw, '--region', REGION]);
      console.log(`PURGE: internet gateway ${igw} delete requested`);
    } catch (e) {
      console.error(`PURGE: internet gateway delete failed: ${e.stdout || e.stderr || e}`);
    }
  }
  if (network.vpc && vpcExists(network.vpc)) {
    try {
      aws(['ec2', 'delete-vpc', '--vpc-id', network.vpc, '--region', REGION]);
      console.log(`PURGE: vpc ${network.vpc} delete requested`);
    } catch (e) {
      console.error(`PURGE: vpc delete failed (retried while the ENI lingers): ${e.stdout || e.stderr || e}`);
    }
  }
}

function networkPresent(network) {
  return (
    network.securityGroups.some((sg) => securityGroupExists(sg)) ||
    network.subnets.some((sn) => subnetExists(sn)) ||
    vpcExists(network.vpc)
  );
}

// Prove the purge actually removed everything (bounded — RDS deletion is
// the slow one; its ENI keeps the security group alive until it drains, so
// the network purge re-runs while the island persists).
function verifyPurged(retained, network) {
  const dbGone = waitForGone(() => rdsExists(retained.dbInstance), 30 * 60 * 1000);
  const secretGone = waitForGone(() => secretExists(retained.dbSecret), 10 * 60 * 1000);
  const urlSecretGone = waitForGone(() => secretExists(retained.dbUrlSecret), 10 * 60 * 1000);
  const bucketGone = waitForGone(() => bucketExists(retained.bucket), 10 * 60 * 1000);
  let networkGone = !networkPresent(network);
  const start = Date.now();
  while (!networkGone && Date.now() - start < 30 * 60 * 1000) {
    purgeRetained(retained, network);
    networkGone = waitForGone(() => networkPresent(network), 5 * 60 * 1000);
  }
  console.log(`PURGE CHECK: dbGone=${dbGone} masterSecretGone=${secretGone} urlSecretGone=${urlSecretGone} bucketGone=${bucketGone} networkGone=${networkGone}`);
  return { dbGone, secretGone, urlSecretGone, bucketGone, networkGone };
}

// Recover a leftover stack (the --cleanup mode): finish the delete via the
// retain-recovery, then purge the retained set and prove the account is
// clean again.
function cleanupMode(stackName) {
  STACK_NAME = stackName;
  const stack = describeStack(stackName);
  if (!stack) {
    console.log(`CLEANUP: stack ${stackName} no longer exists — nothing to do`);
    process.exit(0);
  }
  console.log(`CLEANUP: ${stackName} is ${stack.StackStatus}`);
  // Capture the retained set BEFORE the delete-recovery: once the stack is
  // fully deleted its resource list deregisters and the ids are lost.
  const retained = retainedPhysicalIds(stackName);
  const network = retainedNetworkIds(stackName);
  console.log('CLEANUP: retained set:', JSON.stringify({ retained, network }));
  if (!['DELETE_IN_PROGRESS', 'DELETE_FAILED'].includes(stack.StackStatus)) {
    aws(['cloudformation', 'delete-stack', '--stack-name', stackName, '--region', REGION]);
  }
  const { deleteStatus } = deleteStackWithRetainRecovery(stackName);
  if (deleteStatus !== 'DELETE_COMPLETE') {
    console.error(`RESULT: CLEANUP INCOMPLETE (destroy=${deleteStatus}) — retained resources were NOT purged`);
    process.exit(1);
  }
  const checks = verifyPurged(retained, network);
  const ok = checks.dbGone && checks.secretGone && checks.urlSecretGone && checks.bucketGone && checks.networkGone;
  console.log(`RESULT: ${ok ? 'CLEANUP PASS' : 'CLEANUP INCOMPLETE'} for ${stackName}`);
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv[2] === '--cleanup') {
    if (!process.argv[3]) {
      console.error('Usage: node scripts/canary-compiler-v2-composite.mjs --cleanup <stackName>');
      process.exit(2);
    }
    cleanupMode(process.argv[3]);
    return;
  }

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
  const network = retainedNetworkIds();

  console.log('DESTROY: deleting stack (stateful resources should be RETAINED)');
  const { deleteStatus, retainRetry } = deleteStackWithRetainRecovery();

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

  purgeRetained(retained, network);
  const checks = verifyPurged(retained, network);

  // Summarize. PASS requires the full story: create succeeded, the delete
  // reached DELETE_COMPLETE VIA the retain-retry (the raw delete alone is
  // exactly the bug this canary exists to catch), every retained resource
  // was present with its data between DESTROY and PURGE, and the purge
  // removed them all, including the retained network island.
  const ok =
    status === 'CREATE_COMPLETE' &&
    retainRetry &&
    deleteStatus === 'DELETE_COMPLETE' &&
    dbRetained && dbDeletionProtected && secretRetained && urlSecretRetained && bucketRetained &&
    checks.dbGone && checks.secretGone && checks.urlSecretGone && checks.bucketGone && checks.networkGone;
  console.log(
    `RESULT: ${ok ? 'COMPOSITE CANARY PASS' : 'COMPOSITE CANARY INCOMPLETE'} ` +
      `(create=${status}, destroy=${deleteStatus} via retain-retry=${retainRetry}, ` +
      `retained db=${dbRetained}/deletionProtected=${dbDeletionProtected}/masterSecret=${secretRetained}/urlSecret=${urlSecretRetained}/bucket=${bucketRetained}, ` +
      `purged dbGone=${checks.dbGone}/masterSecretGone=${checks.secretGone}/urlSecretGone=${checks.urlSecretGone}/bucketGone=${checks.bucketGone}/networkGone=${checks.networkGone})`,
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
    // nothing left to clean
  }
  process.exit(1);
});
