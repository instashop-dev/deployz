# Documenso Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Deployz install run the real Documenso application: built by the Deployz pipeline, installed with secure runtime config, healthy behind the ALB, and served over HTTPS on a custom domain known before install.

**Architecture:** Extend `ApplicationStack` with a minimal configurable container contract (port, health path, plain env, NoEcho-parameter-backed ECS secrets, secret-backed database URL). Add a Documenso preset in `packages/cdk` and shared parameter names in `@deployz/contracts`. Populate the existing INSTALL `parameters` payload channel from the control plane. Fix the CodeBuild context for `docker/Dockerfile` repos. No manifest framework, no generic CONFIG_UPDATE.

**Tech Stack:** aws-cdk-lib (TypeScript), Fastify API, Drizzle, Vitest (`Template.fromStack` + `Match`), pnpm/turbo.

## Global Constraints

- CLAUDE.md: smallest necessary change; match existing style; no unrelated refactors; no dead code, placeholders, or redundant comments.
- Write the failing test first (`Template.fromStack` + `Match` style for CDK).
- Documenso only — do NOT build: customer config UI, generic app manifest, generic CONFIG_UPDATE, post-install domain changes, signing-certificate support, migration orchestration.
- The DB password must never appear in plaintext in: ECS environment, CloudFormation parameters, logs, or task definitions.
- If IAM grants change, update `apps/web/src/lib/security-details.ts` in the same commit (test-locked). Current design needs NO IAM change — flag it loudly if one becomes necessary.
- `pnpm build` before any synth/publish script (they import `dist`).
- Documenso facts (verified 2026-08-27 against documenso/documenso@main): Remix/React Router 7 + Hono server; port 3000 (`PORT` env, listens 0.0.0.0); health `/api/health` returns 200 for ok/warning (missing cert = warning), 500 only when DB unreachable; runtime image `node:22-alpine3.22` + openssl, **no curl**; build context = **repo root** with `-f docker/Dockerfile`; `docker/start.sh` runs `npx prisma migrate deploy` before boot (no exit-code gate); `NEXT_PRIVATE_DATABASE_URL` required at boot, `NEXT_PRIVATE_DIRECT_DATABASE_URL` required by migrate; `NEXTAUTH_SECRET`/encryption keys/SMTP are lazy (not boot-blocking); `NEXT_PUBLIC_WEBAPP_URL` is runtime (not baked); `NEXT_PUBLIC_BASE_PATH` is a build ARG defaulting to `""`.

---

### Task 1: Configurable container contract in ApplicationStack

**Files:**
- Modify: `packages/cdk/src/application/application-stack.ts`
- Test: `packages/cdk/test/application-stack.test.ts`

**Interfaces:**
- Produces on `ApplicationStackProps`: `containerPort?: number` (default 3000), `healthCheckPath?: string` (default `'/health'`), `containerEnvironment?: Readonly<Record<string, string>>`, `secretParameters?: readonly SecretParameterSpec[]`, `healthCheckShellCommand?: string`, `taskCpu?: number` (default 256), `taskMemoryMiB?: number` (default 512), `startupGracePeriodSeconds?: number` (default 60, container `startPeriod`; when explicitly set, also sets `healthCheckGracePeriod` on the Fargate service).
- Produces exported type:

```ts
/** One install-time NoEcho parameter surfaced to the container as an ECS secret. */
export interface SecretParameterSpec {
  /** CfnParameter construct id. Must use the `param_` prefix (M17 NoEcho invariant). */
  readonly parameterId: string;
  /** JSON key inside the app config secret that stores the parameter value. */
  readonly secretKey: string;
  /** Environment variable name injected into the container at task start. */
  readonly envName: string;
}
```

