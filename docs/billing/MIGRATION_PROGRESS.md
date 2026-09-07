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
| 2 Billing domain | done | this PR | `apps/api/src/billing-domain.ts`, `billing-lifecycle.ts`; migration `0033_deployment_billing_state` (`deployment_type`, `billing_state`, timestamps) |
| 3 Billing schema | next | | brief drafted: `billing_subscriptions`, `billing_provider_events`, `billing_reconciliation_events`; drop `organization.plan` |
| 4 Paddle catalog (MCP) | pending | | sandbox catalog is empty at baseline |
| 5 SDK + config | pending | | |
| 6 Webhooks | pending | | |
| 7 Evaluation entitlements | pending | | |
| 8 First production activation | pending | | |
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

## Known issues

- None yet.
