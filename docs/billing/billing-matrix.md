# Billing matrix

The decision tables the billing code implements, in one place. Each table
names the test that walks it exhaustively, so a missing cell is a failing
test rather than an oversight. Keep this file and those tests in step.

## 1. Deployment billing transitions

`applyBillingTransition(deployment, event, now)` — `apps/api/src/billing-domain.ts`.
Walked cell by cell in `apps/api/src/billing-matrix.test.ts`.

The function takes no `state` (§46 health/lifecycle) input on purpose: no
health, rollback or recovery signal can ever move billing.

| Type | Billing state | `LIVE` (first verified READY) | `REMOVED` (removal accepted) |
|---|---|---|---|
| TEST | NOT_STARTED | — | — |
| TEST | ACTIVE | — | — |
| TEST | STOPPED | — | — |
| PRODUCTION | NOT_STARTED | → ACTIVE, `billingStartedAt` | → STOPPED, `billingStoppedAt` |
| PRODUCTION | ACTIVE | — (write-once) | → STOPPED, `billingStoppedAt` |
| PRODUCTION | STOPPED | — (terminal) | — (terminal) |

"—" means no patch at all. A TEST deployment never bills from any cell; a
never-live PRODUCTION deployment that is removed goes straight to STOPPED so
it can never activate later.

## 2. Billable predicate

`isBillableDeployment` — true only for PRODUCTION + ACTIVE. Six cells, all in
`billing-matrix.test.ts`. `countBillableDeployments` sums it; that count is
the ONLY number reconciliation ever pushes to Paddle.

## 3. Paddle subscription status → Deployz status

`mapSubscriptionStatus` — `apps/api/src/billing-webhooks.ts`. In
`billing-matrix.test.ts`.

| Paddle | Deployz | Note |
|---|---|---|
| `active` | ACTIVE | |
| `trialing` | ACTIVE | Deployz sells no trials; if Paddle reports one it bills, so it is ACTIVE |
| `past_due` | PAST_DUE | |
| `paused` | PAUSED | |
| `canceled` | CANCELED | |
| anything else | *ignored* | the event is recorded IGNORED, never guessed |

## 4. Entitlements by subscription status (R13-1)

Integration tests: `billing-entitlements.test.ts` (tests 4–9),
`billing-checkout.test.ts`.

| Action | Evaluation (no row) | ACTIVE | PAST_DUE | PAUSED | CANCELED |
|---|---|---|---|---|---|
| New customer deployment (manual / deploy link) | 402 → checkout | ✅ | 402 → card form | 402 → portal | 402 → checkout |
| Start a checkout (`POST /api/billing/checkout`) | ✅ | 409 `SUBSCRIPTION_ALREADY_ACTIVE` | 409 `SUBSCRIPTION_NEEDS_ATTENTION` | 409 `SUBSCRIPTION_NEEDS_ATTENTION` | ✅ (new subscription) |
| Deploy / rollback / restart / config / destroy an EXISTING deployment | ✅ | ✅ | ✅ | ✅ | ✅ |
| TEST deployment, analysis, configuration, customers, releases | ✅ | ✅ | ✅ | ✅ | ✅ |
| Customer portal (`POST /api/billing/portal`) | 409 `NO_SUBSCRIPTION` | ✅ | ✅ | ✅ | ✅ |

Payment state never touches running customer infrastructure.

## 5. Reconciliation outcomes (Phase 9)

`reconcileBilling` — `billing-reconcile.test.ts`.

| Situation | Status | Action | Ledger row? |
|---|---|---|---|
| Billing disabled (no Paddle) | SKIPPED | SKIPPED | no |
| No subscription, nothing live | SKIPPED | SKIPPED | no |
| No subscription, something live | SKIPPED | SKIPPED | yes — anomaly |
| PAUSED / CANCELED, something live | SKIPPED | SKIPPED | yes — anomaly |
| ACTIVE / PAST_DUE, provider already matches | SUCCEEDED | NONE | no — `lastReconciledAt` only |
| first live deployment | SUCCEEDED | ITEM_ADDED | yes |
| count changed | SUCCEEDED | QUANTITY_UPDATED | yes |
| last live deployment removed | SUCCEEDED | ITEM_REMOVED (item dropped, never qty 0) | yes |
| Paddle refused | FAILED | NONE | yes, with reason |

Always the ABSOLUTE count, never a delta: two runs produce the same
subscription as one. Inactive Paddle items are never resent.

## 6. Webhook delivery handling (Phase 6)

`billing-webhooks.test.ts`.

| Delivery | Response | Recorded as |
|---|---|---|
| Missing / invalid signature | 401 (Paddle retries) | nothing written |
| Same `event_id` again, earlier attempt PROCESSED/IGNORED | 200 | DUPLICATE |
| Same `event_id` again, earlier attempt FAILED | processed again | RECEIVED → … |
| Older `occurred_at` than what is on file | 200 | IGNORED (stale) |
| Different subscription id while stored one is not CANCELED | 200 | IGNORED (mismatch) |
| Processing threw | 500 (Paddle retries) | FAILED |
| Row abandoned in RECEIVED > 10 min | — | reset to FAILED by the safety job |