- [ ] **Step 1: Write failing tests** in `application-stack.test.ts` (use the existing `synth(false, extraProps)` helper):
  - `containerPort`/`healthCheckPath` reach the task definition port mapping, `PORT` env, container health-check command, and the `AppTargets` target group `HealthCheckPath` — in BOTH listener branches: synth once with `{ containerPort: 4000, healthCheckPath: '/api/health' }` (no cert → HTTP listener branch) and once adding `certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test'` (HTTPS branch). Assert `template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/api/health', Port: 4000 })` in each.
  - `containerEnvironment: { FOO: 'bar' }` appears in the App container `Environment` list (`Match.arrayWith([{ Name: 'FOO', Value: 'bar' }])`).
  - `secretParameters: [{ parameterId: 'param_TestSecret', secretKey: 'testSecret', envName: 'TEST_SECRET' }]` produces: a template parameter `paramTestSecret` with `NoEcho: true` and `Default: ''`; the app config secret's `SecretString` referencing it; an ECS `Secrets` entry `{ Name: 'TEST_SECRET', ValueFrom: Match.stringLikeRegexp('.*:testSecret::') }`.
  - `healthCheckShellCommand: 'node -e "x"'` replaces the curl command in the container `HealthCheck.Command`.
  - `taskCpu: 512, taskMemoryMiB: 1024` reach `AWS::ECS::TaskDefinition` `Cpu: '512'`, `Memory: '1024'`.
  - `startupGracePeriodSeconds: 300` reaches container `HealthCheck.StartPeriod: 300` and `AWS::ECS::Service` `HealthCheckGracePeriodSeconds: 300`; when the prop is absent the service has NO `HealthCheckGracePeriodSeconds` property.
  - Defaults unchanged: existing tests (port 3000, `/health`, param list `['paramAppApiKey','paramAppSigningSecret']`, snapshot) keep passing without edits in this task.
- [ ] **Step 2: Run the new tests, verify they fail** (`pnpm --filter @deployz/cdk exec vitest run test/application-stack.test.ts`).
- [ ] **Step 3: Implement** in `application-stack.ts`:
  - Resolve `const containerPort = props.containerPort ?? APP_PORT;` and `const healthCheckPath = props.healthCheckPath ?? HEALTH_CHECK_PATH;` next to the other prop defaults; replace every use of `APP_PORT`/`HEALTH_CHECK_PATH` below that point (both express and Fargate branches, target groups, `PORT` env) with the resolved values.
  - Create one `CfnParameter` per `secretParameters` entry alongside the two existing ones (`type: 'String', noEcho: true, default: ''`). Extend `appSecret.secretObjectValue` with `[spec.secretKey]: SecretValue.cfnParameter(param)` entries.
  - Inject `containerEnvironment` and the per-spec ECS secrets into the app container, the express `primaryContainer`, and the worker container — same parity pattern as `redisEnvEntries`.
  - Health-check command: `props.healthCheckShellCommand ?? `curl -f http://localhost:${containerPort}${healthCheckPath} || exit 1``.
  - `taskCpu`/`taskMemoryMiB`/`startupGracePeriodSeconds` apply to the plain-Fargate web task/service only (document "plain-Fargate only" in the prop JSDoc; the published template is always plain Fargate).
- [ ] **Step 4: Run the full file's tests, verify pass.**
- [ ] **Step 5: Commit** `feat(cdk): configurable container contract on ApplicationStack`.

---

### Task 2: Secret-backed database URL

**Files:**
- Modify: `packages/cdk/src/application/application-stack.ts`
- Test: `packages/cdk/test/application-stack.test.ts`

**Interfaces:**
- Produces on `ApplicationStackProps`: `databaseUrlEnvNames?: readonly string[]` — env var names that each receive the complete PostgreSQL URL as an ECS secret (Documenso needs the same URL under two names).
- Produces public member: `readonly databaseUrlSecret?: Secret`.

- [ ] **Step 1: Write failing tests:**
  - With `databaseUrlEnvNames: ['NEXT_PRIVATE_DATABASE_URL', 'NEXT_PRIVATE_DIRECT_DATABASE_URL']`: a second `AWS::SecretsManager::Secret` exists whose `SecretString` is a `Fn::Join` containing `postgresql://deployz_app:`, a `{{resolve:secretsmanager:` dynamic reference to the DB secret's `password` key, the DB endpoint attribute, and `:5432/deployz?sslmode=require`; the app container has ECS `Secrets` entries for both names whose `ValueFrom` is that secret's ARN (whole-value, no JSON key suffix); the template JSON, serialized, contains NO `DATABASE_PASSWORD`-style plaintext of the password (the only password references are `{{resolve:secretsmanager:...}}` dynamic references); the task execution role and task role policies grant `secretsmanager:GetSecretValue` on the URL secret.
  - Without the prop: no second secret, template byte-count of secrets unchanged (existing resource count assertions still pass).
  - `DatabaseSecret` `GenerateSecretString` has `ExcludePunctuation: true` (replaces the `ExcludeCharacters` assertion — a password embedded in a URL userinfo must stay free of URL-reserved characters, which is a superset of the four RDS-forbidden ones).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement:**
  - Change the `DatabaseSecret` generator to `excludePunctuation: true`, delete `excludeCharacters` and the now-unused `RDS_FORBIDDEN_PASSWORD_CHARACTERS` const; rewrite the comment: alphanumeric-only because the password is embedded in a `postgresql://` URL (URL-reserved characters would corrupt it, and percent-encoding cannot happen inside a CloudFormation dynamic reference) and RDS forbids `/@" ` anyway.
  - After the `DatabaseInstance` block:

```ts
if (databaseRequired && (props.databaseUrlEnvNames?.length ?? 0) > 0) {
  this.databaseUrlSecret = new Secret(this, 'DatabaseUrlSecret', {
    description:
      'Complete PostgreSQL connection URL for the customer application. ' +
      'Assembled at deploy time from the generated master credentials — ' +
      'the password never appears in the template or task definition.',
    secretStringValue: SecretValue.unsafePlainText(
      `postgresql://${DB_USER}:${this.databaseSecret!.secretValueFromJson('password').unsafeUnwrap()}@${this.database!.instanceEndpoint.hostname}:${DB_PORT}/${DB_NAME}?sslmode=require`,
    ),
  });
}
```

  - Grant read to `taskExecutionRole` and `taskRole`; add `this.databaseUrlSecret` to the three tag loops; inject `EcsSecret.fromSecretsManager(this.databaseUrlSecret)` under each name in app, express, and worker containers (same parity as Task 1).
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** `feat(cdk): secret-backed PostgreSQL URL injection`.

---

### Task 3: Documenso preset, shared parameter names, publish threading

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/cdk/src/application/documenso.ts`
- Modify: `packages/cdk/src/application/index.ts`, `packages/cdk/src/quick-create/publish.ts`, `packages/cdk/scripts/publish-application.mjs`
- Test: `packages/cdk/test/application-stack.test.ts` (or a new `documenso-preset.test.ts`), regenerate `packages/cdk/test/__snapshots__/application-stack.test.ts.snap` and `packages/cdk/artifacts/*.json`

**Interfaces:**
- Produces in contracts:

```ts
/**
 * CloudFormation parameter logical ids for Documenso runtime config in the
 * published application template. The API install-parameters builder and the
 * CDK Documenso preset must use the same names — CloudFormation rejects a
 * CreateStack call that names a parameter the template does not declare.
 */
export const DOCUMENSO_PARAMETERS = {
  publicUrl: 'paramPublicUrl',
  nextauthSecret: 'paramNextauthSecret',
  encryptionKey: 'paramEncryptionKey',
  encryptionSecondaryKey: 'paramEncryptionSecondaryKey',
  smtpTransport: 'paramSmtpTransport',
  smtpHost: 'paramSmtpHost',
  smtpPort: 'paramSmtpPort',
  smtpUsername: 'paramSmtpUsername',
  smtpPassword: 'paramSmtpPassword',
  smtpFromAddress: 'paramSmtpFromAddress',
  smtpFromName: 'paramSmtpFromName',
} as const;
```

- Produces in `documenso.ts` (CfnParameter id `param_X` synthesizes to logical id `paramX` — same rule as the existing `param_AppApiKey`):

