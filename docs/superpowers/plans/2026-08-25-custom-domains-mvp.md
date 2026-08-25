# Custom Domains MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One custom subdomain per customer deployment (`app.customer.com`), DNS-provider agnostic, with automatic ACM certificate, HTTPS on the customer-account ALB, DNS verification, and removal.

**Architecture:** The control plane (Fastify API, `apps/api`) stores a `custom_domains` row per deployment and drives a small status machine (`PENDING → WAITING_FOR_DNS → CONFIGURING → ACTIVE`, plus `ERROR`/`REMOVING`). All AWS work (ACM request/describe/delete, ALB listener configuration) happens inside the customer's AWS account through two new relay commands (`CONFIGURE_DOMAIN`, `REMOVE_DOMAIN`) executed by the relay Lambda (`packages/relay`). Public DNS checks and the HTTPS probe run on the control plane behind an injectable seam. The customer-facing UI lives on the existing `/install/[installLinkId]` page (post-install state); the vendor dashboard deployment page shows a compact status row.

**Tech Stack:** Fastify 5, Drizzle ORM + Postgres/PGlite, zod v4, Next.js 15 App Router + Tailwind v4, AWS SDK v3 (`@aws-sdk/client-acm`, `@aws-sdk/client-elastic-load-balancing-v2`), CDK (bootstrap-stack IAM), Vitest 3, Playwright.

## Global Constraints

- One non-removed custom domain per deployment; one active ownership of a hostname across all of Deployz (both enforced by partial unique indexes AND pre-checks).
- Subdomains only. Reject: URLs, paths, ports, wildcards, IPs, localhost, malformed hostnames, apex/root domains, Deployz-owned/AWS-internal hostnames.
- Exact user-facing copy (verbatim, from the spec):
  - URL entered: `Enter only the domain, for example app.example.com.`
  - Invalid: `Enter a valid domain such as app.example.com.`
  - Root domain: `Root domains aren't supported yet. Use a subdomain such as app.example.com.`
  - Wildcard: `Wildcard domains aren't supported yet.`
  - Duplicate: `This domain is already connected to a deployment.` (never expose the other organization)
- Status → UI label: `PENDING` → Setting up, `WAITING_FOR_DNS` → Waiting for DNS, `CONFIGURING` → Connecting, `ACTIVE` → Active, `ERROR` → Needs attention, `REMOVING` → Removing.
- API wire format uses lowercase statuses (`waiting_for_dns` etc.); the DB enum is UPPERCASE per house style.
- Domain jobs must NEVER change `deployments.state` (success or failure).
- Never modify customer DNS. Never store private TLS keys. Detailed AWS errors go to job results/logs, never to primary UI.
- All infra operations idempotent / safe to retry.
- HTTPS mandatory; HTTP :80 redirected to HTTPS once configured.
- Repo rules (AGENTS.md): smallest necessary change, match existing style, no dead code/redundant comments. API imports use `.js` suffixes (ESM). No modal/dialog components exist — use inline panels (house pattern), NOT a modal.
- Run tests with `pnpm vitest run <path>` from the repo root (Vitest projects config). CDK tests are slow/serial.
- Commit after every task. Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Data model — enum, table, contracts, migration

**Files:**
- Modify: `packages/db/src/enums.ts`
- Create: `packages/db/src/schema/custom-domains.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/contracts/src/index.ts`
- Generated: `packages/db/drizzle/0010_*.sql` (via drizzle-kit)

**Interfaces:**
- Produces: `customDomainStatusEnum` pg enum `custom_domain_status` with values `['PENDING','WAITING_FOR_DNS','CONFIGURING','ACTIVE','ERROR','REMOVING']`; `jobTypeEnum` gains `'CONFIGURE_DOMAIN'` and `'REMOVE_DOMAIN'`; Drizzle table `customDomains` (see columns below); zod `customDomainStatusSchema` and extended `jobTypeSchema` in contracts.

- [ ] **Step 1: Add enums.** In `packages/db/src/enums.ts`, add the two job types to `jobTypeEnum` (append `'CONFIGURE_DOMAIN', 'REMOVE_DOMAIN'` to the array) and add at the end of the file:

```ts
// Custom-domain lifecycle (custom-domains MVP). Six states; the UI maps
// them 1:1 (Setting up / Waiting for DNS / Connecting / Active / Needs
// attention / Removing). Deliberately separate from deployment_state: a
// domain failure must never look like a deployment failure.
export const customDomainStatusEnum = pgEnum('custom_domain_status', [
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);
```

- [ ] **Step 2: Create `packages/db/src/schema/custom-domains.ts`** (mirror the import style of `schema/deployments.ts` — check how it imports `organization`):

```ts
import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { customDomainStatusEnum } from '../enums.js';
import { organization } from './auth.js';
import { auditFields, id } from './common.js';
import { deployments } from './deployments.js';

// Custom-domains MVP — one custom subdomain per deployment. The row is the
// control plane's source of truth for the domain state machine; ACM/ALB
// facts arrive via relay job results. Removal is a soft delete (removedAt)
// so a hostname frees up the moment removal completes while history stays.
export const customDomains = pgTable(
  'custom_domains',
  {
    id: id(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    hostname: text('hostname').notNull(),
    status: customDomainStatusEnum('status').notNull().default('PENDING'),
    certificateArn: text('certificate_arn'),
    validationName: text('validation_name'),
    validationValue: text('validation_value'),
    routingTarget: text('routing_target'),
    // Stable error code (DNS_VALIDATION_NOT_FOUND, DNS_ROUTING_MISMATCH,
    // HTTPS_NOT_REACHABLE, AWS_PERMISSION_DENIED, CONFIGURE_FAILED,
    // REMOVE_FAILED) — mapped to copy in the web app, never raw AWS text.
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    // Bumped to mint a fresh relay-job idempotency key when a finished job
    // needs re-running (retry after failure, next configure step).
    checkCycle: integer('check_cycle').notNull().default(0),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    ...auditFields(),
  },
  (table) => [
    // One active ownership of a hostname across ALL of Deployz.
    uniqueIndex('custom_domains_active_hostname_idx')
      .on(table.hostname)
      .where(sql`${table.removedAt} is null`),
    // One non-removed domain per deployment.
    uniqueIndex('custom_domains_active_deployment_idx')
      .on(table.deploymentId)
      .where(sql`${table.removedAt} is null`),
  ],
);
```

If `auth.js` does not export `organization` under that name, use whatever `schema/deployments.ts` references for its `organizationId` FK.

- [ ] **Step 3: Export from `packages/db/src/schema/index.ts`** (`export * from './custom-domains.js';` matching existing lines).

- [ ] **Step 4: Contracts.** In `packages/contracts/src/index.ts`: append `'CONFIGURE_DOMAIN', 'REMOVE_DOMAIN'` to `jobTypeSchema`'s enum array (line ~69), and next to the other enum schemas add:

```ts
export const customDomainStatusSchema = z.enum([
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);
export type CustomDomainStatus = z.infer<typeof customDomainStatusSchema>;
```

There is a parity test locking contracts enums to the live pgEnums — find it (`grep -rn "pgEnum\|parity" packages/contracts apps/api --include=*.test.ts`) and extend expectations if it enumerates values explicitly.

- [ ] **Step 5: Generate the migration.** Run `pnpm --filter @deployz/db run db:generate`. Verify a new `packages/db/drizzle/0010_*.sql` appears containing `CREATE TABLE "custom_domains"`, the two partial unique indexes, `CREATE TYPE "custom_domain_status"` (or equivalent), and `ALTER TYPE "job_type" ADD VALUE` statements. Do not hand-edit unless drizzle-kit mis-generates.

- [ ] **Step 6: Verify migrations apply.** Run: `pnpm vitest run apps/api/src/auth.test.ts` (boots PGlite + applies all migrations). Expected: PASS.

- [ ] **Step 7: Commit** (`feat: add custom_domains table and domain job types`).

---

### Task 2: Hostname validation module (TDD)

**Files:**
- Create: `apps/api/src/domain-validation.ts`
- Create: `apps/api/src/domain-validation.test.ts`

**Interfaces:**
- Produces:
  - `normalizeHostname(input: string): string`
  - `validateHostname(hostname: string): { ok: true } | { ok: false; code: DomainValidationCode; message: string }`
  - `type DomainValidationCode = 'URL_ENTERED' | 'INVALID_DOMAIN' | 'ROOT_DOMAIN' | 'WILDCARD_NOT_SUPPORTED'`
- Pure functions, no DB.

- [ ] **Step 1: Write the failing tests** (`apps/api/src/domain-validation.test.ts`):

