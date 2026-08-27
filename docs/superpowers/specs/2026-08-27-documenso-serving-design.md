# Documenso serving design

**Date:** 2026-08-27
**Status:** implemented (Phase 1)

## Purpose

This document explains how Deployz serves the Documenso application. It
covers the container contract, the database URL, the parameter lockstep,
the build context rule, and one known limitation.

## Documenso facts

These facts came from the `documenso/documenso` repository on 2026-08-27.

- Documenso runs a Remix / React Router 7 app with a Hono server.
- The server listens on port 3000.
- The health endpoint is `/api/health`. It returns HTTP 200 for both `ok`
  and `warning` states. A missing signing certificate produces a `warning`,
  not an error. The endpoint returns HTTP 500 only when the database probe
  fails.
- The runtime image has `node`. It does not have `curl`.
- `docker/start.sh` runs `npx prisma migrate deploy` before the server
  starts.
- The Docker build context is the repository root. The build uses
  `-f docker/Dockerfile`.
- `NEXT_PUBLIC_WEBAPP_URL` is a runtime setting, not a build-time setting.
- `NEXT_PUBLIC_BASE_PATH` is a build ARG. It defaults to an empty string.
  An official-style build serves the app at the root path.

These facts drove four design decisions, described below.

## 1. Container contract

`ApplicationStack` had a hardcoded contract: port 3000, health path
`/health`, a curl-based health check, a fixed task size, and a fixed
startup grace period. Documenso needs different values for most of these.

`ApplicationStackProps` now accepts optional overrides:

- `containerPort` (default 3000)
- `healthCheckPath` (default `/health`)
- `containerEnvironment` — plain environment variables
- `secretParameters` — NoEcho CloudFormation parameters injected as ECS
  secrets
- `healthCheckShellCommand` — replaces the curl command
- `taskCpu` / `taskMemoryMiB`
- `startupGracePeriodSeconds`

All defaults match the old hardcoded values. A stack that does not pass
these props synthesizes to the same template as before.

Documenso needs a non-default health check because the runtime image has
no `curl`. The container health check runs a Node command instead. It
calls `fetch('http://localhost:3000/api/health')` and exits 0 or 1 based
on the response.

Documenso also needs a long startup grace period. `docker/start.sh` runs a
database migration before the server starts. A fresh install migrates an
empty database. `DOCUMENSO_APPLICATION_PROPS` sets
`startupGracePeriodSeconds: 300` so the health check does not fail the
task during migration.

## 2. Secret-backed database URL

Documenso needs the full PostgreSQL connection URL under two environment
variables: `NEXT_PRIVATE_DATABASE_URL` (used at boot) and
`NEXT_PRIVATE_DIRECT_DATABASE_URL` (used by `prisma migrate deploy`).

`ApplicationStackProps` gained `databaseUrlEnvNames`. When set, the stack
creates a second Secrets Manager secret, `DatabaseUrlSecret`. The stack
assembles the URL at deploy time using a CloudFormation dynamic reference
to the database secret's password field. The password never appears in
plaintext in the template, in a CloudFormation parameter, or in the task
definition. The URL secret is injected as an ECS secret under each name in
`databaseUrlEnvNames`.

The URL ends with `?sslmode=require`. The managed RDS instance forces SSL
connections.

`databaseUrlEnvNames` requires a managed database. Synth throws a clear
error when the prop is set but `databaseRequired` is false.

### Why the password is alphanumeric-only

The database password generator used to exclude four RDS-forbidden
characters (`excludeCharacters`). It now excludes all punctuation
(`excludePunctuation: true`).

The password sits inside the URL as CloudFormation assembles it with a
dynamic reference (`{{resolve:secretsmanager:...}}`). CloudFormation
resolves a dynamic reference as a plain string substitution. It does not
percent-encode the resolved value. A password with a URL-reserved
character (for example `/`, `@`, `:`, `?`, `#`) would corrupt the
assembled URL. An alphanumeric-only password avoids every URL-reserved
character. This is a strict superset of the four characters RDS itself
forbids.

## 3. Parameter lockstep

Three places must agree on the same set of CloudFormation parameter
names:

1. `DOCUMENSO_PARAMETERS` in `@deployz/contracts` — the single naming
   authority. It maps a short key (for example `publicUrl`) to a
   CloudFormation logical id (for example `paramPublicUrl`).
