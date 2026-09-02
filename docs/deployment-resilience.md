# Deployment resilience — how the lifecycle stays recoverable

How Deployz keeps deployments from becoming duplicated, stuck, misreported,
or unrecoverable. **Read this before changing deployment/job/relay logic.**
For the concrete file/line map of the machinery, see
`docs/testing/discovery/deployment-lifecycle.md`; for the test harness, see
`docs/testing/e2e-testing.md` and `docs/testing/e2e-scenarios.md`.

The guiding principle: the control plane does not try to prevent every AWS
or application failure. It always knows what happened, preserves the safest
known state, and provides a deterministic path forward.

## The domain model

- **Deployment** (`deployments` row) — the long-lived customer environment.
  Its `state` (§46: `NOT_INSTALLED … HEALTHY … DELETED`) is the lifecycle of
  the environment, deliberately distinct from the outcome of any one
  operation and from runtime health (`healthStatus`) and relay connectivity
  (`relayStatus`), which are separate columns.
- **Release** (`releases` row) — an immutable version/build.
  `currentReleaseId` points at the last release that actually deployed
  successfully; it only ever advances on a SUCCEEDED deploy/rollback
  (`RELEASE_ADVANCING_JOBS`), so after any failure it still names what is
  really running. There is no separate lastHealthyRelease column because
  `currentReleaseId` IS that pointer by construction.
- **Operation** (`deployment_jobs` row) — one durable mutation (INSTALL,
  DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE, DESTROY, PURGE, domain
  jobs). Carries identity (`idempotencyKey`), lifecycle
  (`REQUESTED/QUEUED/WAITING/RUNNING/SUCCEEDED/FAILED/CANCELLED`), progress
  (`lastProgressAt`), classification (`failureCode`), and the watchdog's
  re-offer counter (`reconcileCount`).

## A failed update is not a failed deployment

The core semantic rule (`deploymentStateAfterFailedJob` in
`@deployz/contracts`, applied identically by the relay result route and the
watchdog):

- A failed **day-2 operation** (deploy/rollback/restart) on a deployment
  with a running release returns the deployment to `UPDATE_AVAILABLE` (a
  newer READY release exists) or `HEALTHY` — the ECS circuit breaker
  restored the previous release, which never stopped serving. The FAILED
  job carries the failure; the status derivation surfaces it
  (`deploymentStatus.failure`) without regressing the live stage, and the
  vendor UI adds "The previous version is still running."
- A failed **first install** or **destroy** marks the deployment `FAILED` —
  there, the operation's failure IS the environment's.
- A failed **CONFIG_UPDATE** or **PURGE** never touches deployment state
  (a failed purge used to resurrect a DELETED deployment); a purge failure
  lands on `cleanupState: PURGE_FAILED` instead, which keeps it retryable.
  Domain jobs (CONFIGURE_DOMAIN/REMOVE_DOMAIN) follow the same rule: their
  failures surface on the `custom_domains` row, never on the deployment.

Retrying a failed update is just deploying again — `requireDeployableState`
allows it, and `retryAwareIdempotencyKey` mints a fresh attempt key once the
newest attempt under a base key is FAILED. Application rollback restores the
image and service configuration only; it never reverses database
migrations (documented limitation).

## Idempotency and exclusivity

- Every operation has a durable idempotency key
  (`{deploymentId}:{TYPE}[:{releaseId}][:RETRY:n]`, client-overridable via
  the `Idempotency-Key` header). `createOrReuseJob` inserts with
  ON CONFLICT DO NOTHING and replays the existing job for a duplicate.
- **One active mutating job per deployment**, enforced by a partial unique
  index (`deployment_jobs_one_active_mutating_uidx`) — the route-level
  `DEPLOYMENT_BUSY` check is the friendly fast path; the index is the
  correctness backstop for two requests that both pass the check before
  either inserts. Domain jobs are outside the guard (they never race an
  executor over the stack/service), and so is CONFIG_UPDATE: secret
  delivery must be able to queue a config job during an active
  install/deploy (the secret value rides the payload transiently), and the
  relay executes its commands sequentially anyway.
- `GET /api/relay/commands` claims jobs atomically (single
  UPDATE … RETURNING), so overlapping polls cannot hand the same command
  out twice; `POST /api/relay/commands/:id/result` ignores results for
  settled jobs (`alreadySettled`), so a relay retry or a late report after
  force-complete cannot flip state twice or recompute release pointers.
- AWS-side, every relay executor reads before it writes
  (describe-before-create/delete, running-digest short-circuit), so a
  re-delivered or re-offered command converges on real AWS state instead of
  duplicating a mutation.

## Reconciliation: the watchdog repairs, it does not guess

`sweepStuckJobs` (worker Lambda, 15-minute schedule) runs two clocks per
active mutating job:

