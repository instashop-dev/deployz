# Stripe to Paddle migration — progress ledger

Checkpoint file for the migration run. A continuation agent resumes from the
first phase that is not marked done. Do not repeat completed phases.

Workflow per phase: branch `paddle/phase-N-<slug>` from `instashop-dev/Paddle`
(kept equal to `main`), PR into `main`, merge when CI is green, then
fast-forward `instashop-dev/Paddle` to `main`.

Commit trailer (required):

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FVGF7sZpmJ6Va6u11L23kb
```

PR footer (required):

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01FVGF7sZpmJ6Va6u11L23kb
```

## Status

| Phase | Status | PR / commit | Notes |
|---|---|---|---|
| 0 Audit | done | PR #216 | `docs/billing/paddle-migration-audit.md` |
| 1 Remove Stripe | done | PR #218 | migration `0032_remove_stripe_billing`; summary route kept provider-neutral |
| 2 Billing domain | done | PR #219 | `apps/api/src/billing-domain.ts`, `billing-lifecycle.ts`; migration `0033_deployment_billing_state` (`deployment_type`, `billing_state`, timestamps) |
| 3 Billing schema | done | PR #220 | `billing_subscriptions`, `billing_provider_events`, `billing_reconciliation_events` (migration `0034`); `organization.plan` removed; organization responses carry `subscriptionStatus` |
| 4 Paddle catalog (MCP) | done | this PR | Sandbox catalog created through the authenticated Paddle sandbox MCP: `Deployz Platform` ($49/month, qty 1) and `Customer Deployment` ($19/month, qty 1..1000). Ids in `docs/billing/paddle-catalog.md` and `.env.example` |
| 5 SDK + config | done | PR #222 | `@paddle/paddle-node-sdk`, `apps/api/src/paddle.ts`, `PADDLE_*` env validation, CDK allowlist, deploy workflow, `GET /api/billing/config` |
| 6 Webhooks | done | PR #223 | `apps/api/src/billing-webhooks.ts`, `POST /api/billing/webhook` (raw body, `Paddle-Signature`), event ledger dedupe, `occurredAt` regression guard, migration `0035` (scheduled change) |
| 7 Evaluation entitlements | done | PR #228 | `apps/api/src/billing-entitlements.ts`: PRODUCTION needs an ACTIVE subscription (402 `SUBSCRIPTION_REQUIRED`), one active TEST deployment per application (409 `TEST_DEPLOYMENT_EXISTS`, partial unique index, migration `0036`) |
| 8 First production activation | done | this PR | `billing_checkout_intents` (migration `0037`), `apps/api/src/billing-checkout.ts`, `POST /api/billing/checkout` (platform price only), webhook completion on ACTIVE; web checkout hand-off (`apps/web/src/lib/billing-checkout.ts`, Paddle.js). Not verified against Paddle — Phase 4 catalog still missing |
| 9 Reconciliation | done | this PR | `apps/api/src/billing-reconcile.ts`: absolute per-deployment quantity pushed onto the subscription, `billing_reconciliation_events` ledger, wired to every billing transition (map rows 7, 12-15, 19) outside the caller's transaction |
| 10 Scheduled safety job | done | this PR | `sweepBilling` in `packages/cdk/src/lambda/worker.ts`, on the existing 15-minute `WatchdogSchedule`: promotes missed READY activations, releases webhook events abandoned in `RECEIVED`, and reconciles subscriptions stale for an hour. New `@deployz/api` entry points `./billing`, `./billing-lifecycle`, `./paddle` |
| 11 App-wide UX | done | this PR | Past-due/canceled banners, evaluation vs subscribed billing page, evaluation notice (home + readiness), Test·Free badges, deployment Billing row, subscription-aware creation copy, honest disconnect copy, `subscriptionStatus` on `/api/me` |
| 12 Customer portal | done | this PR | `apps/api/src/billing-portal.ts`, `POST /api/billing/portal` (short-lived Paddle portal links for the org's own customer), `ManageBillingButton`: billing page (overview + payment details), PAST_DUE banner deep-links to the card form |
| 13 Entitlements by status | done | this PR | Per-status rules made explicit and tested: creation needs ACTIVE; day-2 on existing deployments never gated (CANCELED guard added); checkout only from evaluation or CANCELED (409 `SUBSCRIPTION_NEEDS_ATTENTION` for PAST_DUE/PAUSED); the creation screen routes each refusal to its real fix |
| 14 Admin | done | this PR | Vendor detail carries `billing` (live count, subscription, last reconciled, last 5 reconciliation outcomes); `POST /api/admin/vendors/:id/reconcile-billing` runs the same `reconcileBilling` as the safety job and writes an `admin.billing.reconcile_requested` audit row |
| 15 Test matrix | done | this PR | `apps/api/src/billing-matrix.test.ts` walks every cell of the pure decision tables (12 transition cells, 6 billable cells, the status mapping); `docs/billing/billing-matrix.md` is the same tables plus the integration-covered ones, each naming its test |
| 16 Sandbox E2E | webhook half done; key half blocked | this PR | Real Paddle deliveries through a cloudflared tunnel to a local PGlite API: activated -> PROCESSED -> parked deployment created; replay -> DUPLICATE, no second deployment; past_due and canceled -> projection + Phase 13 refusals + destroy still allowed under CANCELED. The transaction/reconcile/portal/overlay half is blocked on a valid `PADDLE_API_KEY` (the one supplied is the key's masked id, not the secret). Findings in `docs/billing/paddle-billing.md` |
| 17 Regression + docs | done | this PR | Regression authority is CI: PR #238 (the final code) passed Test-and-build and Simulated E2E. `docs/billing/paddle-billing.md` is the reference document; audit §9 open items closed there. Phase 16 REST-API half stays open pending a valid sandbox key |

## Rulings

- R0-1: `STOPPED` fires when the destroy request is accepted (`DELETING`).
  DESTROY success and force-complete are idempotent backstops. Cost if wrong:
  a vendor whose destroy job fails is not billed for a deployment that may
  still run; acceptable by the spec ("do not wait indefinitely").
- R0-2: `ACTIVE` fires on the first observed `stage === 'READY'` inside
  `advanceStepTimingsAfterWrite`. The Phase 10 job also promotes READY
  production rows still `NOT_STARTED`. Cost if wrong: a late promotion.
- R0-3: `is_test_deployment` becomes `deployment_type` (`TEST`, `PRODUCTION`)
  in Phase 2 with a data migration. Cost if wrong: mechanical churn.
- R0-4: `organization.plan` and `org_plan` are removed in Phase 3, not Phase 1.
  Phase 1 leaves the column unwritten (always `FREE`).
- R0-5: Phase 1 keeps `GET /api/billing/summary` provider-neutral with
  `subscription: null`, and keeps the three tests in `e2e/billing.spec.ts`.
- R0-6: Stripe references inside customer-repository analysis, fixtures and
  benchmark data are retained (audit §2.7).
- R0-7: Phase 8 models the pending production deployment as a
  `billing_checkout_intents` row. No deployment row exists before activation,
  so no install link and no AWS provisioning can start early.
- R0-8: Paddle checkout uses Paddle.js (client token) with a server-created
  transaction.
- R5-1: the deploy workflow verifies the Paddle configuration only when
  `PADDLE_API_KEY` is set, so production deploys are not blocked before the
  catalog exists. Phase 4 is now done, but the PRODUCTION catalog is not —
  flip to unconditional only once the production price ids exist and the
  secrets are populated. Cost if wrong: a half-configured provider is caught only
  when the key is present — which is exactly when it matters.
- R7-1: the simulated E2E suite needs production deployments without a
  real checkout. `BILLING_FIXTURE_MODE=true` (set only by the simulated E2E
  runner; never in the CDK allowlist or the deploy workflow) seeds a normal
  `ACTIVE` `billing_subscriptions` row for each new organization and exposes
  `POST /internal/fixture/billing/subscription` to change or clear it. The
  entitlement gate itself is unchanged. Cost if wrong: none in production;
  a simulated scenario could forget to clear the row when it tests
  evaluation mode.
- R8-1: at most one PENDING checkout intent per organization (partial unique
  index `billing_checkout_intents_one_pending_per_organization_uidx`).
  A second checkout REUSES that row — it overwrites the parked request and
  returns the transaction already on it, so Paddle is never asked for a
  second transaction the first checkout would leave dangling. A PENDING
  intent older than 24h expires (EXPIRED), because Paddle may have dropped
  its transaction by then. Cost if wrong: a vendor cannot queue two
  production deployments before paying; the second is created normally once
  the subscription is ACTIVE.
- R8-2: the checkout transaction carries the PLATFORM price only, never the
  per-deployment price. The parked deployment is not live yet, and Phase 9
  reconciliation bills live deployments (billing_state ACTIVE) by quantity —
  charging $19 at checkout would bill for something that is not running.
- R8-3: `createCheckoutIntent` runs the ownership and preflight gates BEFORE
  it opens the transaction, so a completed checkout does not land on a
  request that was never going to work. A Paddle failure leaves the intent
  PENDING with no transaction id, so the next call reuses the row and
  retries. Cost if wrong: a preflight that passes at checkout and fails at
  completion, which R8-4 covers.
- R8-4: `completePendingCheckoutIntent` picks the intent the paid transaction
  names through Paddle's echoed `customData`, falling back to the
  organization's single PENDING intent. The deployment insert and the
  intent's completion run in ONE transaction guarded by
  `WHERE status = 'PENDING'`, so a redelivered webhook — or two ACTIVE events
  racing — cannot create the deployment twice. It never throws: a deployment
  that cannot be created is recorded FAILED (in a write outside the
  rolled-back transaction, so the reason survives) and logged, because the
  subscription event itself was applied correctly. The subscription is real,
  so the vendor now passes the Phase 7 gate and can create the deployment
  directly. Cost if wrong: a vendor who paid presses the button once more.
- R8-5: the web app reads the Paddle client token from
  `GET /api/billing/config` at runtime instead of a baked `NEXT_PUBLIC_*`
  value, so `deploy-web.yml` needs no Paddle configuration (audit §9 assumed
  the baked route). Cost if wrong: one extra request before checkout opens.
- R9-1: reconciliation writes an ABSOLUTE quantity, never a delta. Running it
  twice produces the same subscription as running it once, so a missed or
  duplicated call cannot drift the number. The quantity is
  `countBillableDeployments` — PRODUCTION rows whose `billing_state` is
  ACTIVE — and nothing else.
- R9-2: reconcile fires only when a billing state ACTUALLY changed
  (`markDeploymentLive`/`markDeploymentRemoved` returned true), plus the
  webhook's ACTIVE path and the Phase 10 job. Transition-map row 8
  ("reconcile is harmless") is deliberately NOT wired: a heartbeat or day-2
  job on an already-billing deployment must not pay for a Paddle round trip,
  and Phase 10 sweeps up any drift. Cost if wrong: drift persists until the
  next scheduled pass.
- R9-3: reconcile never runs inside the caller's transaction — a Paddle round
  trip must not hold a database connection open — and never throws. A
  provider failure is recorded as a FAILED `billing_reconciliation_events`
  row and logged; the deployment request still succeeds (audit §4: billing is
  decoupled from deployment safety).
- R9-4: a no-op pass (the provider already agreed) writes NO reconciliation
  row, only `lastReconciledAt`. Reconcile runs on every billing transition
  and on the Phase 10 schedule, so a ledger of "nothing happened" would bury
  the entries that matter. SKIPPED rows are written only when Deployz
  believes something should be billed but cannot be (no subscription, or a
  PAUSED/CANCELED one) — an anomaly worth the row.
- R9-5: the per-deployment item is REMOVED, not set to zero, when the last
  live deployment goes away — the price's own minimum quantity is 1. Paddle
  replaces the item list wholesale, so every other item is sent back
  unchanged. Updates use `prorated_immediately` (Paddle owns the money math)
  and `on_payment_failure: apply_change` (the deployment is already running;
  refusing the change would only under-bill it and leave the subscription
  lying about what is live).
- R9-6: PAST_DUE subscriptions are reconciled — Paddle is still billing them.
  PAUSED and CANCELED are not: Paddle does not accept item updates on them.
- R10-1: the missed-activation signal is the PERSISTED `step_timings.READY`
  entry, not a re-derivation. `advanceStepTimings` always stamps the active
  step, `deriveDeploymentStatus` sets step `READY` for a READY stage, and
  `markDeploymentLive` runs independently of the step-timings write — so a
  row with a READY timing and `billing_state = NOT_STARTED` is exactly a
  billing write that did not land. Cheap and DB-only. Cost if wrong: a
  deployment whose READY was never persisted is not promoted either, but the
  next heartbeat re-derives READY and runs both writes again.
- R10-2: `DELETING`/`DELETED` deployments are never promoted. The billing
  state machine deliberately takes no `state` input, so the sweep's own query
  is the only thing that stops it billing a deployment on its way out.
- R10-3: the sweep never fails the scheduled invoke — same `.catch()`
  contract as `sweepStuckBuilds`. The next tick retries it.
- R10-4: the drift sweep reconciles ACTIVE/PAST_DUE subscriptions whose
  `last_reconciled_at` is null or older than an hour. This is what makes R9-2
  safe: the request path can skip reconciling on harmless transitions because
  drift is bounded here, not by hoping no call was ever missed.
- R11-1: exactly two app-wide banners — PAST_DUE and CANCELED. Evaluation
  (no subscription) gets none: it is free and never expires, so there is
  nothing to act on, and dressing it as an alert would invent urgency the
  product does not have. Neither banner ever suggests a customer's deployment
  is at risk, because payment state never touches running infrastructure.
- R11-2: the billing page branches on whether a subscription exists. The old
  page showed every vendor a "$49 Platform / Monthly total" breakdown whether
  or not they had bought anything, which was simply untrue for an
  organization in evaluation.
- R11-3: `subscriptionStatus` is served on `/api/me` rather than looked up
  from `organizations` in the client. In a support session `organization` is
  the VENDOR's while `organizations` is the admin's own memberships, so the
  client-side lookup would silently find nothing and the banner would vanish
  exactly where an admin is investigating a billing problem.
- R11-4: cost copy reads the deployment's `billing_state`, never its health.
  A temporarily unhealthy deployment is still billed and one that never came
  up never was — that separation is why `billing_state` exists apart from §46
  `state`. The disconnect dialog therefore claims "this stops the $19/month
  charge" only when the deployment is actually ACTIVE; it was previously
  saying that for free test deployments too.
- R11-5: public pricing copy says a deployment is billed once it is LIVE, not
  once it is "healthy". HEALTHY is a visible §46 state, and the audit
  explicitly does not preserve the bill-on-bare-HEALTHY gate — the gate is
  the verified READY stage.
- R12-1: card, invoices and cancellation live on Paddle's hosted portal,
  never on a Deployz screen. Deployz mints a short-lived pre-authenticated
  session for the signed-in organization's OWN `providerCustomerId` — that id
  is the authorization; nothing from the request chooses the customer. The
  session is never cached and never iframed (Paddle's guidance, and it is
  where the vendor's card lives).
- R12-2: evaluation gets 409 `NO_SUBSCRIPTION`, which the UI never reaches —
  the button only renders on the subscribed branch. A Paddle failure answers
  502 `PORTAL_UNAVAILABLE` without leaking the provider error.
- R12-3: the PAST_DUE banner deep-links straight to the card form — the one
  action that actually fixes a failed payment — instead of sending the vendor
  to a page that asks them to click again.
- R13-1: the entitlement matrix. NEW customer deployment (manual or deploy
  link): ACTIVE only. Everything on an EXISTING deployment — deploy, rollback,
  restart, config, destroy — is never gated by any status, CANCELED included:
  payment state never touches running customer infrastructure, and a
  customer's security update must not wait on the vendor's card. TEST
  deployments and all evaluation surfaces are never gated. Cost if wrong: a
  canceled vendor can keep operating deployments they no longer pay for;
  accepted, because the alternative punishes their customers.
- R13-2: a checkout is the way IN to a subscription and is offered only where
  there is none to fix — evaluation and CANCELED. PAST_DUE and PAUSED refuse
  with 409 `SUBSCRIPTION_NEEDS_ATTENTION` and never reach Paddle: selling a
  second subscription to an organization that already has one would
  double-bill, and the real fix (card form, resume) lives on the portal.
- R13-3: the 402 already carries `subscriptionStatus` (Phase 7), so the web
  routes each refusal to its actual next step with no new API surface:
  evaluation/CANCELED -> checkout card, PAST_DUE -> card form, PAUSED ->
  portal. The message names the reason, never just "subscription required".
- R14-1: the admin Reconcile action runs the SAME `reconcileBilling` the
  lifecycle hooks and the safety job run — never a separate admin-only code
  path. It is idempotent and never throws, so it is a safe action (reason
  optional) and is audited like every other admin intervention, with
  `targetType: 'organization'`.
- R14-2: the admin's live-deployment count is its own query over every
  deployment of the organization, never derived from the capped, ordered
  list the detail page already shows — a vendor with more deployments than
  LIST_CAP would otherwise read as under-billed.
- R15-1: the matrix test walks PURE decision tables cell by cell
  (`applyBillingTransition`, `isBillableDeployment`, `mapSubscriptionStatus`)
  so a missing cell is a failing test. Tables that need a database or Paddle
  (entitlements, reconciliation, webhook delivery) stay in their story-shaped
  suites; the doc names the covering test for each so coverage is auditable
  without reading every file.
- R15-2: `mapSubscriptionStatus` is exported only for the matrix test. Nothing
  outside billing-webhooks.ts calls it — the webhook handler remains the only
  writer of subscription status.
- R16-1: the webhook path is verified against REAL Paddle signing and
  delivery without a card: a notification destination minted through the
  sandbox MCP (its `endpoint_secret_key` is `PADDLE_WEBHOOK_SECRET`) pointed
  at a cloudflared quick tunnel, and Paddle's own simulations carrying
  `custom_data.organizationId`. Paddle merges a partial simulation payload
  into its demo entity, so only `custom_data` needs supplying.
- R16-2: an activation with no `checkoutIntentId` in `customData` resolves to
  the organization's single PENDING intent — observed live: the parked
  deployment appeared from a demo subscription id. That fallback is what
  makes simulations usable, and it is safe because one PENDING intent per
  organization is enforced at the database.
- R16-3: a provider error on checkout or portal must be LOGGED server-side
  (`billing:checkout-transaction-failed`, `billing:portal-session-failed`)
  even though it is never returned to the client. Without it a malformed API
  key was an undiagnosable 502; a direct SDK reproduction was needed to read
  `authentication_malformed`.
- R16-4: a Paddle sandbox API key has five `_`-separated segments; the four-
  segment `pdl_sdbx_apikey_<26-char id>` form is the key's masked identifier
  shown in the dashboard list, not the one-time secret. Validate this shape
  before assuming a permissions problem.
- R17-1: the regression pass is CI, not a local run. The full local suite
  was killed twice for memory on the author's machine during Phase 17 (other
  sessions were resident); CI ran every suite plus the simulated E2E on the
  final code (#238) and is the authority, as the repo's standing rule says.
- R17-2: the migration is complete except one verification, and that is
  recorded rather than papered over: every path that calls the Paddle REST
  API awaits a valid `PADDLE_API_KEY` (R16-4). The code is merged, tested
  against Paddle doubles, and its webhook half is verified against real
  Paddle; nothing in production is switched on until the secrets exist.
- R6-1: the webhook route answers 401 for a missing or invalid signature and
  500 for a processing failure; both make Paddle retry. Duplicate, stale
  (older `occurredAt`) and unresolvable events answer 200 so Paddle stops
  retrying them; they are recorded in `billing_provider_events`.

## Paddle catalog

Done — see `docs/billing/paddle-catalog.md` for the sandbox ids, the verified
values, and the steps for creating the production equivalents. The catalog is
only ever built through the authenticated Paddle **sandbox** MCP (never the
live MCP, never the REST API — invariant 15); nothing in the codebase creates
a product or a price.

Env names (Phase 5): `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`,
`PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PLATFORM`, `PADDLE_PRICE_DEPLOYMENT`,
`PADDLE_ENVIRONMENT`.

## Known issues

- Local full-suite vitest on this Windows machine can crash a worker
  (`Channel closed` / V8 out of memory). Run per-project with
  `--maxWorkers=2`; CI is authoritative.
- `.mcp.json` in the worktree is untracked and not ignored. Stage files
  explicitly; never commit it.
- Adding a dependency makes pnpm re-resolve unrelated peers in
  `pnpm-lock.yaml` (`better-call@1.4.0(zod@4.4.3)` -> `(zod@3.25.76)`,
  `next@15.5.23(@babel/core@7.29.7)` -> without it). Phase 8 added
  `@paddle/paddle-js` to apps/web and reverted those two churn patterns by
  hand, leaving only the new package in the lockfile diff;
  `pnpm install --frozen-lockfile` still passes.
- Phase 16 second half (needs a VALID `PADDLE_API_KEY` + `PADDLE_CLIENT_TOKEN`
  in the worktree `.env`): `POST /api/billing/checkout` -> real transaction;
  pay in Paddle's overlay with the test card; reconcile pushes quantity 1 to a
  real sandbox subscription; `POST /api/billing/portal` opens. Local stack
  recipe and the destination/simulation ids are in
  `docs/billing/paddle-billing.md` (Sandbox verification). The destination
  `ntfset_01m20j6f98zk75cv0w8723dgmc` was left DEACTIVATED with its secret
  still in `.env`; reactivate and repoint it at the new tunnel URL when
  resuming (quick tunnels change URL on every start).
- CLOSED by Phase 10: a `billing_provider_events` row left in `RECEIVED` by a
  crash between insert and processing read as a duplicate on redelivery.
  `sweepBilling` now resets rows older than 10 minutes that are still
  `RECEIVED` to `FAILED`, which is the state `handlePaddleWebhook` retries.
