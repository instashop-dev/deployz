# Discovery: existing test infrastructure

Point-in-time investigation (2026-09-01) that informed the Phase 1 E2E architecture.
File paths and line numbers are as of branch `claude/deployz-phase1-e2e-testing-d6512e`;
they can drift. For the resulting architecture, see `../e2e-testing.md`.

## 1. Playwright e2e suite (`e2e/`)

All specs drive the **real Fastify API + real Next.js dev server** (per `playwright.config.ts`, both booted as Playwright `webServer` entries at `apps/api`/`apps/web` `dev` scripts). None of the six specifically requested specs mocks the backend at the route level except `visual.spec.ts`. Coverage/data strategy per spec:

- **`e2e/install.spec.ts`** — drives the real, unauthenticated `GET /api/install/:installLinkId` (+ `/security`, `/launched`, `/retry`) endpoints. Seeds real `application`/`customer`/`deployment` rows via `POST /api/auth/sign-up/email`, `/api/applications`, `/api/customers`, `/api/deployments` (helper `seedInstall`, lines 32-84), then hits pages as an anonymous customer. Also drives a simulated relay via `POST /api/relay/register` with a real bearer token. No network mocking.
- **`e2e/deployment-progress.spec.ts`** (26KB) — drives a **simulated relay over the real HTTP protocol**: `register` → `commands` (poll) → `result` → `health`, mirroring exactly what a real relay would send (comment lines 6-11). Asserts the "projection-consistency invariant" across three surfaces: customer install page, vendor deployment-detail page, and raw `GET /api/install/:id/status`. Helpers `signUp`, `seedDeployment`, `fetchStatus`, `fetchRelayCommands`, `postRelayResult`, `expectStageEverywhere` are all defined locally in this file (lines 44-177), not shared. Also drives a full custom-domain cycle via `DOMAIN_FIXTURE_MODE` (`*.deployz-fixture.test` hostnames).
- **`e2e/stack-events.spec.ts`** (17KB) — drives the new `POST /api/relay/commands/:jobId/progress` stack-event ingest endpoint over real HTTP, explicitly cloning `deployment-progress.spec.ts`'s setup helpers (comment lines 3-11). Posts raw CFN-shaped event batches (`subnetEvents`, `rdsEvent`, `stackEvent` builders, lines 156-186) and reads back via `GET /api/deployments/:id/stack-events` (vendor, session-authed) and the UI's "Infrastructure events" disclosure.
- **`e2e/diagnostics.spec.ts`** — drives the real `GET /api/deployments/:id/diagnostics` endpoint. Drives a deployment to FAILED via the real relay job workflow (`driveDeploymentToFailed`, lines 85-123: register → INSTALL job → `POST .../result` with `success:false`), since `enqueue()` no-ops locally with no `JOB_QUEUE_URL` so release-based failure paths 409 (comment lines 78-83).
- **`e2e/redis.spec.ts`** — drives the **real deterministic analyser** (`POST /api/applications/:id/analyse`, runs inline with no queue) against fixture GitHub repos served by `GITHUB_FIXTURE_MODE` (`deployz-demo/bullmq-worker`, `deployz-demo/legacy-redis`). No fabricated verdicts — real analysis output is asserted.
- **`e2e/visual.spec.ts`** — the one exception: **fully network-mocked** via `page.route()` against `/api/deployments`, `/api/applications`, `/api/deployments/:id`, `/events`, `/releases` (helpers `mockFleet`/`mockDetail`, lines 194-223), with fixed ids/timestamps so pixel diffs are deterministic. Signup itself is still real (against the live API) to get a session; only data-fetch endpoints are mocked. Uses `toHaveScreenshot` with `maxDiffPixelRatio: 0.02` (playwright.config.ts).

Other specs (`app-url`, `applications`, `auth`, `billing`, `config`, `custom-domain`, `fleet`, `github`, `home`, `organization`, `readiness`, `shell`) follow the same "real API, real Postgres/PGlite, seed via `page.request.post`" convention — `custom-domain.spec.ts` and `fleet.spec.ts` are cited by name in comments as the origin of the `driveDeploymentToHealthy`/relay-seeding conventions other specs mirror.

## 2. API database wiring

