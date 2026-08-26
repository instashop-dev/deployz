# Deployment Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently confirm that a Deployz installation actually exists in the customer's AWS account, so an install can no longer report success — and bill — against an empty account.

**Architecture:** One verifier (`verifyInstallation`) lives in `packages/relay/src/verify.ts`, pure over an injected `CloudFormationReader`. Two callers use it: an operator CLI in `packages/cdk/scripts/` that runs today against any existing installation, and the relay itself, which gates its `INSTALL` result on it. Verification is CloudFormation-centric — `DescribeStacks` plus `DescribeStackResources` — and fails closed on every error.

**Tech Stack:** TypeScript (NodeNext in `packages/relay` and `packages/cdk`), Vitest, AWS SDK v3, AWS CDK v2.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-26-deployment-verification-design.md`. Read it before starting.
- **Fail closed.** Any error — `AccessDenied`, `ValidationError`, stack not found, throttling, a malformed response — produces `verified: false`. Never a pass, and no exception escapes the verifier.
- `packages/relay` and `packages/cdk` are **NodeNext**: every relative import must carry an explicit `.js` extension.
- Tests are colocated as `src/*.test.ts` in `packages/relay`, and live in `test/` in `packages/cdk`. Follow the package you are editing.
- Do **not** add a new value to `FAILURE_CODES` (`packages/analysis/src/failure-codes.ts`). It is mirrored by a Postgres enum with a parity test. Use the existing `STACK_CREATE_FAILED`.
- Do **not** modify `apps/api`. The existing `body.success === false → FAILED` path at `apps/api/src/server.ts:2486` already does the right thing.
- Run the full suite with `pnpm vitest run` from the repo root. Note that a green local run under-reports — CI runs more.
- **Test commands in this plan use `--project <name>` for readability.** Vitest derives project names from each package's `package.json` `name` field, so the actual selector is likely `@deployz/relay`, not `relay`. If `--project` matches nothing, run the file directly instead — `pnpm vitest run packages/relay/src/verify.test.ts` — which always works. Confirm the real project names once with `pnpm vitest --list-projects` (or just use file paths throughout).
- **When a step says to append a test that needs a new import, merge the import into the existing import block at the top of the file.** The plan shows imports next to the tests that use them for readability; ESLint enforces imports-first, so a mid-file `import` will fail `pnpm lint`.
- Commit after every task.

---

### Task 1: Name the application stack

There is no application stack name anywhere in the codebase. `DEFAULT_BOOTSTRAP_STACK_NAME` exists, but the application stack name is only ever an injected config field on the test harness (`packages/cdk/src/integration/runner.ts:75`). The verifier cannot look up a stack whose name is undefined, and whoever implements `INSTALL` must pick the same name.

**Files:**
- Modify: `packages/contracts/src/index.ts:424`
- Test: `packages/contracts/src/index.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_APPLICATION_STACK_NAME: 'deployz-app'` exported from `@deployz/contracts`.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/index.test.ts` (create the file with the import line if it does not exist):

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_APPLICATION_STACK_NAME, DEFAULT_BOOTSTRAP_STACK_NAME } from './index.js';

describe('stack name constants', () => {
  it('names the application stack', () => {
    expect(DEFAULT_APPLICATION_STACK_NAME).toBe('deployz-app');
  });

  it('does not collide with the bootstrap stack name', () => {
    expect(DEFAULT_APPLICATION_STACK_NAME).not.toBe(DEFAULT_BOOTSTRAP_STACK_NAME);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project contracts -t "names the application stack"`
Expected: FAIL — `DEFAULT_APPLICATION_STACK_NAME` is not exported.

- [ ] **Step 3: Add the constant**

In `packages/contracts/src/index.ts`, directly beneath the existing line 424:

```ts
export const DEFAULT_BOOTSTRAP_STACK_NAME = 'deployz-bootstrap';

/**
 * CloudFormation stack name for a customer's application stack.
 *
 * Pinned here rather than at a call site because two independent components
 * must agree on it: whatever creates the stack, and the verifier that looks it
 * up afterwards. A disagreement between them reads exactly like a failed
 * install. Matches the ECS `serviceName` in
 * `packages/cdk/src/application/application-stack.ts:512`.
 */
