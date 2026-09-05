# Deploy Links

A Deploy Link lets a vendor generate a secure, customer-specific "Deploy to
AWS" URL for an existing customer + application pair. The customer opens the
hosted page, connects their own AWS account through the existing flow, reviews
the deployment, and starts it. The feature is a thin entry point into the
existing deployment architecture — it does not add a second pipeline.

## What they are

- Vendor side: a "Deploy to AWS" card on the customer detail page
  (`apps/web/src/components/deploy-link-card.tsx`). Pick application + region,
  generate, copy the URL once, revoke or regenerate later.
- Customer side: `/deploy/<publicId>?token=<secret>`
  (`apps/web/src/app/deploy/[publicId]/page.tsx`). Review (application, AWS
  region, resources), "Deploy to AWS" handoff, then the install flow's own
  progress, domain and retry experience.
- Backend: `apps/api/src/deploy-links.ts` (lifecycle services), routes in
  `apps/api/src/server.ts`, table `deploy_links` +
  `deployments.source` enum (`manual | deploy_link`) in migration `0029`.

## How link authorization works

- A link is a public uuid plus a 32-byte random secret. Only the sha256 hash
  is stored (`token_hash`); the raw secret is returned exactly once, by
  generate and regenerate.
- Every public call presents the secret in the `x-deployz-token` header —
  never in a request URL. `resolveDeployLink` verifies it with the same
  constant-time compare the relay tokens use, then enforces: revoked → 410
  `DEPLOY_LINK_REVOKED`, expired (30-day TTL) → 410 `DEPLOY_LINK_EXPIRED`,
  wrong token / unknown id / deleted deployment → 404 (never a distinction an
  attacker can read).
- The token authorizes exactly one deployment's install flow. It never
  becomes a session and grants no relay/AWS permissions — relay routes still
  authenticate with the relay's own bearer token.
- Public routes are rate-limited like the install routes
  (`PUBLIC_INSTALL_RATE_LIMIT`); the secret never reaches logs (header, not
  URL) and appears in no payload except the one-time generate/regenerate
  responses.
- Vendor routes are org-scoped with the house IDOR rule: another org's
  customer, application or link 404s, never 403s.

## How deployment reuse works

Generation runs the SAME creation path as the vendor manual flow
(`createDeploymentRecord`: region allowlist gate, manifest readiness gates,
one insert with enrollment code + install link) and marks it
`source: 'deploy_link'`. The launch, status, retry and domain-check routes
resolve the link first, then reuse the install routes' logic byte-for-byte
(readiness gate, NOT_INSTALLED → WAITING_FOR_RELAY, customer status
projection). Launch is guarded by a conditional UPDATE on
`state = 'NOT_INSTALLED'`, so double submits record one launch. Everything
after enrollment — jobs, relay, polling, resources, hostname, custom domains,
releases, rollback, destroy — is untouched, origin-agnostic machinery.

## Why there is no separate pipeline

The link is only an entry point: one `deploy_links` row keyed to one normal
deployment. Any second creation/install/status path would fork the state
machine this product depends on. The e2e scenario `deploy-link`
(`e2e/scenario-deploy-link.spec.ts`) proves a link-created deployment reaches
HEALTHY through the shared pipeline and appears in the fleet with
`source: deploy_link`.

## Key tests

- `apps/api/src/deploy-links.test.ts` — token lifecycle (valid, invalid,
  expired, revoked, malformed), cross-tenant 404s, regenerate rotation and
  409-after-start, double-submit race, fleet parity, destroy → link fails
  closed, token-vs-relay permission boundary, no raw token persisted or
  leaked.
- `apps/web/test/deploy-links.test.tsx`, `deploy-page.test.tsx`,
  `deploy-link-flow.test.ts` — vendor card states, page states, resolve-reason
  mapping.
- `e2e/scenario-deploy-link.spec.ts` — simulated E2E journey and failure
  journeys (no real AWS).

## Validated on real AWS (2026-09-05)

The full path was driven against the deployed control plane and the test
AWS account with Documenso (P0 hardening, `docs/ai-mvp-implementation-status.md`):
generate → raw token shown once → customer review (application, region,
resources) → Deploy to AWS → bootstrap Quick Create → relay registration →
HEALTHY → default HTTPS hostname ACTIVE → release update → Disconnect →
Purge, all through the shared pipeline, with the fleet row carrying
`source: deploy_link`. Fail-closed probes on the public route: missing,
wrong or query-string token and an unknown id → 404; revoked → 410;
regenerate rotates the secret (old token → 404). Observed behaviours worth
knowing:

- Revoking a link does not delete its NOT_INSTALLED deployment row; the
  customer page keeps showing it as "Not installed" and the fleet lists it
  with `source: deploy_link`. It holds no AWS resources.
- The vendor card offers *Regenerate* only for an active link whose
  deployment is still NOT_INSTALLED; a revoked link is replaced by
  generating a new one (which creates a new deployment).
- The raw token never reaches the API logs (header-only transport); only
  `token_hash` is stored.

## MVP exclusions

Anonymous links, unknown-customer creation, marketplace, iframe/SDK embeds,
deployment REST API, white-labeling, button/CSS customization, multi-cloud,
Terraform, AWS Marketplace, custom deployment engines, separate link state
machines, and dedicated AWS infrastructure are all out of scope. Analytics are
the `event_logs` audit stream (`deploy_link.*` family) plus
`deployments.source`; there is no dashboard.
