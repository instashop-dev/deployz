# Paddle billing — how it works

The reference for Deployz billing after the Stripe → Paddle migration
(Phases 0–17, September 2026). The phase-by-phase record and every ruling
live in `MIGRATION_PROGRESS.md`; the decision tables in `billing-matrix.md`;
the catalog in `paddle-catalog.md`. This document is the shape of the system
as shipped.

## The commercial model

- **Evaluation is free and never expires.** Signup, analysis, configuration,
  AI recommendations, customer records, release builds, and ONE active test
  deployment of the vendor's own app per application. No card, no clock.
- **$49/month platform** starts with the vendor's first *customer*
  deployment — the moment they ask Deployz to run their app for someone else.
- **$19/month per customer deployment, once it is live** — billed only from
  the first verified READY stage, and stopped the moment removal is accepted.
- **Payment state never touches running customer infrastructure.** A vendor
  whose card fails, or who cancels, keeps every existing deployment operable:
  deploy, rollback, restart, configure, destroy. Only *new* customer
  deployments are withheld.

Deployz displays prices but does no money math. Paddle owns charges, tax,
proration, invoices, cards and cancellation. Deployz owns eligibility and
exactly one number: how many customer deployments are live.

## Division of responsibility

| Deployz owns | Paddle owns |
|---|---|
| Whether a deployment may be created (entitlements) | Charging the card |
| `billing_state` per deployment (NOT_STARTED / ACTIVE / STOPPED) | Proration when the count changes mid-cycle |
| The live-deployment count pushed as an absolute quantity | Invoices, receipts, tax |
| The checkout intent (a parked request, never a deployment) | The checkout overlay and the card form |
| Subscription status as projected from webhooks | Dunning, past-due, pause/resume, cancel |
| The customer portal *link* | The customer portal |

## Data

Four tables (`packages/db/src/schema/billing.ts`) plus two columns on
`deployments`:

- `deployments.deployment_type` (TEST / PRODUCTION) and
  `deployments.billing_state` with `billing_started_at` / `billing_stopped_at`.
  Test deployments never bill from any state (matrix §1).
- `billing_subscriptions` — one row per organization, `provider = PADDLE`.
  No row means evaluation. Status ∈ ACTIVE / PAST_DUE / PAUSED / CANCELED.
- `billing_provider_events` — every webhook delivery, `provider_event_id`
  unique so redelivery dedupes at the database.
- `billing_reconciliation_events` — what Deployz expected vs what Paddle had,
  and what was done about it. No row for a no-op pass.
- `billing_checkout_intents` — a production deployment request parked until
  its subscription activates. At most one PENDING per organization.

## The lifecycle, end to end

### 1. First customer deployment → checkout (Phase 8)

`POST /api/deployments` with `deploymentType: PRODUCTION` and no ACTIVE
subscription answers **402 `SUBSCRIPTION_REQUIRED`** with the status in
`details`. Nothing is written. The web app then calls
`POST /api/billing/checkout`, which:

1. Refuses ACTIVE (409 — create the deployment directly), and PAST_DUE /
   PAUSED (409 `SUBSCRIPTION_NEEDS_ATTENTION` — the fix is on the portal, not
   a second subscription). Only evaluation and CANCELED may check out.
2. Runs the same ownership and preflight gates as deployment creation, so a
   completed checkout cannot land on a request that would never have worked.
3. Parks the request as a `billing_checkout_intents` row and creates ONE
   Paddle transaction for the **platform price only** — the parked
   deployment is not live, so the $19 item is not on it. The intent id
   travels in the transaction's `customData`.
4. Returns the transaction id; the web app opens Paddle's overlay
   (`@paddle/paddle-js`, client token fetched at runtime from
   `GET /api/billing/config` — nothing Paddle-specific is baked into the
   build).

A second click reuses the intent and its transaction. A PENDING intent older
than 24 h expires.

### 2. Activation → the deployment appears (Phases 6, 8)

