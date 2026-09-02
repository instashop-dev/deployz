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

**State of the world (2026-09-02):** no standing installation currently
exists — the 2026-08-27 installation behind the historical default id, and
every other `deployz-app`/bootstrap stack in the test account, was torn down
by later E2E sessions. Until a persistent canary environment is deliberately
provisioned (an ongoing-cost decision — an always-on ALB + RDS + ECS
service), canary runs need a **transient target**: synthesize the production
application template with the published fixture image
(`synthesizeApplicationStack` — see `packages/cdk/scripts/synth-app.mjs` and
`publish-application.mjs` for the pattern), `CreateStack` it as `deployz-app`
with a fresh `deployz:installation` tag plus `DeployzEnvironment=e2e` /
`DeployzTestMode=canary` tags, run the canary with
`DEPLOYZ_E2E_CANARY_INSTALLATION_ID=<that id>`, then delete the stack and the
`RemovalPolicy.RETAIN`-ed RDS instance it leaves behind.

**Never repurpose customer deployments as canary infrastructure.**

The end-to-end product walk (vendor → install link → Quick Create → relay →
HEALTHY → deploy → disconnect → purge) against the deployed control plane is
a separate, manual procedure with its own ledger and cleanup checklist:
[`aws-full-product-canary.md`](aws-full-product-canary.md).

Driving a real update/rollback through the canary installation is out of
scope for Phase 1 — that stays a documented manual escalation via the live-
install workflow (see [`aws-fresh.md`](aws-fresh.md) and
`discovery/live-aws-machinery.md` §5).

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
