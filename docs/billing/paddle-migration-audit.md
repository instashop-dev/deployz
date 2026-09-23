# Paddle migration audit — Phase 0

Date: 2026-09-07. Baseline commit: `2734aca` (`main`).

This document records the complete Stripe billing surface of the Deployz
repository, the deployment state transitions that billing must observe, the
screens that change, and the migration sequence. No code behavior changed in
this phase.

Tags used below:

- **DELETE** — Stripe-specific. Remove in Phase 1.
- **MIGRATE** — a product rule or shape that survives. Re-implement for Paddle.
- **RETAIN** — not Deployz billing. Do not touch.

## 1. What the audit found

- Deployz bills through Stripe Checkout ($49 base price + $19 metered price).
- The metered side (meter events, `usage_records`, daily usage report) was
  never wired to a scheduler. `runDailyUsageReport` has no caller outside
  `apps/api/src/billing.ts` and its test. `packages/cdk` has one EventBridge
  rule (CodeBuild state) and no schedule. **The daily usage scheduler does not
  run in production.** Only the base subscription and the webhook-driven
  `subscriptions` row are live.
- `organization.plan` (`FREE|STARTER|PRO`) is written by one function
  (`syncOrganizationPlan`) and duplicates the subscription status. `PRO` is
  never assigned.
- "Genuinely live" already exists as a derived value:
  `deriveDeploymentStatus(...).stage === 'READY'`
  (`apps/api/src/deployment-status.ts:999-1001`). It requires
  `healthStatus === 'HEALTHY'` and a confirmed HTTPS URL. It is never
  persisted or event-fired today.
- `is_test_deployment` is a boolean. Nothing enforces one test deployment per
  application.
- Customer-facing pages (`/install/[installLinkId]`, `/deploy/[publicId]`)
  contain no pricing or billing copy.

## 2. Stripe reference inventory

### 2.1 Dependency and configuration — DELETE