Paddle posts `subscription.created` / `subscription.activated` to
`POST /api/billing/webhook`, signature-verified over the raw body. The
handler upserts `billing_subscriptions` (regression- and mismatch-guarded),
then completes the intent the event names through the echoed `customData`:
the deployment insert and the intent's completion run in one transaction
guarded by `WHERE status = 'PENDING'`, so a redelivered event can never
create two deployments. Only now does a deployment row — and therefore an
install link — exist.

### 3. Going live → billing starts (Phases 2, 9)

`billing_state` moves NOT_STARTED → ACTIVE on the first observed READY stage
(`markDeploymentLive`, from the relay write paths). That write returning
`true` triggers `reconcileBilling`, which reads the live count and pushes it
to Paddle as an **absolute** quantity on the per-deployment item —
`prorated_immediately`, `on_payment_failure: apply_change`. Never a delta:
running it twice yields the same subscription as once.

### 4. Removal → billing stops (Phases 2, 9)

ACTIVE → STOPPED when removal is *accepted* (the destroy request), with
idempotent backstops at DESTROY success and force-complete. STOPPED is
terminal. Reconcile runs again; when the last live deployment goes, the item
is removed rather than set to zero (its minimum quantity is 1).

### 5. The safety net (Phase 10)

Every request-path billing write is best-effort — a Paddle failure never
fails a deployment. `sweepBilling`, on the worker's existing 15-minute
schedule, closes the gaps that leaves: promotes a READY production deployment
still NOT_STARTED (signal: the persisted `step_timings.READY`), releases
webhook rows abandoned in RECEIVED so Paddle's redelivery is processed, and
reconciles any ACTIVE/PAST_DUE subscription not checked for an hour.

### 6. Paying, managing, lapsing (Phases 11–14)

- Two app-wide banners, and only two: PAST_DUE (deep-links to Paddle's card
  form) and CANCELED. Evaluation gets none.
- The billing page tells the truth: evaluation reads as free; subscribed
  shows the rate, next billing date, per-customer breakdown, and "Manage
  billing" into Paddle's hosted portal via a short-lived session for the
  organization's own customer id.
- Entitlements by status: matrix §4. Existing deployments are never gated.
- Admins see live count, subscription, last reconciled, recent outcomes, and
  can run the same `reconcileBilling` on demand, audited.

## Configuration

Six values, all in `.github/workflows/deploy-api.yml` from repository
secrets (and the CDK allowlist): `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`,
`PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PLATFORM`, `PADDLE_PRICE_DEPLOYMENT`,
`PADDLE_ENVIRONMENT`. Billing is optional at boot: with no API key every
billing surface reports `BILLING_DISABLED` and nothing else is affected.
Once the key is set the other five are validated at startup. Price ids are
configuration, never source — `paddle-catalog.md`.

The worker Lambda receives the same six values, so the safety job needs no
separate configuration.

## What was deliberately not built

- No trials, discounts, annual prices, tiers, or metering.
- No billing screens of Deployz's own for cards, invoices or cancellation.
- No second subscription is ever sold: PAST_DUE and PAUSED cannot check out.
- No provider abstraction: `provider = PADDLE` says what a row is, nothing
  more.
- No day-2 gating by payment state, CANCELED included — accepted cost: a
  canceled vendor can keep operating deployments they no longer pay for,
  because the alternative punishes their customers.

## Sandbox verification (Phase 16)

Run on 2026-09-08 against the real Paddle sandbox, with the API on
file-backed PGlite reached through a cloudflared quick tunnel. Nothing here
used a card; Paddle's simulator delivered real, signed webhooks.

