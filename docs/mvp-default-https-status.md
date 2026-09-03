# Default HTTPS + Custom Domain Upgrade — Status

Status tracker for the MVP plan "Default HTTPS + Existing Custom Domain Upgrade".

Goal: every deployment gets a permanent `https://d-<deployment-id>.deployz.dev`
URL. Existing custom domains keep working. `preferredPublicUrl` is the custom
URL when the custom domain is ACTIVE and healthy; the default URL is the
fallback in every other case.

Rules that hold for every phase:

- Work starts from the latest `main` (repo default branch; the plan text says
  "master" — this repo uses `main`).
- One phase per PR. No phase stacking. Merge before the next phase starts.
- No live Cloudflare API calls, no production DNS changes, no canary. Tests use
  mocks and fixtures only. `app.deployz.dev` is never touched.

## Phase status

| Phase | Scope | Status | PR | Merged commit | Tests | Notes |
|---|---|---|---|---|---|---|
| 0 | Audit existing domain/HTTPS runtime | Merged | #131 | a0f0c0f | none (docs only) | Findings below |
| 1 | Runtime Cloudflare configuration | In review | #TBD (batched) | — | — | — |
| 2 | Default hostname model `d-<id>.deployz.dev` | Pending | — | — | — | — |
| 3 | Cloudflare DNS client (mocked) | Pending | — | — | — | — |
| 4 | Connect default DNS to lifecycle | Pending | — | — | — | — |
| 5 | Default HTTPS state + READY logic | Pending | — | — | — | — |
| 6 | Origin TLS architecture | Pending | — | — | — | — |
| 7 | Custom-domain flow fallback rules | Pending | — | — | — | — |
| 8 | Custom-domain health promotion | Pending | — | — | — | — |
| 9 | UI/UX default vs custom URL | Pending | — | — | — | — |
| 10 | Custom domain removal / change | Pending | — | — | — | — |
| 11 | Delete / purge reconciliation | Pending | — | — | — | — |
| 12 | Watchdogs and reconciliation | Pending | — | — | — | — |
| 13 | Security hardening | Pending | — | — | — | — |
| 14 | Simulated provider E2E (A–H) | Pending | — | — | — | — |
| 15 | Static production config verification | Pending | — | — | — | — |
| 16 | Documentation and cleanup | Pending | — | — | — | — |

## Phase 0 — Audit findings

### Headline