```ts
import { describe, expect, it } from 'vitest';

import { normalizeHostname, validateHostname } from './domain-validation.js';

describe('normalizeHostname', () => {
  it('lowercases, trims, and strips a trailing dot', () => {
    expect(normalizeHostname('  App.Example.COM. ')).toBe('app.example.com');
  });
});

describe('validateHostname', () => {
  const ok = (h: string) => expect(validateHostname(h)).toEqual({ ok: true });
  const code = (h: string) => {
    const r = validateHostname(h);
    return r.ok ? 'OK' : r.code;
  };

  it('accepts a plain subdomain', () => ok('app.example.com'));
  it('accepts a deep subdomain', () => ok('a.b.example.com'));
  it('accepts a subdomain of a multi-part suffix', () => ok('app.example.co.uk'));

  it('rejects https URLs as URL_ENTERED', () =>
    expect(code('https://app.example.com')).toBe('URL_ENTERED'));
  it('rejects http URLs as URL_ENTERED', () =>
    expect(code('http://app.example.com')).toBe('URL_ENTERED'));
  it('rejects paths as URL_ENTERED', () => expect(code('app.example.com/login')).toBe('URL_ENTERED'));
  it('rejects ports as URL_ENTERED', () => expect(code('app.example.com:8443')).toBe('URL_ENTERED'));

  it('rejects the empty string', () => expect(code('')).toBe('INVALID_DOMAIN'));
  it('rejects single labels', () => expect(code('localhost')).toBe('INVALID_DOMAIN'));
  it('rejects IPv4 addresses', () => expect(code('192.168.0.10')).toBe('INVALID_DOMAIN'));
  it('rejects IPv6 addresses', () => expect(code('::1')).toBe('URL_ENTERED'));
  it('rejects underscores and bad chars', () => expect(code('app_1.example.com')).toBe('INVALID_DOMAIN'));
  it('rejects labels over 63 chars', () => expect(code(`${'a'.repeat(64)}.example.com`)).toBe('INVALID_DOMAIN'));
  it('rejects hostnames over 253 chars', () =>
    expect(code(`${'a.'.repeat(127)}example.com`)).toBe('INVALID_DOMAIN'));
  it('rejects hyphen-edged labels', () => expect(code('-app.example.com')).toBe('INVALID_DOMAIN'));
  it('rejects Deployz-owned hostnames', () => expect(code('evil.deployz.dev')).toBe('INVALID_DOMAIN'));
  it('rejects AWS-internal hostnames', () =>
    expect(code('foo.us-east-1.elb.amazonaws.com')).toBe('INVALID_DOMAIN'));
  it('rejects acm-validations hostnames', () =>
    expect(code('x.acm-validations.aws')).toBe('INVALID_DOMAIN'));

  it('rejects apex domains as ROOT_DOMAIN', () => expect(code('example.com')).toBe('ROOT_DOMAIN'));
  it('rejects multi-part-suffix apexes as ROOT_DOMAIN', () =>
    expect(code('example.co.uk')).toBe('ROOT_DOMAIN'));

  it('rejects wildcards as WILDCARD_NOT_SUPPORTED', () =>
    expect(code('*.example.com')).toBe('WILDCARD_NOT_SUPPORTED'));
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm vitest run apps/api/src/domain-validation.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/api/src/domain-validation.ts`:**

```ts
// Custom-domain hostname validation. Pure functions — the API route and the
// UI both rely on the SAME server-side rules; client-side checks are only a
// convenience. Messages are product copy (spec-fixed), not AWS jargon.

export type DomainValidationCode =
  | 'URL_ENTERED'
  | 'INVALID_DOMAIN'
  | 'ROOT_DOMAIN'
  | 'WILDCARD_NOT_SUPPORTED';

export const DOMAIN_VALIDATION_MESSAGES: Record<DomainValidationCode, string> = {
  URL_ENTERED: 'Enter only the domain, for example app.example.com.',
  INVALID_DOMAIN: 'Enter a valid domain such as app.example.com.',
  ROOT_DOMAIN: "Root domains aren't supported yet. Use a subdomain such as app.example.com.",
  WILDCARD_NOT_SUPPORTED: "Wildcard domains aren't supported yet.",
};

// RFC-1123 label: alphanumeric, hyphens inside, 1–63 chars.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Best-effort two-part public suffixes so `example.co.uk` counts as an apex.
// Not a full PSL — a deliberate MVP trade-off.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.in', 'co.za', 'co.kr',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.hk', 'com.tw', 'com.cn',
]);

// Deployz-owned and AWS-internal namespaces must never become customer
// domains (spec security requirement).
const RESERVED_SUFFIXES = [
  'deployz.dev',
  'deployz.app',
  'amazonaws.com',
  'acm-validations.aws',
  'on.aws',
];

export function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/\.+$/, '');
}

export function validateHostname(
  hostname: string,
): { ok: true } | { ok: false; code: DomainValidationCode; message: string } {
  const fail = (code: DomainValidationCode) =>
    ({ ok: false, code, message: DOMAIN_VALIDATION_MESSAGES[code] }) as const;

  if (hostname.includes('*')) return fail('WILDCARD_NOT_SUPPORTED');
  if (/[/:?#@\s]/.test(hostname)) return fail('URL_ENTERED');
  if (hostname.length === 0 || hostname.length > 253) return fail('INVALID_DOMAIN');
  if (IPV4.test(hostname)) return fail('INVALID_DOMAIN');

  const labels = hostname.split('.');
  if (!labels.every((label) => LABEL.test(label))) return fail('INVALID_DOMAIN');
  if (labels.length < 2) return fail('INVALID_DOMAIN');

  const reserved = RESERVED_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (reserved) return fail('INVALID_DOMAIN');

  const lastTwo = labels.slice(-2).join('.');
  const registrableLabels = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length <= registrableLabels) return fail('ROOT_DOMAIN');

  return { ok: true };
}
```

Note the ordering: wildcard first (so `*.example.com` is a wildcard, not a bad char), then URL-ish characters, then shape. `::1` hits the `:` check → `URL_ENTERED`, which the test expects.

- [ ] **Step 4: Run tests.** `pnpm vitest run apps/api/src/domain-validation.test.ts` — Expected: PASS (all).

- [ ] **Step 5: Commit** (`feat: add custom-domain hostname validation`).

---

### Task 3: Domain service — create/find/view, job enqueue, relay-result application (TDD)

**Files:**
- Create: `apps/api/src/domains.ts`
- Create: `apps/api/src/domains.test.ts`
- Modify: `apps/api/src/events.ts` (extend `DeploymentEventType` union)

**Interfaces:**
- Consumes: `createOrReuseJob` from `./jobs.js`, `recordEvent` from `./events.js`, `ApiError`/`NotFoundError` from `./errors.js`, validation from `./domain-validation.js`, schema from `@deployz/db/schema`.
- Produces (exact signatures, used by Tasks 4–6):
  - `type CustomDomainRow = typeof schema.customDomains.$inferSelect`
  - `interface DomainRecordView { purpose: 'verification' | 'routing'; type: 'CNAME'; name: string; value: string }`
  - `interface CustomDomainView { hostname: string; status: string; records: DomainRecordView[]; error: string | null; url: string | null }`
  - `toDomainView(row: CustomDomainRow): CustomDomainView`
  - `findActiveDomain(db: RuntimeDb, deploymentId: string): Promise<CustomDomainRow | null>`
  - `createCustomDomain(db: RuntimeDb, deployment: { id: string; organizationId: string }, rawHostname: string, actorId: string): Promise<CustomDomainRow>`
  - `removeCustomDomain(db: RuntimeDb, deployment: { id: string }, domain: CustomDomainRow): Promise<CustomDomainRow>`
  - `applyDomainJobResult(tx, deployment, job, body): Promise<void>` — `tx` is a Drizzle transaction/db, `job` is a `deploymentJobs` row, `body` is `{ success?: boolean; error?: string; output?: Record<string, unknown>; failureCode?: string }`
  - `isDomainJobType(type: string): boolean` (true for `CONFIGURE_DOMAIN`/`REMOVE_DOMAIN`)
  - `ensureConfigureJob(db, deployment, domain, opts?: { forceNewCycle?: boolean }): Promise<void>`
- Event types added to `DeploymentEventType`: `'domain.added' | 'domain.activated' | 'domain.failed' | 'domain.removed'`.

Semantics to implement (also the test spec):

