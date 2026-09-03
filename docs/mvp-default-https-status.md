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
| 1 | Runtime Cloudflare configuration | Merged | #136 | 5b18167 | — | — |
| 2 | Default hostname model `d-<id>.deployz.dev` | Merged | #136 | 5b18167 | — | — |
| 3 | Cloudflare DNS client (mocked) | Merged | #136 | 5b18167 | — | — |
| 4 | Connect default DNS to lifecycle | In review | #TBD (batched) | — | — | — |
| 5 | Default HTTPS state + READY logic | In review | #TBD (batched) | — | — | — |
| 6 | Origin TLS architecture | In review | #TBD (batched) | — | — | — |
| 7 | Custom-domain flow fallback rules | Merged | #140 | 1b34151 | — | — |
| 8 | Custom-domain health promotion | Merged | #140 | 1b34151 | — | — |
| 9 | UI/UX default vs custom URL | Merged | #141 | 2c57762 | — | — |
| 10 | Custom domain removal / change | Merged | #140 | 1b34151 | — | — |
| 11 | Delete / purge reconciliation | Merged | #142 | 5b3c957 | — | — |
| 12 | Watchdogs and reconciliation | Merged | #142 | 5b3c957 | — | — |
| 13 | Security hardening | Merged | #142 | 5b3c957 | — | — |
| 14 | Simulated provider E2E (A–H) | Merged | #143 | d5b10d3 | — | — |
| 15 | Static production config verification | In review | #TBD (batched) | — | — | — |
| 16 | Documentation and cleanup | In review | #TBD (batched) | — | — | — |

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
- D7: The default-HTTPS machine consumes the Phase 3 client's
  deployment-keyed shape, extended (not loosened) with ACM validation-record
  ops: `upsert/deleteDefaultValidationRecord(deploymentId, validationName)`.
  The namespace guard keeps refusing anything that is not a mutable
  `d-*.<zone>` name or a validation name exactly one label beneath one
  (`_<label>.d-<id>.<zone>`, unproxied so ACM DNS-01 can see it). Routing
  records stay proxied with `ttl: 1`. WAITING_FOR_DNS reconciles both
  records; teardown paths delete both.

### Known follow-ups

- Route53 default-HTTPS writer and `DEPLOYZ_DNS_ZONE_ID` CDK grant become dead
  code after the Cloudflare swap — remove or repurpose in Phase 16 cleanup.
- Zone SSL/TLS mode: with a valid ACM cert on the ALB 443 listener, Full
  (strict) is the correct zone mode; confirm current zone mode out-of-band
  (no live calls from this work).

## Origin TLS architecture (Phase 6)

The default-HTTPS path in production is HTTPS in two segments:

- **Browser → Cloudflare edge.** The proxied `d-*.deployz.dev` records
  terminate TLS at the Cloudflare edge on an automatic (edge) certificate for
  the `d-*` hostname. The browser never sees the origin (ALB) directly.
- **Cloudflare → ALB.** The per-deployment ACM certificate the relay's
  `CONFIGURE_DOMAIN` executor issues lands on the deployment ALB's 443
  listener (packages/relay/src/domain.ts: once the cert is `ISSUED` it calls
  `createHttpsListener`, or `addListenerCertificate` when a 443 listener
  already exists, then flips the 80 listener to a 301 HTTPS redirect).
  `REMOVE_DOMAIN` reverses this: delete the 443 listener (or remove just this
  SNI cert), revert the 80 listener to a forward, delete the cert.

The stack's synth-time `certificateArn` branch
(packages/cdk/src/application/application-stack.ts:1114) is NOT the
default-HTTPS path. A deployment installs with no certificate — the `d-<id>`
hostname and its cert do not exist until after install — so the stack is
synthesized on the plain HTTP:80 branch (:1137) with the 443 security-group
rule opened up front (:1107) for the listener the relay adds later over the
ELBv2 API. The CDK synth pins for both listener shapes already live in
packages/cdk/test/application-stack.test.ts ("HTTPS endpoint contract"): no
certificate → exactly one HTTP:80 listener; certificate supplied → the
HTTPS:443 listener carries the cert and HTTP:80 redirects to it.