- **Staleness** (`lastProgressAt` vs per-type `JOB_TIMEOUTS_MS`): heartbeats
  refresh `lastProgressAt` on every active job, so staleness means the
  relay itself went quiet. The job is parked `WAITING`
  (`operation.waiting_for_relay`) — never failed, because the operation may
  have completed in AWS. The relay's next command poll claims WAITING jobs
  back and resumes from its checkpoint. Only after a 24-hour grace does the
  watchdog fail it (`RELAY_DISCONNECTED`).
- **Runtime** (`startedAt` vs per-type `JOB_MAX_RUNTIME_MS`): the inverse
  hazard — a relay invocation that died between an AWS mutation and its
  checkpoint (SSM pending-marker) write leaves a RUNNING job that
  heartbeats keep fresh forever. Past the runtime bound the job is
  **re-offered** to the relay (state back to REQUESTED, bounded by
  `reconcileCount`, `operation.requeued` event); the describe-first
  executors then resolve the true state — a stack that completed is adopted
  and verified into success, a rolled-back one fails honestly. Only
  exhausted re-offers fail (`UNKNOWN`).
- **DESTROY never fails from the watchdog.** A dead-relay teardown is
  settled by the vendor's force-complete escape hatch
  (`cleanupState: SKIPPED_RELAY_OFFLINE` — explicitly *not* claiming AWS
  resources were removed; PURGE later verifies and clears retained
  leftovers). PURGE itself has a staleness timeout so it cannot block
  retries forever.

The uncertain-result rule: nothing ever assumes a timed-out external call
failed. The relay's resumers re-describe AWS before acting; the control
plane re-offers rather than failing; a duplicate result is a no-op.

## Failure classification and retry policy

- The relay reports a `failureCode`; the control plane **refines** coarse
  defaults (`STACK_CREATE_FAILED`, `AWS_PERMISSION_DENIED`, `UNKNOWN`,
  `STACK_DELETE_FAILED`) deterministically from the error text plus the
  persisted CloudFormation events (`apps/api/src/failure-classification.ts`)
  — server-side on purpose, because relay code in customer accounts never
  updates in place. Specific relay classifications are never second-guessed;
  the event payload records the relay's original code when refinement
  changed it.
- Every code carries a **recoverability** class (`@deployz/copy-map`):
  `RECONCILE_FIRST` (may repair itself — wait/check before acting),
  `USER_ACTION` (permissions/quota/app config must change first),
  `DEPLOYZ_ACTION` (our side of the boundary — support, not retry loops),
  `TERMINAL` (retrying cannot help as-is). The diagnostics endpoint serves
  it; the diagnostic card leads with it.
- There is deliberately no generic retry-everything loop. Transient AWS
  errors are absorbed inside the relay's wait loops (unreadable-poll
  budget, bounded backoff); ambiguous outcomes go through reconciliation;
  permanent failures stop.

## First-install recovery

`ROLLBACK_COMPLETE` cannot brick a deployment: the vendor's retry-install
route (guarded by "never successfully installed" — a deployment that was
ever healthy keeps its data-protection guarantees) runs the relay's
recovery pass: delete the terminal-failed stack; on DELETE_FAILED, clear
the known retained blockers (RDS deletion protection off + delete,
ElastiCache delete — identified from the failed stack's own resource list,
never by name); recreate; re-verify. Retained S3 buckets are deliberately
left (inert, empty, blocked by IAM tag-condition semantics). See
`docs/superpowers/specs/2026-08-27-failed-install-recovery.md`.

## Health is verified, never assumed

CloudFormation success alone never marks a deployment healthy: INSTALL
success leaves the deployment INSTALLING, and only the relay's runtime
health verification (ECS running counts + ALB target health, reported via
heartbeat) advances it to HEALTHY. The derived customer/vendor stage shows
READY only with confirmed health plus an https URL.

## The trust boundary shapes everything

The control plane has **zero** AWS access into customer accounts; the relay
is the only path. That is why reconciliation is expressed as "re-offer to
the relay" rather than "describe from the control plane", why relay loss is
a first-class state (`WAITING`, `relayStatus: DISCONNECTED`,
force-complete) rather than an error, and why classification/refinement
lives server-side.

## Where the guarantees are tested

- Settlement/exclusivity/duplicate-result: `apps/api/src/failure-semantics.test.ts`,
  `deploy-contract.test.ts`, `server.test.ts`.
- Watchdog/reconciler: `packages/cdk/test/worker.test.ts` (the sweeps run in
  the worker Lambda, which the simulated E2E harness deliberately does not
  boot).
- Relay durability (resume, describe-first, recovery):
  `packages/relay/src/*.test.ts`.
- End-to-end failure boundaries: the simulated scenario suite
  (`docs/testing/e2e-scenarios.md`) — including `duplicate-request`,
  `transient-aws`, and `relay-death-destroy` in
  `e2e/scenario-resilience.spec.ts`.