- **`packages/db/src/client.ts`** (`createRuntimeDb`, lines 45-56): two paths — if `DATABASE_URL` is set, real Postgres via `node-postgres` `Pool` + `drizzle-orm/node-postgres` (migrations are "the platform's concern", not applied here); if unset, **file-backed PGlite** at `packages/db/.pgdata` (gitignored) with drizzle migrations auto-applied at startup via the bundled migrator (`drizzle-orm/pglite/migrator`, idempotent, journal-tracked).
- **`apps/api/src/index.ts`** (lines 11-13): entrypoint calls `createRuntimeDb()` with no options, then `createAuth(db)`, then `buildServer({ auth, db })`. `dev` script is `tsx src/index.ts`.
- **`.env.example`** lines 4-7: "When unset, apps/api falls back to a file-backed PGlite dev database at `packages/db/.pgdata`".
- **Playwright's `webServer`** for `@deployz/api` spreads `...process.env` and does not itself set `DATABASE_URL` — so e2e uses whatever the developer's local `.env` has, or falls back to the PGlite file store. Playwright's webServer env explicitly sets `GITHUB_FIXTURE_MODE`, `AI_FIXTURE_MODE`, `DOMAIN_FIXTURE_MODE`, `BOOTSTRAP_TEMPLATE_URL` (`playwright.config.ts` lines 29-42).
- Unit/integration tests (`apps/api/src/*.test.ts`) use **in-memory PGlite** directly (`new PGlite()`, no data dir) + `applyMigrations(client)` from `packages/db/src/migrate.ts` — never touch `DATABASE_URL`.
- `packages/db/src/migrate.ts`: `applyMigrations` reads every `drizzle/*.sql` file in filename order and `client.exec()`s each.

## 3. Test users / auth

- No seeded fixture users. Every e2e spec creates a **fresh account per test** via `crypto.randomUUID().slice(0,8)` suffixed emails, either:
  - through the browser (`page.goto('/sign-up')` → fill Name/Email/Password → click "Create account" → `waitForURL('/dashboard')`) — pattern repeated verbatim in `deployment-progress.spec.ts` (`signUp`, lines 44-52), `stack-events.spec.ts` (lines 38-46), `diagnostics.spec.ts` (lines 16-24), `redis.spec.ts` (lines 20-28), `visual.spec.ts` (lines 184-192), `auth.spec.ts`.
  - or directly against the API (`POST /api/auth/sign-up/email`) for unauthenticated-route specs like `install.spec.ts` (`seedInstall`, no browser session needed).
  - Password is always the literal `'super-secret-1'`.
- Signup **auto-provisions an organization** (Better Auth session hook) — the org name derives from the email's local part (`auth.spec.ts` line 26; `apps/api/src/server.test.ts`'s `signUpAndGetOrg` helper confirms this via a `member` table lookup, lines 20-42).
- `apps/api/src/server.test.ts` has the canonical in-process auth helper `signUpAndGetOrg(auth, db, email)` (lines 20-42): calls `auth.api.signUpEmail` then `auth.api.signInEmail({ asResponse: true })`, extracts the `set-cookie` header, and looks up the `organizationId`. Not exported as a shared module.

## 4. Unit/integration test layout