Preferred configuration: **full HTTPS end-to-end**, i.e. the zone SSL/TLS
mode set to **Full (strict)** — Cloudflare connects to the ALB on 443 and
validates the ACM certificate it finds there against a public CA.

Documented security limitation: if the `deployz.dev` zone SSL/TLS mode stays
**Flexible**, Cloudflare connects to the origin over plain HTTP and the path
is NOT end-to-end TLS — browser→edge is HTTPS, edge→origin is plaintext
behind a Cloudflare IP, so the customer data the ALB serves is only protected
for the first hop. Verifying (and, if needed, correcting) the zone mode is an
out-of-band operator task — this work never calls the Cloudflare API and
never changes the zone setting (no live calls, per the standing rules).

## Custom-domain removal / change (Phase 10)

- **Removal is the only change path.** There is no in-place hostname-change
  route (POST creates, DELETE removes — no PATCH/PUT on a domain). Changing a
  custom domain is remove → add, the MVP path. After the DELETE flow completes
  (`removedAt` set on the `custom_domains` row), `findActiveDomain` no longer
  returns the domain, so the preferred URL reverts to the permanent
  default-HTTPS URL — which Phase 7 kept reconciling throughout, so the
  fallback is always already there. A fresh domain can be added to the same
  deployment immediately: the partial unique indexes cover non-removed rows
  only, and the new row's machine starts a new cycle-0 (`checkCycle`), so job
  idempotency is per-domain and never collides with the removed domain's
  history.