The feature largely exists on `main` already. Commit `0704eb2`
("Phase 11 — Default HTTPS Without Customer DNS", PR #115) shipped:

- `apps/api/src/default-https.ts` — default-HTTPS state machine with statuses
  `PENDING, WAITING_FOR_DNS, CONFIGURING, ACTIVE, ERROR, REMOVING`
  (`DefaultHttpsState` in `deployments.default_https` jsonb).
- `apps/api/src/route53-records.ts` — `DnsRecordClient` seam
  (`upsertCname`/`deleteCname`) with injectable fetch and credentials.
- Lifecycle wiring: post-INSTALL kick, heartbeat driver, destroy
  force-complete, purge sweep, job-result application split
  (`isDefaultHttpsJob`).
- READY integration: `deriveDeploymentStatus` gates READY on
  `healthStatus === 'HEALTHY' && httpsUrl`; custom-domain machinery is already
  reused, not duplicated.

The remaining work is a **delta**, not a build:

1. **Hostname**: today `<deploymentId>.apps.deployz.dev` under apex
   `apps.deployz.dev` (`DEFAULT_HTTPS_APEX`, `defaultHttpsHostname` in
   `default-https.ts`). Target: `d-<deployment-id>.deployz.dev`.
2. **DNS provider**: today a Deployz Route53 zone (`DEPLOYZ_DNS_ZONE_ID`,
   hand-SigV4 client, CDK zone grant). The production zone `deployz.dev` lives
   on **Cloudflare** (`deployz-stack.ts` notes api.deployz.dev DNS is on
   Cloudflare; no Route53 zones in the account). No Cloudflare DNS code
   exists. The plan requires the Cloudflare client.
3. **Precedence**: today default-HTTPS is skipped while a custom domain serves,
   and a custom domain wins `resolveAppUrl`. The plan makes the default URL
   permanent and primary fallback; custom domain promotes only when
   ACTIVE + healthy.
4. **Production config**: `DEPLOYZ_DNS_ZONE_ID` is set in no workflow;
   default-HTTPS is effectively OFF in production today. Cloudflare config
   (`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ZONE_NAME`,
   `DEPLOYZ_DEFAULT_HOSTNAME_PREFIX`, `CLOUDFLARE_ZONE_EDIT_API_TOKEN`) must be
   wired through `deploy-api.yml` → CDK → `apps/api/src/env.ts`.

### Existing trace (file map)

- Deployment → ALB: `packages/cdk/src/application/application-stack.ts:1095`
  (ALB, 443 listener when `certificateArn` supplied), `CfnOutput
  PublicEndpoint` (:1368). Relay reports outputs in the INSTALL job result;
  API derives the ALB hostname with `albEndpointFromResult`
  (`apps/api/src/fleet-row.ts:70`).
- Custom-domain routes: `apps/api/src/server.ts:3862` (POST/GET domain,
  check, DELETE). Service: `apps/api/src/domains.ts` (`createCustomDomain`,
  `removeCustomDomain`, `applyDomainJobResult`, `runDomainCheck`).
- Domain state: `packages/db/src/schema/custom-domains.ts` (`hostname`,
  `status`, `certificateArn`, `validationName/Value`, `routingTarget`,
  `lastError`, `checkCycle`, `removedAt`).
- ACM + listeners (relay side, customer account): `packages/relay/src/domain.ts`
  (`configureDomain`, `removeDomain`, injectable `AcmClient`/`ElbClient`).
- Default-HTTPS machine: `apps/api/src/default-https.ts` (`runDefaultHttpsCheck`
  upserts CNAMEs in the WAITING_FOR_DNS branch; `beginDefaultHttpsRemoval`;
  `applyDefaultHttpsJobResult`).
- URL resolution: `apps/api/src/fleet-row.ts` `resolveAppUrl` (custom domain →
  default HTTPS → ALB fallback) and `resolveProbeUrl` (`server.ts:882`).
- READY gating: `apps/api/src/deployment-status.ts:880` (READY =
  HEALTHY + https URL; `needsDomainSetup` nudge otherwise).
- Teardown: destroy route starts both domain removals
  (`server.ts:3291`), force-complete safety net (:3423), purge backstop
  (:3562), job-result cleanup (:5002), relay ACM orphan sweep
  (`packages/relay/src/purge.ts:360`).

### Reusable seams (house idiom: narrow interface + real impl + in-memory fake)

- `DnsRecordClient` (`route53-records.ts:27`) — the Cloudflare client will
  implement this seam; swap happens at `server.ts:1118` default assembly and
  `env.ts:177` config.
- `DomainCheckDeps` (`domain-check.ts:8`) — DNS/HTTPS probe seam with real and
  fixture impls (`*.deployz-fixture.test` namespace, `DOMAIN_FIXTURE_MODE`).
- Relay AWS seams `AcmClient`/`ElbClient` with fakes in
  `packages/relay/src/domain.test.ts`.
- Fixture env modes (`apps/api/src/env.ts:183`), PGlite test DB, simulated E2E
  harness `e2e/simulation/relay-harness.ts`.

### Status vocabulary

The plan's `DNS_PENDING / TLS_PENDING / VERIFYING / ACTIVE / ERROR` maps onto
the existing default-HTTPS/custom-domain statuses:

| Plan | Existing |
|---|---|
| DNS_PENDING | `PENDING`, `WAITING_FOR_DNS` |
| TLS_PENDING / VERIFYING | `CONFIGURING` |
| ACTIVE | `ACTIVE` |
| ERROR | `ERROR` |
| (removal) | `REMOVING` |

Decision: keep the internal enum; present mapped names at the status/view
layer only if product copy needs them (Phase 5/9).

### Cloudflare API contract (for Phase 3)

Verified against current Cloudflare v4 docs:

- Endpoints: `GET/POST /zones/{zone_id}/dns_records`,
  `GET/PUT/PATCH/DELETE /zones/{zone_id}/dns_records/{id}`. Bearer token.
- Upsert pattern (no API-side upsert; create is not idempotent): search
  `type=CNAME&name.exact=<fqdn>` → 0 hits: create; 1 hit with drift: PUT;
  identical: no-op. A concurrent-create race can return `81057` — catch, re-lookup.
- Error mapping: `9109` invalid token → AUTH_FAILED; permission messages →
  PERMISSION_DENIED; HTTP 429 (+ `retry-after`) → RATE_LIMITED; `81053`/`81057`
  → DNS_CONFLICT; 5xx/timeout → UNAVAILABLE; `81044` record-miss on delete →
  success (idempotent delete).
- Proxied records force `ttl` auto — send `ttl: 1` with `proxied: true`.
- CNAME target must resolve publicly (ALB dualstack hostname is fine).

### Important decisions

- D1: Modify, do not rebuild. All phases are deltas over `default-https.ts`,
  the `DnsRecordClient` seam, and existing READY logic.
- D2: The Cloudflare client implements the existing `DnsRecordClient` seam;
  namespace guard restricts mutations to `d-*.deployz.dev` inside the client.
- D3: Repo default branch is `main` (plan says "master").
- D4: `deployz.dev` apex already hosts `api.deployz.dev` (manual record) and is
  the marketing origin. New records are strictly `d-*` names, so no collision;
  reserved-name protection (`domain-validation.ts` `RESERVED_SUFFIXES`,
  plus `deployz.dev`, `app.deployz.dev`, `www/api/admin.deployz.dev`) stays.
- D5: `docs/mvp-default-https-status.md` is this file, per plan mandate
  (root-level status doc, same pattern as `docs/mvp-implementation-status.md`).
- D6: No live Cloudflare testing at any phase. The Cloudflare HTTP transport
  is injectable; tests use a fake transport only.

### Known follow-ups

- Route53 default-HTTPS writer and `DEPLOYZ_DNS_ZONE_ID` CDK grant become dead
  code after the Cloudflare swap — remove or repurpose in Phase 16 cleanup.
- Zone SSL/TLS mode: with a valid ACM cert on the ALB 443 listener, Full
  (strict) is the correct zone mode; confirm current zone mode out-of-band
  (no live calls from this work).