- Root `vitest.config.ts`: Vitest 3 **projects** mode — `projects: ['packages/*', 'apps/*']`. `pnpm test` = `vitest run` at root.
- `apps/api/vitest.config.ts`: bumps `hookTimeout`/`testTimeout` to 120s/30s because PGlite boot (~7s) plus parallel files can starve default timeouts.
- `apps/web/vitest.config.ts`: aliases `@/` → `src/`. **No test files currently exist under `apps/web/src`** — apps/web has zero unit tests today.
- `apps/api/src/*.test.ts` (30 files) — heavy integration coverage: `server.test.ts` (in-process Fastify via `buildServer`, PGlite, full HTTP-shaped tests via `app.inject`), `deploy-contract.test.ts`, `stack-progress.test.ts`, `stack-event-progress.test.ts` (pure-function unit test for `categorizeResourceType`/`summarizeStackEvents`, no DB), `deployment-status.test.ts`, `health-transitions.test.ts`, `lifecycle.test.ts`, `domain-check.test.ts`/`domain-routes.test.ts`/`domain-validation.test.ts`, `billing.test.ts`/`billing-correctness.test.ts`, `relay-store.test.ts`, `relay-identity.test.ts`, `fix-instructions.test.ts`, `ai-explanation.test.ts`, `github.test.ts`, `step-timings.test.ts`.
- `packages/db/src/*.test.ts` — `client.test.ts`, `constraints.test.ts`, `deployments.test.ts`, `event-logs.test.ts`, `auth-shape.test.ts`, `contracts-parity.test.ts`, `migrations.test.ts`, `stack-events.test.ts`.
- `packages/contracts/src/index.test.ts`, `infrastructure.test.ts` — schema/contract tests for the shared Zod contracts (`relayCommandProgressSchema`, `relayStackEventSchema` at `packages/contracts/src/index.ts` lines 510-526, `bootstrapStackName`, `errorEnvelopeSchema`, `SUPPORTED_AWS_REGIONS`, `DEFAULT_APPLICATION_STACK_NAME`).
- `packages/cdk/test/` (29 files) — the deepest test layer: CDK template synthesis tests (`application-stack.test.ts`, `bootstrap-stack.test.ts`, `deployz-stack.test.ts` with `__snapshots__`), workflow tests (`install-workflow.test.ts`, `deploy-release-workflow.test.ts`, `config-update-workflow.test.ts`, `destroy-workflow.test.ts`, `rollback-workflow.test.ts` — all built on an injectable `AwsClients` seam + `DurableRuntime`/`InMemoryStateStore` + `EventEmitter`/`InMemoryEventStore`), `quick-create.test.ts`, `artifacts.test.ts` (guards committed `artifacts/*-template-v1.json` against synth drift), `audit-completeness.test.ts`, `region-enforcement.test.ts`, `security-hardening.test.ts`, `preflight-engine.test.ts`, `failure-classifier.test.ts`, `diagnostic-explainer.test.ts`/`diagnostic-schema.test.ts`, `golden-path-e2e.test.ts` (25-step golden-path DoD gate, fully mock-seamed, "PENDING-AWS" markers for steps needing real credentials), and **`golden-path-live-aws.test.ts`** (see §9).
- `packages/relay/src/*.test.ts` (20 files) — one per relay executor: `install.test.ts`, `deploy.test.ts`, `destroy.test.ts`, `domain.test.ts`, `config-update.test.ts`, `stack-events.test.ts`, `provision-progress.test.ts`, `verify.test.ts` (the `verifyInstallation`/`createCloudFormationReader` seam consumed by both `audit-deployment.mjs` and `golden-path-live-aws.test.ts`).

## 5. `packages/fixture`

A minimal real Node/Express app (`@deployz/fixture`) that IS the container image a fresh customer install actually runs — not a test-only stub.

- **`packages/fixture/src/server.ts`**: Express app with exactly two routes: `GET /health` and `GET /` — both return `{ status: 'ok', database: <state> }` (or `{ application: 'deployz-fixture', status, database }` for `/`). **No `/version`, `/db`, `/redis`, or `/storage` endpoints exist.** `poolConfigFromEnv` (lines 38-65) reads `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_NAME`/`DATABASE_USER`/`DATABASE_PASSWORD` from env (injected by the CDK application stack) and probes Postgres with `SELECT 1`, forcing SSL with `rejectUnauthorized: false` (RDS `rds.force_ssl=1`). The DB probe is **reported, never enforced** — `/health` always returns 200 once the process is listening, deliberately decoupled from DB readiness (doc comment lines 9-20).
- **`packages/fixture/Dockerfile`**: two-stage build (compile TS → `node:22-alpine` runtime with `curl` installed for the ECS task-definition health check). Doc comment (lines 4-13): "deployed by the integration suite to prove the INSTALL flow reaches HEALTHY." Build context is the package dir itself because `packages/cdk/src/pipeline/build-pipeline.ts` derives context from the Dockerfile's own location.
- **Usage today**: the **default placeholder image** referenced by `packages/cdk/src/application/application-stack.ts` (`DEFAULT_IMAGE_REPOSITORY`/`DEFAULT_IMAGE_DIGEST`, a digest ECS cannot actually pull — deliberately, to force real deployments to pass a real image), and the image `golden-path-live-aws.test.ts` instructs operators to publish and point `DEPLOYZ_LIVE_IMAGE_REPOSITORY`/`DEPLOYZ_LIVE_IMAGE_DIGEST` at (comment lines 108-123 of that file). Has its own `packages/fixture/src/server.test.ts` unit test. Not currently wired into any Playwright e2e.

## 6. Scripts and CI

**Root `package.json`** scripts: `build` (`turbo run build`), `test` (`vitest run`), `test:e2e` (`playwright test`), `lint` (`turbo run lint`), `dev` (`turbo run dev`).

**Per-package scripts** (all packages follow `build`/`lint`/`dev` via `tsc`):
- `apps/api`: `build`, `lint`, `dev` (`tsx src/index.ts`).
- `apps/web`: `build` (`next build`), `lint`, `dev` (`next dev`).
- `packages/db`: adds `db:generate` (`drizzle-kit generate`).
- `packages/cdk`: adds `synth:bootstrap`, `synth:app`, `cdk` (raw passthrough), `publish:bootstrap`, `publish:application`, `audit:deployment`.
- `packages/fixture`: adds `start` (`node dist/server.js`).