export const DEFAULT_APPLICATION_STACK_NAME = 'deployz-app';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project contracts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): name the application stack"
```

---

### Task 2: The verifier core

Pure logic over an injected reader. No AWS SDK dependency yet — that arrives in Task 3 — so this task is fast and runs with no credentials.

**Files:**
- Create: `packages/relay/src/verify.ts`
- Create: `packages/relay/src/verify.test.ts`
- Modify: `packages/relay/package.json`

**Interfaces:**
- Consumes: `DEFAULT_APPLICATION_STACK_NAME` from `@deployz/contracts` (Task 1).
- Produces: `verifyInstallation(options: VerifyOptions): Promise<VerificationResult>`, plus the exported types `StackSummary`, `StackResource`, `StackLookup`, `CloudFormationReader`, `VerifyOptions`, `VerificationCheck`, `VerificationResult`.

- [ ] **Step 1: Add the workspace dependency**

In `packages/relay/package.json`, add to `dependencies` (keep the list alphabetical) and add the subpath export:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./auth": {
      "types": "./dist/auth.d.ts",
      "import": "./dist/auth.js"
    },
    "./verify": {
      "types": "./dist/verify.d.ts",
      "import": "./dist/verify.js"
    }
  },
  "dependencies": {
    "@aws-sdk/client-acm": "^3.1115.0",
    "@aws-sdk/client-elastic-load-balancing-v2": "^3.1115.0",
    "@aws-sdk/client-secrets-manager": "^3.1115.0",
    "@deployz/contracts": "workspace:*"
  },
```

Then run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Create `packages/relay/src/verify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  verifyInstallation,
  type CloudFormationReader,
  type StackResource,
  type StackLookup,
} from './verify.js';

const INSTALLATION = 'c2dca2bb-a733-470d-8ef0-8e96bc889442';

const COMPLETE_RESOURCES: StackResource[] = [
  { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
  { logicalId: 'Db', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
  { logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
];

function reader(lookup: StackLookup, resources: StackResource[] = []): CloudFormationReader {
  return {
    describeStack: async () => lookup,
    describeStackResources: async () => resources,
  };
}

function completeStack(tagValue: string = INSTALLATION, status = 'CREATE_COMPLETE'): StackLookup {
  return {
    found: true,
    stack: { stackName: 'deployz-app', status, tags: { 'deployz:installation': tagValue } },
  };
}

describe('verifyInstallation', () => {
  it('fails when the stack does not exist', async () => {
    const result = await verifyInstallation({
      cfn: reader({ found: false }),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('deployz-app');
    expect(result.checks[0]).toMatchObject({ name: 'stack-exists', passed: false });
  });

  it('names the AWS error code when the lookup was refused', async () => {
    const result = await verifyInstallation({
      cfn: reader({ found: false, errorCode: 'AccessDenied' }),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('AccessDenied');
  });

  it('fails when the stack rolled back', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack(INSTALLATION, 'ROLLBACK_COMPLETE'), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ROLLBACK_COMPLETE');
  });

  it('fails when the stack belongs to another installation', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack('some-other-installation'), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'stack-tagged')?.passed).toBe(false);
  });

  it('fails when the compute resource is absent', async () => {
    const withoutService = COMPLETE_RESOURCES.filter((r) => r.type !== 'AWS::ECS::Service');
    const result = await verifyInstallation({
      cfn: reader(completeStack(), withoutService),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ECS service');
  });

  it('fails when a resource exists but did not finish creating', async () => {
    const inProgress = COMPLETE_RESOURCES.map((r) =>
      r.type === 'AWS::RDS::DBInstance' ? { ...r, status: 'CREATE_IN_PROGRESS' } : r,
    );
    const result = await verifyInstallation({
      cfn: reader(completeStack(), inProgress),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('database');
  });

  it('passes on a complete stack', async () => {
    const result = await verifyInstallation({
      cfn: reader(completeStack(), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('requires a cache only when redis is required', async () => {
    const withoutCache = {
      cfn: reader(completeStack(), COMPLETE_RESOURCES),
      installationId: INSTALLATION,
    };

    expect((await verifyInstallation({ ...withoutCache, redisRequired: false })).verified).toBe(true);
    expect((await verifyInstallation({ ...withoutCache, redisRequired: true })).verified).toBe(false);
  });

  it('passes with a cache when redis is required', async () => {
    const withCache: StackResource[] = [
      ...COMPLETE_RESOURCES,
      { logicalId: 'Cache', type: 'AWS::ElastiCache::CacheCluster', status: 'CREATE_COMPLETE' },
    ];
    const result = await verifyInstallation({
      cfn: reader(completeStack(), withCache),
      installationId: INSTALLATION,
      redisRequired: true,
    });

    expect(result.verified).toBe(true);
  });

  it('honours an explicit stack name', async () => {
    const result = await verifyInstallation({
      cfn: reader({ found: false }),
      installationId: INSTALLATION,
      stackName: 'custom-stack',
    });

    expect(result.reason).toContain('custom-stack');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run --project relay verify`