1. `createCustomDomain`: normalize → validate (throw `ApiError(400, code, message)` on failure) → reject if the deployment already has an active domain (`ApiError(409, 'DOMAIN_EXISTS', 'This deployment already has a custom domain.')`) → reject if the hostname is active anywhere in Deployz (`ApiError(409, 'DOMAIN_TAKEN', 'This domain is already connected to a deployment.')` — never name the other org) → insert row (status `PENDING`, `createdBy: actorId`) catching the unique-violation race → the same 409s → `ensureConfigureJob` → `recordEvent` `domain.added` (actorType `'user'`, actorId, deploymentId, organizationId, result `'success'`, payload `{ hostname }`). Returns the row.
2. `ensureConfigureJob`: look up the newest `CONFIGURE_DOMAIN` job whose `idempotencyKey` starts with `` `${deployment.id}:CONFIGURE_DOMAIN:${domain.id}:` ``. If one exists in state `REQUESTED`/`QUEUED`/`RUNNING` → do nothing. Otherwise (none, or the newest is finished) when `forceNewCycle` is set or the newest finished job's cycle equals `domain.checkCycle`, bump `checkCycle` (persist) and `createOrReuseJob` with key `` `${deployment.id}:CONFIGURE_DOMAIN:${domain.id}:${cycle}` `` and payload `{ hostname, domainId: domain.id, ...(domain.certificateArn ? { certificateArn: domain.certificateArn } : {}) }`, `requestedBy: null`. First call (fresh row, cycle 0, no jobs) creates the cycle-0 job WITHOUT bumping.
3. `removeCustomDomain`: set `status: 'REMOVING'`; bump `checkCycle`; `createOrReuseJob` type `REMOVE_DOMAIN`, key `` `${deployment.id}:REMOVE_DOMAIN:${domain.id}:${cycle}` ``, payload `{ hostname, domainId: domain.id, ...(certificateArn && { certificateArn }) }`. Idempotent: calling again on an already-`REMOVING` row just re-ensures the job (new cycle only if the previous remove job finished FAILED).
4. `applyDomainJobResult(tx, deployment, job, body)`:
   - Load the deployment's active (non-removed) domain; if none, return.
   - `REMOVE_DOMAIN` success → `removedAt = new Date()` + `recordEvent` `domain.removed` (actorType `'relay'`). Failure → `lastError: 'REMOVE_FAILED'` (status stays `REMOVING`).
   - `CONFIGURE_DOMAIN` while status is `REMOVING` → ignore (stale result).
   - `CONFIGURE_DOMAIN` failure → status `ERROR`, `lastError` = `'AWS_PERMISSION_DENIED'` if `body.failureCode === 'AWS_PERMISSION_DENIED'` else `'CONFIGURE_FAILED'`; `recordEvent` `domain.failed` with payload `{ hostname, error: body.error }`.
   - `CONFIGURE_DOMAIN` success → copy string fields `certificateArn`, `validationName`, `validationValue`, `routingTarget` from `body.output` when present; if status `PENDING` and validation name+value now known → status `WAITING_FOR_DNS`, clear `lastError`; if `output.certificateStatus === 'ISSUED' && output.httpsConfigured === true` and status is `PENDING`/`WAITING_FOR_DNS` → status `CONFIGURING`, clear `lastError`. Never touch `ACTIVE` rows' status.
5. `toDomainView`: `status` lowercased; `records` = verification record (when `validationName`+`validationValue`) then routing record (`name: hostname, value: routingTarget` when known); `url` = `` `https://${hostname}` `` only when `ACTIVE`; `error` = `lastError`.
6. `findActiveDomain`: newest row where `deploymentId` matches and `removedAt is null`, or `null`.

- [ ] **Step 1: Extend the event union.** In `apps/api/src/events.ts` add to `DeploymentEventType`: `| 'domain.added' | 'domain.activated' | 'domain.failed' | 'domain.removed'` (family comment: domain). The column is plain text — no migration.

- [ ] **Step 2: Write failing tests** (`apps/api/src/domains.test.ts`). Use the house PGlite pattern from `apps/api/src/auth.test.ts` (`beforeAll` boots PGlite + `applyMigrations` + `createDb`). Seed minimal org/application/customer/deployment rows by direct inserts (copy helper style from `apps/api/src/server.test.ts` — reuse its exported helpers if any, else inline). Cover, at minimum:
  - create → row `PENDING`, hostname normalized, a `CONFIGURE_DOMAIN` job exists with key `` `${deploymentId}:CONFIGURE_DOMAIN:${domainId}:0` ``;
  - create with `https://…` → throws `ApiError` 400 `URL_ENTERED`;
  - create apex → 400 `ROOT_DOMAIN`; wildcard → 400 `WILDCARD_NOT_SUPPORTED`;
  - second create on same deployment → 409 `DOMAIN_EXISTS`;
  - same hostname on a different deployment (other org) → 409 `DOMAIN_TAKEN`;
  - after remove completes (`removedAt` set), the hostname is creatable again;
  - `applyDomainJobResult` CONFIGURE success with validation output moves `PENDING → WAITING_FOR_DNS` and stores cert/validation/routing fields;
  - CONFIGURE success with `certificateStatus: 'ISSUED', httpsConfigured: true` moves `WAITING_FOR_DNS → CONFIGURING`;
  - CONFIGURE failure sets `ERROR` + `lastError 'CONFIGURE_FAILED'`; with `failureCode: 'AWS_PERMISSION_DENIED'` sets that code;
  - CONFIGURE result while `REMOVING` changes nothing;
  - REMOVE success sets `removedAt`; REMOVE failure keeps `REMOVING` with `lastError 'REMOVE_FAILED'`;
  - `ensureConfigureJob` twice in a row creates exactly one unfinished job; after that job is marked `SUCCEEDED` (direct update), calling with `forceNewCycle: true` creates a cycle-1 job;
  - `toDomainView` shapes records/url/status as specified (unit, no DB needed beyond a literal row).

Example of one test to set the shape:

```ts
it('create → PENDING row with a cycle-0 CONFIGURE_DOMAIN job', async () => {
  const domain = await createCustomDomain(db, deployment, '  App.Customer.COM. ', 'user-1');
  expect(domain.hostname).toBe('app.customer.com');
  expect(domain.status).toBe('PENDING');
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.type).toBe('CONFIGURE_DOMAIN');
  expect(jobs[0]!.idempotencyKey).toBe(`${deployment.id}:CONFIGURE_DOMAIN:${domain.id}:0`);
  expect(jobs[0]!.payload).toMatchObject({ hostname: 'app.customer.com', domainId: domain.id });
});
```

- [ ] **Step 3: Run to verify failure.** `pnpm vitest run apps/api/src/domains.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement `apps/api/src/domains.ts`** per the semantics above. Skeleton to follow (fill in the semantics exactly as specified; keep comments sparse per house style):

```ts
import { and, desc, eq, isNull, like } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { normalizeHostname, validateHostname } from './domain-validation.js';
import { ApiError } from './errors.js';
import { recordEvent } from './events.js';
import { createOrReuseJob } from './jobs.js';

export type CustomDomainRow = typeof schema.customDomains.$inferSelect;
export interface DomainRecordView {
  purpose: 'verification' | 'routing';
  type: 'CNAME';
  name: string;
  value: string;
}
export interface CustomDomainView {
  hostname: string;
  status: string;
  records: DomainRecordView[];
  error: string | null;
  url: string | null;
}

const DOMAIN_JOB_TYPES = new Set(['CONFIGURE_DOMAIN', 'REMOVE_DOMAIN']);
export function isDomainJobType(type: string): boolean {
  return DOMAIN_JOB_TYPES.has(type);
}
// … (toDomainView, findActiveDomain, createCustomDomain, ensureConfigureJob,
//    removeCustomDomain, applyDomainJobResult per the Task-3 semantics)
```

For the unique-violation race in `createCustomDomain`, wrap the insert in try/catch; Postgres unique violations surface with `code: '23505'` (check `(error as { code?: string }).code` and the constraint name to pick `DOMAIN_TAKEN` vs `DOMAIN_EXISTS`; when ambiguous prefer `DOMAIN_TAKEN`).

- [ ] **Step 5: Run tests.** `pnpm vitest run apps/api/src/domains.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit** (`feat: add custom-domain service and state machine`).

---

### Task 4: API routes (add/get) + relay result integration

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `packages/relay/src/commands.ts`
- Modify: `packages/relay/src/index.ts` (executor table only — real executors come in Task 7)
- Test: extend `apps/api/src/domains.test.ts` OR create `apps/api/src/domain-routes.test.ts` (house pattern: `buildServer` + `app.inject`, see `server.test.ts`)

**Interfaces:**
- Consumes: Task 3 exports.
- Produces HTTP endpoints:
  - `POST /api/deployments/:id/domain` body `{ hostname }` → 201 `{ domain: CustomDomainView }`
  - `GET /api/deployments/:id/domain` → 200 `{ domain: CustomDomainView | null }`
  - Relay result endpoint updated so domain jobs never move `deployments.state` and instead run `applyDomainJobResult`.
- Relay vocabulary: `RELAY_COMMAND_TYPES` includes `'CONFIGURE_DOMAIN'` and `'REMOVE_DOMAIN'`.

- [ ] **Step 1: Relay vocabulary.** In `packages/relay/src/commands.ts` append the two types to `RELAY_COMMAND_TYPES`; update the "exactly eight" comments to say ten. In `packages/relay/src/index.ts` `createDefaultExecutors()`, add `CONFIGURE_DOMAIN: noop, REMOVE_DOMAIN: noop` (Task 7 replaces these with real executors). Run `pnpm vitest run packages/relay` — Expected: PASS (fix any count assertions in `commands.test.ts`).

- [ ] **Step 2: Write failing route tests.** Using the `server.test.ts` pattern (sign up via `auth.api.signUpEmail` helper / existing `signUpAndGetOrg`, seed application + customer + deployment):
  - POST with valid hostname → 201, body `domain.status === 'pending'`, `domain.hostname === 'app.customer.com'`;
  - POST invalid (`https://…`) → 400, envelope `error.code === 'URL_ENTERED'`, `error.message` equals the spec copy;
  - POST for a deployment in another org → 404 (IDOR guard via `loadOwnedDeployment`);
  - POST duplicate hostname (seed a second org + deployment, add same hostname) → 409 `DOMAIN_TAKEN`, message doesn't contain the first org's name;
  - GET → `{ domain: null }` before create; the view after;
  - unauthenticated POST → 401;
  - relay result for a CONFIGURE_DOMAIN job (drive via `POST /api/relay/commands/:id/result` with a relay token — seed `relayTokenHash` on the deployment with `hashRelayToken` from `./relay-store.js`, mirroring how relay tests in `server.test.ts` do it): success output moves the domain row to `WAITING_FOR_DNS` and `deployments.state` is UNCHANGED;
  - relay result failure for CONFIGURE_DOMAIN → domain `ERROR`, `deployments.state` UNCHANGED (this is the regression guard for the `nextState = 'FAILED'` pitfall).

