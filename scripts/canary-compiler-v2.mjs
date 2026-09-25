// Real-AWS lifecycle canary for dynamic-compiler-v2: deploy the compiled
// stateless topology, confirm it reaches CREATE_COMPLETE, then destroy it.
// This proves the compiler output provisions and tears down real AWS, not just
// validates syntactically.
//
// Usage: AWS_PROFILE=<profile> node scripts/canary-compiler-v2.mjs
// Requires the compiler package to be built. Deploys a short-lived stack and
// always deletes it (including on failure). Uses a public nginx image so no
// ECR/relay dependency is needed.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { compileDeployzInfrastructure } from '../packages/infrastructure-compiler/dist/index.js';
import { CAPABILITY_KEYS } from '../packages/contracts/dist/index.js';

function aws(args, { json = false } = {}) {
  const out = execFileSync('aws', args, { encoding: 'utf8' });
  return json ? JSON.parse(out) : out;
}

function statelessIr() {
  return {
    schemaVersion: 1,
    workloads: [{
      componentId: 'web', kind: 'web', label: 'Web service', buildArtifactId: 'app', command: null, port: 80,
      public: true, healthCheck: { path: '/', mode: 'explicit' }, desiredCount: 1,
      compute: { provider: 'aws', capabilityKey: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small', architecture: null },
      dependencyCapabilityKeys: [CAPABILITY_KEYS.S3],
    }],
    resources: [
      { componentId: 'storage', capabilityKey: CAPABILITY_KEYS.S3, label: 'S3 bucket', quantity: 1, configuration: {}, lifecycle: 'retain', scope: 'REGIONAL', envBindings: [] },
      { componentId: 'endpoint', capabilityKey: CAPABILITY_KEYS.ALB, label: 'Application load balancer', quantity: 1, configuration: {}, lifecycle: 'delete', scope: 'REGIONAL', envBindings: [] },
    ],
    bindings: [],
    ingress: { public: true, capabilityKey: CAPABILITY_KEYS.ALB, targetWorkloadIds: ['web'] },
    schedules: [],
    policies: { allowTopologyChanges: false, defaultRetention: 'retain' },
    metadata: { graphSchemaVersion: 1, capabilityRegistryVersion: 'phase1-2026-09-25', sizeProfileId: 'small-v1', region: 'us-east-1' },
  };
}

const REGION = 'us-east-1';
const STACK_NAME = `deployz-v2-canary-${randomBytes(4).toString('hex')}`;
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
    execFileSync('node', ['-e', 'setTimeout(()=>{},15000)']);
  }
  return describeStack();
}

async function main() {
  const { template } = compileDeployzInfrastructure({ ir: statelessIr(), region: REGION });

  console.log(`INSTALL: creating stack ${STACK_NAME} from compiled template (${JSON.stringify(template).length} bytes)`);
  try {
    aws(['cloudformation', 'create-stack',
      '--stack-name', STACK_NAME,
      '--region', REGION,
      '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM',
      '--template-body', JSON.stringify(template),
      '--parameters',
      `ParameterKey=paramImageReference,ParameterValue=${IMAGE}`,
      'ParameterKey=paramContainerPort,ParameterValue=80',
      'ParameterKey=paramHealthCheckPath,ParameterValue=/',
    ]);
  } catch (e) {
    // Already-exists or a validation error is a real failure; cleanup below.
    console.error(`INSTALL failed: ${e.stdout || e.stderr || e}`);
  }

  const created = waitFor(['CREATE_COMPLETE', 'ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'], 15 * 60 * 1000);
  const status = created?.StackStatus ?? 'UNKNOWN';
  console.log(`VERIFY: stack status = ${status}`);

  if (status === 'CREATE_COMPLETE') {
    const outputs = created.Outputs ?? [];
    const endpoint = outputs.find((o) => o.OutputKey === 'PublicEndpoint')?.OutputValue;
    console.log(`VERIFY: PublicEndpoint = ${endpoint ?? '(none)'}`);
    console.log('RESULT: INSTALL + VERIFY PASS');
  } else {
    console.error(`RESULT: INSTALL FAILED (${status})`);
  }

  // Always destroy + clean up.
  console.log('DESTROY: deleting stack');
  try {
    aws(['cloudformation', 'delete-stack', '--stack-name', STACK_NAME, '--region', REGION]);
  } catch (e) {
    console.error(`DESTROY failed: ${e.stdout || e.stderr || e}`);
  }
  const deleted = waitFor(['DELETE_COMPLETE'], 10 * 60 * 1000);
  const deleteStatus = deleted?.StackStatus ?? 'UNKNOWN';
  console.log(`DESTROY: final status = ${deleteStatus}`);

  if (status !== 'CREATE_COMPLETE' || deleteStatus !== 'DELETE_COMPLETE') {
    process.exit(1);
  }
  console.log('RESULT: DESTROY + CLEANUP PASS');
}

main().catch((e) => {
  console.error('canary crashed:', e);
  process.exit(1);
});
