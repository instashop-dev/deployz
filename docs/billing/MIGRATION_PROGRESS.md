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
| 4 Paddle catalog (MCP) | deferred | | Blocked on the Paddle sandbox MCP in this session (DNS failure, then tools not loadable in-process). Must complete before Phase 8 checkout verification. Sandbox catalog was empty at baseline. See "Phase 4 resume steps" |
| 5 SDK + config | done | PR #222 | `@paddle/paddle-node-sdk`, `apps/api/src/paddle.ts`, `PADDLE_*` env validation, CDK allowlist, deploy workflow, `GET /api/billing/config` |
| 6 Webhooks | done | PR #223 | `apps/api/src/billing-webhooks.ts`, `POST /api/billing/webhook` (raw body, `Paddle-Signature`), event ledger dedupe, `occurredAt` regression guard, migration `0035` (scheduled change) |
| 7 Evaluation entitlements | done | PR #228 | `apps/api/src/billing-entitlements.ts`: PRODUCTION needs an ACTIVE subscription (402 `SUBSCRIPTION_REQUIRED`), one active TEST deployment per application (409 `TEST_DEPLOYMENT_EXISTS`, partial unique index, migration `0036`) |
| 8 First production activation | done | this PR | `billing_checkout_intents` (migration `0037`), `apps/api/src/billing-checkout.ts`, `POST /api/billing/checkout` (platform price only), webhook completion on ACTIVE; web checkout hand-off (`apps/web/src/lib/billing-checkout.ts`, Paddle.js). Not verified against Paddle — Phase 4 catalog still missing |
| 9 Reconciliation | pending | | |
| 10 Scheduled safety job | pending | | |
| 11 App-wide UX | pending | | |
| 12 Customer portal | pending | | |
| 13 Entitlements by status | pending | | |
| 14 Admin | pending | | |
| 15 Test matrix | pending | | |
| 16 Sandbox E2E | pending | | |
| 17 Regression + docs | pending | | |

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
  catalog exists. Flip to unconditional once Phase 4 is done and the secrets
  are populated. Cost if wrong: a half-configured provider is caught only
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
- R6-1: the webhook route answers 401 for a missing or invalid signature and
  500 for a processing failure; both make Paddle retry. Duplicate, stale
  (older `occurredAt`) and unresolvable events answer 200 so Paddle stops
  retrying them; they are recorded in `billing_provider_events`.

## Phase 4 resume steps

Phase 4 needs the authenticated Paddle **sandbox** MCP (never the live MCP,
never the REST API — invariant 15). In a session where the MCP loads:

1. Load the tools (`mcp__plugin_paddle_paddle-sandbox__search` /
   `execute`) and the `paddle:catalog-setup` skill.
2. List the sandbox catalog (`client.products.list`, `client.prices.list`).
   The sandbox is shared: on 2026-09-08 it held one unrelated product
   (`Revealyst Team`). Never modify or delete products that are not the two
   Deployz products; create the Deployz products only if they do not exist.
3. Create product `Deployz Platform` (description "Monthly Deployz platform
   subscription for vendors using Deployz in production.") with one
   recurring price: USD 4900, billing cycle 1 month, quantity 1..1 —
   and product `Customer Deployment` (description "Monthly charge for each
   active production customer deployment managed through Deployz.") with one
   recurring price: USD 1900, billing cycle 1 month, quantity 1..1000.
   Tax category `standard`. No trials, discounts, annual prices, tiers.
4. Verify both prices are `active`, USD, monthly, 4900 / 1900.
5. Record the ids in `docs/billing/paddle-catalog.md` (create it: environment,
   product names, product ids, price ids, pricing model, date, sandbox
   confirmation, how to create production equivalents). Put the price ids in
   `.env.example` only as the documented values for `PADDLE_PRICE_PLATFORM`
   and `PADDLE_PRICE_DEPLOYMENT`; never in source.
6. Commit, PR, merge. Then run the Phase 8 Paddle-facing verification.

Env names (already used by Phase 5): `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`,
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
- Phase 8 is unverified against Paddle: the sandbox catalog (Phase 4) does not
  exist, so `PADDLE_PRICE_*` name nothing and no real checkout has been
  opened. Run the Phase 8 Paddle-facing verification right after Phase 4.
- Phase 10 follow-up: a `billing_provider_events` row left in `RECEIVED`
  by a crash between insert and processing reads as a duplicate on redelivery.
  The safety job should reset rows older than 10 minutes that are still
  `RECEIVED` to `FAILED` so the next redelivery processes them.