- [ ] **Step 3: Run to verify failure**, then implement in `apps/api/src/server.ts`:

(a) Imports: add `import { applyDomainJobResult, createCustomDomain, findActiveDomain, isDomainJobType, toDomainView } from './domains.js';`

(b) Near the other request schemas: `const addDomainBodySchema = z.object({ hostname: z.string() });`

(c) In the Deployments section (near the other `/api/deployments/:id/...` routes):

```ts
// ── Custom domain (custom-domains MVP) ────────────────────────────────
app.post('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = request.params as { id: string };
  requireUuidId(id);
  const organizationId = requireSessionOrganizationId(request);
  const actor = requireActor(request);
  const deployment = await loadOwnedDeployment(db, id, organizationId);
  const body = addDomainBodySchema.parse(request.body);
  const domain = await createCustomDomain(db, deployment, body.hostname, actor.id);
  return reply.code(201).send({ domain: toDomainView(domain) });
});

app.get('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request) => {
  const { id } = request.params as { id: string };
  requireUuidId(id);
  const organizationId = requireSessionOrganizationId(request);
  const deployment = await loadOwnedDeployment(db, id, organizationId);
  const domain = await findActiveDomain(db, deployment.id);
  return { domain: domain ? toDomainView(domain) : null };
});
```

(match the exact helper names in the file — e.g. if `requireActor` is named differently, follow the neighboring routes).

(d) Relay result endpoint (`POST /api/relay/commands/:id/result`, ~line 2321): change

```ts
const nextState = state === 'FAILED' ? 'FAILED' : JOB_SUCCESS_STATE[job.type];
```

to

```ts
// Domain jobs manage the custom_domains row, never the deployment
// lifecycle — a failed cert request must not mark the deployment FAILED.
const nextState = isDomainJobType(job.type)
  ? undefined
  : state === 'FAILED'
    ? 'FAILED'
    : JOB_SUCCESS_STATE[job.type];
```

and inside the transaction, after the job update:

```ts
if (isDomainJobType(job.type)) {
  await applyDomainJobResult(tx, deployment, job, body);
}
```

- [ ] **Step 4: Run tests.** `pnpm vitest run apps/api/src/domain-routes.test.ts apps/api/src/server.test.ts` — Expected: PASS (both — server.test.ts guards against regressions).

- [ ] **Step 5: Commit** (`feat: add custom-domain API routes and relay result handling`).

---

### Task 5: Verification flow — check deps seam, runDomainCheck, check/remove endpoints, auto-check, destroy cleanup

**Files:**
- Create: `apps/api/src/domain-check.ts`
- Modify: `apps/api/src/domains.ts` (add `runDomainCheck`)
- Modify: `apps/api/src/server.ts` (check + DELETE routes, install-link check route, heartbeat hook, destroy hook, buildServer dep)
- Modify: `apps/api/src/env.ts` (or wherever `env` is defined — add `domainFixtureMode`)
- Test: extend `apps/api/src/domains.test.ts` + `apps/api/src/domain-routes.test.ts`

**Interfaces:**
- Produces (`apps/api/src/domain-check.ts`):

```ts
export interface DomainCheckDeps {
  /** True when `name` has a CNAME chain reaching `expectedTarget` (public DNS). */
  checkCname(name: string, expectedTarget: string): Promise<boolean>;
  /** True when an HTTPS request to the hostname completes a TLS handshake and returns any HTTP response. */
  probeHttps(hostname: string): Promise<boolean>;
  /** Floor between checks for one domain; the "Check now" throttle. */
  minCheckIntervalMs: number;
}
export function createRealDomainCheckDeps(): DomainCheckDeps;   // node:dns/promises + fetch, 30_000ms
export function createFixtureDomainCheckDeps(): DomainCheckDeps; // *.deployz-fixture.test → true, 0ms
```

- Produces (`apps/api/src/domains.ts`): `runDomainCheck(db, deployment, domain, deps): Promise<CustomDomainRow>` — returns the fresh row.
- New endpoints: `POST /api/deployments/:id/domain/check` (auth) and `DELETE /api/deployments/:id/domain` (auth) → `{ domain: CustomDomainView | null }`; `POST /api/install/:installLinkId/domain/check` (link-scoped, unauthenticated) → `{ domain: CustomDomainView }`.

- [ ] **Step 1: Implement `apps/api/src/domain-check.ts`:**

```ts
import { resolveCname } from 'node:dns/promises';

// Public-DNS + HTTPS probes behind a seam so tests and E2E runs never do
// real network I/O. Deployz only ever READS public DNS — it never writes
// to a customer's DNS provider.

export interface DomainCheckDeps {
  checkCname(name: string, expectedTarget: string): Promise<boolean>;
  probeHttps(hostname: string): Promise<boolean>;
  minCheckIntervalMs: number;
}

const normalizeTarget = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '');

export function createRealDomainCheckDeps(): DomainCheckDeps {
  return {
    minCheckIntervalMs: 30_000,
    async checkCname(name, expectedTarget) {
      try {
        const targets = await resolveCname(name);
        return targets.map(normalizeTarget).includes(normalizeTarget(expectedTarget));
      } catch {
        return false; // NXDOMAIN / ENODATA / timeout — record simply not there yet
      }
    },
    async probeHttps(hostname) {
      try {
        // Any completed HTTPS response proves DNS + TLS + routing; the app's
        // own status code (401, 302, …) is its business, not ours.
        await fetch(`https://${hostname}/`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// E2E fixture mode (DOMAIN_FIXTURE_MODE=true): deterministic answers for the
// reserved test namespace, mirroring GITHUB_FIXTURE_MODE.
export function createFixtureDomainCheckDeps(): DomainCheckDeps {
  const isFixture = (name: string) => name.endsWith('.deployz-fixture.test');
  return {
    minCheckIntervalMs: 0,
    checkCname: async (name) => isFixture(name),
    probeHttps: async (hostname) => isFixture(hostname),
  };
}
```

- [ ] **Step 2: Add `runDomainCheck` to `apps/api/src/domains.ts`:**

```ts
export async function runDomainCheck(
  db: RuntimeDb,
  deployment: { id: string; organizationId: string; customerId: string },
  domain: CustomDomainRow,
  deps: DomainCheckDeps,
): Promise<CustomDomainRow> {
  if (
    domain.lastCheckedAt &&
    Date.now() - domain.lastCheckedAt.getTime() < deps.minCheckIntervalMs
  ) {
    return domain;
  }
  await db
    .update(schema.customDomains)
    .set({ lastCheckedAt: new Date() })
    .where(eq(schema.customDomains.id, domain.id));

  switch (domain.status) {
    case 'PENDING':
      await ensureConfigureJob(db, deployment, domain, { forceNewCycle: false });
      break;
    case 'WAITING_FOR_DNS': {
      const validationOk =
        domain.validationName && domain.validationValue
          ? await deps.checkCname(domain.validationName, domain.validationValue)
          : false;
      const routingOk = domain.routingTarget
        ? await deps.checkCname(domain.hostname, domain.routingTarget)
        : false;
      const lastError = !validationOk
        ? 'DNS_VALIDATION_NOT_FOUND'
        : !routingOk
          ? 'DNS_ROUTING_MISMATCH'
          : null;
      await db
        .update(schema.customDomains)
        .set({ lastError })
        .where(eq(schema.customDomains.id, domain.id));
      if (validationOk && routingOk) {
        // DNS is in place — nudge the relay to progress ACM/listener state.
        await ensureConfigureJob(db, deployment, domain, { forceNewCycle: true });
      }
      break;
    }
    case 'CONFIGURING': {
      if (await deps.probeHttps(domain.hostname)) {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.customDomains)
            .set({ status: 'ACTIVE', lastError: null })
            .where(eq(schema.customDomains.id, domain.id));
          await recordEvent(tx, {
            organizationId: deployment.organizationId,
            eventType: 'domain.activated',
            actorType: 'system',
            actorId: deployment.id,
            deploymentId: deployment.id,
            customerId: deployment.customerId,
            result: 'success',
            payload: { hostname: domain.hostname },
          });
        });
      } else {
        await db
          .update(schema.customDomains)
          .set({ lastError: 'HTTPS_NOT_REACHABLE' })
          .where(eq(schema.customDomains.id, domain.id));
      }
      break;
    }
    case 'ERROR': {
      // Retry: fall back to the earliest still-plausible stage and re-run.
      const nextStatus = domain.validationName ? 'WAITING_FOR_DNS' : 'PENDING';
      await db
        .update(schema.customDomains)
        .set({ status: nextStatus, lastError: null })
        .where(eq(schema.customDomains.id, domain.id));
      await ensureConfigureJob(db, deployment, domain, { forceNewCycle: true });
      break;
    }
    case 'REMOVING':
      await ensureRemoveJob(db, deployment, domain);
      break;
    case 'ACTIVE':
      break;
  }
  const fresh = await db
    .select()
    .from(schema.customDomains)
    .where(eq(schema.customDomains.id, domain.id))
    .limit(1);
  return fresh[0] ?? domain;
}
```

(`ensureRemoveJob` is the REMOVE_DOMAIN analog of `ensureConfigureJob` — factor the shared lookup so `removeCustomDomain` uses it too. `recordEvent`'s field set must match `apps/api/src/events.ts` — adjust to the real `DeploymentEvent` interface.)

- [ ] **Step 3: Wire into `server.ts`.**
  - `buildServer` options: add `domainCheckDeps` with default `env.domainFixtureMode ? createFixtureDomainCheckDeps() : createRealDomainCheckDeps()`. Add `domainFixtureMode: process.env['DOMAIN_FIXTURE_MODE'] === 'true'` to the env module, mirroring how `githubFixtureMode` reaches `buildServer` (follow that exact plumbing).
  - Routes:

```ts
app.post('/api/deployments/:id/domain/check', { preHandler: requireAuth }, async (request) => {
  const { id } = request.params as { id: string };
  requireUuidId(id);
  const organizationId = requireSessionOrganizationId(request);
  const deployment = await loadOwnedDeployment(db, id, organizationId);
  const domain = await findActiveDomain(db, deployment.id);
  if (!domain) throw new NotFoundError('Custom domain not found');
  const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
  return { domain: toDomainView(fresh) };
});

