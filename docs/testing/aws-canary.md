# AWS canary E2E

Read-only, real-AWS verification of a persistent installation. See
[`README.md`](README.md) and
[`discovery/phase1-design-decisions.md`](discovery/phase1-design-decisions.md)
(D5) for how this fits the rest of the test hierarchy.

## Purpose

Prove the relay's actual AWS SDK calls — `verifyInstallation`,
`observeRuntimeHealth`, `listAllStackResources` — still work against a real
AWS account, without creating or destroying anything. This is the cheapest
possible real-AWS check: it only ever reads.

## What the canary installation is

A **persistent, verify-only** real installation, not a resource created for
the test run. It stays deployed indefinitely and is reused by every canary
run. The installation id comes from `DEPLOYZ_E2E_CANARY_INSTALLATION_ID`
(falls back to `DEPLOYZ_LIVE_INSTALLATION_ID`, then the historical standing
id `c2dca2bb-a733-470d-8ef0-8e96bc889442`, in that order).

## Persistent canary lifecycle

The standing canary installation is a long-lived, always-on application stack
managed by the test-infrastructure owner. It is the single canonical target
for `pnpm e2e:canary`.

**Ownership and id.** The standing installation id is
`c2dca2bb-a733-470d-8ef0-8e96bc889442` (the default in
`STANDING_INSTALLATION_ID`). The test-infrastructure owner is responsible for
its provisioning, health, and decommissioning. The installation id is
overridable via `DEPLOYZ_E2E_CANARY_INSTALLATION_ID` or
`DEPLOYZ_LIVE_INSTALLATION_ID`.

**Required tags.** The application stack MUST carry all four tags for the
canary to pass:

| Tag | Value | Purpose |
| --- | --- | --- |
| `DeployzEnvironment` | `e2e` | Identifies the environment as test infrastructure |
| `DeployzTestMode` | `canary` | Marks the stack as a canary target |
| `DeployzPersistent` | `true` | Signals that the stack is intentionally kept alive |
| `DeployzProtected` | `true` | Protection marker — prevents accidental cleanup by bulk operations |

**Region.** `us-east-1` per repository convention. Configured via `AWS_REGION`.

**Expected cost.** The canary installation runs one small always-on ECS
service, an ALB, an RDS instance, and an S3 bucket. For actual cost figures,
check the AWS Console billing dashboard for the test account
(151955775369).

**How to provision it intentionally.** The standing installation is created
through the normal bootstrap + application template flow, as documented in
[`version-rollback-canary.md`](version-rollback-canary.md) (`pnpm e2e:canary:versions core`
without `--reuse-stack`). This is an intentional provisioning action — the
canary test never creates infrastructure.

**How to verify it.** Run the canary ladder:
1. `pnpm e2e:canary --dry-run` to confirm the resolved command.
2. `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary` to run the full
   verify-installation, runtime-health, resource-inventory, and tag check
   suite.

**How to recover when unhealthy.** First re-run the canary to confirm the
failure is persistent. Then redeploy the application stack intentionally
through the normal bootstrap + application template flow (see provisioning
above). The canary test itself never mutates the installation — it only reads.

**Accidental cleanup prevention.** Two mechanisms protect the standing
installation:
- The four required tags (especially `DeployzProtected=true`) act as a
  marker that bulk operations and scripts can check before acting.
- The customer-reset tag guard (`scripts/customer-reset/safety.ts`) refuses
  to reset any stack carrying `DeployzPersistent=true` or
  `DeployzProtected=true`.

**Never repurpose customer deployments as canary infrastructure.**

The end-to-end product walk (vendor → install link → Quick Create → relay →
HEALTHY → deploy → disconnect → purge) against the deployed control plane is
a separate, manual procedure with its own ledger and cleanup checklist:
[`aws-full-product-canary.md`](aws-full-product-canary.md).

Driving a real update/rollback through a transient installation is the job
of the version canary — [`version-rollback-canary.md`](version-rollback-canary.md)
(`pnpm e2e:canary:versions core`).

## AWS account/region assumptions

- Standard AWS SDK v3 credential chain (env vars, `~/.aws/credentials`, or an
  IAM role) — no explicit credential wiring beyond that.
