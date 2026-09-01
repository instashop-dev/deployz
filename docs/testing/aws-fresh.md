# AWS fresh E2E

A hardened wrapper around the bootstrap stack's real create/destroy golden
path. See [`README.md`](README.md) and
[`discovery/phase1-design-decisions.md`](discovery/phase1-design-decisions.md)
(D5) for how this fits the rest of the test hierarchy.

## When fresh is justified

Only after a change to the actual create/destroy path a customer's bootstrap
stack goes through: `packages/cdk/src/bootstrap/bootstrap-stack.ts`,
`bin/bootstrap.ts`, or the relay's registration/tagging behaviour. Simulated
E2E already proves everything downstream of the relay's AWS calls; fresh
exists specifically to prove those calls still work for real.

**Situations that do NOT justify fresh E2E**: copy changes, dashboard-only
changes, CSS, non-infrastructure API refactors, test-only changes,
documentation. For any of these, the simulated suite (`pnpm e2e`) is the
right and sufficient check.

## Preconditions

- AWS credentials via the standard SDK v3 chain.
- The `aws` CLI on `PATH` (used for Lambda-config and resource-tag lookups).
- `AWS_REGION` set or defaulting to `us-east-1`.
- `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`.

## The guard

`fresh` refuses to run without the opt-in, before spawning anything
(verified, no AWS calls made):

```
Real AWS E2E is disabled.
Set DEPLOYZ_E2E_ALLOW_REAL_AWS=1
only when intentionally running AWS-backed E2E tests.
```

## Execution command

```bash
DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh
```

On Windows PowerShell:

```powershell
$env:DEPLOYZ_E2E_ALLOW_REAL_AWS = '1'
pnpm e2e:fresh
```

With the opt-in, `--dry-run` shows the resolved command without running it
(also verified, no AWS calls made):

```json
{"mode":"fresh","command":"pnpm","args":["--filter","@deployz/cdk","exec","vitest","run","test/fresh-e2e.live.test.ts"],"envKeys":["DEPLOYZ_E2E_MODE"]}
```

`pnpm e2e:fresh` wraps
`pnpm --filter @deployz/cdk exec vitest run test/fresh-e2e.live.test.ts` with
`DEPLOYZ_E2E_MODE=fresh` set; AWS credentials/region pass through unchanged.

## Resources created

The **bootstrap stack** only: a relay Lambda, its IAM role, a Secrets
Manager secret for its bearer token, and a 5-minute EventBridge schedule.
Cost is negligible and the whole cycle (deploy → verify → destroy) takes a
few minutes.

The suite:

1. Preflights that the minted stack name does not already exist.
2. `cdk deploy`s the bootstrap stack, tagged `DeployzTestMode=fresh` /
   `DeployzEnvironment=e2e`.
3. Verifies `CREATE_COMPLETE`, the relay Lambda is `Active`, and
   `deployz:installation`-tagged resources exist (≥3 ARNs, including a
   Lambda).
4. `cdk destroy`s the stack and polls until it is gone.

## Unique naming, collision refusal, and teardown

- Each run mints an 8-hex-char run id and names its stack
  `deployz-fresh-<runid>` (via `DEPLOYZ_BOOTSTRAP_STACK_NAME`, consumed by
  `bin/bootstrap.ts`) — concurrent or previously-un-torn-down runs cannot
  collide with each other or with a real customer's `DeployzBootstrap`
  stack.
- If a stack with the freshly minted name somehow already exists, the suite
  **refuses to proceed** rather than treating it as a collision to recover
  from — this should not happen with a fresh random id, and existing means
  something else is wrong.
- Teardown runs in a `try`/`finally` (`CleanupRegistry`/`runWithTeardown`):
  even if an assertion fails mid-suite, the stack this run created is still
  destroyed.
- **Orphan handling**: if a run is killed outright (process killed, machine
  lost power) before its `finally` can run, its stack is never torn down.
  Because the name is unique per run, this does not block future runs — but
  the orphaned `deployz-fresh-<runid>` stack must be destroyed manually
  (`cdk destroy --app "tsx bin/bootstrap.ts"` with
  `DEPLOYZ_BOOTSTRAP_STACK_NAME` set to the orphan's name, or via the AWS
  Console) to avoid leaving live infrastructure behind.

## Failure handling

An assertion failure inside the suite still runs the registered teardown
(see above), then re-throws the original assertion error — a failed fresh
run does not need manual cleanup unless the process itself was killed before
teardown could run.

## The Redis/application-stack block

Provisioning an actual application stack with `redisRequired: true` (RDS +
ElastiCache, 15–25 minutes, real cost) is **not** part of fresh's default
run. It stays gated behind `DEPLOYZ_LIVE_AWS=1` in
`packages/cdk/test/golden-path-live-aws.test.ts`'s "live AWS Redis cache
provisioning" block. That block's RDS instance is `RemovalPolicy.RETAIN` —
deleting the stack **orphans the RDS instance**, which needs manual cleanup
in the AWS Console. Only run it deliberately, and only when a change
specifically touches Redis/RDS provisioning.

## Full product-flow fresh install

The complete customer-facing flow (install link → a real customer AWS
account → HEALTHY → update → delete) is not automated by fresh mode. It
remains the documented manual live-install workflow — see
`discovery/live-aws-machinery.md` §5 for the current step-by-step.