**`turbo.json`**: `build` and `test` tasks both `dependsOn: ["^build"]`; `dev` also `dependsOn: ["^build"]` but is `persistent`/uncached.

**`.github/workflows/ci.yml`** — triggers on every `push`/`pull_request`. Steps: `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm vitest run` → `pnpm lint`. Sets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` env at workflow level (used by CDK unit tests that touch AWS SDK types, not by any live-AWS gated suite — `DEPLOYZ_LIVE_AWS` is not set here so `golden-path-live-aws.test.ts`'s live blocks stay skipped).

**`.github/workflows/e2e.yml`** — `workflow_dispatch` only ("Not part of the PR check set" because committed visual snapshots are Windows-generated). Steps: install → `pnpm build` → `pnpm exec playwright install --with-deps chromium` → `pnpm exec playwright test --grep-invert visual` → uploads `test-results/` on failure.

**`.github/workflows/deploy-api.yml`** — push to `main` (path-filtered) or `workflow_dispatch`. Deploys the control-plane CDK stack, gated by a "verify env complete" step, then verifies `https://api.deployz.dev/health` post-deploy.

**`.github/workflows/deploy-web.yml`** — push to `main` (path-filtered) or `workflow_dispatch`. Builds a `linux/amd64` Docker image, ships to AWS Lightsail.

No `workflow_dispatch` job currently runs anything against real AWS resources with `DEPLOYZ_LIVE_AWS=1` — that flag exists only in `golden-path-live-aws.test.ts` and must be run manually today.

## 7. Helpers for creating applications/deployments/releases in tests

