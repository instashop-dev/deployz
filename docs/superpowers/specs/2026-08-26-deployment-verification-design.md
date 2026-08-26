# Deployment verification

**Date:** 2026-08-26
**Status:** approved

## Problem

A Deployz install reports success and provisions nothing, and no part of the
system notices.

Verified live on 2026-08-26 in account `151955775369` / `us-east-1`. The
customer bootstrap stack reached `CREATE_COMPLETE` at 12:45 UTC, the relay
registered and polled cleanly, and at 12:47 UTC it executed the `INSTALL`
command for deployment `eabf8ab9-0993-44ca-9f46-f9ef3baeee3d` and reported
`succeeded: 1`. The account contains no application CloudFormation stack, no ECS
cluster, no load balancer, no application database, no ElastiCache cluster, no
application S3 bucket and no application secrets — not even a failed creation
attempt.

The cause is that `INSTALL`, `DEPLOY_RELEASE`, `ROLLBACK`, `CONFIG_UPDATE`,
`DESTROY`, `MIGRATE` and `REPORT_HEALTH` all map to one no-op executor that
returns `success: true` without any AWS call
(`packages/relay/src/index.ts:44-84`). The consequence is that
`apps/api/src/server.ts:548-553` maps `INSTALL → HEALTHY` purely from
`body.success !== false`, consulting no AWS state, and `apps/api/src/billing.ts:394`
meters exactly the `HEALTHY` and `UPDATE_AVAILABLE` states. A stubbed install
therefore produces a deployment that reads healthy in the fleet view and bills
$19/month against an empty account.

Nothing catches the discrepancy. Preflight (17 checks), the health monitor (10
signals) and drift detection are all written and tested, and all have zero
production callers. The relay's health report sends a hardcoded object with
`runningVersion: null` and `infraHealth: null` and no `healthStatus` field at
all (`packages/relay/src/poll.ts:234-240`), so the control plane's parse of that
field always fails and `health_status` stays `UNKNOWN` for the lifetime of the
deployment.

**The gap being closed here is not "the executors are stubs." It is that
nothing independently confirms an install happened.** Those are different
problems, and the second one outlives the first: an implemented `INSTALL` can
still fail halfway, and today nothing would notice that either.

## Approach

One verifier, two callers. A single `verifyInstallation()` establishes what a
real installation looks like; an operator CLI and the relay both call it.

Rejected alternatives:

- **Write the operator tool and the in-product check separately.** Two
  definitions of "a real install," which drift apart the first time the
  application stack gains a resource. Not worth it for two callers.
- **Sweep the account for resources**, as the manual audit did (`ListClusters`,
  `DescribeDBInstances`, `DescribeLoadBalancers`, and so on). Broader, but it
  told us nothing that querying the stack would not have, it needs far more IAM
  than the relay has or should have, and most of those calls cannot be
  tag-conditioned — so granting them to the relay would widen its authority
  beyond its own installation.
- **Verify from the control plane.** Requires cross-account credentials in
  Deployz, which §15 forbids outright. Verification has to run where the
  resources are.
- **Add an `INSTALL_UNVERIFIED` failure code.** `FAILURE_CODES` is mirrored by a
  Postgres enum with a parity test (`packages/analysis/src/failure-codes.ts:19-24`),
  so a new code costs a migration plus an enum change plus a test update.
  `STACK_CREATE_FAILED` already means "the stack is not there," which is exactly
  what the verifier found.

### Two rules the design turns on

**CloudFormation-centric.** `DescribeStacks` for existence and terminal status,
`DescribeStackResources` for the resource inventory. Two API calls catch the
entire "claimed success, nothing exists" class. Both are already tag-conditioned
in the permissions boundary.

**Fail closed.** Any error — `AccessDenied`, `ValidationError`, stack not found,
throttling, a malformed response — is `verified: false` with a reason, never a
pass. Given that the bug being fixed is an unconditional `success: true`, a
verifier that treats an unreadable answer as a good one would reproduce it.

## Placement

`packages/relay/src/verify.ts`.

`@deployz/cdk` already depends on `@deployz/relay`, so the CLI in `packages/cdk`
can import the verifier, while the reverse would close a cycle. The relay is
also the honest owner: it is the component that runs inside the customer
account. No new package.

The relay gains one dependency, `@aws-sdk/client-cloudformation`. It already
carries `@aws-sdk/client-elastic-load-balancing-v2` for the domain executors.

Tests are colocated as `src/*.test.ts`, matching the rest of the package
(`packages/relay/src/poll.test.ts` and siblings). The relay has no `test/`
directory.

### Prerequisite: name the application stack

There is no application stack name anywhere in the codebase. `DEFAULT_BOOTSTRAP_STACK_NAME`
exists (`packages/contracts/src/index.ts:424`), but the application stack name
is only ever an injected config field on the test harness
(`packages/cdk/src/integration/runner.ts:75`). A verifier cannot look up a stack
whose name is undefined.

