# CloudFormation Progress Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the relay waits for a CloudFormation CREATE/DELETE operation, poll `DescribeStackEvents` inside the existing wait loop and surface real-time, deduplicated, phase-level progress on the vendor dashboard and customer install page.

**Architecture:** A new relay module (`stack-events.ts`) collects new stack events each tick of the EXISTING install wait loop (`install.ts::run()`) and batches them to a new relay-authenticated endpoint `POST /api/relay/commands/:id/progress`. The API persists raw events in a new `deployment_stack_events` table (unique on `deployment_id + provider_event_id`) and folds an event-derived provisioning snapshot into `deployments.observed_state.infraHealth.provisioning` — the exact shape `deriveDeploymentStatus` already consumes — so the existing six-stage/ten-step status pipeline and both UIs get fresher data with ZERO changes to the derivation logic. A vendor-only read endpoint plus a collapsed "Infrastructure events" disclosure gives raw diagnostics. The event cursor survives Lambda invocations via a new optional field on the SSM-persisted `PendingCommand`.

**Tech Stack:** TypeScript, Fastify (apps/api), Next.js 15 + shadcn (apps/web), Drizzle + PGlite (packages/db), AWS SDK v3 `@aws-sdk/client-cloudformation` (packages/relay), Vitest, Playwright.

## Global Constraints

