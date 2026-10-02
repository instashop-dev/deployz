# Deployment resilience — how the lifecycle stays recoverable

How Deployz keeps deployments from becoming duplicated, stuck, misreported,
or unrecoverable. **Read this before changing deployment/job/relay logic.**
For the test harness, see `docs/testing/simulated-e2e.md`; for diagnosing
a live deployment, see
`docs/operations/troubleshooting.md`; for the surrounding architecture, see
`docs/architecture.md`.

The guiding principle: the control plane does not try to prevent every AWS
or application failure. It always knows what happened, preserves the safest
known state, and provides a deterministic path forward.

## The domain model

- **Deployment** (`deployments` row) — the long-lived customer environment.
  Its `state` is the lifecycle of the environment, deliberately distinct
  from the outcome of any one operation and from runtime health
  (`healthStatus`: UNKNOWN / HEALTHY / DEGRADED / UNHEALTHY) and relay
  connectivity (`relayStatus`: CONNECTED / DISCONNECTED / UNKNOWN), which
  are separate columns. The states and their transitions:

  | State | Entered when | Leaves to |
  | --- | --- | --- |
  | `NOT_INSTALLED` | deployment created | `WAITING_FOR_RELAY` (customer launches the Quick Create), `DELETED` (disconnect before install) |
  | `WAITING_FOR_RELAY` | launch recorded | `INSTALLING` (relay registers, INSTALL job created), `DELETED` |
  | `INSTALLING` | INSTALL claimed; also a retry-install | `HEALTHY` (heartbeat verifies runtime health after INSTALL success), `FAILED` (INSTALL fails) |
  | `HEALTHY` | runtime health verified; a day-2 job succeeded with no newer release | `UPDATING`, `UPDATE_AVAILABLE`, `DELETING` |
  | `UPDATE_AVAILABLE` | a newer READY release exists | `UPDATING`, `DELETING` |
  | `UPDATING` | DEPLOY_RELEASE / ROLLBACK / RESTART running | `HEALTHY` or `UPDATE_AVAILABLE` (success, or a failed day-2 job whose previous release still serves), `FAILED` (a failed first deploy of a configured-first-start install) |
  | `FAILED` | first install or destroy failed | `INSTALLING` (retry-install), `UPDATING` (deploy again after a first-start failure), `DELETING` |
  | `DELETING` | DESTROY queued | `DELETED` (success or force-complete), `FAILED` (destroy failed) |
  | `DELETED` | terminal; `cleanupState` tracks purge (`SKIPPED_RELAY_OFFLINE`, `PURGE_FAILED`, `COMPLETE`) | — |

  `DISCONNECTED` exists in the enum but nothing writes it as a deployment
  state; relay loss is `relayStatus`, not a lifecycle state.
- **Release** (`releases` row) — an immutable version/build.
  `currentReleaseId` points at the release that is really running, and only
  the heartbeat's digest reconciliation advances it — and only when that
  heartbeat shows the new digest running, rollout COMPLETED, full task
  counts, healthy ALB targets and a successful HTTP probe.
  A SUCCEEDED DEPLOY_RELEASE/ROLLBACK job result alone never advances the
  pointer, so after any failure it still names what is really running. There
  is no separate lastHealthyRelease column because `currentReleaseId` IS that
  pointer by construction.
- **Customer** (`customers` row) — who the deployment is for. `name`, `email`
  and `company` are contact metadata the vendor edits freely; the immutable
  `id` is the only thing anything is anchored to (`deployments.customer_id`,
  `application_configs.customer_id`, `event_logs.customer_id`). Email is never
  an identifier and is not unique. So `PATCH /api/customers/:id` writes three
  text columns and nothing else: no install link is reissued, no deployment
  changes hands, nothing in AWS is touched. `DELETE /api/customers/:id`
  refuses any customer that still has a deployment row — including a `DELETED`
  one, which may hold retained resources — because removing a record must
  never become a path to removing infrastructure. Disconnect and Purge on the
  deployment stay the only things that reach a customer's AWS account.