2. `DOCUMENSO_APPLICATION_PROPS` in `packages/cdk/src/application/documenso.ts`
   — the CDK preset. It declares one `secretParameters` entry per
   `DOCUMENSO_PARAMETERS` value, plus the SMTP parameters. Each entry
   becomes a NoEcho `CfnParameter` in the published template.
3. `buildInstallParameters` in `apps/api/src/install-parameters.ts` — the
   API builder. It emits install-time parameter values keyed on
   `DOCUMENSO_PARAMETERS`.

A template test asserts that the published template's parameter set
matches `Object.values(DOCUMENSO_PARAMETERS)` exactly (plus the two
pre-existing app parameters). This test catches drift between the
contract and the preset.

The API and the CDK preset do not share a build step. Lockstep depends on
publishing the template and deploying the API from the same commit. A
commit that changes `DOCUMENSO_PARAMETERS` must publish a new template and
deploy the API together.

`synthesizeApplicationStack` accepts an optional `preset` option. The
value `'documenso'` spreads `DOCUMENSO_APPLICATION_PROPS` into the stack
props. The publish script reads this from the `APP_PRESET` environment
variable. Synth without a preset produces the same template as before —
the preset is opt-in.

## 4. Build context for `docker/`-style Dockerfiles

The build pipeline used to derive the Docker build context from the
Dockerfile's own directory (`dirname($DOCKERFILE_PATH)`). This matches a
`backend/Dockerfile` convention, where the build context is `backend/`.

Documenso's Dockerfile is different. It lives at `docker/Dockerfile`, but
the build context is the repository root
(`docker build -f docker/Dockerfile .`).

The buildspec now honors an explicit `BUILD_CONTEXT` environment variable
when `startBuild` supplies one. It falls back to the dirname rule
otherwise. `buildRelease` calls `resolveBuildContext(dockerfilePath)`. This
function returns `.` when the Dockerfile's own directory is exactly
`docker`, and `undefined` otherwise. A nested `foo/docker/Dockerfile` does
not match this rule — only a top-level `docker/` directory does.

The CodeBuild project also moved from SMALL to MEDIUM compute, with a
60-minute timeout (was 30 minutes). Documenso's monorepo image build
exceeds the SMALL builder's 3 GB memory and could approach the old
timeout.

## Install-time parameters

`buildInstallParameters(db, deploymentId)` runs at every INSTALL job
creation, both for a fresh relay registration and for a retried install
after failure recovery.

- `NEXTAUTH_SECRET`, `NEXT_PRIVATE_ENCRYPTION_KEY`, and
  `NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY` are generated per install with
  `randomBytes(32).toString('base64url')`. They travel through the job
  payload, into NoEcho CloudFormation parameters, and into Secrets
  Manager in the customer account. They do not appear anywhere else.
- `NEXT_PUBLIC_WEBAPP_URL` (`paramPublicUrl`) comes from the deployment's
  active custom domain at install time: `https://<hostname>`. When no
  domain exists yet, the key is omitted and the template default (an
  empty string) applies.
- SMTP parameters (`paramSmtpTransport`, `paramSmtpHost`, and so on) are
  declared in the template. Phase 1 does not populate them. Deployz has no
  vendor configuration UI yet. Email stays disabled until a later phase
  adds one. The generated auth and encryption secrets transit the same job
  payload channel that future vendor config will use.

## No IAM change

This work does not change any IAM grant. The CloudFormation execution
role's existing `PROVISION_*` actions already cover creating the new
`DatabaseUrlSecret`. The test-locked security disclosures in
`apps/web/src/lib/security-details.ts` are unchanged.

## Known limitation: domain must exist before install

Phase 1 requires the custom hostname before install. The final HTTPS URL
is passed at install time as `paramPublicUrl`. To change the domain after
install, you must reinstall the deployment. Do not install a
URL-dependent application without its domain.

This limitation exists because Deployz has no `CONFIG_UPDATE` command yet
for Documenso. `NEXT_PUBLIC_WEBAPP_URL` reaches the container only through
an install-time CloudFormation parameter. There is no channel to change it
after `CREATE_COMPLETE` without recreating the stack.