```ts
import type { ApplicationStackProps } from './application-stack.js';

/**
 * Container contract for the Documenso application (documenso/documenso).
 * Verified against upstream main, 2026-08-27:
 * - Hono server on PORT (default 3000), health at /api/health (200 for
 *   ok/warning — a missing signing certificate is a warning, not an error).
 * - The runtime image has node but NOT curl, so the container health check
 *   shells out to node's fetch.
 * - docker/start.sh runs `prisma migrate deploy` before the server starts;
 *   a fresh install migrates an empty database, so the health checks get a
 *   long start period.
 * - NEXT_PRIVATE_DATABASE_URL boots the app; NEXT_PRIVATE_DIRECT_DATABASE_URL
 *   is what `prisma migrate deploy` reads. Both carry the same URL here.
 */
export const DOCUMENSO_APPLICATION_PROPS = {
  containerPort: 3000,
  healthCheckPath: '/api/health',
  healthCheckShellCommand:
    `node -e "fetch('http://localhost:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"`,
  taskCpu: 512,
  taskMemoryMiB: 1024,
  startupGracePeriodSeconds: 300,
  databaseUrlEnvNames: ['NEXT_PRIVATE_DATABASE_URL', 'NEXT_PRIVATE_DIRECT_DATABASE_URL'],
  containerEnvironment: {
    NEXT_PUBLIC_BASE_PATH: '',
    NEXT_PRIVATE_INTERNAL_WEBAPP_URL: 'http://localhost:3000',
  },
  secretParameters: [
    { parameterId: 'param_PublicUrl', secretKey: 'publicUrl', envName: 'NEXT_PUBLIC_WEBAPP_URL' },
    { parameterId: 'param_NextauthSecret', secretKey: 'nextauthSecret', envName: 'NEXTAUTH_SECRET' },
    { parameterId: 'param_EncryptionKey', secretKey: 'encryptionKey', envName: 'NEXT_PRIVATE_ENCRYPTION_KEY' },
    { parameterId: 'param_EncryptionSecondaryKey', secretKey: 'encryptionSecondaryKey', envName: 'NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY' },
    { parameterId: 'param_SmtpTransport', secretKey: 'smtpTransport', envName: 'NEXT_PRIVATE_SMTP_TRANSPORT' },
    { parameterId: 'param_SmtpHost', secretKey: 'smtpHost', envName: 'NEXT_PRIVATE_SMTP_HOST' },
    { parameterId: 'param_SmtpPort', secretKey: 'smtpPort', envName: 'NEXT_PRIVATE_SMTP_PORT' },
    { parameterId: 'param_SmtpUsername', secretKey: 'smtpUsername', envName: 'NEXT_PRIVATE_SMTP_USERNAME' },
    { parameterId: 'param_SmtpPassword', secretKey: 'smtpPassword', envName: 'NEXT_PRIVATE_SMTP_PASSWORD' },
    { parameterId: 'param_SmtpFromAddress', secretKey: 'smtpFromAddress', envName: 'NEXT_PRIVATE_SMTP_FROM_ADDRESS' },
    { parameterId: 'param_SmtpFromName', secretKey: 'smtpFromName', envName: 'NEXT_PRIVATE_SMTP_FROM_NAME' },
  ],
} satisfies Partial<ApplicationStackProps>;
```

- Produces on `SynthesizeApplicationOptions`: `readonly preset?: 'documenso'` — when set, `DOCUMENSO_APPLICATION_PROPS` is spread into the stack props. `publish-application.mjs` reads `APP_PRESET` (optional; only `documenso` valid, anything else exits 1 with a message).

- [ ] **Step 1: Write failing tests:**
  - Synthesize with `...DOCUMENSO_APPLICATION_PROPS`: template parameter names contain exactly `Object.values(DOCUMENSO_PARAMETERS)` plus `paramAppApiKey`/`paramAppSigningSecret` — this is the lockstep test tying contracts to the template; every parameter is `NoEcho: true` (extend the existing invariant test to a preset synth).
  - Documenso health path `/api/health` appears in: container `HealthCheck.Command` (node command), target group `HealthCheckPath` — in both cert/no-cert branches (reuse Task 1 pattern with preset props).
  - `NEXT_PUBLIC_BASE_PATH` with `Value: ''` present in container env.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** contracts const, preset file, barrel export, `synthesizeApplicationStack` preset spread, `APP_PRESET` in the publish script (echo the chosen preset in its log output).
- [ ] **Step 4: Run tests; regenerate committed artifacts:** `pnpm --filter @deployz/cdk run build && pnpm --filter @deployz/cdk run synth:app && pnpm --filter @deployz/cdk run synth:bootstrap`, re-run the full cdk suite so the snapshot updates deliberately (`vitest run -u` for the snapshot test only after eyeballing the diff: expected changes are ExcludePunctuation and nothing image-related).
- [ ] **Step 5: Commit** `feat(cdk): Documenso application preset and publish threading`.

---

### Task 4: Control-plane INSTALL parameters

**Files:**
- Create: `apps/api/src/install-parameters.ts`
- Modify: `apps/api/src/server.ts` (relay/register INSTALL job at ~line 2495; retry-install payload at ~line 2046)
- Test: `apps/api/test/install-parameters.test.ts` (new; follow the existing api test setup for a db-backed route test — look at how `retry-install` or domains routes are tested)