- **Operation** (`deployment_jobs` row) — one durable mutation (INSTALL,
  DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE, DESTROY, PURGE, domain
  jobs). Carries identity (`idempotencyKey`), lifecycle
  (`REQUESTED/QUEUED/WAITING/RUNNING/SUCCEEDED/FAILED/CANCELLED`), progress
  (`lastProgressAt`), classification (`failureCode`), and the watchdog's
  re-offer counter (`reconcileCount`).

## A failed update is not a failed deployment

The core semantic rule (`deploymentStateAfterFailedJob` in
`@deployz/contracts`, applied identically by the relay result route, the
watchdog, and the stack-event progress route's settlement backstop):

- A failed **day-2 operation** (deploy/rollback/restart) on a deployment
  with a running release returns the deployment to `UPDATE_AVAILABLE` (a
  newer READY release exists) or `HEALTHY` — the ECS circuit breaker
  restored the previous release, which never stopped serving. A running
  install counts here even when `currentReleaseId` is still null: the
  pointer advances only once the heartbeat verifies the auto-deployed
  release, so a SUCCEEDED install is itself a running workload. The FAILED job
  carries the failure; the status derivation surfaces it
  (`deploymentStatus.failure`) without regressing the live stage, and the
  vendor UI adds "The previous version is still running."
- A failed **first install** or **destroy** marks the deployment `FAILED` —
  there, the operation's failure IS the environment's.
- A **configured first start** (DEPLOY-009): when a vendor value or a
  Deployz-generated secret must reach the task before it can boot
  (`configPrecedesFirstStart`, `apps/api/src/install-config.ts`) and a READY
  release exists, the INSTALL creates the stack with `param_DesiredCount=0`
  and carries `startAfterConfig` in its payload. The stack completes without
  ever running an unconfigured task; the post-install `CONFIG_UPDATE`
  (queued first) registers the configured task-definition revision, and the
  auto-deploy of the newest READY release scales the service up and waits
  for the rollout (`packages/relay/src/deploy.ts`, `FIRST_START_DESIRED_COUNT`).
  Such an install counts as a running workload only once a deploy has
  started it (`hasStartedInstall`), so a failed first deploy marks the
  deployment `FAILED` like a failed install would; the relay scales the
  rolled-back service back to zero so the template's unconfigured
  definition never churns. Recovery is deploying again after the
  configuration is fixed (`requireDeployableState` allows a FAILED
  deployment whose install succeeded); retry-install stays for installs that
  never created a stack.
- A failed **CONFIG_UPDATE** or **PURGE** never touches deployment state
  (a failed purge used to resurrect a DELETED deployment); a purge failure
  lands on `cleanupState: PURGE_FAILED` instead, which keeps it retryable.
  Domain jobs (CONFIGURE_DOMAIN/REMOVE_DOMAIN) follow the same rule: their
  failures surface on the `custom_domains` row, never on the deployment.

The customer-facing retry (`POST /api/install/:id/retry`,
`POST /api/deploy-links/:id/retry`) re-arms a first install with a fresh
enrollment code and credential. It is refused after any successful install and
outside NOT_INSTALLED, WAITING_FOR_RELAY, INSTALLING and FAILED (for example
while a DESTROY runs); a retry during INSTALLING is allowed on purpose.

Retrying a failed update is just deploying again — `requireDeployableState`
allows it, and `retryAwareIdempotencyKey` mints a fresh attempt key once the
newest attempt under a base key is FAILED. Application rollback restores the
image and service configuration only; it never reverses database
migrations (documented limitation).

A READY release is deployable only while its image still exists in the
control-plane registry. `requireDeployableRelease` asks the registry at
request time (deploy, rollback, bulk deploy, the post-install auto-deploy),
so a release the page listed before its image was deleted is refused with
409 `RELEASE_UNAVAILABLE` rather than queued to fail; the release is marked
`image_unavailable_at` (sticky, served as `UNAVAILABLE`) and the running
release is untouched. The uncertain-result rule applies here too: a registry
that does not answer marks nothing and lets the deploy proceed, where the
pipeline's own image-pull failure and the circuit breaker stay honest
(`apps/api/src/release-images.ts`, `release-images.test.ts`).

## Migrations run once, before the rollout, and never on rollback

A deployment whose frozen spec carries a migration workload compiles one
`AWS::ECS::TaskDefinition` (family `DeployzAppMigration`) with the
migration command baked in at compile time. DEPLOY_RELEASE then runs a
fixed order:

``` text
install / database ready
    → run the migration task once (exit 0 required)
    → roll every service to the new digest
```

- **Ordering.** The migration always runs after the infrastructure and
  the database are ready and before any service updates.
- **Failure.** A non-zero exit or a stopped task fails the job with
  `MIGRATION_FAILED` (family, exit code, stopped reason). No service is
  updated, the previous release keeps serving, and the deployment
  returns to `UPDATE_AVAILABLE` — a failed migration is a failed update,
  not a failed deployment.
- **Verdict.** Only the application container's own exit code 0 succeeds.
  ECS reports runtime containers without their `essential` flag, so the
  relay finds the application container in the exact revision the task ran
  (its one essential container that runs the release image) and reads that
  container's exit code by name. A missing or ambiguous container, or a
  missing exit code, fails `MIGRATION_FAILED`; it never succeeds. A failed
  AWS read defers to the next poll on the same task. The crash-loop detector
  and the install failure evidence read exit codes the same way: an exit of
  a helper container (the RDS CA init container) never counts as the
  application's.
- **Exactly-once by identity.** The deploy payload's migration identity
  is sha256 over the frozen command plus the image digest. A SUCCEEDED
  DEPLOY_RELEASE job row carrying that identity proves the migration
  ran: a relay retry of a confirmed identity skips the run, while within
  one rollout the same task ARN resumes. A failed job never confirms an
  identity.
- **Trust boundary.** The relay runs only the family the control plane
  names. The payload carries `{family, identity}`; a payload with a
  command string is rejected and dropped — the relay can never execute
  an arbitrary command.
- **ROLLBACK and RESTART never run migrations.** Application rollback
  restores the image and service configuration only; it never reverses
  database migrations, and no down-migration orchestration exists. Every
  rollback affordance in the UI carries the warning verbatim
  ("Application rollback does not automatically reverse database
  migrations."), and vendors must write backward-compatible migrations.

## One-shot task families stay current without a CloudFormation update

The migration family and every scheduled-job family (Phase 5) are compiled
into the stack once, with the INSTALL-time image baked in. DEPLOY_RELEASE and
ROLLBACK never touch CloudFormation, so a family's latest revision would
otherwise keep running whatever image the last stack operation set — never
the new release. `registerReleaseImageIntoFamily`
(`packages/relay/src/deploy.ts`) is the one generic, bounded step that keeps
a named family current: it reads the family's latest ACTIVE revision, skips
registration when that revision already runs the target digest (idempotent
and retry-safe), and otherwise registers a new revision carrying the release
image.

- **The migration family** is brought current right before RunTask, on every
  DEPLOY_RELEASE and ROLLBACK. This fixed a real Phase 4 defect: the
  migration used to run whatever image the stack was installed with, never
  the release image being deployed.
- **Every scheduled-job family** is brought current only once a
  DEPLOY_RELEASE or ROLLBACK has otherwise **settled** — never before, never
  interleaved with the service rollout. A failed update must leave scheduled
  jobs running the previous release's image, the same as it leaves services.
- **A registration error keeps the command in progress, not failed.** The
  services may already be running the release by the time a scheduled-job
  family fails to register, so treating that failure as a failed update
  would be dishonest — the previous release is no longer what serves. The
  command stays "in progress" (carrying any already-confirmed migration
  identity, so it is never re-run) and the next poll retries, bounded by the
  same in-progress grace as any other rollout. A scheduled-job family issue
  never fails an otherwise-successful release.
- **The relay only ever registers into a compiler-generated family name.**
  `TASK_FAMILY_PATTERN = /^DeployzApp[A-Za-z0-9]+$/` is a trust-boundary
  check on every family name the control plane sends (the migration family
  and every scheduled-job family alike) — the relay can never be pointed at
  an arbitrary family from a payload.

Scheduled-job task runs sit outside health and readiness semantics entirely.
No ECS service backs a scheduled job, so nothing verifies it the way a
service's rollout is verified: EventBridge Scheduler successfully invoking
`RunTask` is not the same as the task completing its actual work, and
Deployz has no execution-history subsystem for scheduled runs. Outcome
visibility for a scheduled job is only through the customer's own ECS
console and CloudWatch Logs — the same as for the migration task, which is
likewise proven only by its exit code, never by a long-lived service.

## Idempotency and exclusivity

- Every operation has a durable idempotency key
  (`{deploymentId}:{TYPE}[:{releaseId}][:RETRY:n]`). A caller's
  `Idempotency-Key` header replaces it as
  `{deploymentId}:{TYPE}:client:{header}`: job keys are unique across all
  deployments, so the header is scoped to one deployment and one job type
  and can never return another deployment's or operation's job.
  `createOrReuseJob` inserts with
  ON CONFLICT DO NOTHING and replays the existing job for a duplicate.
- **One active mutating job per deployment**, enforced by a partial unique
  index (`deployment_jobs_one_active_mutating_uidx`) — the route-level
  `DEPLOYMENT_BUSY` check is the friendly fast path; the index is the
  correctness backstop for two requests that both pass the check before
  either inserts. Domain jobs are outside the guard (they never race an
  executor over the stack/service), and so is CONFIG_UPDATE: secret
  delivery must be able to queue a config job during an active
  install/deploy (for a deployment whose relay is not yet connected the
  secret values live in the pending-secrets vault and are delivered through
  the authenticated relay config endpoint; for a connected relay they ride
  the job payload until the relay claims it, after which the stored payload
  is redacted — see `docs/pending-secret-delivery.md`), and the relay
  executes its commands sequentially anyway.
- `GET /api/relay/commands` claims jobs atomically (single
  UPDATE … RETURNING), so overlapping polls cannot hand the same command
  out twice; `POST /api/relay/commands/:id/result` ignores results for
  settled jobs (`alreadySettled`), so a relay retry or a late report after
  force-complete cannot flip state twice or recompute release pointers.
- AWS-side, every relay executor reads before it writes
  (describe-before-create/delete, running-digest short-circuit), so a
  re-delivered or re-offered command converges on real AWS state instead of
  duplicating a mutation.
- **A pending command carries authority.** Before it resumes or provisions,
  the relay asks the control plane whether the command is still active
  (`GET /api/relay/commands/:id/authority`). A superseded command never
  mutates AWS; an ambiguous answer defers every mutation. See
  "Pending-command authority and safe recreation" below.

## Pending-command authority and safe recreation

A deferred INSTALL must never recreate a stack the control plane has
superseded. Before it resumes or provisions, the relay asks the control
plane `GET /api/relay/commands/:id/authority` (authenticated with the
relay bearer token; returns `{active, jobState, reason?}`). Authority is
false when the job settled or was cancelled, when the deployment is
DELETING/DELETED, or when a later DESTROY superseded an INSTALL. A network
or 5xx answer is ambiguous: the relay defers all mutations and asks again
on the next poll. The decision record is
`docs/decisions/pending-command-authority.md`.

`installApplicationStack` has three create modes:

- `fresh` — a first install creates the stack when it is absent.
- `resume` — a resumed install adopts an existing stack and never recreates
  a missing one.
- `recovery` — the authorized first-install recovery may recreate after
  `DELETE_IN_PROGRESS` becomes absent. Recovery rechecks authorization
  immediately before every `CreateStack`.

A read distinguishes a confirmed absent stack from a failed read. A
throttle, a permission denial or a transport error (`absent: false` plus an
`errorCode`) is never evidence that the stack was deleted. A run of
unreadable reads fails the install with that distinction; it does not claim
the stack was deleted.

On terminal settle the INSTALL resumer writes a `settled` marker (the
result plus `settledAt`) instead of clearing first. The marker is cleared
only after the result report succeeds (`onResultReported`). A failed report
retries without rerunning provisioning. Every clear and write uses
`compareAndSet`, so a newer command's marker is never cleared or
overwritten.

DESTROY cancels an obsolete INSTALL before the idle check: a DISCONNECTED
relay's active INSTALL can never complete, so it must not block the
teardown the vendor asked for. A CONNECTED relay's in-flight INSTALL still
blocks DESTROY through operation exclusivity.

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
  exhausted re-offers fail (`UNKNOWN`). One edge case: a REQUESTED job that
  a CONNECTED relay never claims within its staleness window also fails
  `UNKNOWN` without a re-offer (rare, because heartbeats refresh REQUESTED
  jobs too).
- **DESTROY never fails from the watchdog.** A dead-relay teardown is
  settled by the vendor's force-complete escape hatch
  (`POST /api/deployments/:id/disconnect/force-complete`, also a Team Admin
  action): allowed only when the relay is `DISCONNECTED` and the pending
  DESTROY has been stale for at least 60 minutes, or at least two
  consecutive DESTROY attempts have failed and 60 minutes have passed;
  otherwise `409 DESTROY_NOT_STALE`, `RELAY_NOT_OFFLINE` or
  `NO_PENDING_DESTROY`. It records `cleanupState: SKIPPED_RELAY_OFFLINE` —
  explicitly *not* claiming AWS resources were removed; PURGE later verifies
  and clears retained leftovers. PURGE itself has a staleness timeout so it
  cannot block retries forever.

| Job type | Staleness (`JOB_TIMEOUTS_MS`) | Maximum runtime (`JOB_MAX_RUNTIME_MS`) |
| --- | --- | --- |
| INSTALL | 60 min | 90 min |
| DEPLOY_RELEASE, ROLLBACK, RESTART, CONFIG_UPDATE | 20 min | 30 min |
| DESTROY | none (never failed by the watchdog) | 90 min (re-offered) |
| PURGE | 60 min | 90 min |
| CONFIGURE_DOMAIN, REMOVE_DOMAIN | 60 min | 90 min |

Re-offers are bounded at three per job. The same schedule also runs the
relay-liveness sweep: a relay with no heartbeat for 15 minutes
(`RELAY_STALE_AFTER_MS`) is marked `DISCONNECTED`, which the UI shows and
which retry eligibility respects.

The uncertain-result rule: nothing ever assumes a timed-out external call
failed. The relay's resumers re-describe AWS before acting; the control
plane re-offers rather than failing; a duplicate result is a no-op.

### Progress reporting

During INSTALL and DESTROY the relay polls `DescribeStackEvents` inside its
existing wait loop (no second polling loop, worker, queue or WebSocket) and
posts new events to `POST /api/relay/commands/:id/progress`, which stores
them in `deployment_stack_events` (deduplicated on the provider event id),
refreshes `lastProgressAt` so the watchdog stays fed during long installs,
and derives the customer-facing provisioning phases. CloudFormation's own
stack status stays authoritative: events are progress only, a completed
stack never marks a deployment HEALTHY by itself, and `DELETE_*` /
`ROLLBACK_*` resource events never flip a phase to FAILED — only a genuine
`*_FAILED` with a non-boilerplate reason does. Lambda, IAM, log and secret
resources map to no customer-visible phase. Resource properties are never
forwarded.

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

## Disconnect retains data on purpose: DESTROY vs PURGE

DESTROY (disconnect) is a data-preserving teardown, and **a DESTROY that
retains data is a success**. Before the delete call, the relay stops any
standalone task still running in the stack's own cluster — an ECS task whose
`group` starts with `family:` (a scheduled-job run, or a migration mid-run)
rather than a service. Nothing else stops these: CloudFormation's own
`AWS::ECS::Service` deletion drains service-managed tasks as part of the
stack's normal delete sequence, but a standalone task left running blocks
the cluster's own delete with `ClusterContainsTasksException`, which would
otherwise land the whole stack on `DELETE_FAILED`. This step is best-effort
and scoped to the stack's own cluster only — a task that cannot be stopped
just leaves the stack on the same `DELETE_FAILED` recovery path described
below. The relay deletes the application stack; the
deletion-protected RDS instance (PostgreSQL or MySQL) fails its delete only
after the security
group and subnet it pins, so the stack first lands on `DELETE_FAILED` —
expected pacing (45+ minutes of CloudFormation retrying), not a failure.
The relay lists the `DELETE_FAILED` resources and re-issues
`delete-stack` with `RetainResources`, repeating the pass on each poll
until the stack reaches `DELETE_COMPLETE`. The deployment then settles
`DELETED` — truthfully: the application, network and cache are gone; the
database, its credential secrets and the bucket are deliberately retained
(no final snapshot is ever taken), clearly visible, and removable by
PURGE.

PURGE is the second, explicit half. It deletes the retained data — every
retained RDS instance (PostgreSQL or MySQL; deletion protection off,
`SkipFinalSnapshot`), **every owned
application secret regardless of infrastructure generation** (anything
carrying the installation tag that is not the relay's own
`deployz:component=bootstrap` secret), the bucket (every version), ACM
certificates, subnet groups and network orphans — one kind per relay poll.
A failed purge lands on `cleanupState: PURGE_FAILED` and stays retryable.

## First-install recovery

`ROLLBACK_COMPLETE` cannot brick a deployment: the vendor's retry-install
route (guarded by "never successfully installed" — a deployment that was
ever healthy keeps its data-protection guarantees) runs the relay's
recovery pass: delete the terminal-failed stack; on DELETE_FAILED, clear
the known retained blockers (RDS deletion protection off + delete,
ElastiCache replication-group delete — identified from the failed stack's
own resource list, never by name); recreate; re-verify. Retained S3 buckets
are deliberately left (inert, empty, blocked by IAM tag-condition
semantics). The decision record is `docs/decisions/failed-install-recovery.md`.

Recovery is the only recreation path. A normal install creates a stack
only when none exists; a resumed install adopts an existing stack and
never recreates a missing one. Only the authorized recovery pass may
recreate a stack the previous attempt lost — see "Pending-command
authority and safe recreation" above and
`docs/decisions/pending-command-authority.md`.

## Health is verified, never assumed

CloudFormation success alone never marks a deployment healthy: INSTALL
success leaves the deployment INSTALLING, and only the relay's runtime
health verification (ECS running counts + ALB target health, reported via
heartbeat) advances it to HEALTHY. The derived customer/vendor stage shows
READY only with confirmed health plus an https URL. A missing required
infrastructure component is reported, never repaired automatically.

## The trust boundary shapes everything

The control plane has **zero** AWS access into customer accounts; the relay
is the only path. That is why reconciliation is expressed as "re-offer to
the relay" rather than "describe from the control plane", why relay loss is
a first-class state (`WAITING`, `relayStatus: DISCONNECTED`,
force-complete) rather than an error, and why classification/refinement
lives server-side.

Verification expectations follow the same rule. `databaseRequired` and
`redisRequired` are explicit booleans derived from the deployment's stored
spec's verification contract (frozen at creation — see the domain model
above), never a silent default. The relay never assumes a database is
required. Until the
control plane's poll response has told it what this deployment actually
needs, it skips verification for that heartbeat instead of checking against
a guess. This keeps verification honest about what it does not yet know,
the same way the uncertain-result rule keeps reconciliation honest.

## Where the guarantees are tested

- Settlement/exclusivity/duplicate-result: `apps/api/src/failure-semantics.test.ts`,
  `deploy-contract.test.ts`, `server.test.ts`.
- Watchdog/reconciler: `packages/cdk/test/worker.test.ts` (the sweeps run in
  the worker Lambda, which the simulated E2E harness deliberately does not
  boot).
- Relay durability (resume, describe-first, recovery):
  `packages/relay/src/*.test.ts`.
- Real AWS, end to end (release build → install → deploy → rollback → failed
  release → recovery → destroy → purge → leak audit): the version canary,
  `docs/testing/aws-e2e.md` — the MVP release gate, with the
  product semantics it enforces (serving release, last successful release,
  latest attempt, rollback, persistent data) in one table.
- End-to-end failure boundaries: the simulated scenario suite
  (`docs/testing/simulated-e2e.md`) — including `duplicate-request`,
  `transient-aws`, and `relay-death-destroy` in
  `e2e/scenario-resilience.spec.ts`, `stale-install-resurrect` in
  `e2e/scenario-recovery.spec.ts`, and the DESTROY-retains /
  PURGE-removes proof in `retained-delete-recovery`
  (`e2e/scenario-lifecycle.spec.ts`).