Add `DEFAULT_APPLICATION_STACK_NAME = 'deployz-app'` to `@deployz/contracts`
beside the bootstrap constant, and default both callers to it. This is a
prerequisite rather than scope creep: whoever implements `INSTALL` must pick the
same name, and pinning it in one shared place now is what stops the installer
and the verifier from disagreeing about which stack to look for. The value
matches the existing `serviceName: 'deployz-app'` in
`packages/cdk/src/application/application-stack.ts:512`.

## Components

### 1. The core — `packages/relay/src/verify.ts`

```ts
/**
 * A lookup that failed carries the AWS error code when there was one. "The
 * stack is missing" and "I am not allowed to look" are both `found: false`
 * — the fail-closed rule makes them equivalent for the verdict — but they
 * need different actions from an operator, so the reason preserves which.
 */
export type StackLookup =
  | { found: true; stack: StackSummary }
  | { found: false; errorCode?: string };

export interface CloudFormationReader {
  describeStack(stackName: string): Promise<StackLookup>;
  describeStackResources(stackName: string): Promise<StackResource[]>;
}

export interface VerifyOptions {
  cfn: CloudFormationReader;
  installationId: string;
  /** Defaults to DEFAULT_APPLICATION_STACK_NAME. */
  stackName?: string;
  /** Expect an ElastiCache cluster. Defaults to false. */
  redisRequired?: boolean;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  verified: boolean;
  checks: VerificationCheck[];
  /** Present when `verified` is false — the first failing check's detail. */
  reason?: string;
}

export async function verifyInstallation(options: VerifyOptions): Promise<VerificationResult>;
```

Checks, in order, short-circuiting on the first failure that makes later checks
meaningless:

| Check | Passes when |
| --- | --- |
| `stack-exists` | `DescribeStacks` returns a stack |
| `stack-complete` | Status is `CREATE_COMPLETE` or `UPDATE_COMPLETE` |
| `stack-tagged` | Stack carries `deployz:installation` matching `installationId` |
| `compute` | Resources include an `AWS::ECS::Service` in a complete state |
| `ingress` | Resources include an `AWS::ElasticLoadBalancingV2::LoadBalancer` |
| `database` | Resources include an `AWS::RDS::DBInstance` |
| `storage` | Resources include an `AWS::S3::Bucket` |
| `cache` | When `redisRequired`, resources include an `AWS::ElastiCache::CacheCluster` |

`stack-tagged` exists to stop a same-named stack in the account from passing for
another installation's. It is a cheap check and the tag is what the IAM model
already relies on.

The client interface is injected, so the whole module tests with `vi.fn()` and
no credentials — the same seam style as
`packages/cdk/src/integration/aws-clients.ts`. A real implementation
(`createCloudFormationReader()`) wraps the SDK and maps every thrown error to
`null` or an empty list, so error handling lives in one place and the pure logic
never sees an exception.

### 2. The operator CLI — `packages/cdk/scripts/audit-deployment.mjs`

```bash
pnpm --filter @deployz/cdk audit:deployment \
  --installation c2dca2bb-a733-470d-8ef0-8e96bc889442 \
  --region us-east-1 \
  --claimed HEALTHY
```

A thin wrapper matching the existing `publish-bootstrap.mjs` shape: parse
arguments, build a real reader from the ambient AWS credential chain, call
`verifyInstallation`, print the check table, exit `0` when verified and `1`
otherwise. `--claimed` is optional and affects only the summary line, which
calls out the contradiction when the control plane claims `HEALTHY` and
verification fails.

This runs **today**, against any existing installation, with operator
credentials and no IAM change.

### 3. The in-product gate — `packages/relay/src/index.ts`

After executing `INSTALL`, the relay verifies before reporting:

```
execute INSTALL (stub or real)
        │
        ▼
verifyInstallation()
        │
   verified? ──no──▶ { success: false,
        │              failureCode: 'STACK_CREATE_FAILED',
        │              error: result.reason,
        │              output: { checks } }
       yes
        │
        ▼
{ success: true, output: { checks } }
```

Two things follow from this that are worth stating plainly:

- **No API change is required.** `apps/api/src/server.ts:2486` already maps
  `body.success === false` to `FAILED`. The gate is entirely relay-side.
- **It closes the false-healthy hole before `INSTALL` is implemented.** With the
  executor still a stub, the verifier finds no stack and the install fails
  honestly. The separately-planned "make stubs fail loudly" change becomes
  unnecessary.

Applies to `INSTALL` only. `DEPLOY_RELEASE` and `ROLLBACK` need a different
assertion (the running image digest), which is not in scope here.

### 4. Observed state — `packages/relay/src/poll.ts`