**Interfaces:**
- Produces:

```ts
import { randomBytes } from 'node:crypto';
import { DOCUMENSO_PARAMETERS } from '@deployz/contracts';

/**
 * Builds the CloudFormation parameter values for an INSTALL job (§31).
 * Phase 1: the runtime-v1 template is Documenso-shaped, so every install
 * receives these; unrelated images simply ignore the injected env vars.
 * - publicUrl comes from the deployment's custom domain and MUST exist
 *   before INSTALL — the app cannot learn its URL later (no CONFIG_UPDATE).
 *   When no domain exists the key is omitted and the template default ('')
 *   applies; do not install a URL-dependent app that way.
 * - Auth/encryption secrets are generated per install and travel only
 *   through the job payload into NoEcho parameters and Secrets Manager.
 * - SMTP parameters are declared in the template but not yet populated —
 *   vendor config supplies them in a later phase.
 */
export async function buildInstallParameters(
  db: Db,
  deploymentId: string,
): Promise<Record<string, string>>;
```

- Generated values use `randomBytes(32).toString('base64url')`. The custom-domain query: earliest `customDomains` row for the deployment with `removedAt IS NULL`; value `https://${hostname}`.

- [ ] **Step 1: Write failing tests:**
  - With a seeded deployment + custom domain: result has `paramPublicUrl === 'https://docs.example.com'`, and `paramNextauthSecret`/`paramEncryptionKey`/`paramEncryptionSecondaryKey` each match `/^[A-Za-z0-9_-]{43}$/`; two calls produce different secrets; no SMTP keys present.
  - Without a domain: no `paramPublicUrl` key.
  - Route test: relay register on a `NOT_INSTALLED` deployment creates an INSTALL job whose `payload.parameters` carries those keys; retry-install keeps `recovery.neverInstalled` AND adds `parameters`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the builder; wire `payload: { parameters: await buildInstallParameters(db, deployment.id) }` at both job-creation sites (retry keeps its recovery key).
- [ ] **Step 4: Run the api test suite, verify pass** (`pnpm --filter @deployz/api exec vitest run` — adjust filter name to the actual package name in `apps/api/package.json`).
- [ ] **Step 5: Commit** `feat(api): supply Documenso runtime parameters on INSTALL`.

---

### Task 5: Build pipeline — repo-root context and bigger builder

**Files:**
- Modify: `packages/cdk/src/pipeline/build-pipeline.ts` (buildspec), `packages/cdk/src/lambda/worker.ts` (`buildRelease`), `packages/cdk/src/deployz-stack.ts` (BuildPipeline props at ~line 122)
- Test: the existing suites covering these (find them: grep `BuildPipeline`/`buildRelease` under `packages/cdk/test`)

**Interfaces:**
- Buildspec: `export BUILD_CONTEXT=${BUILD_CONTEXT:-$(dirname "$DOCKERFILE_PATH")}` — an explicit `BUILD_CONTEXT` env var from `startBuild` wins; the dirname fallback keeps PR #33 behavior.
- `buildRelease`: when `dirname(dockerfilePath) === 'docker'`, pass `{ name: 'BUILD_CONTEXT', value: '.' }`. A `docker/` directory is the convention for a repo-root-context Dockerfile (Documenso: `docker build -f docker/Dockerfile .`), unlike `backend/Dockerfile` whose context is `backend/`. Implement as a small exported pure function (e.g. `resolveBuildContext(dockerfilePath: string): string | undefined` returning `'.'` or `undefined`) so it is unit-testable.
- `deployz-stack.ts`: pass `computeType: ComputeType.MEDIUM, timeoutMinutes: 60` to `BuildPipeline` — Documenso's monorepo image build exceeds the SMALL (3 GB) builder.

- [ ] **Step 1: Write failing tests:** `resolveBuildContext('docker/Dockerfile') === '.'`, `resolveBuildContext('Dockerfile') === undefined`, `resolveBuildContext('backend/Dockerfile') === undefined`; buildRelease passes `BUILD_CONTEXT` env only for the `docker/` case (extend existing buildRelease dep-injection tests); buildspec string contains the override form; DeployzStack template has the CodeBuild project with `ComputeType: BUILD_GENERAL1_MEDIUM` and `TimeoutInMinutes: 60`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run affected suites, verify pass;** regen any deployz-stack snapshot.
- [ ] **Step 5: Commit** `feat(pipeline): repo-root build context for docker/ Dockerfiles; larger builder`.