- Do NOT create a second polling loop, new worker, SNS, EventBridge, WebSockets, or new AWS infrastructure. The only wait loop is `packages/relay/src/install.ts` `run()`.
- CloudFormation execution status stays authoritative. Event polling is progress/diagnostics only. Event-polling failure must NEVER fail a deployment — every new relay function is best-effort, never throws.
- Dedupe by CloudFormation `EventId`; idempotent across polls, retries, Lambda restarts, job retries. DB unique constraint `(deployment_id, provider_event_id)` + `onConflictDoNothing` is the durable guard.
- Process events oldest-first. Follow `NextToken` newest-first with a page cap; stop paging at the operation boundary or previously-seen events.
- Bound events to the current operation via the operation start time (executor start / `PendingCommand.startedAt`).
- Never persist or forward `ResourceProperties` (contains stack parameter values). Redact `ResourceStatusReason` with `redactSecrets` and cap at 500 chars. Never log secrets or stack parameter values.
- Do not mark the deployment HEALTHY because CloudFormation completed — do not touch `JOB_SUCCESS_STATE`, verification, or health flows.
- Raw CloudFormation lifecycle terms must not appear as string literals in `apps/web/src` (ESLint `no-restricted-syntax` hard-errors). Raw statuses appear only as dynamic values inside a diagnostic disclosure (Collapsible), vendor-only.
- No percentages or ETAs. Preserve existing `TYPICAL_STEP_DURATION_SECONDS` / `takingLongerThanUsual` behavior.
- Mixed-version tolerance: new relay against old API (404 on `/progress`) must swallow and continue; old relay against new API must work unchanged.
- New drizzle migration MUST also be registered in `packages/cdk/src/lambda/db-connection.ts` `MIGRATION_SQL` (CI test `packages/cdk/test/lambda-migrations.test.ts` enforces).
- CLAUDE.md: smallest necessary change; match existing style; no dead code/redundant comments. tsconfig has `strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — use `import type`, avoid assigning `undefined` to optional props.
- Verification commands (CI order): `pnpm build` (also the typecheck gate), `pnpm vitest run`, `pnpm lint`. E2E: `WEB_PORT=3100 API_PORT=3101 pnpm test:e2e -- e2e/<spec>` (always override ports).

## Reference map (from research; verify exact lines when editing)

- Wait loop: `packages/relay/src/install.ts` `run()` (~204–301), `DEFAULT_POLL_INTERVAL_MS = 15_000` (~170), `DEFAULT_BUDGET_MS = 180_000` (~169), `StackInstaller` (~122), `toInstaller` (~413), failure-only `describeStackEvents` (~485, `MAX_EVENT_PAGES = 5`), `CANCELLED_REASONS` (~305), `MAX_REASON_LENGTH = 500` (~328).
- Continuation: `packages/relay/src/pending.ts` `PendingCommand` (~32–50); executor defer-write in `packages/relay/src/index.ts` `createInstallExecutor` (~714, defer ~752–770), `createInstallResumer` (~798), `settleInstall` (~556), `createDefaultInstallDeps` (~1015).
- Relay HTTP: `packages/relay/src/poll.ts` `reportCommandResult` (~297–325) — copy its auth/fetch idiom.
- API ingest peers: `apps/api/src/server.ts` `POST /api/relay/commands/:id/result` (~3746), `POST /api/relay/health` (~3893), `advanceStepTimingsAfterWrite` (~823–873).
- Derivation: `apps/api/src/deployment-status.ts` `readProvisioningSnapshot` (~529) reads `observedState.infraHealth.provisioning.{stackStatus,observedAt,categories}`; categories are `network|database|storage|redis|application`, each `{status: 'IN_PROGRESS'|'COMPLETE'|'FAILED', startedAt?, completedAt?}`. Relay-side equivalent: `packages/relay/src/provision-progress.ts` `summarizeProvisioning` (type-prefix table ~65–78) — mirror its category semantics, including the "rollback debris does not mark a category FAILED" rule (commit ae71590) and truthful rollback handling (d6bbfb5).
- Redaction: `packages/analysis/src/redact.ts` `redactSecrets`, `normalizeErrorText`.
- DB idioms: `packages/db/src/schema/*.ts`, unique-index idiom in `custom-domains.ts`; test helper `packages/db/src/test-utils.ts` `createTestDb()`.
- API test idiom: `apps/api/src/relay-identity.test.ts` (PGlite → applyMigrations → createDb → createAuth → buildServer).
- Web: vendor page `apps/web/src/app/dashboard/deployments/[id]/page.tsx`; poll hook `apps/web/src/lib/use-status-poll.ts`; fetchers `apps/web/src/lib/deployments.ts`; Collapsible pattern `apps/web/src/components/diagnostic-card.tsx`.
- E2E idiom: `e2e/deployment-progress.spec.ts` (simulates relay over real HTTP; `JARGON` regex assertion).

---

### Task 1: `deployment_stack_events` table (schema + migration + Lambda bundling)

**Files:**
- Create: `packages/db/src/schema/stack-events.ts`
- Modify: `packages/db/src/schema/index.ts` (export the new table)
- Create (generated): `packages/db/drizzle/0020_*.sql` via `pnpm --filter @deployz/db db:generate`
- Modify: `packages/cdk/src/lambda/db-connection.ts` (import + `MIGRATION_SQL` entry)
- Test: `packages/db/src/stack-events.test.ts`

**Interfaces:**
- Produces: drizzle table `deploymentStackEvents` with columns `id, deploymentId, jobId, providerEventId, eventAt, logicalResourceId, resourceType, resourceStatus, resourceStatusReason, createdAt`; unique index `deployment_stack_events_dedupe_uidx (deployment_id, provider_event_id)`; index `deployment_stack_events_deployment_idx (deployment_id, event_at)`.

- [ ] **Step 1: Write the failing test** (`packages/db/src/stack-events.test.ts`, follow `createTestDb`/`seedBase` idioms from neighboring db tests):

```ts
import { describe, expect, it } from 'vitest';
import { createTestDb, seedBase } from './test-utils';
import { deploymentStackEvents, deployments } from './schema';

describe('deployment_stack_events', () => {
  it('stores one row per (deployment, provider event id) and ignores duplicates', async () => {
    const { db } = await createTestDb();
    const seed = await seedBase(db);
    // create a deployment row per the idiom used in deployments.test.ts (customerId/applicationId/organizationId/region)
    const [deployment] = await db.insert(deployments).values({
      customerId: seed.customer.id,
      applicationId: seed.application.id,
      organizationId: seed.organization.id,
      region: 'us-east-1',
      enrollmentCode: 'code-stack-events',
    }).returning();

    const row = {
      deploymentId: deployment!.id,
      providerEventId: 'event-1',
      eventAt: new Date('2026-09-01T10:00:00Z'),
      logicalResourceId: 'Vpc',
      resourceType: 'AWS::EC2::VPC',
      resourceStatus: 'CREATE_IN_PROGRESS',
    };
    await db.insert(deploymentStackEvents).values(row);
    await db.insert(deploymentStackEvents).values(row)
      .onConflictDoNothing({ target: [deploymentStackEvents.deploymentId, deploymentStackEvents.providerEventId] });

    const rows = await db.select().from(deploymentStackEvents);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @deployz/db exec vitest run src/stack-events.test.ts` (module/table missing). Note: relay/db packages have no local vitest config; run via root project filter if the package filter form fails: `pnpm vitest run --project db` or `pnpm vitest run packages/db/src/stack-events.test.ts`.
- [ ] **Step 3: Implement schema** (`packages/db/src/schema/stack-events.ts`) — match column-factory style of `custom-domains.ts` / `jobs.ts`; adapt drizzle "table extras" syntax to whatever the neighboring files use:

```ts
import { bigserial, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { deployments } from './deployments';
import { deploymentJobs } from './jobs';

// Raw CloudFormation stack events reported by the relay while it waits for a
// stack operation. Progress/diagnostics only — never an input to lifecycle
// decisions. Uniqueness on (deployment, provider event id) makes ingestion
// idempotent across relay retries and Lambda restarts.
export const deploymentStackEvents = pgTable(
  'deployment_stack_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deploymentId: uuid('deployment_id').notNull().references(() => deployments.id),
    jobId: uuid('job_id').references(() => deploymentJobs.id),
    providerEventId: text('provider_event_id').notNull(),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    logicalResourceId: text('logical_resource_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceStatus: text('resource_status').notNull(),
    resourceStatusReason: text('resource_status_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('deployment_stack_events_dedupe_uidx').on(table.deploymentId, table.providerEventId),
    index('deployment_stack_events_deployment_idx').on(table.deploymentId, table.eventAt),
  ],
);
```

Export from `packages/db/src/schema/index.ts` alongside the others.
- [ ] **Step 4: Generate migration** — `pnpm --filter @deployz/db db:generate`. Inspect the new `packages/db/drizzle/00XX_*.sql`.
- [ ] **Step 5: Bundle migration into the Lambda** — in `packages/cdk/src/lambda/db-connection.ts`, add the esbuild text import and `MIGRATION_SQL` map entry for the new journal tag, exactly mirroring entry 0019.
- [ ] **Step 6: Run tests** — the new db test passes; also `pnpm vitest run packages/cdk/test/lambda-migrations.test.ts` passes (proves bundling).
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: add deployment_stack_events table for CloudFormation progress"`.

---

### Task 2: Contracts — relay progress wire schemas + vendor stack-event type

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts` (extend)

**Interfaces:**
- Produces (verbatim, consumed by Tasks 3–5, 7, 9, 10):

```ts
export const relayStackEventSchema = z.object({
  eventId: z.string().min(1).max(255),
  timestamp: z.string().datetime({ offset: true }),
  logicalResourceId: z.string().min(1).max(255),
  resourceType: z.string().min(1).max(255),
  resourceStatus: z.string().min(1).max(64),
  resourceStatusReason: z.string().min(1).max(2000).optional(),
});
export type RelayStackEvent = z.infer<typeof relayStackEventSchema>;

export const relayCommandProgressSchema = z.object({
  commandId: z.string().min(1),
  installationId: z.string().min(1),
  stackName: z.string().min(1).max(255),
  events: z.array(relayStackEventSchema).min(1).max(50),
});
export type RelayCommandProgress = z.infer<typeof relayCommandProgressSchema>;

export const vendorStackEventSchema = z.object({
  id: z.number(),
  eventAt: z.string(),
  logicalResourceId: z.string(),
  resourceType: z.string(),
  resourceStatus: z.string(),
  resourceStatusReason: z.string().nullable(),
});
export type VendorStackEvent = z.infer<typeof vendorStackEventSchema>;
```

- [ ] **Step 1: Write failing tests** in `packages/contracts/src/index.test.ts`: a valid `relayCommandProgressSchema` payload parses; a payload with 51 events fails; a `resourceStatus` longer than 64 fails; `vendorStackEventSchema` round-trips a row shape.
- [ ] **Step 2: Run to verify fail** — `pnpm vitest run packages/contracts`.
- [ ] **Step 3: Add the schemas** near the other relay/status schemas, matching file conventions (section comments, `.strict()` is NOT used on relay ingest schemas — match how existing relay payloads are validated in server.ts; keep these plain `z.object`).
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `feat: add relay stack-event progress wire schemas`.

---

### Task 3: API — central phase mapper + event-derived provisioning snapshot

**Files:**
- Create: `apps/api/src/stack-event-progress.ts`
- Test: `apps/api/src/stack-event-progress.test.ts` (pure, no PGlite)

**Interfaces:**
- Consumes: `RelayStackEvent`-shaped rows (as `StoredStackEvent` below).
- Produces (verbatim, consumed by Task 4):

```ts
export type ProvisioningCategory = 'network' | 'database' | 'storage' | 'redis' | 'application';

export interface StoredStackEvent {
  readonly eventAt: Date;
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason: string | null;
}

export function categorizeResourceType(resourceType: string): ProvisioningCategory | null;

// Returns the same shape readProvisioningSnapshot() consumes:
// { stackStatus, observedAt, categories: { [cat]: { status, startedAt?, completedAt? } } }
export function summarizeStackEvents(
  stackName: string,
  events: readonly StoredStackEvent[],
  observedAt: string,
): Record<string, unknown> | null;
```

**Mapping (central, the only place resource types are normalized server-side):** mirror `packages/relay/src/provision-progress.ts`'s prefix table for parity, then extend for types the resource-based table may not cover. Target categories (these feed the existing steps NETWORK / DATABASE_STORAGE / REDIS / APPLICATION — do NOT invent new categories or steps):
- `AWS::EC2::` (VPC/Subnet/Route/SecurityGroup/NAT/InternetGateway/EIP…) → `network`
- `AWS::RDS::` → `database`
- `AWS::ElastiCache::` → `redis`
- `AWS::S3::` → `storage`
- `AWS::ECS::`, `AWS::ECR::`, `AWS::ElasticLoadBalancingV2::`, `AWS::CertificateManager::`, `AWS::Route53::` → `application`
- `AWS::Lambda::`, `AWS::IAM::`, `AWS::Logs::`, `AWS::SecretsManager::`, `AWS::SSM::`, anything else → `null` (support/deployment services — counted for vendor diagnostics, not a customer phase)
- `AWS::CloudFormation::Stack` where `logicalResourceId === stackName` → overall `stackStatus`, not a category.

FIRST read `provision-progress.ts`'s actual table and adopt its exact assignments where they overlap (e.g. if it puts ELB under a different category, follow it — the two snapshots must agree). Leave `provision-progress.ts` untouched.

**Summarize semantics (mirror `summarizeProvisioning`, verified against its tests):**
- Use the LATEST event per `logicalResourceId` to determine that resource's current status.
- Category `FAILED` only on a genuine `*_FAILED` whose reason is not rollback boilerplate (`'Resource creation cancelled'`, `'Resource update cancelled'` — same set as install.ts `CANCELLED_REASONS`). `DELETE_*`/`ROLLBACK_*` resource events never mark a category FAILED (rollback debris rule).
- Category `COMPLETE` when every seen resource in it ends `*_COMPLETE` (excluding delete-phase events); `IN_PROGRESS` otherwise.
- `startedAt` = earliest event in category; `completedAt` = latest `*_COMPLETE` when COMPLETE.
- `stackStatus` = latest stack-level event's `resourceStatus` (e.g. `CREATE_IN_PROGRESS`, `ROLLBACK_IN_PROGRESS`) — the existing derivation's rollback regex (`/ROLLBACK|DELETE/`) then handles "Deployment failed. Cleaning up resources…" copy with no derivation change.
- Return `null` when `events` is empty.

- [ ] **Step 1: Write failing tests** covering: EC2 five-subnet events collapse to one `network` category IN_PROGRESS; RDS → `database`; ElastiCache → `redis`; S3 → `storage`; ECS/ELB/ACM/Route53/ECR → `application`; Lambda/IAM → null; latest-per-resource wins; genuine CREATE_FAILED → FAILED; cancelled-reason CREATE_FAILED does NOT fail the category; DELETE_IN_PROGRESS debris does not change a COMPLETE category; stack-level event sets `stackStatus`; empty input → null; oldest `startedAt` / completion timestamps correct.
- [ ] **Step 2: Verify fail.** `pnpm vitest run apps/api/src/stack-event-progress.test.ts`
- [ ] **Step 3: Implement** per the semantics above (pure module, no imports from server.ts).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: central CloudFormation event phase mapper and snapshot summarizer`.

---

### Task 4: API — `POST /api/relay/commands/:id/progress` ingest endpoint

**Files:**
- Modify: `apps/api/src/server.ts` (new route next to the `/result` handler)
- Test: `apps/api/src/stack-progress.test.ts` (PGlite + buildServer, model on `relay-identity.test.ts` and the existing `/result` tests in `server.test.ts`)

**Interfaces:**
- Consumes: `relayCommandProgressSchema` (Task 2), `deploymentStackEvents` (Task 1), `summarizeStackEvents` (Task 3), existing `requireRelayDeployment`-style auth, `redactSecrets` from `@deployz/analysis`, `advanceStepTimingsAfterWrite`.
- Produces: HTTP contract used by Task 7's reporter: relay-authenticated POST, body `RelayCommandProgress`, 200 → `{ accepted: number }`; 404 for unknown job; 403/401 per existing relay auth behavior.

**Handler behavior (exact):**
1. Authenticate exactly like `POST /api/relay/commands/:id/result` (bearer + installation lookup + token rotation headers).
2. Validate body with `relayCommandProgressSchema`; 400 on failure.
3. Load the job by `:id`; require `job.deploymentId === deployment.id` and `job.type` ∈ {`INSTALL`, `DESTROY`} — otherwise 404/409 following the `/result` handler's error idiom.
4. Insert all events with `onConflictDoNothing({ target: [deploymentId, providerEventId] })`, `.returning({ id })` to count accepted; `resourceStatusReason` passed through `redactSecrets` then sliced to 500 chars; `jobId: job.id`.
5. Set `lastProgressAt: new Date()` on the job (keeps the watchdog fed during long installs).
6. If `job.type === 'INSTALL'` and `job.state` ∈ {`RUNNING`, `WAITING`}: select all events for `jobId` ordered by `eventAt`, call `summarizeStackEvents(stackName, rows, nowIso)`, and when non-null merge into the deployment row preserving unrelated keys:
   `observedState = { ...(existing ?? {}), infraHealth: { ...(existing?.infraHealth ?? {}), provisioning: snapshot } }` — then `advanceStepTimingsAfterWrite(...)` best-effort (try/catch, log, never fail the request), matching how `/health` calls it.
7. Structured log: `request.log.info({ deploymentId, jobId: job.id, stackName, accepted, event: 'relay:stack-events-ingested' })` (match server.ts's existing log style). Never log reasons or payload bodies.
8. Reply `{ accepted }`.

- [ ] **Step 1: Write failing tests** covering:
  - happy path: register relay → fetch INSTALL command → POST 2 events → 200 `{accepted: 2}`; rows persisted; `GET /api/install/:installLinkId/status` now shows stage PROVISIONING with step NETWORK (snapshot fold works end-to-end through `deriveDeploymentStatus`).
  - duplicate batch POSTed twice → second returns `{accepted: 0}`, still 1 row per event.
  - wrong bearer token → 401/403 (match existing relay-auth test assertions).
  - job id belonging to another deployment → 404.
  - reason containing `PASSWORD=hunter2` is persisted redacted (assert stored reason contains `***` and not `hunter2`).
  - DESTROY job: events persist, `observedState.infraHealth.provisioning` NOT rewritten.
  - stack-level `ROLLBACK_IN_PROGRESS` event → customer status shows the existing rollback copy and no jargon; a failed category does not flip stage on its own (stage still derived from job/deployment state).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement the route.** Place it directly after the `/result` handler; reuse its auth plumbing verbatim.
- [ ] **Step 4: Verify pass.** Also run the full `apps/api` project (`pnpm vitest run --project api` or path filter) to catch regressions in status derivation tests.
- [ ] **Step 5: Commit** — `feat: relay stack-event progress ingest endpoint`.

---

### Task 5: API — vendor read endpoint `GET /api/deployments/:id/stack-events`

**Files:**
- Modify: `apps/api/src/server.ts` (next to `GET /api/deployments/:id/events`)
- Test: extend `apps/api/src/stack-progress.test.ts`

**Interfaces:**
- Produces: authenticated vendor endpoint returning `{ events: VendorStackEvent[] }` — newest-first, `limit` query (default 100, max 200). Raw `resourceStatus`/`resourceType`/`logicalResourceId`/`resourceStatusReason` preserved (vendor diagnostics). Org-scoped exactly like `GET /api/deployments/:id/events`.

- [ ] **Step 1: Write failing tests**: authenticated owner gets rows newest-first; user from another org gets 404; unauthenticated gets 401; limit respected.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** by copying the `/events` handler shape (requireAuth preHandler, org-scoped deployment lookup, select + order + limit).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: vendor stack-events diagnostics endpoint`.

---

### Task 6: Relay — stack-event collector module

**Files:**
- Create: `packages/relay/src/stack-events.ts`
- Test: `packages/relay/src/stack-events.test.ts`

**Interfaces:**
- Produces (verbatim, consumed by Tasks 7–8):

```ts
export interface StackEventRecord {
  readonly eventId: string;
  readonly timestamp: string; // ISO 8601
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
}

export interface StackEventsPage {
  readonly events: readonly StackEventRecord[];
  readonly nextToken?: string;
}

export interface StackEventsReader {
  // null on any error — readers never throw (repo convention).
  describeStackEventsPage(stackName: string, nextToken?: string): Promise<StackEventsPage | null>;
}

export function toStackEventsReader(client: { send(command: unknown): Promise<unknown> }): StackEventsReader;
export function createStackEventsReader(region?: string): StackEventsReader; // lazy real client, same idiom as createStackInstaller

export interface StackEventCollector {
  // Fetch new events since the boundary/cursor and report them. Never throws.
  poll(stackName: string): Promise<void>;
  // Cursor for cross-invocation resume; null until something was reported.
  lastEventAt(): string | null;
}

export interface StackEventCollectorOptions {
  readonly reader: StackEventsReader;
  // POSTs a batch (<= 50, oldest-first) to the control plane; false on failure. Never throws.
  readonly report: (events: readonly StackEventRecord[]) => Promise<boolean>;
  readonly operationStartedAt: string; // ISO — events strictly before this are out of scope
  readonly resumeAfter?: string;       // prior invocation's lastEventAt (inclusive boundary; server dedupes overlap)
  readonly maxPages?: number;          // default 5
  readonly log?: (entry: Record<string, unknown>) => void; // default JSON console.log
}

export function createStackEventCollector(options: StackEventCollectorOptions): StackEventCollector;
```

**Collector algorithm (exact):**
1. `boundary = resumeAfter && resumeAfter > operationStartedAt ? resumeAfter : operationStartedAt`.
2. Page `describeStackEventsPage` (newest-first, AWS order) up to `maxPages`; stop early when a page yields an event with `timestamp < boundary` or an `eventId` already in the in-memory seen set. Collect events with `timestamp >= boundary` and unseen `eventId`.
3. Reverse to oldest-first. Chunk into batches of 50. For each batch call `report`; on `true`, add ids to seen set and advance internal `lastEventAt` to the batch's max timestamp; on `false`, stop (leftover events retry next tick; server-side unique constraint absorbs any resend overlap).
4. Log `{ event: 'relay:stack-events-collected', stackName, count, lastEventAt }` only when `count > 0`. Never include reasons/parameters in logs.
5. Any thrown error anywhere → swallow, log `{ event: 'relay:stack-events-poll-failed', stackName }`, return.

**`toStackEventsReader`:** send `DescribeStackEventsCommand({ StackName, NextToken })`; map `StackEvents[]` → `StackEventRecord` (`EventId`, `Timestamp` → ISO, `LogicalResourceId`, `ResourceType`, `ResourceStatus`, `ResourceStatusReason`), DROP `ResourceProperties` and every other field; skip records missing `EventId`/`Timestamp`/`ResourceStatus`; on throw return `null`.

- [ ] **Step 1: Write failing tests** (model on `install.test.ts`'s `scriptedInstaller` + `vi.fn()` on `{send}`):
  - `toStackEventsReader` maps fields, drops `ResourceProperties`, returns null on throw, passes `NextToken` through.
  - collector reports oldest-first (input newest-first).
  - operation boundary: events timestamped before `operationStartedAt` are excluded.
  - pagination: follows nextToken, stops at page cap; stops early once past boundary.
  - dedupe: second `poll()` with overlapping pages reports only new events.
  - resume: `resumeAfter` set → previously-reported window not re-fetched beyond one inclusive overlap.
  - failed `report` → events retried on next `poll()`; `lastEventAt` not advanced.
  - reader returning null → poll completes silently, nothing reported.
  - >50 new events → chunked into multiple `report` calls, all oldest-first.
- [ ] **Step 2: Verify fail.** `pnpm vitest run packages/relay/src/stack-events.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: relay stack-event collector with cursor and pagination`.

---

### Task 7: Relay — integrate collector into the install wait loop + cursor persistence + HTTP wiring

**Files:**
- Modify: `packages/relay/src/install.ts` (add `onPoll` hook; poll interval 15s → 5s)
- Modify: `packages/relay/src/pending.ts` (`PendingCommand.stackEventsCursor?`)
- Modify: `packages/relay/src/poll.ts` (add `reportCommandProgress` beside `reportCommandResult`)
- Modify: `packages/relay/src/index.ts` (`InstallExecutorDeps.createStackEventCollector?`, executor/resumer/settleInstall threading, default wiring)
- Tests: extend `packages/relay/src/install.test.ts`, `pending.test.ts`, `poll.test.ts`, `index.test.ts`

**Interfaces:**
- Consumes: Task 6's `createStackEventCollector`/`createStackEventsReader`; Task 4's endpoint.
- Produces:
  - `InstallOptions.onPoll?: (stackName: string) => Promise<void>` — invoked once per existing loop tick and once more after the loop reaches a terminal state (flushes tail events). Guarded `try/catch`; can never change the install outcome.
  - `install.ts` `DEFAULT_POLL_INTERVAL_MS` changes `15_000` → `5_000` (spec: events roughly every 5s; the loop already shares one cadence). Update any test asserting the old default; `budgetMs` unchanged.
  - `PendingCommand.stackEventsCursor?: { readonly lastEventAt: string }` — optional; `pending.ts` read tolerates markers without it (older relay versions).
  - `poll.ts`: `reportCommandProgress(ctx, commandId, events): Promise<boolean>` — same auth/fetch/rotation idiom as `reportCommandResult`, POSTs `RelayCommandProgress`-shaped body to `/api/relay/commands/${commandId}/progress`; returns false (and logs `relay:stack-events-report-failed` with status code, once per status) on ANY non-2xx including 404 from an older API. Never throws.
  - `index.ts`: `InstallExecutorDeps.createStackEventCollector?: (args: { commandId: string; operationStartedAt: string; resumeAfter?: string }) => StackEventCollector`.
    - `createInstallExecutor`: builds collector with `operationStartedAt = new Date(now()).toISOString()` at command start; passes it to `settleInstall`; at defer time includes `stackEventsCursor: { lastEventAt }` in the `PendingCommand` when the collector reported anything.
    - `createInstallResumer`: builds collector with `operationStartedAt = pending.startedAt`, `resumeAfter = pending.stackEventsCursor?.lastEventAt`; on re-defer, rewrites the pending marker with the updated cursor.
    - `settleInstall`: accepts the optional collector and passes `onPoll: (stackName) => collector.poll(stackName)` into the install options.
    - `createDefaultInstallDeps`: wires the real pieces — `createStackEventsReader()` + a `report` closure using `reportCommandProgress` with the same base-URL/token context the handler already gives the poll loop (thread whatever config `createRelayHandler` already holds; do not invent new config).

- [ ] **Step 1: Write failing tests:**
  - `install.test.ts`: `onPoll` is awaited once per tick with the stack name (scripted 3-state sequence → expect ≥3 calls incl. the terminal flush); an `onPoll` that rejects does not change the outcome; default interval is now 5000 (fix any test pinned to 15000).
  - `pending.test.ts`: marker with `stackEventsCursor` round-trips; legacy marker JSON without the field parses.
  - `poll.test.ts`: `reportCommandProgress` posts the right body/headers; 404 → false without throwing.
  - `index.test.ts`: executor defer writes cursor into pending; resumer passes `resumeAfter` from pending and `operationStartedAt = pending.startedAt`; when `createStackEventCollector` is absent (older wiring), install works exactly as before.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement**, smallest diffs: `run()` gains one `try { await onPoll?.(stackName) } catch {}` per iteration plus one after terminal settle; do not restructure the loop.
- [ ] **Step 4: Run the whole relay project** — `pnpm vitest run --project relay` (or path filter) — all pre-existing tests green.
- [ ] **Step 5: Commit** — `feat: poll DescribeStackEvents inside the install wait loop with resumable cursor`.

---

### Task 8: Relay — DESTROY event coverage (one collector poll per invocation)

**Files:**
- Modify: `packages/relay/src/destroy.ts`, `packages/relay/src/index.ts` (destroy deps wiring)
- Test: extend `packages/relay/src/destroy.test.ts`

**Interfaces:**
- Consumes: Task 6 collector, Task 7's deps pattern (`createStackEventCollector` on the destroy deps, same arg shape).
- Produces: `createDestroyExecutor`/`createDestroyResumer` call `await collector.poll(stackName)` once per invocation (best-effort) after issuing/observing the delete; cursor persisted in the destroy `PendingCommand` writes identically to Task 7. DESTROY has no intra-invocation wait loop — do NOT add one; once per 5-minute resume tick is the correct cadence here.

- [ ] **Step 1: Write failing tests**: executor polls collector once with the stack name; resumer passes cursor; collector failure doesn't change destroy outcome; absent factory → unchanged behavior.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify relay project green.**
- [ ] **Step 5: Commit** — `feat: report stack events during destroy`.

---

### Task 9: Web — vendor "Infrastructure events" disclosure

**Files:**
- Create: `apps/web/src/lib/stack-events.ts` (fetcher + type re-export from `@deployz/contracts`)
- Create: `apps/web/src/components/infrastructure-events.tsx`
- Modify: `apps/web/src/app/dashboard/deployments/[id]/page.tsx` (mount below the progress card)
- Test: `pnpm lint` must pass (the raw-CFN-literal ESLint rule is the gate); component keeps all statuses dynamic.

**Interfaces:**
- Consumes: Task 5 endpoint, `VendorStackEvent` from contracts, `useStatusPoll`, shadcn `Collapsible`/`Card`, `cn`.
- Produces: a vendor-only section. Requirements:
  - Fetcher: `export async function fetchStackEvents(id: string): Promise<VendorStackEvent[]>` in `apps/web/src/lib/stack-events.ts`, modeled byte-for-byte on `fetchDeploymentEvents` in `deployments.ts` (`credentials: 'include'`, `${apiUrl}/api/deployments/${id}/stack-events`).
  - Component `InfrastructureEvents({ deploymentId, stage })`: polls via `useStatusPoll` (`intervalMs: 5000`, `terminalIntervalMs: 60000`, `isTerminal` from `isTerminalStage(stage)` passed by the page); renders nothing when there are no events; otherwise a `Collapsible` DEFAULT-COLLAPSED titled "Infrastructure events" with an event count, containing a scrollable (`max-h-` + `overflow-y-auto`) list — each row: time (`text-xs text-muted-foreground tabular-nums`), `logicalResourceId` (`text-sm font-medium`), `resourceType` (`text-xs text-muted-foreground`), status in `<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">` (dynamic value — never a literal), and `resourceStatusReason` as wrapped muted text when present. Follow `diagnostic-card.tsx`'s disclosure style and `docs/ui-system.md` typography/spacing. Lucide icons only if any. This is the raw-diagnostics surface; the phase timeline itself is the EXISTING `DeploymentProgressCard`, which gets fresher automatically — do not duplicate it.
  - Page: mount `<InfrastructureEvents deploymentId={id} stage={detail.deploymentStatus.stage} />` right after the `DeploymentProgressCard` section. No customer-page change (the customer timeline + rollback copy already exist and are fed by the snapshot fold).
- [ ] **Step 1: Implement fetcher + component + mount** (UI code: verify visually in Task 10/11 and with lint; the web project has no unit-test culture for pages — follow the repo).
- [ ] **Step 2: `pnpm lint`** — passes (no raw CFN literals; no arbitrary palette colors).
- [ ] **Step 3: `pnpm build`** — Next build + typecheck passes.
- [ ] **Step 4: Commit** — `feat: vendor infrastructure events disclosure`.

---

### Task 10: E2E (fixture-mode) — full HTTP-simulated flow

**Files:**
- Create: `e2e/stack-events.spec.ts` (clone the setup helpers of `e2e/deployment-progress.spec.ts`)

**Scenarios (one spec file, serial):**
1. Setup org/app/customer/deployment via API exactly as `deployment-progress.spec.ts` does; register relay; fetch the INSTALL command.
2. POST a progress batch (5 subnet `CREATE_IN_PROGRESS` events + 1 RDS `CREATE_IN_PROGRESS` + stack-level `CREATE_IN_PROGRESS`) → vendor detail page shows the progress card with the network step active (ONE phase row, not five subnet rows — assert no `logicalResourceId` text outside the collapsed disclosure); expand "Infrastructure events" → raw rows visible with statuses.
3. Customer install page: shows the existing step timeline; assert page text matches the `JARGON` regex prohibition (reuse the constant idiom).
4. POST the SAME batch again → `GET /api/deployments/:id/stack-events` row count unchanged (no duplicate timeline entries).
5. `page.reload()` on both pages → progress still shown (persistence across refresh).
6. Failure path: POST a genuine `CREATE_FAILED` (reason text) + stack `ROLLBACK_IN_PROGRESS`, then POST the failed `/result` → customer page shows friendly failure copy + collapsed technical detail; vendor page shows the raw reason in diagnostics/events.
7. Success path: POST all-`CREATE_COMPLETE` events + stack `CREATE_COMPLETE`, then the successful `/result` → status proceeds into the existing verification flow (stage `VERIFYING`, NOT `READY` — proves CFN completion alone never marks healthy).

- [ ] **Step 1: Write the spec.**
- [ ] **Step 2: Run** — PowerShell: `$env:WEB_PORT="3110"; $env:API_PORT="3111"; pnpm test:e2e -- e2e/stack-events.spec.ts` (build first: `pnpm build`). Iterate to green.
- [ ] **Step 3: Regression run** — `$env:WEB_PORT="3110"; $env:API_PORT="3111"; pnpm test:e2e -- e2e/deployment-progress.spec.ts e2e/fleet.spec.ts` (install/status flows unaffected).
- [ ] **Step 4: Commit** — `test: e2e coverage for CloudFormation progress events`.

---

### Task 11: Full verification pass

- [ ] `pnpm build` (typecheck gate) — green.
- [ ] `pnpm vitest run` — green. If the run dies with the known `Timeout calling "onTaskUpdate"` vitest-worker flake (documented in `packages/cdk/vitest.config.ts` / `.janitor/history.md`), re-run per project instead of assuming a regression.
- [ ] `pnpm lint` — green.
- [ ] Regression e2e (ports overridden): `deployment-progress`, `stack-events`, plus one destroy-adjacent spec if present.
- [ ] Fix anything found; commit fixes individually.

---

### Task 12: Live E2E validation on real AWS (orchestrator-led, not subagent)

Follow the persisted recipe in `C:\Users\smili\.claude\projects\C--Users-smili-Desktop-deployz\memory\deployz-live-e2e-technique.md` (tunnel + PGlite control plane + real us-east-1 install, fixed `deployz-app` stack name). Constraints from memory: installs are us-east-1 only; shared platform+customer account; DESTROY retains the app DB/bucket — tear down orphans afterward.

- [ ] Publish the new relay/bootstrap artifacts per the recipe (BOOTSTRAP_TEMPLATE_URL flow).
- [ ] Run a real install of the fixture app; while CREATE is in progress, capture `aws cloudformation describe-stack-events --stack-name deployz-app --region us-east-1` via CLI and compare against `GET /api/deployments/:id/stack-events` — event ids seen by AWS appear in Deployz, oldest-first in the UI, no duplicates (`count == distinct provider_event_id`).
- [ ] Verify progress appears DURING execution on both the vendor dashboard and customer install page (browser); refresh both — progress preserved.
- [ ] Verify final `CREATE_COMPLETE` transitions into existing verification (stage VERIFYING → READY only after health/HTTPS).
- [ ] Teardown: DESTROY + purge; delete retained DB/bucket orphans per `deployz-prod-reset-teardown.md`.
- [ ] Save evidence (CLI excerpts, screenshots, row counts) for the PR body.

---

### Task 13: PR

- [ ] Re-run Task 11 commands one final time.
- [ ] Use the finishing-a-development-branch skill / `commit-commands:commit-push-pr` to open ONE PR against `main` titled `feat: real-time CloudFormation progress via DescribeStackEvents polling`, with: summary, architecture notes (single-loop integration, snapshot fold, cursor resume, dedupe key), tests run, E2E evidence, limitations (progress only flows during relay watch windows — up to ~2 min gaps between 5-minute ticks after the 180s budget; DESTROY events at 5-min cadence; fleet-list status unchanged coarser path).