app.delete('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request) => {
  const { id } = request.params as { id: string };
  requireUuidId(id);
  const organizationId = requireSessionOrganizationId(request);
  const deployment = await loadOwnedDeployment(db, id, organizationId);
  const domain = await findActiveDomain(db, deployment.id);
  if (!domain) throw new NotFoundError('Custom domain not found');
  const fresh = await removeCustomDomain(db, deployment, domain);
  return { domain: toDomainView(fresh) };
});

// Customer-facing "Check now" — link-scoped like GET /api/install/:installLinkId.
// Read-only trigger; runDomainCheck's own interval floor is the rate limit.
app.post('/api/install/:installLinkId/domain/check', async (request) => {
  const { installLinkId } = request.params as { installLinkId: string };
  requireUuidId(installLinkId);
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.installLinkId, installLinkId))
    .limit(1);
  const deployment = rows[0];
  if (!deployment) throw new NotFoundError('Installation not found');
  const domain = await findActiveDomain(db, deployment.id);
  if (!domain) throw new NotFoundError('Custom domain not found');
  const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
  return { domain: toDomainView(fresh) };
});
```

  - Auto-check on the relay heartbeat: at the end of the `POST /api/relay/health` handler (before its reply), add:

```ts
// Custom-domain auto-check piggybacks on the ~5-minute relay heartbeat —
// the existing background cadence, no new scheduler. Best-effort: a DNS
// hiccup must never fail a health report.
const activeDomain = await findActiveDomain(db, deployment.id);
if (
  activeDomain &&
  ['PENDING', 'WAITING_FOR_DNS', 'CONFIGURING', 'REMOVING'].includes(activeDomain.status) &&
  (!activeDomain.lastCheckedAt || Date.now() - activeDomain.lastCheckedAt.getTime() > 180_000)
) {
  try {
    await runDomainCheck(db, deployment, activeDomain, domainCheckDeps);
  } catch {
    // swallowed — heartbeat must succeed regardless
  }
}
```

  - Deployment deletion cleanup: in `POST /api/deployments/:id/destroy` (line ~1758), after the destroy job is created, if `findActiveDomain` returns a row → `removeCustomDomain(db, deployment, domain)`. And in the relay result handler, when a `DESTROY` job succeeds, also mark any still-active domain `removedAt = new Date()` inside the transaction (safety net: the stack is gone regardless).

- [ ] **Step 4: Tests** (extend the Task-4 test files; inject `domainCheckDeps` fakes into `buildServer`):
  - check on `WAITING_FOR_DNS` with failing CNAME deps → `error: 'DNS_VALIDATION_NOT_FOUND'`, status unchanged;
  - validation resolves but routing doesn't → `DNS_ROUTING_MISMATCH`;
  - both resolve → a new CONFIGURE_DOMAIN job appears (cycle bumped);
  - `CONFIGURING` + prober true → `active` + a `domain.activated` event row;
  - `CONFIGURING` + prober false → `HTTPS_NOT_REACHABLE`;
  - two checks within the interval → second is a no-op (`minCheckIntervalMs: 60_000` fake, assert `lastCheckedAt` unchanged);
  - `minCheckIntervalMs: 0` allows immediate re-check;
  - DELETE → `removing` + REMOVE_DOMAIN job; DELETE again → 200, no duplicate unfinished job;
  - link-scoped check works unauthenticated and 404s on unknown link;
  - destroy route removes the domain (REMOVE_DOMAIN job enqueued alongside DESTROY);
  - `ERROR` + check → status falls back and a fresh job is enqueued (the "Retry" path).

Run: `pnpm vitest run apps/api/src` — Expected: PASS.

- [ ] **Step 5: Commit** (`feat: add custom-domain verification, check-now, removal and auto-check`).

---

### Task 6: Relay executors — real ACM/ALB logic behind seams (TDD)

**Files:**
- Create: `packages/relay/src/domain.ts`
- Create: `packages/relay/src/domain.test.ts`
- Modify: `packages/relay/src/index.ts`
- Modify: `packages/relay/package.json` (add `@aws-sdk/client-acm`, `@aws-sdk/client-elastic-load-balancing-v2` at the same `^3.x` line as the existing `@aws-sdk/client-secrets-manager`; run `pnpm install`)

**Interfaces:**
- Consumes: `RelayCommand`, `RelayCommandResult`, `CommandExecutor` from `./commands.js`. Command payloads: `{ hostname: string; domainId: string; certificateArn?: string }`.
- Produces:

```ts
export interface AcmClient {
  requestCertificate(p: { domainName: string; idempotencyToken: string; tags: Record<string, string> }): Promise<string>; // arn
  describeCertificate(arn: string): Promise<{
    status: string; // 'PENDING_VALIDATION' | 'ISSUED' | 'FAILED' | …
    validationRecord?: { name: string; value: string };
  }>;
  deleteCertificate(arn: string): Promise<void>; // must swallow ResourceNotFoundException
}
export interface LoadBalancerInfo { arn: string; dnsName: string }
export interface ListenerInfo {
  arn: string;
  port: number;
  defaultCertificateArn?: string;
  redirectsToHttps: boolean;
  forwardTargetGroupArn?: string;
}
export interface ElbClient {
  findTaggedLoadBalancer(tagKey: string, tagValue: string): Promise<LoadBalancerInfo | undefined>;
  describeListeners(loadBalancerArn: string): Promise<ListenerInfo[]>;
  describeTargetGroups(loadBalancerArn: string): Promise<string[]>; // target group arns
  createHttpsListener(p: { loadBalancerArn: string; certificateArn: string; targetGroupArn: string }): Promise<void>;
  addListenerCertificate(listenerArn: string, certificateArn: string): Promise<void>; // idempotent
  removeListenerCertificate(listenerArn: string, certificateArn: string): Promise<void>; // swallow not-found
  deleteListener(listenerArn: string): Promise<void>;
  setHttpRedirect(listenerArn: string): Promise<void>;   // 80 → 301 https://#{host}:443
  setHttpForward(listenerArn: string, targetGroupArn: string): Promise<void>;
}
export function createDomainExecutors(deps: { acm: AcmClient; elb: ElbClient; installationId: string }): {
  CONFIGURE_DOMAIN: CommandExecutor;
  REMOVE_DOMAIN: CommandExecutor;
};
export function createRealDomainAwsClients(): { acm: AcmClient; elb: ElbClient }; // lazy SDK v3 clients
```

Executor semantics (this is also the test spec):

**CONFIGURE_DOMAIN**
1. `certificateArn` = payload's, else `acm.requestCertificate({ domainName: hostname, idempotencyToken: domainId.replace(/-/g, ''), tags: { 'deployz:installation': installationId } })` (uuid sans dashes = 32 chars, ACM's token limit; ACM dedupes identical requests natively).
2. `describeCertificate` → `status`, `validationRecord`.
3. `elb.findTaggedLoadBalancer('deployz:installation', installationId)` → `routingTarget = lb.dnsName` (may be undefined pre-INSTALL — still succeed, report what's known).
4. If `status === 'ISSUED'` and lb found: listeners = `describeListeners(lb.arn)`. If no 443 listener → targetGroupArn = the 80-listener's `forwardTargetGroupArn` ?? first of `describeTargetGroups(lb.arn)`; if found → `createHttpsListener`. If a 443 listener exists → `addListenerCertificate(listener.arn, certificateArn)` (skip when it's already the default). Then, if HTTPS is in place and the 80 listener exists and `!redirectsToHttps` → `setHttpRedirect(http.arn)`. Set `httpsConfigured = true` when the 443 listener exists/was created with our cert.
5. Success output: `{ certificateArn, certificateStatus, validationName?, validationValue?, routingTarget?, httpsConfigured }`.
6. Errors: catch; `success: false`, `error: String(err)`, `failureCode: 'AWS_PERMISSION_DENIED'` when the error name/code contains `AccessDenied`, else `'UNKNOWN'`.

**REMOVE_DOMAIN**
1. If lb found and payload has `certificateArn`: 443 listener present? If its `defaultCertificateArn === certificateArn` → `deleteListener(https.arn)` and, if the 80 listener `redirectsToHttps` → `setHttpForward(http.arn, firstTargetGroup)` (restore the pre-domain state). Else → `removeListenerCertificate(https.arn, certificateArn)`.
2. `acm.deleteCertificate(certificateArn)` — swallow not-found; if in-use (`ResourceInUseException`) return `success: false` with `error` so the control plane retries later.
3. Success output: `{ removed: true }`.
4. Every step tolerates missing resources — a partially-removed domain finishes cleanly on retry.

- [ ] **Step 1: Write failing tests** (`packages/relay/src/domain.test.ts`) with hand-rolled fake `AcmClient`/`ElbClient` (house idiom — in-memory fakes implementing the interface, see `packages/cdk/test/notifications.test.ts` style). Cases:
  - fresh configure: requests cert, reports validation record + routing target, `httpsConfigured: false` while `PENDING_VALIDATION`;
  - configure with `certificateArn` in payload: does NOT call `requestCertificate`;
  - issued + no 443: creates the HTTPS listener with the 80-listener's target group and sets the 80 redirect; output `httpsConfigured: true`;
  - issued + 443 already ours: no create/add calls (idempotent), still `httpsConfigured: true`;
  - issued + 443 with a different default cert: `addListenerCertificate` called;
  - no load balancer found: succeeds with `routingTarget` undefined, no listener calls;
  - AccessDenied from ACM → `success: false, failureCode: 'AWS_PERMISSION_DENIED'`;
  - remove with our default cert: deletes listener, restores 80 forward, deletes cert;
  - remove when everything is already gone: still `success: true`;
  - remove with cert in use: `success: false`.

- [ ] **Step 2: Run to verify failure.** `pnpm vitest run packages/relay/src/domain.test.ts` — FAIL.

- [ ] **Step 3: Implement `packages/relay/src/domain.ts`** per the semantics, plus `createRealDomainAwsClients()` using `ACMClient`/`ElasticLoadBalancingV2Client` (module-lazy singletons, region from the Lambda's own environment — the relay always operates in its home region). The real `ElbClient.findTaggedLoadBalancer` = `DescribeLoadBalancers` (paginate) + `DescribeTags` in chunks of 20 ARNs; `redirectsToHttps` = default action type `redirect` with `Protocol: 'HTTPS'`; `setHttpRedirect` = `ModifyListener` with `DefaultActions: [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }]`.

- [ ] **Step 4: Wire `packages/relay/src/index.ts`:** in `createDefaultExecutors()`, replace the two noop entries from Task 4:

```ts
const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? '';
const domainExecutors = createDomainExecutors({
  ...createRealDomainAwsClients(),
  installationId,
});
return {
  /* eight existing noop entries unchanged */
  CONFIGURE_DOMAIN: domainExecutors.CONFIGURE_DOMAIN,
  REMOVE_DOMAIN: domainExecutors.REMOVE_DOMAIN,
};
```

Keep `createRealDomainAwsClients` lazy (construct SDK clients inside the first call, not at module load) so unit tests of the handler never touch the SDK.

- [ ] **Step 5: Run the relay suite.** `pnpm vitest run packages/relay` — Expected: PASS.

- [ ] **Step 6: Commit** (`feat: implement relay ACM/ALB executors for custom domains`).

---

### Task 7: IAM — least-privilege ACM + listener permissions, disclosure sync, artifacts

**Files:**
- Modify: `packages/cdk/src/bootstrap/bootstrap-stack.ts`
- Modify: `apps/web/src/lib/security-details.ts`
- Modify: `packages/cdk/test/bootstrap-stack.test.ts` (+ snapshot), `apps/web/test/security-details.test.ts` (expectations)
- Regenerate: `packages/cdk/artifacts/bootstrap-template-v1.json` via `node packages/cdk/scripts/synth-bootstrap.mjs` (check the script's actual invocation in `packages/cdk/package.json`)

**Interfaces:**
- Consumes: existing phase-2 statement pattern (tag-scoped `PolicyStatement`s on `ProvisionerPolicy`, installation-tag conditions).
- Produces: relay role phase-2 additionally allows exactly the actions below, nothing else.

Current audit (verified): phase 2 grants CFN create/manage (tag-scoped), `iam:PassRole` (path-scoped), ECS update/delete/describe, RDS modify/delete/describe, and ELB **read-only** (`DescribeLoadBalancers`, `DescribeTargetGroups`, `DescribeTargetHealth`). **No ACM actions and no ELB listener-write actions exist anywhere.** Missing for custom domains:

```ts
/** Phase 2 — custom-domain certificate lifecycle (custom-domains MVP). */
const PHASE_2_ACM_REQUEST_ACTIONS = ['acm:RequestCertificate', 'acm:AddTagsToCertificate'] as const;
const PHASE_2_ACM_MANAGE_ACTIONS = [
  'acm:DescribeCertificate',
  'acm:DeleteCertificate',
  'acm:ListTagsForCertificate',
] as const;
/** Phase 2 — custom-domain HTTPS listener management on the deployment's ALB. */
const PHASE_2_DOMAIN_INGRESS_ACTIONS = [
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeListenerCertificates',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DescribeRules',
  'elasticloadbalancing:CreateListener',
  'elasticloadbalancing:ModifyListener',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:AddListenerCertificates',
  'elasticloadbalancing:RemoveListenerCertificates',
] as const;
```

- [ ] **Step 1: Add statements to `ProvisionerPolicy`** in `bootstrap-stack.ts`, following the existing statements' construction style exactly:
  - ACM request statement: actions `PHASE_2_ACM_REQUEST_ACTIONS`, resources `['*']` (RequestCertificate takes no resource), condition `StringEquals: { 'aws:RequestTag/deployz:installation': <installation tag value used by the existing statements> }` — copy the exact condition expression the CFN create statement uses.
  - ACM manage statement: actions `PHASE_2_ACM_MANAGE_ACTIONS`, resources `['*']`, condition `StringEquals: { 'aws:ResourceTag/deployz:installation': ... }`.
  - Domain ingress statement: actions `PHASE_2_DOMAIN_INGRESS_ACTIONS`, resources `['*']`. The `Describe*` ELB actions do not support resource-level restrictions; scope the write actions (`CreateListener`, `ModifyListener`, `DeleteListener`, `AddListenerCertificates`, `RemoveListenerCertificates`) in a **separate** statement with the `aws:ResourceTag/deployz:installation` condition (the ALB and its listeners inherit the application stack's tags), and leave only the `Describe*` set condition-free. If a synthesized-template test shows a condition breaks a Describe call pattern already in use, keep writes conditioned and describes open — least privilege with working reads.

- [ ] **Step 2: Sync the disclosure.** Update `apps/web/src/lib/security-details.ts` with the new actions in the same structure it already uses (it is test-locked to the stack). Plain-language purpose line: "Request and manage the TLS certificate for a custom domain you configure, and attach it to the deployment's load balancer."

- [ ] **Step 3: Update tests + snapshots.** Extend the exact-action assertions in `packages/cdk/test/bootstrap-stack.test.ts` (`allIamActions()`/`relayRoleActions()` helpers) with the new actions. Run:
  - `pnpm vitest run packages/cdk/test/bootstrap-stack.test.ts` (regenerate snapshot with `-u` if the diff is exactly the new statements);
  - `pnpm vitest run apps/web/test/security-details.test.ts`.
  Expected: PASS.

- [ ] **Step 4: Regenerate the checked-in bootstrap artifact** (`packages/cdk/scripts/synth-bootstrap.mjs` — run it the way `packages/cdk/package.json` scripts do) and commit the JSON diff. Do NOT run `publish-bootstrap.mjs` (publishing to S3 is a deploy-time operation, CI/maintainer-only).

- [ ] **Step 5: Commit** (`feat: grant relay least-privilege ACM and listener permissions for custom domains`).

---

### Task 8: Web lib — domain client + status/error copy (TDD)

**Files:**
- Create: `apps/web/src/lib/domains.ts`
- Create: `apps/web/test/domain-copy.test.ts`

**Interfaces:**
- Consumes: `apiRequest` from `@/lib/api-client` (mutations need the error envelope), `apiUrl` pattern from `@/lib/deployments`.
- Produces:

```ts
export type CustomDomainStatus =
  | 'pending' | 'waiting_for_dns' | 'configuring' | 'active' | 'error' | 'removing';