| Location | Reference |
|---|---|
| `apps/api/package.json:76` | `"stripe": "^22.5.0"` |
| `apps/api/src/env.ts:85-89,143-146` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BASE`, `STRIPE_PRICE_METERED` and the startup warning |
| `apps/api/src/env.test.ts:242` | comment that names the workflow price loop |
| `packages/cdk/src/deployz-stack.ts:355-358` | the four `STRIPE_*` keys in the Lambda env allowlist. A key absent from this list is removed from the function on the next deploy |
| `.github/workflows/deploy-api.yml:73-76,136-138,151-160` | secrets passed to the deploy job, the completeness gate, the `price_*` format check |
| `.env.example:29,64-68` | the Stripe block and the return-URL comment |

### 2.2 Backend implementation — DELETE unless noted

| Location | Reference |
|---|---|
| `apps/api/src/billing.ts` (532 lines) | `createStripe`, `createCheckoutSession`, `ensureBasePrice`, `ensureMeteredPrice`, `findActiveMeter`, `createMeter`, `constructWebhookEvent`, `handleWebhookEvent`, `syncOrganizationPlan`, `extractInvoiceSubscriptionId`, `mapStripeStatus`, `upsertSubscriptionRow`, `isBillable`, `reportUsageForDate`, `runDailyUsageReport`, `METER_EVENT_NAME` |
| `apps/api/src/billing-correctness.ts` (191 lines) | pure rules. `shouldBillForDeployment`, `decideBilling`, test exemption — MIGRATE the rules into the Phase 2 domain module. `calculateDailyProration`, `calculateInvoiceTotal`, `BASE_PRICE_CENTS`, `METERED_PRICE_CENTS` — DELETE (day-based money math) |
| `apps/api/src/billing.test.ts`, `billing-correctness.test.ts` | Stripe fixtures and proration tests. The transient-failure and delete rules move to the Phase 2 domain tests |
| `apps/api/src/server.ts:80-88` | imports from `./billing.js` |
| `apps/api/src/server.ts:290-294` | `BASE_PRICE_DOLLARS`, `METERED_PRICE_DOLLARS` |
| `apps/api/src/server.ts:1477-1508` | `createStripe()`, raw-body carve-out for `/api/billing/webhook`, the `stripe-signature` route. The carve-out pattern is MIGRATE (Phase 6 reuses it for `Paddle-Signature`) |
| `apps/api/src/server.ts:2498-2500` | `checkoutBodySchema` |
| `apps/api/src/server.ts:5044-5055` | `POST /api/billing/checkout` |
| `apps/api/src/server.ts:5057-5101` | `GET /api/billing/summary` — MIGRATE the route shape. Phase 1 keeps it provider-neutral with `subscription: null` |
| `apps/api/src/server.ts:1142,3606` | comments that cite §48 metered billing |

### 2.3 Contracts — DELETE fields, MIGRATE shapes

| Location | Reference |
|---|---|
| `packages/contracts/src/index.ts:328-329` | `orgPlanSchema`, `OrgPlan` — remove in Phase 3 with `organization.plan` |
| `packages/contracts/src/index.ts:334-342` | `subscriptionStatusSchema` (`ACTIVE, TRIALING, PAST_DUE, CANCELED, INCOMPLETE`) — replaced by the Phase 3 vocabulary (`ACTIVE, PAST_DUE, PAUSED, CANCELED`) |
| `packages/contracts/src/index.ts:740-752` | `organizationSchema.stripeCustomerId` |
| `packages/contracts/src/index.ts:919-944` | `subscriptionSchema` (three `stripe*` ids), `usageRecordSchema` |
| `packages/contracts/src/index.test.ts:99-100,255-257,273` | fixtures for the fields above |

### 2.4 Database — DELETE

| Location | Reference |
|---|---|
| `packages/db/src/schema/billing.ts` | `subscriptions` (`stripe_subscription_id`, `stripe_base_price_id`, `stripe_metered_price_id`), `usage_records` (`stripe_usage_record_id`) |
| `packages/db/src/schema/auth.ts:119-121` | `organization.stripe_customer_id`; `organization.plan` (Phase 3) |
| `packages/db/src/enums.ts:138-145,160-164` | `subscription_status`, `org_plan` (Phase 3) |
| `packages/db/drizzle/0000_parallel_triton.sql:9,40,44,190-215,231-232` | original DDL. Do not edit. A new forward migration drops the objects |
| `packages/db/drizzle/0002_dizzy_red_shift.sql:3,17` | `org_plan` DDL. Same rule |
| `packages/db/src/auth-shape.test.ts:90,99` | asserts `stripe_customer_id` |
| `packages/db/src/migrations.test.ts` | table and enum count assertions |
| `packages/cdk/src/lambda/db-connection.ts` | hand-lists every migration file. Every new migration needs an import line here. This fails only in CI |

### 2.5 Tests, E2E, scripts

| Location | Reference | Tag |
|---|---|---|
| `e2e/billing.spec.ts` | summary page copy, nav reachability, jargon regex `Stripe|meter event|proration|usage record|metered` | MIGRATE. Keep the three tests. Add `Paddle` to the jargon regex |
| `packages/cdk/test/golden-path-e2e.test.ts:18,206-211,595,621` | `PENDING-AWS` placeholder for "Stripe test subscription exists" | DELETE the wording |
| `packages/cdk/src/integration/aws-clients.ts:16`, `packages/cdk/src/lambda/api-gateway-adapter.ts:53-61`, `packages/cdk/test/api-gateway-adapter.test.ts:51` | comments only. The base64 raw-body decode is provider-neutral | RETAIN code, update comments |
| `scripts/customer-reset/db.ts:90,120,131,143`, `inventory.ts:122`, `verify.ts:40`, `cleanup.ts:5-6` | `usage_records` counted and purged as customer data; `subscriptions` preserved as control-plane data | MIGRATE. Remove `usage_records` handling. Keep the preserve rule for `billing_subscriptions` |
| `docs/superpowers/specs/2026-08-25-block-manual-control-plane-deploys-design.md:24-25,136` | incident history that names Stripe secrets | RETAIN as history |
| `.janitor/history.md:35` | dev log | RETAIN |

### 2.6 Frontend — DELETE unless noted

| Location | Reference |
|---|---|
| `apps/web/src/lib/billing.ts` | `BillingSummary`, `fetchBillingSummary`, `formatDollars` — MIGRATE (Phase 1 keeps the summary fetch) |
| `apps/web/src/components/subscribe-button.tsx` | `SubscribeButton` — DELETE in Phase 1 |
| `apps/web/src/app/dashboard/settings/billing/page.tsx` | billing page — MIGRATE. Phase 1 removes the subscribe control. Phase 11 rebuilds |
| `apps/web/src/lib/organization-vocabulary.ts:7,52-56` | `OrgPlan`, `PLAN_LABELS` — DELETE in Phase 3 |
| `apps/web/src/app/dashboard/settings/page.tsx:10`, `apps/web/src/app/admin/vendors/page.tsx:31,179`, `apps/web/src/app/admin/vendors/[id]/page.tsx:32,148`, `apps/web/src/lib/admin.ts:18,147,211` | plan display — Phase 3 replaces with subscription status |
| `apps/web/src/components/organization-form.tsx:14` | comment only |

### 2.7 References that are not Deployz billing — RETAIN

These detect Stripe as a third-party dependency inside a customer's
repository, or use `STRIPE_SECRET_KEY` as a sample customer secret in tests.
They stay after Phase 1. The Phase 1 "zero active references" check excludes
them.

- `packages/analysis/src/detectors.ts:1975,2522`
- `packages/analysis/src/env-classification.ts:56`
- `packages/analysis/test/*.test.ts` (stage-a, stage-b-phase3, stage-b-phase4, phase7, application-analysis, env-classification, eval-corpus)
- `apps/api/src/github.ts:25,973,1165`
- `apps/api/src/preflight.test.ts`, `apps/api/src/server.test.ts:634-681`
- `packages/contracts/src/manifest.test.ts:26,173`
- `packages/relay/src/config-update.test.ts:573,581`
- `apps/web/test/env-plan.test.ts`, `preflight-summary.test.tsx`, `repository-picker.test.ts`
- `docs/testing/repository-*/runs/*.json`, `docs/testing/repository-compatibility/benchmark.yaml` (benchmark data)
- `docs/ai-mvp-implementation-status.md:332,598`, `docs/mvp-implementation-status.md:564` (describe the detector)
- `packages/analysis/src/repository-ai.ts:198,242,260` — `stripEnvValues`, a false match

## 3. What is deleted

- The `stripe` npm dependency.
- All of `apps/api/src/billing.ts` and the Stripe-specific parts of
  `billing-correctness.ts` (proration, invoice total, price constants).
- Routes `POST /api/billing/checkout` and `POST /api/billing/webhook`, and the
  raw-body carve-out for the billing webhook (Phase 6 adds it back for Paddle).
- Tables `subscriptions` and `usage_records`; column
  `organization.stripe_customer_id`; enum `subscription_status`.
- `STRIPE_*` env vars in `env.ts`, CDK allowlist, deploy workflow, `.env.example`.
- `SubscribeButton` and the subscription copy on the billing page.
- Stripe fixtures in contracts, db and api tests.
- `usage_records` handling in `scripts/customer-reset`.

## 4. What domain behavior is preserved

| Rule | Source today | Where it lives after migration |
|---|---|---|
| A vendor-owned test deployment is never billed | `billing-correctness.ts:157-160`, billing page footnote | `billing-domain.ts` (Phase 2). Test deployments never change the Paddle quantity |
| Updates and rollbacks do not add billing units | `billing-correctness.ts:59-70` | Once `ACTIVE`, only intentional removal changes the state |
| Temporary failures do not stop billing | `billing-correctness.ts:178-188` | `ACTIVE` ignores HEALTHY, UPDATE_AVAILABLE, UPDATING, FAILED, DISCONNECTED, rollback, recovery |
| Removal stops future billing | `billing-correctness.ts:162-166` | `ACTIVE -> STOPPED` on accepted removal intent |
| Jargon-free billing copy | `e2e/billing.spec.ts:9` | Same test, regex extended with `Paddle` |
| Billing is decoupled from deployment safety | no billing call inside lifecycle routes | Paddle API failure never rolls back or blocks a deployment |

Behavior that is **not** preserved: day-level metering, usage records, the
"bill on bare HEALTHY" gate (too loose — the new gate is the verified `READY`
stage), `organization.plan`.

## 5. Schema changes required

| Phase | Change |
|---|---|
| 1 | Drop `usage_records`, `subscriptions`, `organization.stripe_customer_id`, enum `subscription_status`. Forward migration `0032_*`. Update `migrations.test.ts` counts and `db-connection.ts` |
| 2 | `deployments.billing_state` enum `deployment_billing_state` (`NOT_STARTED`, `ACTIVE`, `STOPPED`), default `NOT_STARTED`; `deployments.billing_started_at`, `deployments.billing_stopped_at`. Replace `is_test_deployment` boolean with `deployment_type` enum (`TEST`, `PRODUCTION`) with a data migration |
| 3 | `billing_subscriptions` (one row per organization, `provider = PADDLE`), `billing_provider_events` (`provider_event_id` unique), `billing_reconciliation_events`. Drop `organization.plan` and enum `org_plan` |
| 7 | Partial unique index: one non-`DELETED` `TEST` deployment per application |
| 8 | `billing_checkout_intents` (pending production deployment parameters tied to a Paddle transaction) |

## 6. Deployment transition map

Source of truth for each site: `apps/api/src/server.ts` unless stated.
"Reconcile" means call `reconcileBilling(organizationId)` (Phase 9).

| # | Transition | Site | Billing action |
|---|---|---|---|
| 1 | Row created (`NOT_INSTALLED`) | `deploy-links.ts:127-208`, `server.ts:3338-3370`, `deploy-links.ts:235-240` | none. Phase 7/8: a PRODUCTION row requires an active subscription; otherwise a checkout intent is created instead |
| 2 | Quick Create launched (`WAITING_FOR_RELAY`) | `2059-2074`, `3149-3198` | none |
| 3 | Relay registers, INSTALL created (`INSTALLING`) | `5372`, `5502-5521` | none |
| 4 | INSTALL job SUCCEEDED | `5660`; `JOB_SUCCESS_STATE` omits INSTALL (`1148-1159`) | none. Not the live signal |
| 5 | First heartbeat HEALTHY (`INSTALLING -> HEALTHY`) | `6212-6226` | none alone |
| 6 | Default HTTPS / custom domain `ACTIVE` | `default-https.ts:668-672`, `domains.ts` | none alone |
| 7 | First `stage === 'READY'` | `deployment-status.ts:999-1001`, observed in `advanceStepTimingsAfterWrite` (`1083-1135`, called from `6364-6377` and `5900-5905`) | **`NOT_STARTED -> ACTIVE`** for PRODUCTION, then reconcile |
| 8 | DEPLOY_RELEASE / ROLLBACK / RESTART SUCCEEDED | `5809-5825` | none (reconcile is harmless) |
| 9 | Day-2 job FAILED with a running release | `contracts/index.ts:169-176`, `5756-5766` | none. Billing stays ACTIVE |
| 10 | First install FAILED (`FAILED`) | `contracts/index.ts:181` | none. Never reached ACTIVE |
| 11 | Heartbeat recovers FAILED -> HEALTHY | `6202-6206,6224` | none, unless this is the first READY (row 7) |
| 12 | Destroy of a never-installed row (`DELETED` at once) | `4028-4046` | `-> STOPPED` if ACTIVE (cannot be), else none |
| 13 | Destroy accepted (`DELETING`, DESTROY job queued) | `4073-4079` | **`ACTIVE -> STOPPED`**, then reconcile. This is the accepted removal intent |
| 14 | DESTROY SUCCEEDED (`DELETED`) | `5809-5825` | `-> STOPPED` if still ACTIVE (idempotent backstop), reconcile |
| 15 | Force-complete | `4113-4286`, write `4218-4226` | `-> STOPPED` if still ACTIVE (backstop), reconcile |
| 16 | PURGE result | `5850-5866` | none. Never reactivates |
| 17 | `retry-install` | `4677` | none |
| 18 | `deployment_type = TEST` | `deployments.ts:92` | none at every row above |
| 19 | Subscription activated / resumed (webhook) | Phase 6 | resume pending intents (Phase 8), reconcile |
| 20 | Scheduled safety job | Phase 10 | promote READY PRODUCTION rows still `NOT_STARTED`, then reconcile |

Rulings recorded here:

- STOPPED fires when the destroy request is accepted (row 13), not when AWS
  cleanup ends. Nothing after `DELETING` returns a deployment to a live state
  (`deploymentStateAfterFailedJob` never returns a live state after DESTROY or
  PURGE). Rows 14 and 15 are idempotent backstops.
- ACTIVE fires on the first observed `READY` stage from the relay write
  paths. The Phase 10 job also promotes a READY production deployment that is
  still `NOT_STARTED`, so a missed hook cannot leave a live deployment unbilled.
- `stage === 'READY'` is the only accepted live signal. `state === 'HEALTHY'`
  alone is not.

## 7. Screens affected

| Screen | File | Change |
|---|---|---|
| Dashboard home / onboarding | `apps/web/src/app/dashboard/page.tsx`, `dashboard/onboarding/page.tsx` | Evaluation message (free, test deployment free, pay at first customer deployment). Hidden after activation |
| Application readiness page | `apps/web/src/app/dashboard/applications/[id]/page.tsx` (stepper at 493-544, "Customer ready" step) | Unsubscribed: platform starts with the first customer deployment; each deployment adds $19/month once live |
| Test deployment creation | `apps/web/src/app/dashboard/deployments/new/page.tsx` (`?test=true`, copy at 215-220) | "Test deployment / Free / Does not affect billing". CTA "Run free test deployment" |
| Production deployment creation | same file, production branch | First deployment: $49/month platform + $19/month per live deployment, continue to checkout. Subscribed: "adds $19/month once live" |
| Customers list / detail | `dashboard/customers/page.tsx`, `customers/[id]/page.tsx` | No cost implied on customers |
| Deployment progress | `apps/web/src/components/install-progress.tsx` (customer-facing) and vendor deployment detail | Vendor side only: subtle "included in billing at $19/month" after live. Customer side: nothing |
| Deployment detail | `dashboard/deployments/[id]/page.tsx` | "Billing: $19/month" or "Billing: Free test deployment" |
| Deployment list | `dashboard/deployments/page.tsx` | Test / Free badge |
| Disconnect (delete) dialog | `deployments/[id]/page.tsx` `DisconnectDialog` (~1373) | Removal stops the $19/month charge; AWS cleanup may continue |
| Billing settings | `dashboard/settings/billing/page.tsx` | Before: evaluation is free, no card, no expiry. After: current monthly rate, next billing date, Manage billing |
| Organization settings | `dashboard/settings/page.tsx` | Plan line replaced by subscription status |
| App-wide banners | `dashboard/layout.tsx` (`SupportModeBanner` precedent, 23-36) | One past-due banner, one canceled banner |
| Admin vendors | `admin/vendors/page.tsx`, `admin/vendors/[id]/page.tsx` | Plan column replaced. Phase 14 adds billing detail and Reconcile action |
| Customer-facing install / invitation link | `app/install/[installLinkId]/*`, invitation confirm flow | No change. Must stay free of vendor pricing |
| Marketing pricing | `app/(public)/pricing/page.tsx` | Copy already matches $49 + $19. Review wording only |

Existing UI primitives: alert, alert-dialog, badge, card, dialog, separator,
skeleton, table, tabs, tooltip, sonner. No new UI framework is needed.
`packages/copy-map` has no billing copy.

## 8. Migration sequence

1. Phase 1 — remove Stripe, drop Stripe tables, keep a provider-neutral
   billing summary. Production loses checkout until Phase 8; this is
   accepted because no vendor is charged for metered usage today.
2. Phase 2 — `deployment_type`, `billing_state`, pure domain module and tests.
3. Phase 3 — `billing_subscriptions`, `billing_provider_events`,
   `billing_reconciliation_events`; remove `organization.plan`.
4. Phase 4 — create the sandbox catalog through the Paddle MCP; record ids in
   config and `docs/billing/paddle-catalog.md`.
5. Phase 5 — Paddle SDK, env validation, CDK and workflow wiring.
6. Phase 6 — webhook verification, dedupe, ordering, subscription state.
7. Phase 7 — evaluation entitlements, test deployment cardinality, production
   gate.
8. Phase 8 — checkout intents and resumed deployments.
9. Phase 9 — `reconcileBilling` with absolute quantities.
10. Phase 10 — scheduled safety job (worker Lambda schedule).
11. Phases 11-14 — UX, portal, entitlements, admin.
12. Phases 15-17 — test matrix, sandbox E2E, final audit.

## 9. Open items carried forward

- Deploy-link deployments are always PRODUCTION (`deploy-links.ts:235-240`).
  The subscription gate must cover deploy-link creation too (Phase 7).
- The worker Lambda that runs the 15-minute relay-liveness sweep is the
  natural host for the Phase 10 schedule. Confirm in `packages/cdk`.
- Paddle checkout will use Paddle.js with a client token and a server-created
  transaction. The web build bakes `NEXT_PUBLIC_*` values through
  `deploy-web.yml`; Phase 5 must add the client token and environment there.