`reportHealth` replaces its hardcoded `infraHealth: null` with the verification
result, which the relay already has. `runningVersion` and `observedConfig` stay
`null` — they need the image digest, which this design does not fetch.

This is included because the verifier hands it over for free and it removes a
hardcoded value rather than adding a feature. It does not attempt to fix
`health_status`, which additionally requires sending a `healthStatus` field the
control plane can parse. That stays out of scope.

### 5. IAM — `packages/cdk/src/bootstrap/bootstrap-stack.ts`

Add `cloudformation:DescribeStacks` and `cloudformation:DescribeStackResources`
to the relay's inline policy, conditioned on
`aws:ResourceTag/deployz:installation` matching the installation. Both actions
are already in the permissions boundary
(`PHASE_2_MANAGE_STACK_ACTIONS`), so the ceiling does not move — only the grant
does.

Note that a tag-conditioned `DescribeStacks` against a stack that does not exist
returns an error rather than an empty result. The fail-closed rule makes that
the correct outcome regardless.

## Rollout consequence

Components 3, 4 and 5 reach only installations created after the bootstrap
template is republished and `BOOTSTRAP_TEMPLATE_URL` is updated. Existing
installations — including the Documenso one that prompted this work — keep
reporting healthy until their customer updates the bootstrap stack.

That asymmetry is the reason component 2 is a standalone tool rather than
something folded into the relay. The CLI covers the existing fleet from day one;
the relay gate covers everything provisioned afterwards.

The republish must also pick up the ACM, ElastiCache and ALB-listener grants
that the currently-published template is missing — it predates both the
custom-domains and Redis work.

## Testing

Unit tests (`packages/relay/src/verify.test.ts`), no credentials:

- Empty account — `DescribeStacks` returns null → `verified: false`, reason
  names the missing stack. This is the case observed in production today.
- Stack exists but is `ROLLBACK_COMPLETE` → not verified.
- Stack complete but carrying another installation's tag → not verified.
- Stack complete, resources missing the ECS service → not verified, reason names
  `compute`.
- Full expected resource set → verified.
- `redisRequired: true` with no cache resource → not verified; the same input
  with `redisRequired: false` → verified.
- Each error mode (`AccessDenied`, `ValidationError`, throttling, a rejected
  promise) → not verified. Never a pass, never a thrown exception escaping.

Relay handler tests (`packages/relay/src/index.test.ts`): a stubbed `INSTALL`
against an empty account reports `success: false` with
`failureCode: 'STACK_CREATE_FAILED'`.

Live test, gated behind `DEPLOYZ_LIVE_AWS=1` in
`packages/cdk/test/golden-path-live-aws.test.ts`: run the verifier against
installation `c2dca2bb-a733-470d-8ef0-8e96bc889442` and assert it reports not
verified with the stack missing. This is a regression test for the exact
production state found on 2026-08-26, and it will start failing — correctly —
once a real `INSTALL` provisions that stack.

## Out of scope

- Implementing the `INSTALL` executor, or any other executor.
- Publishing the application-stack template, which `INSTALL` will need.
- Attaching the provisioner policy, or creating the CloudFormation execution
  role at `role/deployz/*`. Verification needs read access only.
- ECS running-task counts and ALB target health. Stack-level verification is
  what catches the observed bug; runtime health is a separate concern with a
  separate failure mode.
- Drift detection, the 10-signal health monitor, and preflight wiring.
- `health_status` reaching anything other than `UNKNOWN`.
- Verification for `DEPLOY_RELEASE` and `ROLLBACK`.
- **Stack-level tags.** `verifyInstallation`'s `stack-tagged` check and the
  relay's tag-conditioned IAM both read CloudFormation *stack* tags — the
  `Tags` parameter of `CreateStack` — not the per-resource tags CDK's
  `Tags.of(...)` aspect writes into a template. Whoever implements `INSTALL`
  must pass `Tags` on `CreateStack` or verification will fail and the IAM
  condition will deny. The existing helper in
  `packages/cdk/src/integration/aws-clients.ts` passes no `Tags`.
- **Express mode.** The verifier requires `AWS::ECS::Service` and
  `AWS::ElasticLoadBalancingV2::LoadBalancer`. An `expressMode: true`
  application stack has neither (it uses `AWS::ECS::ExpressGatewayService`
  and ECS manages the load balancer), so a correctly provisioned
  express-mode install would never verify. Must be handled before express
  mode is used with a real `INSTALL`.
- **Failure caching in `dispatchCommand`.** `packages/relay/src/commands.ts:137`
  caches every result by idempotency key, failures included, for the lifetime of
  the warm Lambda container. A transient `AccessDenied` during verification
  therefore sticks until the container recycles. This is pre-existing behaviour,
  not something verification introduces, and it only bites on *recovery* — which
  cannot be exercised until `INSTALL` genuinely provisions something. Left alone
  deliberately; revisit when implementing `INSTALL`.