Expected: FAIL — cannot resolve `./verify.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/relay/src/verify.ts`:

```ts
/**
 * Installation verification — does the customer's account actually contain
 * the application the control plane believes is deployed?
 *
 * This exists because a relay command reporting `success: true` is, on its
 * own, worth nothing: it is a claim made by the same process that was
 * supposed to do the work. Verification is a second, independent question
 * asked of CloudFormation directly.
 *
 * Two API calls answer it — the stack's existence and status, and its
 * resource inventory. That is deliberately narrower than sweeping the
 * account: the relay's IAM is scoped by the `deployz:installation` tag, and
 * most account-wide list calls cannot carry that condition.
 *
 * EVERY failure mode resolves to `verified: false`. A verifier that treated
 * an unreadable answer as a good one would reproduce the bug it exists to
 * catch.
 */

import { DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';

// ── Observed shapes ─────────────────────────────────────────────────────────

export interface StackSummary {
  readonly stackName: string;
  readonly status: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface StackResource {
  readonly logicalId: string;
  readonly type: string;
  readonly status: string;
}

/**
 * A failed lookup carries the AWS error code when there was one. "The stack
 * is missing" and "I am not allowed to look" are both `found: false` — the
 * fail-closed rule makes them equivalent for the verdict — but an operator
 * acts differently on each, so the reason preserves which it was.
 */
export type StackLookup =
  | { readonly found: true; readonly stack: StackSummary }
  | { readonly found: false; readonly errorCode?: string };

/** The injectable seam. Implementations must never throw. */
export interface CloudFormationReader {
  describeStack(stackName: string): Promise<StackLookup>;
  describeStackResources(stackName: string): Promise<StackResource[]>;
}

// ── Verification ────────────────────────────────────────────────────────────

export interface VerifyOptions {
  readonly cfn: CloudFormationReader;
  readonly installationId: string;
  /** Defaults to `DEFAULT_APPLICATION_STACK_NAME`. */
  readonly stackName?: string;
  /** Expect an ElastiCache cluster. Defaults to false. */
  readonly redisRequired?: boolean;
}

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
  /** Present when `verified` is false — the first failing check's detail. */
  readonly reason?: string;
}

const INSTALLATION_TAG = 'deployz:installation';

/** Stack and resource statuses that mean "this finished, and it worked". */
const COMPLETE_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

const REQUIRED_RESOURCES = [
  { name: 'compute', type: 'AWS::ECS::Service', label: 'ECS service' },
  { name: 'ingress', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', label: 'load balancer' },
  { name: 'database', type: 'AWS::RDS::DBInstance', label: 'database' },
  { name: 'storage', type: 'AWS::S3::Bucket', label: 'storage bucket' },
] as const;

const CACHE_RESOURCE = {
  name: 'cache',
  type: 'AWS::ElastiCache::CacheCluster',
  label: 'cache',
} as const;

export async function verifyInstallation(options: VerifyOptions): Promise<VerificationResult> {
  const stackName = options.stackName ?? DEFAULT_APPLICATION_STACK_NAME;
  const checks: VerificationCheck[] = [];

  // 1. The stack exists.
  const lookup = await options.cfn.describeStack(stackName);
  if (!lookup.found) {
    const because = lookup.errorCode ? ` (${lookup.errorCode})` : '';
    checks.push({
      name: 'stack-exists',
      passed: false,
      detail: `No CloudFormation stack named "${stackName}" in this account and region${because}`,
    });
    return conclude(checks);
  }
  checks.push({
    name: 'stack-exists',
    passed: true,
    detail: `Stack "${stackName}" found`,
  });

  // 2. It finished successfully. A rolled-back stack still exists.
  const { stack } = lookup;
  if (!COMPLETE_STATUSES.has(stack.status)) {
    checks.push({
      name: 'stack-complete',
      passed: false,
      detail: `Stack status ${stack.status} is not a successful terminal state`,
    });
    return conclude(checks);
  }
  checks.push({ name: 'stack-complete', passed: true, detail: `Stack status ${stack.status}` });

  // 3. It is THIS installation's stack — a same-named stack in the account
  //    must not pass for another installation's.
  const tag = stack.tags[INSTALLATION_TAG];
  if (tag !== options.installationId) {
    checks.push({
      name: 'stack-tagged',
      passed: false,
      detail: `Stack ${INSTALLATION_TAG} is ${tag ?? 'unset'}, expected ${options.installationId}`,
    });
    return conclude(checks);
  }
  checks.push({
    name: 'stack-tagged',
    passed: true,
    detail: `Stack carries ${INSTALLATION_TAG}=${options.installationId}`,
  });

  // 4. It contains the application, not just an empty shell.
  const resources = await options.cfn.describeStackResources(stackName);
  const expected = options.redisRequired
    ? [...REQUIRED_RESOURCES, CACHE_RESOURCE]
    : [...REQUIRED_RESOURCES];

  for (const want of expected) {
    const present = resources.some(
      (resource) => resource.type === want.type && COMPLETE_STATUSES.has(resource.status),
    );
    checks.push({
      name: want.name,
      passed: present,
      detail: present
        ? `Found a complete ${want.label}`
        : `No complete ${want.label} (${want.type}) in the stack`,
    });
  }

  return conclude(checks);
}

function conclude(checks: VerificationCheck[]): VerificationResult {
  const firstFailure = checks.find((check) => !check.passed);
  return firstFailure
    ? { verified: false, checks, reason: firstFailure.detail }
    : { verified: true, checks };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project relay verify`