- Region defaults to `us-east-1` (`AWS_REGION`), matching where the standing
  installation lives.
- The standing installation's stack name defaults to
  `DEFAULT_APPLICATION_STACK_NAME` (`deployz-app`), overridable with
  `DEPLOYZ_E2E_CANARY_STACK_NAME`.

## Required environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEPLOYZ_E2E_ALLOW_REAL_AWS=1` | Yes | The real-AWS opt-in guard — refused without it. |
| AWS credentials | Yes | Standard SDK v3 chain; preflight fails fast via `sts.getCallerIdentity` if unresolvable. |
| `DEPLOYZ_E2E_CANARY_INSTALLATION_ID` | No | Overrides the standing installation id. |
| `DEPLOYZ_E2E_CANARY_STACK_NAME` | No | Overrides the stack name (defaults `deployz-app`). |
| `DEPLOYZ_E2E_CANARY_REDIS_REQUIRED=1` | No | Set only if the standing installation has a Redis cache, to include the `cache` verify check. |
| `AWS_REGION` | No | Defaults `us-east-1`. |

## How to invoke

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary
```

On Windows PowerShell:

```powershell
$env:DEPLOYZ_E2E_ALLOW_REAL_AWS = '1'
pnpm e2e:canary
```

Without the opt-in it refuses immediately (verified, no AWS calls made):

```
Real AWS E2E is disabled.
Set DEPLOYZ_E2E_ALLOW_REAL_AWS=1
only when intentionally running AWS-backed E2E tests.
```

With the opt-in, `--dry-run` shows the resolved command without running it
(also verified, no AWS calls made):

```json
{"mode":"canary","command":"pnpm","args":["--filter","@deployz/cdk","exec","vitest","run","test/canary-e2e.live.test.ts"],"envKeys":["DEPLOYZ_E2E_MODE"]}
```

`pnpm e2e:canary` wraps
`pnpm --filter @deployz/cdk exec vitest run test/canary-e2e.live.test.ts`
with `DEPLOYZ_E2E_MODE=canary` set; AWS credentials/region pass through
unchanged (simulated mode's env-scrubbing does not apply here — real AWS
access is the entire point).

## What it verifies

1. **The verify ladder** (`verifyInstallation`): `stack-exists`,
   `stack-complete`, `stack-tagged`, `compute`, `ingress`, `database`,
   `storage`, and `cache` if `DEPLOYZ_E2E_CANARY_REDIS_REQUIRED=1`. A failure
   is reported with the full check-by-check detail, and it refuses to look
   past a failed `stack-tagged` check.
2. **Runtime health** (`observeRuntimeHealth` over real ECS/ELB reads):
   expects `HEALTHY`; a non-healthy result fails loudly with the full
   observed detail (component states, desired/running counts, unhealthy
   target count, rollout state) rather than skipping.
3. **Resource inventory** (`listAllStackResources`): non-null, non-empty,
   and includes the expected resource kinds (`AWS::ECS::Service`,
   `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::RDS::DBInstance`,
   `AWS::S3::Bucket`).
4. **Persistent-canary tags**: the application stack must carry
   `DeployzEnvironment=e2e`, `DeployzTestMode=canary`,
   `DeployzPersistent=true`, and `DeployzProtected=true`. A missing or
   incorrect tag fails the suite with the expected and actual values.

## Cleanup rules

None needed. The canary suite creates and deletes nothing — every check is a
read-only CloudFormation/ECS/ELB call.

## Troubleshooting

- **"Canary preflight failed: could not resolve AWS credentials"** — the
  standard SDK credential chain found nothing. Configure credentials via env
  vars, `~/.aws/credentials`, or an IAM role.
- **A verify check fails** — the suite prints the full `checks` array; fix
  the underlying installation (or the relay code, if the check itself
  regressed) rather than loosening the assertion.
- **Runtime health is not `HEALTHY`** — the standing installation itself is
  unhealthy; this is a real signal, not a flaky test. Investigate the
  installation before re-running.

## Cost

Negligible. Every call is a `Describe*`/`List*` read against CloudFormation,
ECS, and ELB — no resources are created, modified, or deleted.