export interface DnsRecordView { purpose: 'verification' | 'routing'; type: 'CNAME'; name: string; value: string }
export interface CustomDomainView {
  hostname: string;
  status: CustomDomainStatus;
  records: DnsRecordView[];
  error: string | null;
  url: string | null;
}
export const DOMAIN_STATUS_LABEL: Record<CustomDomainStatus, string>;
export function domainErrorCopy(code: string | null): { title: string; body: string } | null;
export function fetchDomain(deploymentId: string): Promise<CustomDomainView | null>;
export function addDomain(deploymentId: string, hostname: string): Promise<CustomDomainView>;
export function checkDomain(deploymentId: string): Promise<CustomDomainView>;
export function removeDomain(deploymentId: string): Promise<CustomDomainView | null>;
export function checkDomainByLink(installLinkId: string): Promise<CustomDomainView>;
export function fetchDomainByLink(installLinkId: string): Promise<CustomDomainView | null>; // re-GETs /api/install/:id, returns .domain
```

- [ ] **Step 1: Failing test** (`apps/web/test/domain-copy.test.ts`) asserting `DOMAIN_STATUS_LABEL` maps all six statuses to the spec labels (Setting up / Waiting for DNS / Connecting / Active / Needs attention / Removing) and `domainErrorCopy`:
  - `'DNS_VALIDATION_NOT_FOUND'` → title `Verification record not found`, body `We couldn't find the required DNS record yet. Check that it matches exactly.`
  - `'DNS_ROUTING_MISMATCH'` → title `Domain isn't pointing to this deployment`, body `Update the routing CNAME to the value shown below.`
  - `'AWS_PERMISSION_DENIED'` → title `Deployz couldn't configure HTTPS`, body `The connected AWS account doesn't currently allow Deployz to complete the domain setup.`
  - `'CONFIGURE_FAILED'`, `'HTTPS_NOT_REACHABLE'`, `'REMOVE_FAILED'`, unknown strings → title `We couldn't connect this domain`, body `Check the DNS records and try again.`
  - `null` → `null`.

