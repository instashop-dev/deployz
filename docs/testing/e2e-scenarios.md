# Simulated E2E scenarios

Fifteen scenarios ship today, registered in
`e2e/simulation/scenarios/index.ts`. Every terminal-status column below is
the **honest, observed** production behaviour (verified against the actual
spec assertions and, where noted, against production logic itself) — not the
behaviour a naive reading of the scenario name would suggest.

"Main UI expectation" describes what the vendor/customer surfaces would show,
based on the same `deploymentStatus`/`healthStatus` fields these tests assert
over the HTTP API (`apps/web/src/lib/deployment-vocabulary.ts` is the single
source of the UI's wording for these). Phase 1's scenario specs drive the
real HTTP API only — no browser is involved yet.

| Scenario id | Simulates | Terminal status | Main UI expectation | Main backend expectation | Test file |
| --- | --- | --- | --- | --- | --- |
| `happy-path` | Full successful install: network, database, storage, ALB/target-group, ECS service all `CREATE_COMPLETE`; ECS reports every target healthy | `state: HEALTHY`, `healthStatus: HEALTHY`; `deploymentStatus.stage: VERIFYING`, `step: TLS` (holds here — no custom domain configured, so the customer-facing ladder never reaches READY over plain HTTP) | "Waiting for secure domain setup" | Stack events persisted for every resource; resource inventory `technicalResourceCount > 0`; `stepTimings` populated | `e2e/scenario-install.spec.ts` |
| `cloudformation-rollback` | RDS `CREATE_FAILED` (AZ/instance-class mismatch) mid-install; stack rolls back to `ROLLBACK_COMPLETE` | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE` | "Failed" | Persisted `CREATE_FAILED` event on `ApplicationDatabase` with the AZ-mismatch reason | `e2e/scenario-install.spec.ts` |
| `ecs-failure` | Infra completes fine; `AWS::ECS::Service` `CREATE_FAILED` ("Service failed health checks"); stack rolls back | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE` | "Failed" | `ApplicationService` event carries the health-check reason; `ApplicationDatabase` shows `CREATE_COMPLETE` (failure is application-specific, not infra-wide) | `e2e/scenario-install.spec.ts` |
| `healthcheck-failure` | Stack reaches `CREATE_COMPLETE` and `verifyInstallation` passes, but every ALB target is unhealthy | `state: HEALTHY`, `healthStatus: UNHEALTHY`; `deploymentStatus.stage: VERIFYING`, `step: HEALTH_CHECK`, `failure: null` — install succeeded; runtime health is a separate, honestly-UNHEALTHY signal | "Running health checks" — never Failed, never Ready | No `CREATE_FAILED` events; resource inventory populated | `e2e/scenario-install.spec.ts` |
| `slow-provision` | RDS stays `CREATE_IN_PROGRESS` for ~15 virtual minutes (past `DATABASE_STORAGE`'s 720s typical max) before the rest of the stack completes | Mid-flight: `stage: PROVISIONING`, `step: DATABASE_STORAGE`, `takingLongerThanUsual: true`; terminal: `state: HEALTHY`, `takingLongerThanUsual: false` | An ETA/"taking longer than usual" flag during the database step, Healthy once settled | `typicalDurationSeconds: { min: 180, max: 720 }` present for the active step | `e2e/scenario-provisioning.spec.ts` |
| `cloudformation-failure` | `AWS::EC2::VPC` `CREATE_FAILED`; the stack terminates directly at `CREATE_FAILED` — **no rollback at all** | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: CREATE_FAILED` (distinct from the rollback scenarios above) | "Failed" | `ApplicationVpc` `CREATE_FAILED` event; no `ROLLBACK_*` events anywhere in the persisted log | `e2e/scenario-provisioning.spec.ts` |
| `database-failure` | RDS `CREATE_FAILED` on a capacity reason; stack rolls back to `ROLLBACK_COMPLETE`; network completed first | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE`, `step: DATABASE_STORAGE` (exactly one failed category) | "Failed" at the database step | `ApplicationDatabase` event reason contains `InsufficientDBInstanceCapacity` | `e2e/scenario-provisioning.spec.ts` |
| `redis-failure` | Network + database complete; `AWS::ElastiCache::ReplicationGroup` `CREATE_FAILED`; stack rolls back. Uses the real analyser (`deployz-demo/bullmq-worker`) so `redisRequired` comes from production analysis, not a hand-set flag | `state: FAILED`; `failure.code: STACK_CREATE_FAILED`, `failure.awsStatus: ROLLBACK_COMPLETE`, `step: REDIS` | Install page lists "Redis cache" under what will be created; "Failed" at the Redis step | `GET /api/install/:id` `resourcesCreated` contains `Redis cache`; `ApplicationRedis` event type is `AWS::ElastiCache::ReplicationGroup` | `e2e/scenario-provisioning.spec.ts` |
| `bootstrap-failure` | The customer's bootstrap stack fails before the relay Lambda inside it ever registers — no relay ever starts | `state: WAITING_FOR_RELAY`; `stage: WAITING_FOR_AWS`, `step: AWS_SETUP`, `failure: null` — stable, not a false Failed/stuck state | "Waiting for AWS" | `GET /api/install/:id` reports `waitingForRelay: true`, `relayStuck: false` | `e2e/scenario-provisioning.spec.ts` |
| `relay-disconnect` | The relay registers, reports one early progress batch, then goes silent for the rest of the test (`stopAfterFirstProgress`) | Holds `state: INSTALLING`, `stage: PROVISIONING`, `step: NETWORK` (its last genuinely-known step), `job: { type: INSTALL, status: RUNNING }` — never regresses, never a false terminal state | "Installing" at the network step | Persisted stack-event count stops growing after the first batch | `e2e/scenario-provisioning.spec.ts` |
| `update-failure` | Install reaches HEALTHY; a `v1` release deploys and succeeds; a `v2` release rollout trips the ECS deployment circuit breaker | `state: UPDATE_AVAILABLE` (the deployment stays live — `v1` keeps serving); `failure.code: ECS_DEPLOYMENT_FAILED` surfaced on the live stage; `currentReleaseId` stays `v1` | Fleet shows the deployment live with the failed-update alert, `v1` still current | Event log contains `deploy.failed` | `e2e/scenario-lifecycle.spec.ts` |
| `rollback-success` | Same as `update-failure`, then a rollback to `v1` succeeds | `state: HEALTHY`, `failure: null`; `currentReleaseId` and `previousReleaseId` both `v1` (the honest pointer state — `v2` never advanced anything) | Healthy again after rollback | Event log contains `rollback.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `rollback-failure` | Same as `update-failure`, but the rollback to `v1` also fails | `state: UPDATE_AVAILABLE` (still live — `v1` never stopped serving); `failure.code: ECS_DEPLOYMENT_FAILED`; release pointers unchanged — never a false success | Live with the failure surfaced | Event log contains `rollback.failed`, never `rollback.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `delete-failure` | Install reaches HEALTHY; DESTROY hits a stack-level `DELETE_FAILED` with no attributable resource-level blocker | `state: FAILED` (**never** `DELETED`); `failure.code: STACK_DELETE_FAILED` | Never claims the deployment was removed | Event log contains `destroy.failed`, never `destroy.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `retained-resources` | Install reaches HEALTHY; DESTROY completes cleanly (`DELETE_COMPLETE`) | `state: DELETED` | Infrastructure section shows database/storage as retained, application as removed | `infra.components`: `database`/`storage` status `retained`, `application` status `removed`; event log contains `destroy.completed` | `e2e/scenario-lifecycle.spec.ts` |
| `duplicate-request` | Two concurrent deploys of the same release race each other; a different release is requested while the first is active | One logical job (both responses name the same `jobId`); the different release gets 409 `DEPLOYMENT_BUSY`; exactly one `deploy.requested`/`deploy.completed` event pair | — | Uses the `happy-path` scenario definition | `e2e/scenario-resilience.spec.ts` |
| `transient-aws` | The first two post-create `DescribeStacks` polls answer as unreadable (throttled/timed out) | Install still reaches `HEALTHY` — the wait loop rides out transient errors within its unreadable-poll budget | Normal install | `transientDescribeFailures` scenario knob | `e2e/scenario-resilience.spec.ts` |
| `relay-death-destroy` | The teardown starts in the account, then the relay invocation dies mid-DESTROY (its poll cycle hangs) | `state` stays `DELETING` — never a false `DELETED` or `FAILED`; no `destroy.completed`/`destroy.failed` event; force-complete is the production escape hatch | Honest "deleting" until the vendor force-completes | `dieDuringDestroy` relay knob over `retained-resources` | `e2e/scenario-resilience.spec.ts` |

Browser-level coverage: `e2e/scenario-ui.spec.ts` drives four of these
scenarios (`happy-path`, `slow-provision`, `cloudformation-rollback`, and
`update-failure` → `rollback-success`) through a real Chromium browser against
both the customer install page and the vendor deployment detail page — the API
specs above prove the pipeline; this file proves both UIs render it honestly.

## How to add a scenario

1. **Fixture file** — add `e2e/simulation/scenarios/<id>.ts` exporting a
   `ScenarioDefinition` (`e2e/simulation/types.ts`). Most lifecycle scenarios
   spread an existing one (usually `happyPath`) and only add the
   lifecycle-specific knob (`updateRollouts`, `destroy`) rather than
   reauthoring a whole install timeline.
2. **Registry** — import and add it to the `SCENARIOS` map in
   `e2e/simulation/scenarios/index.ts`, and re-export it from that file.
3. **Spec** — add a `test.describe` block (in an existing
   `e2e/scenario-*.spec.ts` file, or a new one) with
   `test.use({ deployzScenario: '<id>' })` and a test titled
   `` `@scenario:<id> ...` `` so `--scenario=<id>`/`--scenarios` picks it up.

### The two-clock timeline

Each `TimelineEvent` carries two independent clocks:

- `afterMs` — **real** (wall-clock) milliseconds after install start at which
  the event becomes visible to the simulated account's readers. Kept in the
  tens-to-low-thousands range so the whole suite stays fast.
- `atVirtualMs` — **simulated** milliseconds elapsed "into the install" this
  event's `Timestamp` field reports — minutes scale, so ETA/step-timing logic
  sees a realistic duration.

Events must be authored in non-decreasing `afterMs` (and correspondingly
non-decreasing `atVirtualMs`) order — array order doubles as reveal order.
A minimal annotated example (two events, ~30ms of real time apart, 40
virtual seconds apart):

```ts
{
  afterMs: 30,           // revealed 30ms into the test, real time
  atVirtualMs: 0,        // reports as "0 seconds into the install"
  logicalResourceId: 'ApplicationVpc',
  resourceType: 'AWS::EC2::VPC',
  status: 'CREATE_IN_PROGRESS',
},
{
  afterMs: 80,           // revealed 50ms later, real time
  atVirtualMs: 40_000,   // but reports as "40 virtual seconds" later
  logicalResourceId: 'ApplicationVpc',
  resourceType: 'AWS::EC2::VPC',
  status: 'CREATE_COMPLETE',
},
```

## Convention

Every material deployment failure discovered in production or real E2E
should, where feasible, become a deterministic simulated regression scenario.