- **Custom domains write nothing in the deployz zone.** The custom-domain
  machine never calls the Cloudflare DNS client: it only READS public DNS
  (`checkCname` for the customer's validation/routing CNAMEs, `probeHttps`)
  and drives the relay's ACM/ELB executors inside the customer account. The
  deployz-zone writes (`upsertDefaultDeploymentRecord` /
  `upsertDefaultValidationRecord` / their deletes) belong exclusively to the
  default-HTTPS machine and are deployment-keyed to `d-*` names behind the
  namespace guard — so custom-domain removal needs no deployz-side record
  cleanup, and default-HTTPS teardown cleans up both of its own records
  (routing + validation).

## Simulated provider E2E (Phase 14)

A fully simulated default-HTTPS E2E suite (`e2e/scenario-default-https.spec.ts`,
scenarios A–H) over the REAL API: the existing simulated relay harness
(`e2e/simulation/relay-harness.ts`) installs into a simulated AWS account, the
fixture HTTPS verifier (`DOMAIN_FIXTURE_MODE`) approves `*.deployz-fixture.test`
probes, and the default-HTTPS machine writes into a fixture-only, in-memory DNS
provider instead of Cloudflare. No real request leaves the process.

- **Scenario A — default HTTPS success**: install → DNS reconciliation →
  ACTIVE → READY; the provider holds exactly one proxied routing CNAME
  `d-<deploymentId>.deployz-fixture.test` → the fixture ALB plus the unproxied
  validation CNAME beneath it. Zone assertions use the fixture zone
  (`deployz-fixture.test`); the PRODUCTION zone hex is Phase 15's static
  check, deliberately not asserted here.
- **B — Cloudflare unavailable**: two scripted `CLOUDFLARE_UNAVAILABLE` write
  failures are state-only (no new INSTALL/DESTROY job, AWS untouched); the
  heartbeat retries and the machine recovers to ACTIVE/READY with both
  failures recorded in the watchdog budget (`configureAttempts`).
- **C — rate limiting**: scripted 429s (`retryAfter 30`) retry without
  consuming the watchdog budget (`configureAttempts` stays at the clean-path
  value) and never duplicate records.
- **D — custom domain**: default ACTIVE → add a `deployz-fixture.test` custom
  domain → relay ACM two-phase → ACTIVE → `appUrl` flips to the custom
  hostname while `defaultUrl` stays the `d-*` hostname.
- **E — custom failure**: a relay-refused custom domain lands in ERROR; the
  app stays READY/HEALTHY behind the default URL.
- **F — removal**: DELETE the custom domain → preferred URL reverts to the
  default; the default record remains.
- **G — delete/purge**: destroy deletes BOTH default records (routing +
  validation) via the provider; a subsequent purge finds nothing and never
  deletes twice.
- **H — namespace protection**: planted reserved (`app`/`www`/apex) and
  non-uuid `d-*` names survive the purge-orphan reconciliation untouched;
  only a true orphan (valid uuid, no live deployment) is deleted.

**Fixture/exposure mechanism.** The API server is a separate process under
Playwright, so assertions and failure-scripting travel over HTTP, not object
references. When BOTH `DOMAIN_FIXTURE_MODE` and `DEPLOYZ_DEFAULT_HTTPS_FIXTURE`
are on, `apps/api/src/server.ts` constructs `createDefaultHttpsFixtureProvider`
(`apps/api/src/default-https-fixture.ts`) — a `CloudflareDnsClient` backed by
the same in-memory store as the unit-level fake plus FIFO failure scripting —
and registers three internal endpoints that exist ONLY in that boot:
`GET /internal/fixture/default-dns-records` (records snapshot + remaining
failures + mutation log), `POST /internal/fixture/default-dns-records` (plant a
raw guarded-unaware record), and `POST /internal/fixture/default-dns-failures`
(`{ code: 'unavailable' | 'rate_limit', count }`). Production never constructs
the provider (the flags are off and scrubbed from the deploy env), so those
routes do not exist there — the same property `e2e/production-safety.spec.ts`
pins for scenario-control surfaces. The relay harness models ACM's real
two-phase DNS-01 flow (first PENDING_VALIDATION with the validation/routing
records, then ISSUED) so the machine genuinely passes through WAITING_FOR_DNS
and writes records; a `failConfigureForHostnameRegex` knob lets scenario E
drive a custom domain into ERROR.

The suite skips unless `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true` (the ordinary
simulated `--scenarios` run keeps HTTP-only behaviour); CI runs the file
separately with the flag on ("Default-HTTPS simulated scenarios" step in
`ci.yml`).

## Documentation and cleanup (Phase 16)

**Legacy Route53 path removed.** The reference graph was fully contained, so
the Route53 default-HTTPS writer was deleted rather than documented as
legacy:

- `apps/api/src/route53-records.ts` + `route53-records.test.ts` — the SigV4
  Route53 CNAME writer (deleted). The narrow `DnsRecordClient` interface and
  the no-op writer it also hosted moved into `apps/api/src/cloudflare-records.ts`
  beside `createDnsClientFromNameWriter`, because the no-op writer is still the
  DNS seam when the flow is off or under the fixture namespace.
- `apps/api/src/env.ts` — `dnsZoneId` (`DEPLOYZ_DNS_ZONE_ID`) removed.
- `apps/api/src/server.ts` — the legacy Route53 assembly branch removed;
  assembly is now fixture provider → Cloudflare → off (no other provider).
- `.env.example` — the `DEPLOYZ_DNS_ZONE_ID` block removed.
- `packages/cdk/src/deployz-stack.ts` + its test — the zone-id context/env
  var and the scoped `route53:ChangeResourceRecordSets` IAM grant removed.

No consumer outside those files referenced the path (verified by grep); the
fixture default-HTTPS provider (`default-https-fixture.ts`) and the E2E
scenario suite already rode the Cloudflare-shaped seam, so the removal changes
no fixture behaviour.

**Documentation updates.** `README.md` and `docs/architecture.md` now describe
the permanent `https://d-<deployment-id>.deployz.dev` model, the
defaultUrl/preferred-URL precedence, the runtime flow (deployment → ALB →
deployz.dev Cloudflare DNS reconciliation → HTTPS verification → READY), and
the four production config key NAMES (never a token value);
`docs/testing/aws-full-product-canary.md` was brought in line with the
Cloudflare reconciliation model.

**Phase 15 verification note.** Phase 15 is static-only: it scans the deploy
workflow and the CDK env allowlist text for the production Cloudflare bindings
and never reads or prints a secret value and never makes a provider call.

Automated implementation testing does not modify the production Cloudflare
zone. Cloudflare API behavior is covered through provider mocks and simulated
E2E tests.