| Step | Observed |
|---|---|
| Notification destination `ntfset_01m20j6f98zk75cv0w8723dgmc` (all `subscription.*`, `transaction.completed`, `transaction.payment_failed`, `traffic_source: all`) | created via the sandbox MCP; its `endpoint_secret_key` became `PADDLE_WEBHOOK_SECRET` |
| Vendor signs up, connects `deployz-demo/express-api`, analyses | READY |
| `POST /api/deployments` PRODUCTION, no subscription | **402 `SUBSCRIPTION_REQUIRED`**, `subscriptionStatus: null` |
| `POST /api/billing/checkout` | intent parked PENDING; Paddle refused `transactions.create` (see the key finding) |
| Simulation `ntfsim_01m20kfkxc6crfhwtbr4f9vjc3` `subscription.activated`, `custom_data.organizationId` only | API **200 `PROCESSED`**; `/api/me` ACTIVE; the parked request became `P16 Customer / PRODUCTION / NOT_INSTALLED / billingState NOT_STARTED` (single-pending fallback); reconcile ran and recorded FAILED with Paddle's reason |
| Replay of the same event id | API **200 `DUPLICATE`**; deployment count still 1 |
| Simulation `ntfsim_01m20kn8b2dek7g7b4rgt6rhtr` `subscription.past_due` | `/api/me` PAST_DUE; checkout **409 `SUBSCRIPTION_NEEDS_ATTENTION`**; new deployment **402** with PAST_DUE |
| Simulation `ntfsim_01m20kr2gqkvz384w9w3s2fe3z` `subscription.canceled` | `/api/me` CANCELED; new deployment **402**; checkout **reached Paddle** (502 on the key, not 409); destroy of the existing deployment **200 DELETED** |

**Did not behave as documented, and was fixed:** a provider error on
checkout or portal was swallowed entirely, so a bad key surfaced only as a
bare 502. Both now log `billing:checkout-transaction-failed` /
`billing:portal-session-failed` server-side (R16-3).

**Follow-up, same day, with a valid key:** authentication and a catalog read
succeeded, and `customerPortalSessions.create` returned a real session on
`sandbox-customer-portal.paddle.com` — the portal path is verified live. What
still blocks every transaction-dependent check is account-level and
dashboard-only: `transaction_default_checkout_url_not_set`. The sandbox
refuses *every* `transactions.create` — even a manually-collected one with
checkout disabled — until Paddle sandbox → Checkout → Checkout settings →
**Default payment link** is set (e.g. `http://localhost:3000/dashboard/settings/billing`).
There is no API for it. Once set, the server-free script pattern (customer →
address → manual billed transaction → real subscription → update items the
way `reconcileBilling` does → read the quantity back → cancel) proves the
remaining REST paths without a card or a running API; the overlay still needs
a browser and the client token.

**Original key finding:** the first-supplied `PADDLE_API_KEY` was the key's masked
identifier (`pdl_sdbx_apikey_<26-char id>`, four segments), not the one-time
secret (five segments). Paddle answers `authentication_malformed` for it.
Every path that calls the Paddle REST API is therefore **not yet verified
live**: `transactions.create`, `subscriptions.get/update`,
`customerPortalSessions.create`, and the Paddle.js overlay. Recipe to finish
once a valid key and client token are in the worktree `.env`: start the API
and a quick tunnel, reactivate and repoint the destination above, run
`POST /api/billing/checkout`, pay with Paddle's test card in the overlay,
confirm `subscription.activated` arrives with the real `checkoutIntentId`,
force the deployment live, press the admin Reconcile, and read the quantity
back with `subscriptions.get`.

## Audit §9 open items — closed

| Item | Closed by |
|---|---|
| Deploy-link deployments are always PRODUCTION; the gate must cover them | Phase 7 — `createDeployLink` calls `assertProductionDeploymentAllowed` |
| The relay-liveness worker is the natural host for the safety schedule | Phase 10 — `sweepBilling` on the existing `WatchdogSchedule`, no CDK change |
| Paddle.js needs `NEXT_PUBLIC_*` baked through `deploy-web.yml` | Superseded (R8-5) — the client token is fetched at runtime from `GET /api/billing/config` |