- [ ] **Step 2: Run to verify failure**, then implement `apps/web/src/lib/domains.ts`. Fetch helpers: mutations via `apiRequest<{ domain: CustomDomainView }>(...)`; `fetchDomain` GET returns `.domain`; treat 401/403/404 from `fetchDomain` as `null` (drives the read-only customer mode). `fetchDomainByLink`/`checkDomainByLink` hit `/api/install/:installLinkId` and `/api/install/:installLinkId/domain/check` with plain `fetch` + `cache: 'no-store'` (follow `apps/web/src/lib/deployments.ts`'s `getJson`/`postJson` local-helper convention).

- [ ] **Step 3: Run.** `pnpm vitest run apps/web/test/domain-copy.test.ts` — PASS.

- [ ] **Step 4: Commit** (`feat: add web custom-domain client and copy maps`).

---

### Task 9: CustomDomainCard component

**Files:**
- Create: `apps/web/src/components/custom-domain-card.tsx`

**Interfaces:**
- Consumes: everything from `@/lib/domains`, `Button`/`Card`/`CardContent`/`Input`/`Label` from `@/components/ui/*`, `errorMessage`/`ApiRequestError` from `@/lib/api-client`, lucide icons (`Loader2`, `ExternalLink`).
- Produces: `export function CustomDomainCard(props: { deploymentId: string | null; installLinkId: string | null; initialDomain: CustomDomainView | null })` — client component.

Behavior:
- **Mode detection:** if `deploymentId` is set, on mount call `fetchDomain(deploymentId)`; success (including `null` domain) → `canManage = true` and use authenticated endpoints; thrown 401/403/404 → `canManage = false` (customer view) and fall back to `initialDomain` + link endpoints. If only `installLinkId` is set → customer view.
- **Polling:** while a domain exists and `status !== 'active'`, poll every 5000 ms (manage: `fetchDomain`; customer: `fetchDomainByLink`), `setInterval` + cleanup exactly like the `ANALYSIS_POLL_MS` pattern in `apps/web/src/app/dashboard/applications/[id]/page.tsx`.
- **Empty state (manage):** card titled `Custom domain`, body `Use your customer's own domain for this deployment.`, button `Set up custom domain`, helper `You'll need access to the domain's DNS settings.` Button opens an **inline panel** (house pattern — no modal): heading `Set up custom domain`, `Label` `Domain` + `Input` placeholder `app.example.com`, helper `Enter a subdomain you control.`, buttons `Cancel` / `Add domain`. Submit → `addDomain`; on `ApiRequestError` show `error.message` (the server copy) under the input via `role="alert"`.
- **Empty state (customer):** card says `No custom domain is set up for this deployment yet.` (no actions).
- **Waiting for DNS:** status line `Waiting for DNS`; text `Add these DNS records at your DNS provider. Deployz will automatically continue once they're detected.`; the two records rendered by a local `DnsRecordRow` (label `Verify ownership` / `Route traffic` from `purpose`); footer `DNS changes can take some time to appear.`; actions `Check now` (both modes) and `Remove domain` (manage only, opens inline confirm).
- **DnsRecordRow:** stacked `Type` / `Name` / `Value` fields; Name and Value in `<code className="block overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">` with a `Copy` button each (clipboard + `Copied` for 2 s — lift the exact pattern from `InstallLinkCard` in `apps/web/src/app/dashboard/deployments/[id]/page.tsx:564`). Never truncate values; `overflow-x-auto` keeps them selectable. Mobile stacks naturally (flex-col).
- **Pending:** status `Setting up` + `Loader2` spinner (`animate-spin`), text `Requesting a certificate for this domain…`, no records yet.
- **Connecting (`configuring`):** status `Connecting` + spinner; text `Your domain is verified. Deployz is configuring HTTPS and connecting it to this deployment.`; collapsible `View DNS records` (local `useState` toggle rendering the records).
- **Active:** status `Active`; text `Your deployment is available securely at:` + `https://{hostname}` as a link; actions: `Open domain ↗` (Button `asChild` + `<a target="_blank" rel="noreferrer">`), `View DNS records` toggle, `Remove domain` (manage only).
- **Error:** status `Needs attention`; render `domainErrorCopy(domain.error)` title/body; show the expected records; button `Check again` → same handler as Check now (label switches to `Retry` when the copy is the generic failure).
- **Removing:** status `Removing` + spinner; actions disabled.
- **Remove confirm (inline panel, house style like `DisconnectPanel`):** heading `Remove custom domain?`, body `` `{hostname}` will stop routing to this deployment. Your DNS records will not be deleted automatically. ``, buttons `Cancel` / `Remove domain` (destructive) → `removeDomain`.
- `Check now` sets a brief `checking` state on the button (`Checking…`), then re-renders from the returned view. The server throttles; no client cooldown needed beyond disabling while in flight.
- Status labels always via `DOMAIN_STATUS_LABEL`. Keep the card `max-w-2xl` so DNS values don't stretch full-page (spec).

- [ ] **Step 1: Implement the component** exactly as specified. Reuse `Card`, `Button`, `Input`, `Label`; no new visual primitives.
- [ ] **Step 2: Type-check + lint.** `pnpm --filter @deployz/web run lint` and `pnpm --filter @deployz/web exec tsc --noEmit` (or the package's existing typecheck script). Expected: clean.
- [ ] **Step 3: Commit** (`feat: add CustomDomainCard component`).

---

### Task 10: Customer-facing deployment page (install link, post-install state)

**Files:**
- Modify: `apps/api/src/server.ts` (`GET /api/install/:installLinkId` response)
- Modify: `apps/web/src/lib/install-data.ts`
- Modify: `apps/web/src/app/install/[installLinkId]/page.tsx`

**Interfaces:**
- Consumes: `CustomDomainCard` (Task 9), `toDomainView`/`findActiveDomain` (Task 3).
- Produces: `InstallData` gains `deploymentId: string`, `deploymentState: string`, `domain: CustomDomainView | null`, `routingTarget: string | null`.

- [ ] **Step 1: Extend the API.** In `GET /api/install/:installLinkId` add `deploymentId: schema.deployments.id` and `deploymentState: schema.deployments.state` to the select; after loading, `const domain = await findActiveDomain(db, row.deploymentId);` and add to the response: `deploymentId`, `deploymentState`, `domain: domain ? toDomainView(domain) : null`, `routingTarget: domain?.routingTarget ?? null`. (The link already identifies exactly this deployment; none of this crosses a tenant boundary.)

- [ ] **Step 2: Extend `InstallData`** in `apps/web/src/lib/install-data.ts` with the four fields (import `CustomDomainView` from `@/lib/domains`).

- [ ] **Step 3: Rewrite the `alreadyInstalled` branch** of `apps/web/src/app/install/[installLinkId]/page.tsx` into the customer-facing deployment page:

```tsx
if (data.alreadyInstalled) {
  const primaryUrl = data.domain?.status === 'active' ? data.domain.url : null;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Running in your cloud account · deployed by {data.publisherName}
        </p>
      </div>

      <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
        <h2 id="deployment-access" className="text-base font-semibold">
          Access
        </h2>
        {primaryUrl ? (
          <p className="text-sm">
            Your deployment is available at{' '}
            <a className="font-medium underline underline-offset-4" href={primaryUrl}>
              {primaryUrl}
            </a>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {data.routingTarget
              ? 'Set up a custom domain below to give this deployment a permanent address.'
              : 'This deployment does not have a public address configured yet.'}
          </p>
        )}
        {data.routingTarget ? (
          <p className="text-xs text-muted-foreground">
            Deployment endpoint:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {data.routingTarget}
            </code>
          </p>
        ) : null}
      </section>

      <CustomDomainCard
        deploymentId={data.deploymentId}
        installLinkId={installLinkId}
        initialDomain={data.domain}
      />

      <p className="text-xs text-muted-foreground">
        This setup link has been used — {data.applicationName} is already installed. To install
        again, ask {data.publisherName} for a new link.
      </p>
    </div>
  );
}
```

(The page is a server component; `CustomDomainCard` is `'use client'` — importing it here is the standard Next.js boundary. The reinstall note preserves the page's previous message.)

- [ ] **Step 4: Route tests.** Extend the Task-4/5 API test file: GET install data now includes `deploymentId`, `deploymentState`, and `domain: null`/view. Run `pnpm vitest run apps/api/src` — PASS.

- [ ] **Step 5: Manual smoke (optional but cheap):** `pnpm dev`, seed via UI or skip — the E2E task covers this end to end.

- [ ] **Step 6: Commit** (`feat: customer-facing deployment view with custom domain on install page`).

---

### Task 11: Dashboard — compact status row + primary URL

**Files:**
- Modify: `apps/api/src/server.ts` (`GET /api/deployments/:id` detail response)
- Modify: `apps/web/src/lib/deployments.ts` (`FleetDeploymentDetail` type)
- Modify: `apps/web/src/app/dashboard/deployments/[id]/page.tsx`

**Interfaces:**
- Produces: detail response + `FleetDeploymentDetail` gain `customDomain: { hostname: string; status: CustomDomainStatus } | null` (lowercase status, matching the wire format).

- [ ] **Step 1: API.** In `GET /api/deployments/:id` (line ~1482), after the row loads: `const domain = await findActiveDomain(db, deployment.id);` and add `customDomain: domain ? { hostname: domain.hostname, status: domain.status.toLowerCase() } : null` to the response object (wherever the route composes `toFleetRow(...)` output — attach at the route level, not inside `toFleetRow`, so the list endpoint stays untouched).

- [ ] **Step 2: Type.** Add `customDomain: { hostname: string; status: CustomDomainStatus } | null` to `FleetDeploymentDetail` in `apps/web/src/lib/deployments.ts` (import the status type from `./domains`).

- [ ] **Step 3: UI.** In `DetailBody` (`apps/web/src/app/dashboard/deployments/[id]/page.tsx`):
  - In the Overview card, when `detail.customDomain?.status === 'active'`, add `<MetaRow label="URL" value={`https://${detail.customDomain.hostname}`} />` right after the Application row (the custom domain is the primary displayed URL).
  - After the Overview section, add the compact row (omit entirely when no domain — the spec allows omitting):

```tsx
{detail.customDomain ? (
  <section aria-labelledby="custom-domain" className="flex flex-col gap-3">
    <h2 id="custom-domain" className="text-base font-semibold">
      Custom domain
    </h2>
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
          {detail.customDomain.hostname}
        </code>
        <span className="text-sm text-muted-foreground">
          {DOMAIN_STATUS_LABEL[detail.customDomain.status]}
        </span>
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <Link href={`/install/${detail.installLinkId}`}>Manage →</Link>
        </Button>
      </CardContent>
    </Card>
  </section>
) : null}
```

  (import `DOMAIN_STATUS_LABEL` from `@/lib/domains`; `detail.installLinkId` already exists — `InstallLinkCard` uses it. Do NOT add any domain setup flow here.)

- [ ] **Step 4: Verify.** `pnpm --filter @deployz/web run lint` + typecheck; `pnpm vitest run apps/api/src apps/web` — PASS.

- [ ] **Step 5: Commit** (`feat: show compact custom-domain status on the deployment page`).

---

### Task 12: E2E — full lifecycle with a simulated relay

**Files:**
- Create: `e2e/custom-domain.spec.ts`
- Modify: `playwright.config.ts` (add `DOMAIN_FIXTURE_MODE: 'true'` to the API `webServer.env`, next to `GITHUB_FIXTURE_MODE`)

**Interfaces:**
- Consumes: fixture hostname namespace `*.deployz-fixture.test` (Task 5); relay HTTP protocol (`POST /api/relay/register`, `GET /api/relay/commands`, `POST /api/relay/commands/:id/result` with `Authorization: Bearer <token>`); seeding patterns from `e2e/install.spec.ts` (copy its `seedInstall`-style helper).

Test flow (single `test()` or a small serial `describe`, unique names via `crypto.randomUUID().slice(0, 8)`):

1. Seed vendor user + org + application + customer + deployment via `request.post` against `http://localhost:3001` (mirror `install.spec.ts`).
2. `GET /api/install/:installLinkId` → parse `quickCreateUrl`, extract `param_EnrollmentCode`.
3. Simulate relay enrollment: `POST /api/relay/register` with bearer token `e2e-relay-${suffix}` and body `{ enrollmentCode, installationId: 'e2e-inst-${suffix}', awsAccountId: '123456789012' }` → 200.
4. Sign in through the UI (existing auth helper pattern), navigate to `/install/{installLinkId}` → expect the post-install view and the Custom domain card's empty state.
5. Click `Set up custom domain`, type `app.${suffix}.deployz-fixture.test`, click `Add domain` → expect status `Setting up`.
6. Relay round 1: `GET /api/relay/commands` (bearer) → expect one `CONFIGURE_DOMAIN` command; `POST /api/relay/commands/{id}/result` with `{ success: true, output: { certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/e2e', certificateStatus: 'PENDING_VALIDATION', validationName: '_e2e.app.${suffix}.deployz-fixture.test', validationValue: '_e2e.acm-validations.aws.deployz-fixture.test', routingTarget: 'e2e-alb.deployz-fixture.test', httpsConfigured: false } }`.
   (Note the validation/routing values end in `.deployz-fixture.test` so the fixture CNAME checker approves them — the checker keys off the **name** argument; both names here are in the fixture namespace.)
7. UI (poll picks it up ≤5 s): expect `Waiting for DNS`, both records visible, `Copy` buttons present; click one → `Copied`.
8. Click `Check now` → fixture DNS passes → relay round 2: poll commands → new `CONFIGURE_DOMAIN` → post result `{ success: true, output: { certificateArn: …, certificateStatus: 'ISSUED', routingTarget: 'e2e-alb.deployz-fixture.test', httpsConfigured: true } }`.
9. UI: expect `Connecting`; click `Check now` → fixture probe passes → expect `Active` and the `https://app.…deployz-fixture.test` link + `Open domain ↗`.
10. Dashboard: navigate to the deployment detail page → expect the compact `Custom domain` section with the hostname, `Active`, and a `Manage →` link pointing at `/install/{installLinkId}`; Overview shows the URL row.
11. Back on the install page: `Remove domain` → confirm panel → confirm → expect `Removing`; relay round 3: poll commands → `REMOVE_DOMAIN` → post `{ success: true, output: { removed: true } }` → UI returns to the empty state.
12. API assertion: `GET /api/deployments/:id/domain` (authed via the browser context's cookies or a `request` context that signed in) → `{ domain: null }`.

- [ ] **Step 1: Write the spec** per the flow above (use `expect.poll`/`page.waitFor` generously — the UI polls at 5 s).
- [ ] **Step 2: Update `playwright.config.ts`** env.
- [ ] **Step 3: Run.** `pnpm test:e2e -- custom-domain` (kill any stale dev servers on 3000/3001 first — locally Playwright reuses them and would serve stale code; see the `reuseExistingServer` note). Expected: PASS.
- [ ] **Step 4: Commit** (`test: add custom-domain E2E lifecycle spec`).

---

### Task 13: Full verification sweep

- [ ] **Step 1:** `pnpm vitest run` at the repo root (all projects — apps/api, apps/web, packages/*; CDK tests are serial and slow, expect several minutes). Expected: PASS. Fix anything broken (parity tests, snapshots, counts).
- [ ] **Step 2:** `pnpm lint`. Expected: clean.
- [ ] **Step 3:** `pnpm test:e2e`. Expected: PASS (all specs, not just the new one).
- [ ] **Step 4:** Re-read the spec's Acceptance Criteria list against the diff (`git diff main --stat`); confirm each criterion maps to shipped code or a documented MVP trade-off (real-AWS E2E is covered by the fixture-mode spec + relay executor unit tests, consistent with the repo's simulated-relay stage; note this in the PR body).
- [ ] **Step 5: Commit** any fixes (`test: stabilize custom-domains suite`).

---

### Task 14: Ship — PR, CI, merge, cleanup

- [ ] **Step 1:** Push branch `claude/deployz-custom-domains-mvp-c9cbdf`; open a PR to `main` titled `feat: custom domains MVP` with a summary (feature, architecture decision notes: relay commands, install-page placement, IAM additions, fixture-mode E2E). PR body ends with the standard generated-with footer.
- [ ] **Step 2:** Watch CI (`gh pr checks --watch`). Remember: local vitest under-reports (~700 CDK tests run in CI) — trust CI. Fix failures, push, repeat.
- [ ] **Step 3:** Merge the PR once green.
- [ ] **Step 4:** Cleanup: delete the remote branch, remove the worktree per repo conventions.
