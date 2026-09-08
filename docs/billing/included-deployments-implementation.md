# Included production deployments — implementation note

Phase 0 of the included-deployment allowance. Written before any code, from
the repository as it stands after the Paddle migration (PR #241). This is the
plan adapted to the real codebase; `paddle-billing.md` remains the shape of
the shipped system and is updated as each phase lands.

## What exists today

### Billing formula

`countBillableDeployments(rows)` in `apps/api/src/billing-domain.ts` counts
rows where `deploymentType = PRODUCTION` and `billingState = ACTIVE`. That
count is the ONLY number Deployz pushes to Paddle. It is read in three places:

| Reader | File | Purpose |
|---|---|---|
| `reconcileBilling` | `apps/api/src/billing-reconcile.ts` | the absolute quantity sent to Paddle |
| `GET /api/billing/summary` | `apps/api/src/server.ts` (~line 5222) | vendor billing page: `$49 + n × $19` |
| `getVendorDetail` | `apps/api/src/admin/queries.ts` (~line 610) | admin `billing.liveDeployments` |

### Reconciliation source of truth

`reconcileBilling` reads every deployment row of the organization, computes
the expected quantity, reads the Paddle subscription, and replaces the item
list with `Platform × 1` plus `Customer Deployment × expected` (or no
deployment item when expected is 0). Absolute, never a delta. It never throws;
a failure is recorded in `billing_reconciliation_events`. Callers:

- `markDeploymentLive` / `markDeploymentRemoved` write paths (relay and
  destroy routes) — best effort, after the billing state changed.
- `sweepBilling` in `packages/cdk/src/lambda/worker.ts` — the 15-minute
  safety job, re-checks any ACTIVE/PAST_DUE subscription not reconciled for
  an hour.
- `POST /api/admin/vendors/:id/reconcile-billing` — the admin button.

All three call the same function, so changing the formula in one place
changes it everywhere.

### Subscription lifecycle

`billing_subscriptions` has one row per organization and exists only after
the first production checkout activates (Phase 8 webhook). Evaluation means
no row. `assertProductionDeploymentAllowed` refuses a PRODUCTION deployment
without an ACTIVE row (402 `SUBSCRIPTION_REQUIRED`), which the web app turns
into the Paddle checkout for the platform price only.

### Admin

- Routes in `apps/api/src/admin/routes.ts`, all behind `requireTeamAdmin`.
- Audit rows through `recordAdminAuditEvent` (`apps/api/src/admin/audit.ts`)
  into the append-only `event_logs` table (trigger rejects UPDATE/DELETE).
  Payload carries `adminEmail`, `targetType`, `targetId`, `reason`, and
  action-specific fields.
- Vendor detail page `apps/web/src/app/admin/vendors/[id]/page.tsx` already
  has a `VendorBillingSection` with the live count, subscription facts, the
  Reconcile button and the last five reconciliations.
- Audit-log labels live in `apps/web/src/lib/admin-vocabulary.ts`.
- Support mode ("View as Vendor") is enforced read-only for every non-GET
  request outside `/api/admin/*` by `enforceSupportModeReadOnly` in
  `apps/api/src/require-auth.ts`.

### Vendor UI

- Billing page `apps/web/src/app/dashboard/settings/billing/page.tsx` reads
  `GET /api/billing/summary` (`{ base, deployments[], total, subscription }`)
  and lists one `$19` line per live customer deployment.
- New deployment page `apps/web/src/app/dashboard/deployments/new/page.tsx`
  shows a price line from the subscription status only.
- Deployment detail `apps/web/src/app/dashboard/deployments/[id]/page.tsx`
  shows `deploymentBillingLabel` (`$19/month` for a live production
  deployment) and the disconnect dialog says "This stops the $19/month
  Deployz charge".

### Tests

- Domain: `billing-domain.test.ts`, `billing-matrix.test.ts`.
- Reconcile: `billing-reconcile.test.ts` with a `fakePaddle` double.
- Admin: `admin-billing.test.ts` (buildServer + PGlite + fake Paddle).
- Worker: `packages/cdk/test/worker-billing.test.ts`.
- Schema: `packages/db/src/migrations.test.ts`, `constraints.test.ts`.
- Web: `apps/web/test/deployment-billing.test.ts`.
- E2E (simulated, `BILLING_FIXTURE_MODE=true`, no Paddle client):
  `e2e/billing.spec.ts`, `e2e/admin.spec.ts`.

## Where the allowance lives

`organization.included_production_deployments integer NOT NULL DEFAULT 0`
with a CHECK constraint `0 <= value <= 10000`.

Why the organization row and not a new entitlement table: there is no
provider-neutral billing account record today; `billing_subscriptions` exists
only after paid activation, so it cannot hold a pre-subscription value. A
single integer column on the organization is the smallest change, is
available from signup, and needs no join or upsert. The control plane owns
every write to `organization` (Better Auth never writes it), so the NOT NULL
default is safe. The upper bound 10000 is a practical sanity cap with no
existing repo convention to follow.

## The new formula

```
activeProductionDeployments = count(PRODUCTION AND billingState = ACTIVE)
billableDeploymentQuantity  = max(activeProductionDeployments - included, 0)
```

`billing-domain.ts` gains `billableDeploymentQuantity(active, included)`.
`countBillableDeployments` keeps its name and meaning (the active count) so
the three readers stay honest about which number they show. Paddle receives
only the billable quantity; the platform item is untouched.

## Affected files

Backend:
- `packages/db/src/schema/auth.ts`, `packages/db/drizzle/0038_*.sql`,
  `drizzle/meta/_journal.json`, `migrations.test.ts`, `constraints.test.ts`
- `packages/contracts/src/index.ts` — `INCLUDED_PRODUCTION_DEPLOYMENTS_MAX`,
  the admin body schema
- `apps/api/src/billing-domain.ts`, `billing-reconcile.ts`
- `apps/api/src/server.ts` — `/api/billing/summary`
- `apps/api/src/admin/queries.ts`, `routes.ts`
- `apps/api/src/organizations.ts` — organization delete already cascades;
  no change expected

Frontend:
- `apps/web/src/lib/admin.ts`, `admin-vocabulary.ts`
- `apps/web/src/app/admin/vendors/[id]/page.tsx`
- `apps/web/src/lib/billing.ts`, `deployment-billing.ts`
- `apps/web/src/app/dashboard/settings/billing/page.tsx`
- `apps/web/src/app/dashboard/deployments/new/page.tsx`
- `apps/web/src/app/dashboard/deployments/[id]/page.tsx`

Docs: `paddle-billing.md`, `billing-matrix.md`, `docs/admin/team-admin.md`,
`docs/testing/e2e-testing.md`, this file.

## Migration strategy

One additive migration: `ALTER TABLE organization ADD COLUMN ... NOT NULL
DEFAULT 0` plus the CHECK constraint. Existing rows get 0, which preserves
current billing exactly. No backfill, no data movement, reversible by
dropping the column.

## Admin mutation

`POST /api/admin/vendors/:id/included-deployments` with
`{ includedProductionDeployments, reason }`. Inside one transaction the
organization row is locked (`FOR UPDATE`), the old value read, the new value
written. Then `reconcileBilling` runs outside the transaction (a Paddle round
trip must not hold a connection), and the audit event
`admin.billing.included_deployments.updated` is written with old/new
allowance, the active count, old/new billable quantity, the reason, and the
reconciliation outcome — the same order every other admin action in
`routes.ts` uses. A same-value update is audited but does not reconcile.
A Paddle failure never reverts the allowance: the reconciliation ledger
records it and the existing Reconcile button and safety job retry.

## Edge cases to test

- Default 0 preserves every existing reconcile test unchanged.
- Allowance set before any subscription: no Paddle call, no subscription.
- First production deployment with allowance 0 / 1 / >1: the platform
  checkout still happens; the deployment item is added only when
  `active > included`.
- Active below / equal to / crossing / falling back under the allowance.
- Allowance larger than the active count, and the maximum 10000.
- Admin input: increase, decrease, same value, negative, decimal, string,
  over max, blank reason, unknown vendor id, non-admin (403), support mode.
- Concurrency: allowance change while a deployment goes live or is removed;
  two admin updates in flight; reconcile always converges.
- Paddle failure during the change: allowance kept, ledger row FAILED,
  later retry and the sweep repair it.
- Cancellation and reactivation keep the allowance.
- Ownership transfer and member removal do not touch the allowance.
- TEST deployments never count.
- The sweep uses the same formula.

## Differences from the prompt

- The prompt's `Current monthly rate` for the admin view is computed as
  `49 + billable × 19` from the display constants; Paddle remains the source
  of truth for money and the label says so.
- "Actual Paddle deployment quantity" is not stored live; the admin view
  exposes the provider quantity from the most recent reconciliation row,
  which is what the existing Phase 14 view already shows.
- The vendor billing page stops listing a `$19` amount per customer line,
  because with a pooled allowance no individual deployment has a price. It
  lists the live customer deployments by name and bills the pooled quantity.
- Phases are grouped into four pull requests (schema+formula; admin read,
  mutation, audit, reconcile, admin UI; vendor UI; tests, sweep, e2e, docs),
  each phase its own commit.

## Status (2026-09-08)

Shipped in four stacked pull requests, one commit per phase:

| PR | Phases | Content |
|---|---|---|
| #243 | 0–3 | this note; `organization.included_production_deployments` + migration 0038 + Lambda bundle entry; `billableDeploymentQuantity` in reconcile and the billing summary; admin read model |
| #244 | 4–7 | admin mutation route (locked update, validation, audit, immediate reconcile); vendor-detail editor with preview and confirmation; audit-log labels; Team Admin docs |
| #245 | 8–10 | vendor Billing page pool line; allowance-aware create page and checkout card; deployment detail and disconnect copy |
| #246 | 11–14 | safety-job test; edge-case tests; these docs |

### Verification

- Unit/integration (vitest, PGlite, fake Paddle): domain formula; reconcile
  under allowances (subtract, cover all, never negative, TEST rows, order of
  changes, no subscription, Paddle failure); the admin route (26 cases:
  authorization, validation, pre-subscription, increase/decrease/cover-all,
  same value, Paddle failure + retry, concurrent updates, PAUSED / CANCELED /
  PAST_DUE, audit log); the write path (row lock, CHECK backstop, cancellation
  and reactivation, ownership and membership changes, pooled across apps);
  the safety sweep (5 live, 2 included, Paddle had 4 → repaired to 3, repeat
  pass no-op); web copy helpers and the admin preview helper.
- Simulated E2E: the admin allowance flow in `e2e/admin.spec.ts` (CI's Team
  Admin step) and the billing page in `e2e/billing.spec.ts`.
- Not verified live: no Paddle sandbox round trip was run for this feature.
  The reconciliation call is byte-for-byte the Phase 16 one (`items` replaced
  wholesale, absolute quantity, item removed at 0), so the sandbox evidence in
  `paddle-billing.md` covers the mechanism; only the arithmetic changed.

### Scenario mapping (prompt Phase 13)

| Scenario | Covered by |
|---|---|
| A — paid vendor, 3 live, allowance 0 → 2, qty 3 → 1 | `admin-included-deployments.test.ts` "an increase reduces the Paddle quantity"; vendor page counts in `deployment-billing.test.ts` / billing page |
| B — reduce 2 → 0, qty 1 → 3, warning, audit | "a decrease raises the Paddle quantity"; dialog copy + destructive confirm; audit row asserted |
| C — allowance before subscription, no Paddle call; first deployment still checks out | "stores the allowance … makes no provider call"; `billing-reconcile.test.ts` "with no subscription"; checkout gate unchanged (`billing-checkout.test.ts`) |
| D — cross the threshold 1 → 0, 2 → 0, 3 → 1 | `billing-domain.test.ts` threshold case; reconcile "converges … whichever order" |
| E — delete back 3 → 2, qty 1 → 0, platform stays | reconcile "removes the deployment item when every live deployment is included" (platform item only) |
| F — TEST deployment never counts | reconcile and admin-route TEST cases |
| G — Paddle failure: saved, diagnosable, retry repairs | "a Paddle failure keeps the new allowance … a retry repairs it"; sweep test |