Expected: PASS — 10 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/verify.ts packages/relay/src/verify.test.ts packages/relay/package.json pnpm-lock.yaml
git commit -m "feat(relay): verify an installation against CloudFormation"
```

---

### Task 3: The real CloudFormation reader

The single place errors are mapped. Everything above it is pure.

**Files:**
- Modify: `packages/relay/src/verify.ts`
- Modify: `packages/relay/src/verify.test.ts`
- Modify: `packages/relay/package.json`

**Interfaces:**
- Consumes: `CloudFormationReader` (Task 2).
- Produces: `createCloudFormationReader(region?: string): CloudFormationReader`, and `toReader(client)` for tests.

- [ ] **Step 1: Add the SDK dependency**

In `packages/relay/package.json`, add `"@aws-sdk/client-cloudformation": "^3.1115.0"` as the first entry of `dependencies`, then run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Append to `packages/relay/src/verify.test.ts`:

```ts
import { toReader } from './verify.js';

describe('toReader', () => {
  it('maps a described stack into a lookup', async () => {
    const client = {
      send: async () => ({
        Stacks: [
          {
            StackName: 'deployz-app',
            StackStatus: 'CREATE_COMPLETE',
            Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }],
          },
        ],
      }),
    };

    const lookup = await toReader(client).describeStack('deployz-app');

    expect(lookup).toEqual({
      found: true,
      stack: {
        stackName: 'deployz-app',
        status: 'CREATE_COMPLETE',
        tags: { 'deployz:installation': INSTALLATION },
      },
    });
  });

  it('reports a refused lookup as not found, with the error code', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    };

    expect(await toReader(client).describeStack('deployz-app')).toEqual({
      found: false,
      errorCode: 'AccessDeniedException',
    });
  });

  it('reports an empty Stacks array as not found', async () => {
    const client = { send: async () => ({ Stacks: [] }) };
    expect(await toReader(client).describeStack('deployz-app')).toEqual({ found: false });
  });

  it('returns no resources when the describe call throws', async () => {
    const client = {
      send: async () => {
        throw new Error('throttled');
      },
    };
    expect(await toReader(client).describeStackResources('deployz-app')).toEqual([]);
  });

  it('drops resources missing any required field', async () => {
    const client = {
      send: async () => ({
        StackResources: [
          { LogicalResourceId: 'A', ResourceType: 'AWS::ECS::Service', ResourceStatus: 'CREATE_COMPLETE' },
          { LogicalResourceId: 'B', ResourceType: 'AWS::S3::Bucket' },
        ],
      }),
    };

    expect(await toReader(client).describeStackResources('deployz-app')).toEqual([
      { logicalId: 'A', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run --project relay verify -t "toReader"`
Expected: FAIL — `toReader` is not exported.

- [ ] **Step 4: Write the implementation**

Append to `packages/relay/src/verify.ts`:

```ts
// ── Real reader ─────────────────────────────────────────────────────────────

import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

/** The one method of the SDK client this module uses. */
interface SendsCommands {
  send(command: unknown): Promise<unknown>;
}

/**
 * Wrap a CloudFormation client as a reader.
 *
 * Every throw becomes `found: false` or an empty resource list — that is the
 * fail-closed rule, implemented once here so the pure logic above never has
 * to handle an exception. Split out from `createCloudFormationReader` so it
 * can be tested against a fake client with no SDK construction.
 */
export function toReader(client: SendsCommands): CloudFormationReader {
  return {
    async describeStack(stackName: string): Promise<StackLookup> {
      try {
        const response = (await client.send(
          new DescribeStacksCommand({ StackName: stackName }),
        )) as { Stacks?: { StackName?: string; StackStatus?: string; Tags?: { Key?: string; Value?: string }[] }[] };

        const stack = response.Stacks?.[0];
        if (!stack?.StackName || !stack.StackStatus) return { found: false };

        const tags: Record<string, string> = {};
        for (const tag of stack.Tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) tags[tag.Key] = tag.Value;
        }

        return {
          found: true,
          stack: { stackName: stack.StackName, status: stack.StackStatus, tags },
        };
      } catch (err) {
        const errorCode = err instanceof Error ? err.name : undefined;
        return errorCode ? { found: false, errorCode } : { found: false };
      }
    },

    async describeStackResources(stackName: string): Promise<StackResource[]> {
      try {
        const response = (await client.send(
          new DescribeStackResourcesCommand({ StackName: stackName }),
        )) as { StackResources?: { LogicalResourceId?: string; ResourceType?: string; ResourceStatus?: string }[] };

        return (response.StackResources ?? []).flatMap((resource) =>
          resource.LogicalResourceId && resource.ResourceType && resource.ResourceStatus
            ? [{
                logicalId: resource.LogicalResourceId,
                type: resource.ResourceType,
                status: resource.ResourceStatus,
              }]
            : [],
        );
      } catch {
        return [];
      }
    },
  };
}

/** Production reader — credentials come from the standard SDK chain. */
export function createCloudFormationReader(region?: string): CloudFormationReader {
  return toReader(new CloudFormationClient(region === undefined ? {} : { region }));
}
```

Move the two `import` statements to the top of the file with the others — they are shown inline above only to keep the diff readable.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project relay verify`
Expected: PASS — 15 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/verify.ts packages/relay/src/verify.test.ts packages/relay/package.json pnpm-lock.yaml
git commit -m "feat(relay): add the real CloudFormation reader"
```

---

### Task 4: The operator CLI

Runs today, against any existing installation, with operator credentials and no IAM change. This is the only part of the plan that helps the installations already in the field.

**Files:**
- Create: `packages/cdk/scripts/audit-deployment.mjs`
- Modify: `packages/cdk/package.json`

**Interfaces:**
- Consumes: `verifyInstallation`, `createCloudFormationReader` from `@deployz/relay/verify` (Tasks 2–3).
- Produces: `pnpm --filter @deployz/cdk audit:deployment`. Exit 0 verified, 1 not verified, 2 bad usage.

- [ ] **Step 1: Add the script entry**

In `packages/cdk/package.json`, add to `scripts`:

```json
    "audit:deployment": "node scripts/audit-deployment.mjs",
```

- [ ] **Step 2: Write the CLI**

Create `packages/cdk/scripts/audit-deployment.mjs`:

```js
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
console.log(field('Stack', values['stack-name'] ?? 'deployz-app'));
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
```

- [ ] **Step 3: Build and run it against the live account**

```bash
pnpm build
pnpm --filter @deployz/cdk audit:deployment --installation c2dca2bb-a733-470d-8ef0-8e96bc889442 --region us-east-1 --claimed HEALTHY
```

Expected: exit 1, with `FAIL stack-exists` and a verdict naming the contradiction. This reproduces the production finding of 2026-08-26. If it exits 0, something is wrong with the plumbing — that stack does not exist.

- [ ] **Step 4: Verify usage errors**

```bash
pnpm --filter @deployz/cdk audit:deployment
```

Expected: exit 2, prints `--installation is required.` and the usage line.

- [ ] **Step 5: Commit**

```bash
git add packages/cdk/scripts/audit-deployment.mjs packages/cdk/package.json
git commit -m "feat(cdk): add the audit:deployment operator command"
```

---

### Task 5: Gate the relay's INSTALL result on verification

**Files:**
- Modify: `packages/relay/src/index.ts:44-84`
- Modify: `packages/relay/src/index.test.ts`

**Interfaces:**
- Consumes: `verifyInstallation`, `createCloudFormationReader`, `VerificationResult` (Tasks 2–3).
- Produces: `createDefaultExecutors()` returns an `INSTALL` executor that reports `success: false` with `failureCode: 'STACK_CREATE_FAILED'` when verification fails. `RelayHandlerDeps` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/relay/src/index.test.ts`:

```ts
import { createVerifyingInstallExecutor } from './index.js';

describe('INSTALL verification gate', () => {
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  it('fails the install when the account cannot be verified', async () => {
    const executor = createVerifyingInstallExecutor(async () => ({
      verified: false,
      checks: [{ name: 'stack-exists', passed: false, detail: 'No CloudFormation stack named "deployz-app"' }],
      reason: 'No CloudFormation stack named "deployz-app"',
    }));

    const result = await executor(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('deployz-app');
    expect(result.output).toMatchObject({ checks: expect.any(Array) });
  });

  it('succeeds when the account verifies', async () => {
    const executor = createVerifyingInstallExecutor(async () => ({
      verified: true,
      checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
    }));

    const result = await executor(command);

    expect(result.success).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });

  it('fails the install when verification itself throws', async () => {
    const executor = createVerifyingInstallExecutor(async () => {
      throw new Error('boom');
    });

    const result = await executor(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project relay index -t "INSTALL verification gate"`
Expected: FAIL — `createVerifyingInstallExecutor` is not exported.

- [ ] **Step 3: Write the implementation**

In `packages/relay/src/index.ts`, add the import:

```ts
import {
  createCloudFormationReader,
  verifyInstallation,
  type VerificationResult,
} from './verify.js';
```

Add this function above `createDefaultExecutors`:

```ts
/**
 * The INSTALL executor: run the install, then prove it happened.
 *
 * The install step itself is still the stub described below. The
 * verification is not — and that is what matters, because it means this
 * executor cannot report success against an account where nothing was
 * created. Until the install step is real, every INSTALL fails honestly
 * rather than silently reaching Healthy and billing.
 *
 * A throw from verification is a failure, not a pass: an install we cannot
 * confirm is indistinguishable from one that did not happen.
 */
export function createVerifyingInstallExecutor(
  verify: (installationId: string) => Promise<VerificationResult>,
): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? '';

    let result: VerificationResult;
    try {
      result = await verify(installationId);
    } catch (err) {
      result = {
        verified: false,
        checks: [],
        reason: `Verification could not run: ${String(err)}`,
      };
    }

    console.log(
      JSON.stringify({
        event: 'relay:install-verified',
        commandId: command.id,
        installationId,
        verified: result.verified,
        ...(result.reason ? { reason: result.reason } : {}),
      }),
    );

    if (!result.verified) {
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: result.reason ?? 'Installation could not be verified',
        failureCode: 'STACK_CREATE_FAILED',
        output: { checks: result.checks },
      };
    }

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: { executed: true, type: command.type, checks: result.checks },
    };
  };
}
```

Then, inside `createDefaultExecutors()`, replace the `INSTALL: noop,` entry with `INSTALL: installExecutor,` and build it just above the `return`:

```ts
  const installExecutor = createVerifyingInstallExecutor((id) =>
    verifyInstallation({ cfn: createCloudFormationReader(), installationId: id }),
  );
```

Finally, replace the block comment above `createDefaultExecutors` (currently `packages/relay/src/index.ts:31-43`), because it no longer describes INSTALL correctly:

```ts
/**
 * Default executors for the ten command types.
 *
 * ⚠️ SEVEN OF THESE ARE STILL STUBS: REPORT_HEALTH, DEPLOY_RELEASE, ROLLBACK,
 * CONFIG_UPDATE, DESTROY, MIGRATE and REFRESH_METADATA each log and report
 * success without touching the customer's account. The real implementations
 * — CloudFormation stack operations, ECS service updates, migrations — are
 * the remaining half of the product.
 *
 * INSTALL is no longer among them, but not because it provisions anything.
 * Its provisioning step is still missing; what changed is that it now proves
 * the account contains the application before reporting success, so it fails
 * honestly instead of reaching Healthy over an empty account. The remaining
 * stubs still carry that hazard and should be gated the same way as each one
 * gains a real implementation.
 *
 * CONFIGURE_DOMAIN and REMOVE_DOMAIN are real.
 *
 * The command vocabulary + dispatch + idempotency layer around them IS real.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project relay`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/index.ts packages/relay/src/index.test.ts
git commit -m "feat(relay): gate the INSTALL result on verification"
```

---

### Task 6: Report real observed state

`reportHealth` sends `infraHealth: null` on every poll, which is why the control plane's observed state has never contained anything. The verifier already produces the answer.

**Files:**
- Modify: `packages/relay/src/poll.ts:51-59, 227-240`
- Modify: `packages/relay/src/index.ts`
- Modify: `packages/relay/src/poll.test.ts`

**Interfaces:**
- Consumes: `VerificationResult` (Task 2), `PollDependencies` (existing).
- Produces: `PollDependencies` gains an optional `observe?: () => Promise<VerificationResult>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/relay/src/poll.test.ts`, following the existing fetch-stub style in that file:

This reuses `makeMockFetch()` and `makeExecutors()`, which already exist at the top of that file.

```ts
/**
 * Run one poll and return the body the relay POSTed to /api/relay/health.
 */
async function runPollCapturingHealth(
  extra: Partial<PollDependencies>,
): Promise<{ observedState: Record<string, unknown> }> {
  const { fetchFn, getRequests } = makeMockFetch();

  const deps: PollDependencies = {
    fetchFn,
    controlPlaneUrl: 'https://api.example.test',
    installationId: 'install-1',
    enrollmentCode: 'code-1',
    executors: makeExecutors(),
    idempotency: new IdempotencyStore(),
    ...extra,
  };

  await pollOnce(deps, createAuthState('install-1', 'token-1'));

  const health = getRequests().find((request) => request.url.includes('/api/relay/health'));
  if (!health?.body) throw new Error('no health report was sent');
  return JSON.parse(health.body) as { observedState: Record<string, unknown> };
}

describe('observed state', () => {
  it('sends infraHealth null when no observer is supplied', async () => {
    const payload = await runPollCapturingHealth({});
    expect(payload.observedState['infraHealth']).toBeNull();
  });

  it('sends the observation when one is supplied', async () => {
    const payload = await runPollCapturingHealth({
      observe: async () => ({
        verified: false,
        checks: [{ name: 'stack-exists', passed: false, detail: 'missing' }],
        reason: 'missing',
      }),
    });

    expect(payload.observedState['infraHealth']).toMatchObject({
      verified: false,
      reason: 'missing',
    });
  });

  it('sends infraHealth null when the observer throws', async () => {
    const payload = await runPollCapturingHealth({
      observe: async () => {
        throw new Error('boom');
      },
    });

    expect(payload.observedState['infraHealth']).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project relay poll -t "observed state"`
Expected: FAIL — `observe` is not a recognised dependency; `infraHealth` is hardcoded.

- [ ] **Step 3: Write the implementation**

In `packages/relay/src/poll.ts`, add to `PollDependencies`:

```ts
  /**
   * §59 observed state. Optional so the poll loop stays usable without AWS —
   * when it is absent, or throws, `infraHealth` stays null rather than
   * reporting a healthy-looking absence of information.
   */
  observe?: () => Promise<VerificationResult>;
```

Import the type: `import type { VerificationResult } from './verify.js';`

Change the `reportHealth` signature to accept `observe: PollDependencies['observe']` and replace the hardcoded field:

```ts
  let infraHealth: VerificationResult | null = null;
  if (observe) {
    try {
      infraHealth = await observe();
    } catch {
      // An observation we could not take is not an observation. Leaving this
      // null is honest; substituting a default would not be.
      infraHealth = null;
    }
  }

  const observedState: Record<string, unknown> = {
    idempotencyKeysTracked: idempotency.size,
    lastPoll: new Date().toISOString(),
    runningVersion: null,
    observedConfig: null,
    infraHealth,
  };
```

Update the call site at line 182 to pass `deps.observe` through.

In `packages/relay/src/index.ts`, add `observe` to the `pollDeps` object:

```ts
      observe: () =>
        verifyInstallation({ cfn: createCloudFormationReader(), installationId }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project relay`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/poll.ts packages/relay/src/poll.test.ts packages/relay/src/index.ts
git commit -m "feat(relay): report observed infrastructure state"
```

---

### Task 7: Grant the relay read access to its own stack

Without this the relay's verification returns `AccessDenied` on every poll, which fails closed — correct, but useless.

**Files:**
- Modify: `packages/cdk/src/bootstrap/bootstrap-stack.ts:101-107, 240-254, 476-492`
- Modify: `packages/cdk/test/bootstrap-stack.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the relay role carries a `RelayVerifyInstallation` statement.

- [ ] **Step 1: Write the failing test**

Append to `packages/cdk/test/bootstrap-stack.test.ts`, matching the `Template.fromStack` style already used there:

```ts
it('lets the relay read its own application stack', () => {
  const template = Template.fromStack(new BootstrapStack(new App(), 'TestStack'));

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'RelayVerifyInstallation',
          Effect: 'Allow',
          Action: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResources'],
        }),
      ]),
    },
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project cdk bootstrap-stack -t "lets the relay read"`
Expected: FAIL — no statement with that Sid.

- [ ] **Step 3: Write the implementation**

In `packages/cdk/src/bootstrap/bootstrap-stack.ts`, add near the other action constants (around line 107):

```ts
/**
 * Phase 2 — read-only stack access so the relay can verify its own
 * installation. Both actions are already inside
 * `PHASE_2_MANAGE_STACK_ACTIONS`, so this grant does not raise the
 * permissions boundary's ceiling — it only extends what the role is
 * actually granted beneath it.
 */
const PHASE_2_VERIFY_STACK_ACTIONS = [
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackResources',
] as const;
```

Add the statement beside `phase1SecretAccess` (around line 253):

```ts
    const phase2VerifyStack = new PolicyStatement({
      sid: 'RelayVerifyInstallation',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_VERIFY_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });
```

And attach it beside the existing two (around line 485):

```ts
    this.relayRole.addToPolicy(phase2VerifyStack);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project cdk bootstrap-stack`
Expected: PASS. Snapshot tests in this package may need updating — inspect the diff and re-run with `-u` only after confirming the only change is the added statement.

- [ ] **Step 5: Commit**

```bash
git add packages/cdk/src/bootstrap/bootstrap-stack.ts packages/cdk/test/bootstrap-stack.test.ts packages/cdk/test/__snapshots__
git commit -m "feat(cdk): let the relay read its own application stack"
```

---

### Task 8: Live regression test

Pins the production state found on 2026-08-26 so the bug cannot return unnoticed.

**Files:**
- Modify: `packages/cdk/test/golden-path-live-aws.test.ts`

**Interfaces:**
- Consumes: `verifyInstallation`, `createCloudFormationReader` (Tasks 2–3).
- Produces: nothing.

- [ ] **Step 1: Write the test**

Append to `packages/cdk/test/golden-path-live-aws.test.ts`, using the `liveAws` gate already defined at line 314:

```ts
/**
 * Verification against the real account.
 *
 * On 2026-08-26 installation c2dca2bb reported HEALTHY in the control plane
 * with nothing provisioned behind it. This asserts the verifier calls that
 * what it is. It SHOULD start failing once a real INSTALL provisions the
 * stack — at which point update the expectation rather than deleting it.
 */
liveAws('installation verification (live)', () => {
  const INSTALLATION = process.env.DEPLOYZ_LIVE_INSTALLATION_ID ?? 'c2dca2bb-a733-470d-8ef0-8e96bc889442';

  it('reports an unprovisioned installation as not verified', async () => {
    const result = await verifyInstallation({
      cfn: createCloudFormationReader(REGION),
      installationId: INSTALLATION,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.checks.find((check) => check.name === 'stack-exists')?.passed).toBe(false);
  }, 60_000);
});
```

Add the import at the top of the file:

```ts
import { createCloudFormationReader, verifyInstallation } from '@deployz/relay/verify';
```

- [ ] **Step 2: Confirm it skips by default**

Run: `pnpm vitest run --project cdk golden-path-live-aws`
Expected: the new describe block is SKIPPED (no `DEPLOYZ_LIVE_AWS`).

- [ ] **Step 3: Run it against live AWS**

```bash
DEPLOYZ_LIVE_AWS=1 AWS_REGION=us-east-1 pnpm vitest run --project cdk golden-path-live-aws -t "not verified"
```

Expected: PASS — the stack genuinely is absent.

- [ ] **Step 4: Run the whole suite and lint**

```bash
pnpm vitest run
pnpm build
pnpm lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cdk/test/golden-path-live-aws.test.ts
git commit -m "test(cdk): pin the unverified-installation regression"
```

---

## After the plan

Two follow-ups this plan deliberately does not do, in order:

1. **Republish the bootstrap template** (`pnpm --filter @deployz/cdk run publish:bootstrap`) and update the `BOOTSTRAP_TEMPLATE_URL` repository variable. Tasks 5–7 reach only installations created afterwards. The republish also picks up the ACM, ElastiCache and ALB-listener grants the currently-published template is missing.
2. **Implement the `INSTALL` executor** and publish the application-stack template. Verification is the check; provisioning is still the missing half.
