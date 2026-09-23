# MVP Readiness 2 — implementation note (Phase 0 audit)

Concise record of the current architecture, the confirmed overlap, and the
implementation strategy for the public-MVP changes (invitations, customer
Region, versioned profiles, pre-relay secret delivery, customer-page
consolidation). Authoritative source files are cited by path.

## Current link model (the overlap, confirmed)

Three link concepts exist today and they overlap:

1. **Per-deployment customer link** — `deployments.install_link_id`
   (`packages/db/src/schema/deployments.ts:78`), a random uuid that appears in
   the customer URL `/install/:installLinkId`. Every deployment has exactly
   one. This is already the "customer deployment link" the target model wants;
   it must be kept as-is.

2. **Deploy links** — `deploy_links` (`packages/db/src/schema/deploy-links.ts`).
   Vendor-generated, tokenized (`token_hash` = sha256), and it **pre-creates
   one deployment** (`deployments.source = 'deploy_link'`) via
   `createDeployLink` → `createDeploymentRecord`
   (`apps/api/src/deploy-links.ts:236-290`). The customer resolves it at
   `/deploy/:publicId` with an `x-deployz-token` header. One link per
   deployment (`deploy_links_deployment_uidx`).

3. **Public install links** — `public_install_links`
   (`packages/db/src/schema/public-install-links.ts`). Credential-free,
   app-scoped (one live link per application), names only the application; the
   customer reviews then **confirms**, and only then a deployment is created
   (`deployments.source = 'public_link'`, keyed by `public_install_link_id` +
   `confirm_key` for idempotency) — `apps/api/src/public-install.ts`.

**Overlap the task targets:**

- Manual creation (`POST /api/deployments` → `createDeploymentRecord`) creates
  a deployment **and** its `install_link_id`.
- Deploy-link generation (`createDeployLink`) also creates a deployment **and**
  another link (the `deploy_links` row), *in addition to* the deployment's own
  `install_link_id`.
- The customer-level "Copy install link" and the Install Link card copy the
  same `/install/:installLinkId` URL, and a customer-level helper selects one
  non-deleted deployment — ambiguous when a customer has several deployments.

Net effect: three entry points that can each produce an equivalent production
deployment, two of them (manual + deploy-link) minting a deployment before any
customer confirmation.

## Region ownership (current)

- Canonical 17-region allowlist: `SUPPORTED_AWS_REGIONS`
  (`packages/contracts/src/index.ts:49`) and the mirroring Postgres enum
  `regionEnum` (`packages/db/src/enums.ts:29`).
- Deployment creation takes `region` as a fixed vendor-supplied value
  (`CreateDeploymentParams.region`, `apps/api/src/deploy-links.ts:109`), gated
  only by the `env.deployableAwsRegions` allowlist. **Vendor silently fixes the
  region** for manual and deploy-link flows today.
- `public-install` confirm already takes a customer-chosen `region` in the body
  (`apps/api/src/public-install.ts:59,268`) — the closest existing shape to the
  target "customer selects Region".

## Sizing / footprint / pricing (current)

- The one unversioned sizing table is `DEPLOYMENT_SIZING`
  (`packages/contracts/src/footprint.ts:32`): web/worker
  `{cpuUnits:256, memoryMiB:512, quantity:1, sizeLabel:'Small'}`,
  database `{instanceType:'db.t4g.micro', storageGb:20}` (no max storage), cache
  `{nodeType:'cache.t4g.micro'}`. Its own comment flags it as needing a
  per-`infraVersion` registry when a second generation ships.
- Footprint resolves from manifest + region + sizing:
  `resolveDeploymentFootprint` (`packages/contracts/src/footprint.ts:258`).
- Pricing is `estimateFootprintCost` (`packages/contracts/src/pricing.ts:104`)
  with `REGION_PRICE_FACTOR` (`:71`) — so **Region already factors cost**; the
  bug is the UI/path that never re-derives the estimate after the customer
  changes Region, plus silent first-Region selection.
- Deployments already carry `infra_version` (default `'runtime-v1'`)
  (`packages/db/src/schema/deployments.ts:68`).

## Secret delivery (DEPLOY-027, root cause confirmed)

- Config capture (`setConfig`) stores non-secret values as plaintext
  customer-scoped rows; secret values persist **only as `SECRET_MASK`** — the
  plaintext never reaches the control-plane DB (`apps/api/src/public-install.ts:250-256`).
- The relay's effective-config view (`buildRelayConfigEntries`,
  `apps/api/src/install-config.ts:41`) sends plaintext for non-secrets and
  **never** the value for secrets; it only marks `internal_secret` /
  `deployz_generated` keys as relay-mintable (`mintableKeys`,
  `apps/api/src/install-config.ts:76`).
- A **customer-required secret** (external credential, format-sensitive) typed
  before the relay connects is therefore write-only and **never reaches the
  install**; minted replacements ignore the application's format. This is
  DEPLOY-027 (see `docs/testing/repository-deployment/findings.md:1414`).
- `configPrecedesFirstStart` + `startAfterConfig` already support
  "INSTALL with zero tasks until config applied" (`install-config.ts:91-157`,
  `apps/api/src/install-config.ts`).

## Strategy

- **Phase 1** — replace `DEPLOYMENT_SIZING` with an immutable profile registry
  keyed `small-v1` (publish only `small-v1`; preserve exact sizing; add
  `desiredCount` and a `maxStorageGb`; resolve via manifest + region +
  profile id/version + `infra_version`). Store profile id/version in every new
  deployment's frozen desired state; existing deployments resolve to `small-v1`.
- **Phase 2** — unify link creation into one invitation model by extending
  `public_install_links` (optional `customer_id`, `recommended_region`,
  `token_hash`, `expires_at`, `confirmed_at`, `resulting_deployment_id`,
  `region_selection`, `legacy_publisher_fixed`). New targeted links use
  `regionSelection: 'customer'`; legacy fixed-region links are marked
  `legacy_publisher_fixed`. `deploy_links` stops being minted for new links but
  stays for legacy reads.
- **Phase 3** — `GET /api/invitations/:id/plan?region=…&profile=…` reusing the
  same footprint/pricing path as creation; customer-selects-Region UI.
- **Phase 4** — deployment-scoped encrypted pending-secret storage (KMS
  envelope encryption, ciphertext-only, encryption context bound to
  org/deployment/key, expiry, decrypt only for authenticated relay, delete on
  ack/purge/expiry) fixing DEPLOY-027.
- **Phase 5** — customer-page consolidation: invitations (pending) vs
  deployments (links per deployment), remove customer-level Copy / Install Link
  card / Deploy Link generator.
- **Phase 6** — audit events + cleanup rules.
- **Phase 7** — full validation + real AWS canary + cleanup.

Migrations: drizzle, `packages/db/drizzle/`, latest `0043_install_link_lifecycle.sql`;
single-statement migrations are the recent convention.
