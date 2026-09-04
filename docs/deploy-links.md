# Deploy Links — implementation map (Phase 0)

A Deploy Link lets a vendor generate a secure, customer-specific "Deploy to AWS"
URL for an existing customer + application. The customer opens the hosted page,
connects AWS with the existing flow, reviews the deployment, and starts it. The
feature reuses the existing deployment engine. It does not add a second pipeline.

## Current architecture (what we reuse)

- Tenant model: `organization` (vendor) owns `applications`, `customers`,
  `deployments`. Customers are rows without accounts. They act through bearer
  links (`deployments.installLinkId`), never sessions.
- Deployment creation: `POST /api/deployments` (`apps/api/src/server.ts:2632`,
  vendor session). It gates region (`env.deployableAwsRegions`) and manifest
  readiness, then inserts a `deployments` row with state `NOT_INSTALLED`, a
  single-use `enrollmentCode`, and a public `installLinkId`. No job is created.
- AWS connection: the customer opens `/install/[installLinkId]`, launches the
  CloudFormation Quick Create stack, then the relay registers with
  `POST /api/relay/register` (burns the enrollment code, binds
  `relayTokenHash`). The first INSTALL job is created there through
  `createOrReuseJob` (`apps/api/src/jobs.ts:33`, idempotency key + partial
  unique index for one active mutating job).
- Status/progress: `deriveDeploymentStatus` (`apps/api/src/deployment-status.ts`)
  with a customer projection `toCustomerDeploymentStatus`. The install page
  polls `GET /api/install/:installLinkId/status`. Resource inventory, default
  hostname (`d-<id>.deployz.dev` via `apps/api/src/default-https.ts`), custom
  domains, releases, rollback, destroy all hang off the deployment row and are
  origin-agnostic.
- Secrets: `mintEnrollmentCode` (32-byte hex, single use) and
  `hashRelayToken`/`verifyRelayToken` (sha256 at rest, constant-time compare) in
  `apps/api/src/relay-store.ts`. Public routes opt in to
  `PUBLIC_INSTALL_RATE_LIMIT`.
- Audit: append-only `event_logs` written by `recordEvent` in the same
  transaction as state changes. Link-driven actions use actor
  `install-link:<id>`.
- No deployment origin attribution exists today (`createdBy` only).

## Design

One pipeline. A Deploy Link is a thin, tokenized entry point that pre-creates a
normal deployment through the same creation logic as the vendor manual flow.

- New table `deploy_links` (`packages/db/src/schema/deploy-links.ts`): `id`
  (public uuid), `organizationId`, `customerId`, `applicationId`,
  `deploymentId` (unique), `tokenHash` (sha256 of a 32-byte secret),
  `expiresAt`, `revokedAt`, `lastUsedAt`, `createdBy`, timestamps. Status is
  derived (revoked / expired / active); no separate state machine.
- New column `deployments.source`: enum `manual | deploy_link`, default
  `manual`. One migration (`packages/db/drizzle/0029_*.sql`).
- Vendor API (org-scoped, `requireAuth`):
  - `POST /api/customers/:customerId/deploy-links` — creates the deployment via
    the shared creation logic (source `deploy_link`) plus the link row.
  - `GET /api/customers/:customerId/deploy-links` — link state for the panel.
  - `POST /api/deploy-links/:id/revoke`, `POST /api/deploy-links/:id/regenerate`
    (regenerate rotates the token while the deployment is still
    `NOT_INSTALLED`).
- Public API (rate-limited like install routes, token via header): resolve,
  launched, status, retry, domain-check. Handlers reuse the extracted install
  route logic; the token only authorizes this one deployment flow and never
  becomes a session.
- Customer page `/deploy/[publicId]?token=...` reuses the install page
  components (Quick Create step, launch, progress, retry) with friendly invalid,
  revoked, expired, and already-deleted states.
- Region is vendor-chosen at generation (matches existing constraint). The
  customer review step shows application, connected AWS account, region,
  hostname, and the resource list derived from existing `*Required` flags.
- Idempotency: the deployment exists before the customer acts. Re-opening the
  link resumes the same deployment. Double submit cannot create duplicates.
- Events: `deploy_link.created`, `deploy_link.opened`, `deploy_link.revoked`
  via `recordEvent`; deployment actions carry actor `deploy-link:<publicId>`.
  Attribution `source=deploy_link` distinguishes origins without changing
  semantics.

## Test and verification commands

- Unit/integration: `pnpm vitest run` (PGlite-backed; API tests apply
  migrations in-memory). Component tests render server-side (no jsdom env).
- Simulated E2E only: `pnpm e2e` / `pnpm e2e --scenario=<id>`. Real-AWS
  (`e2e:canary`, `e2e:fresh`) is out of scope for this feature.
- CI on PRs: `test-build` (build, vitest, lint) and `e2e-simulated`.

## Baseline at Phase 0 (branch omos/deploy_link @ 7a8e111)

- `pnpm build`: 9/9 tasks pass.
- `pnpm lint`: 9/9 tasks pass.
- `pnpm vitest run`: 2671 passed, 63 skipped, 1 failed, 5 files failed — all
  timeout-flavored (`server.test.ts` beforeAll hooks at 60s,
  `domain-routes.test.ts` test at 30s, one vitest RPC timeout) on a slow local
  machine (suite ran 903s). Treated as pre-existing flakiness, not logic
  failures. Re-checked per phase with targeted runs.