---

### Task 6: Docs, full validation

**Files:**
- Create: `docs/superpowers/specs/2026-08-27-documenso-serving-design.md`
- Modify: none beyond regenerated artifacts/snapshots if stale

- [ ] **Step 1: Write the design doc** (Simplified Technical English: short sentences, active voice). Record: the container contract; the secret-backed DB URL (and why the password alphabet is alphanumeric); the parameter lockstep between `DOCUMENSO_PARAMETERS`, the preset, and the API builder; the build-context rule; and this limitation, verbatim intent: **Phase 1 requires the custom hostname BEFORE install. The final HTTPS URL is passed at install time as `paramPublicUrl`. To change the domain after install, you must reinstall the deployment. Do not install a URL-dependent application without its domain.** Also record: SMTP parameters are declared but unpopulated in Phase 1; generated auth/encryption secrets transit the job payload (same channel future vendor config will use).
- [ ] **Step 2: Full validation:** `pnpm build && pnpm lint && pnpm vitest run` at repo root; regenerate `synth:app`/`synth:bootstrap` artifacts after the final build and commit any diff.
- [ ] **Step 3: Commit** `docs(spec): Documenso serving design and phase-1 domain limitation`.

---

### Task 7: PR, CI, merge, production deploy (orchestrator-led)

- [ ] Push branch, open PR against `main`; confirm CI runs are created (Actions stalled 2026-08-26, resolved 2026-08-27 — re-verify with `gh run list --limit 3`).
- [ ] CI green → merge → confirm `deploy-api` workflow deploys (watch for the api.deployz.dev health poll step) — the control plane MUST NOT be deployed by hand (CI-only gate).

### Task 8: Live proof (orchestrator-led)

- [ ] Preflight: identify control-plane vs test-customer AWS accounts; check the GitHub App (`deployz-dev`, id 4703462) still authenticates (memory: stale Actions secrets reverted it once); check `BOOTSTRAP_TEMPLATE_URL` repo variable.
- [ ] Fork `documenso/documenso` into the vendor org (the GitHub App can only see repos it is installed on), grant the App access to the fork, connect it in Deployz, run analysis, confirm `detectedMetadata.dockerfilePath === 'docker/Dockerfile'`.
- [ ] Create a release; watch CodeBuild; confirm `releases.image_digest` records a `sha256:` digest.
- [ ] `pnpm build`, then `APP_PRESET=documenso APP_IMAGE_REPOSITORY=<ecr-uri> APP_IMAGE_DIGEST=sha256:<digest> pnpm --filter @deployz/cdk run publish:application`; republish bootstrap with the printed URL; update the `BOOTSTRAP_TEMPLATE_URL` repo variable and re-run deploy-api.
- [ ] Create customer + deployment; add the custom domain (e.g. `documenso.deployz.dev`) BEFORE install; create the bootstrap stack in the test account from the install link's Quick Create parameters; watch the relay INSTALL; drive the domain to ACTIVE (Cloudflare DNS records DNS-only, both validation CNAME and hostname CNAME to the ALB).
- [ ] Evidence for the final report: `aws elbv2 describe-target-health ...` showing `healthy`, and `curl -i https://<domain>/` showing the real Documenso response (sign-in page, not fixture/blank/error).

## Self-Review Notes

- Spec coverage: contract (T1), health path everywhere (T1/T3), runtime env + parameters channel (T3/T4), secure DB URL (T2), domain-known-before-install + docs (T4/T6), build/publish/live (T5/T7/T8). IAM: no grant changes expected; T2 keeps secret creation inside the CFN execution role's existing `PROVISION_*` scope.
- The "both ALB target groups" requirement maps to one `AppTargets` group across two mutually exclusive listener branches; tests cover both branches, and the post-install HTTPS listener reuses the same group.
- Types consistent: `SecretParameterSpec` (T1) is what `DOCUMENSO_APPLICATION_PROPS` (T3) uses; `DOCUMENSO_PARAMETERS` (T3) is what `buildInstallParameters` (T4) keys on.