There is **no shared/exported e2e helper module** — every spec file inlines its own copies of near-identical helpers:
- `signUp(page)` — duplicated across `deployment-progress.spec.ts`, `stack-events.spec.ts`, `diagnostics.spec.ts`, `redis.spec.ts`, `visual.spec.ts`, `auth.spec.ts`.
- `seedInstall`/`seedDeployment`/`seedAnalysedApplication`/`seedCustomerAndDeployment` — each spec defines its own version of "POST /api/applications → POST /api/customers → POST /api/deployments", varying only in payload fields.
- `fetchStatus`, `fetchRelayCommands`, `postRelayResult`, `postRelayProgress` — near-identical relay-protocol helpers duplicated in `deployment-progress.spec.ts` and `stack-events.spec.ts`.
- `driveDeploymentToHealthy`/`driveDeploymentToFailed` — duplicated in `diagnostics.spec.ts` and `redis.spec.ts` (comments cite `fleet.spec.ts`'s `driveDeploymentToHealthy` as the origin).

For **API-level integration tests**, `apps/api/src/server.test.ts` defines the canonical in-process helpers: `signUpAndGetOrg(auth, db, email)`, `insertApplication(db, organizationId, overrides)`, `insertCustomer(db, organizationId, overrides)` (lines 20-80+) — local to that file, not exported.

For **DB-level tests**, `packages/db/src/test-utils.ts` is the one genuinely shared helper module: `createTestDb()` (fresh in-memory PGlite + migrations) and `seedBase(db)` (minimal org→application→customer graph).

## 8. Env flags altering test/fixture behavior

Defined in `apps/api/src/env.ts` (lines 172-179), all read once into the `env` const:
- **`GITHUB_FIXTURE_MODE`** (`'true'` or `'1'`) — GitHub routes serve a fixture org/repo set instead of calling GitHub; read in `apps/api/src/github.ts` (fixture repos `fixture-repo-1..6`: `express-api`, `legacy-redis`, `bullmq-worker`, plus 3 more, defined ~line 476-520; per-repo file-tree fixtures ~line 918-980).
- **`AI_FIXTURE_MODE`** (`'true'`) — canned AI gateway responses for deterministic fix-instructions generation; implemented in `apps/api/src/ai-fixture.ts`.
- **`DOMAIN_FIXTURE_MODE`** (`'true'`) — DNS/HTTPS domain checks pass only for `*.deployz-fixture.test` hostnames, no throttle; read in `apps/api/src/domain-check.ts`'s `createFixtureDomainCheckDeps`.
- **`DATABASE_URL`** — presence toggles real Postgres vs PGlite file store (see §2).
- **`BOOTSTRAP_TEMPLATE_URL`** — stand-in for the real `publish:bootstrap` output URL; unset means `quickCreateUrl: null` from the install API.
- **`DEPLOYABLE_AWS_REGIONS`** — comma-separated allowlist, defaults to `['us-east-1']`; fail-closed.
- All three fixture-mode flags are set together only in `playwright.config.ts`'s `webServer` env block — **every** Playwright e2e run implicitly runs in triple-fixture mode.
- Separately, **`DEPLOYZ_LIVE_AWS=1`** (read in `packages/cdk/test/golden-path-live-aws.test.ts` line 316) gates real-AWS vitest suites — a test-runner gate, not an API env flag. Companion vars: `DEPLOYZ_LIVE_IMAGE_REPOSITORY`, `DEPLOYZ_LIVE_IMAGE_DIGEST` (real pullable image, required — `requireLiveImage()`, lines 124-138), `DEPLOYZ_LIVE_INSTALLATION_ID` (optional override), `AWS_REGION` (defaults `us-east-1`).

## 9. Existing real-AWS scripts

- **`packages/cdk/test/golden-path-live-aws.test.ts`** — the only existing real-AWS *test file*. Gated by `process.env.DEPLOYZ_LIVE_AWS === '1'` (`describe`/`describe.skip` swap, line 316). Three gated `describe` blocks:
  1. **"§67 Phase 4 — live AWS bootstrap golden path"** (lines 318-371): `cdk deploy` (via `spawnSync`, `shell:true` for Windows) → `describeStacks` asserts `CREATE_COMPLETE` → verify relay Lambda `Active` + installation-id env var via `aws lambda get-function-configuration` CLI shellout → verify `deployz:installation` tags via `resourcegroupstaggingapi get-resources` → `cdk destroy` teardown with polling for stack deletion.
  2. **"§67 Phase 4 — live AWS Redis cache provisioning"** (lines 404-461): synthesizes a standalone `ApplicationStack` with `redisRequired: true`, calls `aws.cloudFormation.createStack` directly, polls to `CREATE_COMPLETE` (~15-25 min, RDS-dominated), polls ElastiCache to `available` via injectable `ElastiCacheClient` seam, then deletes and verifies cluster gone. Requires `DEPLOYZ_LIVE_IMAGE_REPOSITORY`/`DEPLOYZ_LIVE_IMAGE_DIGEST` pointing at a real published image (recommends a published `packages/fixture` build) — refuses to run without them via `requireLiveImage()`.
  3. **"installation verification (live)"** (lines 478-506): runs `verifyInstallation` from `@deployz/relay/verify` against a real, previously-provisioned installation id, asserting checks `stack-exists`, `stack-complete`, `stack-tagged`, `compute`, `ingress`, `database`, `storage` all pass, and a fake stack name fails verification.
  - All AWS access goes through the injectable `createAwsClients()` seam (`packages/cdk/src/integration/aws-clients.ts`) except Lambda-config/tag lookups which shell out to the `aws` CLI directly.
- **`packages/cdk/scripts/audit-deployment.mjs`** — a standalone operator CLI (not a test): `pnpm --filter @deployz/cdk audit:deployment --installation <uuid> [--region] [--stack-name] [--claimed] [--redis]`. Uses the same `verifyInstallation`/`createCloudFormationReader` seam from `@deployz/relay/verify`. Exit codes: 0 verified, 1 not verified, 2 usage error. Effectively a manual/on-demand **canary** for a live installation.
- **`packages/cdk/scripts/publish-bootstrap.mjs`** and **`publish-application.mjs`** — real-AWS *publishing* scripts (not tests): synth the CFN templates, ZIP Lambda assets, upload to per-region public S3 buckets, verify reachability + `ValidateTemplate` post-publish (fail closed).
- No dedicated "canary" GitHub Actions workflow exists today; `DEPLOYZ_LIVE_AWS=1` runs are manual/local only.

## 10. Turbo/pnpm build order effects on tests

- `playwright.config.ts` top-of-file comment: "API needs `@deployz/db` built (dist) — run `pnpm build` first (turbo dev dependsOn is also wired so `pnpm dev` works standalone)."
- `turbo.json`: `build` and `dev` both `dependsOn: ["^build"]` — running `pnpm --filter @deployz/api dev` (as Playwright's `webServer` does) transitively builds every workspace dependency (`@deployz/db`, `@deployz/contracts`, `@deployz/analysis`, `@deployz/copy-map`) first, since those packages are imported from compiled `dist/`. `apps/api`'s own code runs via `tsx` (no build step for itself).
- `turbo.json`'s `test` task also `dependsOn: ["^build"]` — `pnpm vitest run` from root is expected after `pnpm build`, per `ci.yml`.
- Practical implication: any new suite that boots `@deployz/api` needs fresh `dist/` for its workspace dependencies — stale dist after a source edit is the class of bug the `artifacts.test.ts` "committed CFN artifacts match a fresh synth" guard exists to catch.
