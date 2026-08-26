/**
 * Audits one customer installation: does the account actually contain the
 * application the control plane claims is deployed?
 *
 * Answers the question the control plane cannot, because the control plane
 * only knows what the relay told it. Runs against any installation with
 * operator credentials — it needs no change to the customer's bootstrap
 * stack, which is why it works on installations provisioned before
 * verification shipped.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/relay dist).
 *
 * Usage:
 *   pnpm --filter @deployz/cdk audit:deployment \
 *     --installation <uuid> [--region us-east-1] [--stack-name deployz-app] \
 *     [--claimed HEALTHY] [--redis]
 *
 * Exit codes: 0 verified, 1 not verified, 2 usage error.
 */
import { parseArgs } from 'node:util';

import { DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';
import { createCloudFormationReader, verifyInstallation } from '@deployz/relay/verify';

const USAGE =
  'Usage: pnpm --filter @deployz/cdk audit:deployment --installation <uuid> ' +
  '[--region <region>] [--stack-name <name>] [--claimed <state>] [--redis]';

let values;
try {
  ({ values } = parseArgs({
    options: {
      installation: { type: 'string' },
      region: { type: 'string' },
      'stack-name': { type: 'string' },
      claimed: { type: 'string' },
      redis: { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}

if (!values.installation) {
  console.error(`--installation is required.\n${USAGE}`);
  process.exit(2);
}

const region = values.region ?? process.env.AWS_REGION ?? 'us-east-1';

const result = await verifyInstallation({
  cfn: createCloudFormationReader(region),
  installationId: values.installation,
  ...(values['stack-name'] ? { stackName: values['stack-name'] } : {}),
  redisRequired: values.redis,
});

const field = (label, value) => `${label.padEnd(14)}${value}`;
console.log('');
console.log(field('Installation', values.installation));
console.log(field('Region', region));
console.log(field('Stack', values['stack-name'] ?? DEFAULT_APPLICATION_STACK_NAME));
console.log(field('Claimed', values.claimed ?? 'not supplied'));
console.log('');

for (const check of result.checks) {
  console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(16)}${check.detail}`);
}

const failed = result.checks.filter((check) => !check.passed).length;
console.log('');

if (result.verified) {
  console.log(`VERDICT  verified — ${result.checks.length} checks passed`);
  process.exit(0);
}

// Calling out the contradiction explicitly: a control plane claiming HEALTHY
// over a failed verification is the exact bug this tooling exists to surface.
const claimsHealthy = values.claimed === 'HEALTHY' || values.claimed === 'UPDATE_AVAILABLE';
console.log(
  claimsHealthy
    ? `VERDICT  control plane claims ${values.claimed}, but ${failed} of ${result.checks.length} checks failed — ${result.reason}`
    : `VERDICT  not verified — ${result.reason}`,
);
process.exit(1);
