# Environment variables setup

How detected environment variables become a vendor setup task, and how
their values reach release builds and customer deployments.

## Flow

1. **Analysis** detects variable **names** (never values) from code reads,
   `.env*` sample files and the external-service catalog
   (`packages/analysis/src/detectors.ts` `detectEnvVarModel`,
   `env-classification.ts`). An analysis that completes with variables is
   not a failure. Only a pipeline error sets `analysisStatus = FAILED`.
2. **Overview** shows **Configuration needs review** when a required
   detected variable has no vendor decision, or a vendor-provided required
   value is missing. The primary action is **Review configuration**
   (`/config#environment-variables`). Repository required changes still come
   first. When customer deployments exist, the state stays and a notice is
   added.
3. **Configuration → Environment variables**: the detected names are a
   draft. Each row starts from a suggestion (marked "Suggested"). Nothing is
   saved until the vendor saves. The same table lists every other vendor
   default. Rows are grouped, all expanded and never paged: Needs
   attention, Set by vendor, Set by customer, Managed by Deployz, Optional
   and uncertain. The vendor can bulk-classify rows.
4. **Save** stores the decisions (`PUT /api/applications/:id/environment-settings`)
   and vendor values (`PUT /api/applications/:id/config`, vendor scope). The
   page then reads readiness again. Saving never runs analysis again.
   Analysis runs again only when the repository or the commit changes.
5. **Release build**: required build-time values set by the vendor gate
   release creation (`422 BUILD_CONFIGURATION_MISSING`, also for the first
   release an install link creates).
6. **Install link**: customer-provided runtime values never block creating
   or sharing a link.
7. **Customer install page**: an **Application settings** section after the
   region and before the review. It shows only customer-provided runtime
   fields, with the vendor's label and help text. The technical name is
   secondary. Installation is refused while a required value is missing. A
   blank or whitespace-only value counts as missing and is not saved. The
   vendor's decision, not the browser, says which values are secret. The page
   trims leading and trailing spaces from a plain value; a secret, and every
   vendor value, is stored exactly as typed.

## Per-variable decision

Stored in `applications.environment_settings` (jsonb, nullable). Schema and
pure evaluation: `packages/contracts/src/environment-setup.ts`.

| Field | Values |
|---|---|
| When used | `build` or `runtime` |
| Required | yes / no (always no for "Optional / not needed") |
| Secret | yes / no |
| Who provides | Managed by Deployz · Set by vendor · Set by customer · Optional / not needed |
| Label, help | Customer-facing text, for "Set by customer" only |

Rules (server-validated):
- **Managed by Deployz** is allowed only for keys that Deployz really
  supplies: managed bindings (database, cache, storage, port, a provisioned
  queue and its dead-letter queue) and app-internal secrets that the relay
  generates.
- **Set by customer** and **Managed by Deployz** are runtime only.
- A variable without a saved decision keeps the behaviour it had before
  this feature (legacy default). Existing applications keep working without
  migration.

Suggestions come from the analysis evidence (code reads, `.env.example`,
the service catalog) and show their source. Uncertain detections (sample
file only, low confidence) are marked **Uncertain**. Build-time suggestions
come from well-known name prefixes (`NEXT_PUBLIC_`, `VITE_`,
`REACT_APP_`, …). The vendor confirms them.

## Defaults, derived values and precedence

- **Sample files are evidence, not defaults.** A value in `.env.example`,
  `.env.sample` or `.env.template` names the variable, but it never reaches
  the container. It does not make a required read optional. Only a real
  (non-placeholder) value in a runtime env file (`.env`, `.env.production`)
  or an inline fallback in the code is a default.
- **Some reads are never required.** A variable the runtime source assigns
  itself (`process.env.X = ...`), a `createEnv` `runtimeEnv` pass-through
  (`KEY: process.env.KEY`), and a key that a zod schema declares
  `.optional()` or `.default()` are not required, whatever other bare reads
  exist.
- **Compose build args.** A Dockerfile `ARG NAME` with no default that a compose
  file sets under `build.args` is a required **build** variable. The compose
  value is shown as evidence (not for secret-looking names); the vendor enters
  the value.
- **Sibling apps are out of scope.** When the Dockerfile sits in `apps/<name>/`,
  reads in another `apps/<other>/` directory do not count, unless a production
  compose file (`docker-compose.yml`, `compose.yml`) or a Procfile points at it,
  or the Dockerfile names it. A sibling with only its own Dockerfile is a
  separate image (a release has one image), so it does not count. Comment
  lines and build-override compose variants are not references.
- **Boot guards make a key required.** A key that the code refuses to start
  without (`if (!env.KEY) throw`, or the same test limited only by "not in
  mode X", such as `env.DEPLOY_MODE !== "desktop" && !env.KEY`) is required,
  even when its zod schema says `.optional()`. A guard that applies only in a
  named mode (`env.CLOUD_MODE && !env.KEY`) or only outside production does
  not count. Shared `packages/*` still count. A non-secret value
  passed alone to a named converter (`Boolean(...)`, `formatBaseUri(...)`) is
  not required; `Number(...)` and `String(...)` are not converters in this sense.
- **Deployz-derived S3 values.** When Deployz provisions storage and the app
  reads an S3 region or endpoint variable in code (`S3_REGION`,
  `S3_ENDPOINT`, `S3_ENDPOINT_URL`, `AWS_S3_ENDPOINT`, `*_S3_REGION`), the
  variable is **Managed by Deployz**. `GET /api/relay/config` serves it as a
  `derived` plain value: the deployment Region, or
  `https://s3.<region>.amazonaws.com`. The template already injects
  `AWS_REGION` and the bucket names.
- **Precedence:** explicit vendor or customer value > Deployz-derived value >
  analysis evidence (sample values, suggestions). A derived value never
  replaces an explicit value.
- **The saved decision selects the source** (`deliversConfigValue`). "Set by
  vendor" delivers the vendor default, or the vendor's override for one
  customer. "Set by customer" delivers only that customer's value, never a
  vendor default. "Managed by Deployz" and "Optional / not needed" deliver no
  saved value. A value saved under an earlier decision therefore never
  overrides the new source. The preflight counts a value as provided only by
  the same rule. A key with no saved decision keeps the legacy rule: every
  saved value is delivered.
- **Generated secrets** (`mintedEnvKeys`). With a saved decision, the relay
  mints a key only when it is "Managed by Deployz" and an app-internal
  secret. Without a decision, it mints `deployz_generated` keys: a required
  secret with a generatable name, or an optional internal secret with a
  generatable name (it usually falls back to a development default). An
  optional secret such as an ACME HMAC key or an analytics project key is
  never minted: a random value turns on a feature that the app then rejects.
- **Credentials:** Deployz never creates AWS access keys or IAM users, and
  never derives a public bucket URL (`S3_PUBLIC_BASE_URL`). The AWS SDK gets
  credentials from the ECS task role through the default credential chain.
  An app that requires static keys (`S3_ACCESS_KEY_ID`) needs a vendor or
  customer value, or a code change to use the default chain.

## Where values go

Both secret paths below share one `SecretCipher` seam
(`apps/api/src/pending-secrets.ts`): a KMS-backed cipher in production
(`DEPLOYZ_KMS_KEY_ARN`, the control-plane key `alias/deployz-config-secrets`),
an in-memory stub in local dev/tests only. In AWS Lambda a missing or
invalid key fails closed; the stub is never used there. See
`docs/pending-secret-delivery.md` for the cipher contract and the
legacy-row migration. Neither path
ever returns plaintext from an API except the relay's own authenticated
`GET /api/relay/config` read.

| Value | Stored | Reaches |
|---|---|---|
| Vendor plain value | `application_configs.value` | Build: worker decrypts (trivially, not a secret) and passes it to CodeBuild as an environment var + `--build-arg NAME`. Runtime: served on `GET /api/relay/config`, applied by the post-install CONFIG_UPDATE executor. |
| Vendor secret | `application_configs.encrypted_value` — ciphertext from `SecretCipher.encrypt`, deterministic context (`organizationId` + `applicationId` + `key` + `scope: 'vendor'`, never stored) | Build: the worker decrypts with the same cipher (`listVendorValues`) before handing CodeBuild the build args. Runtime: the relay's `GET /api/relay/config` decrypts it the same way (`readVendorSecret`) and serves the plaintext over that authenticated channel only — never in a job payload. |
| Customer value (install page) | DEPLOY-027 pending-secret vault (`pending_secrets` table, see `docs/pending-secret-delivery.md`) — staged before a deployment exists, bound to a deployment once one does | The relay's `GET /api/relay/config` decrypts the bound row and applies it via the post-install CONFIG_UPDATE executor. |
| Customer override (vendor edits) | Customer-scope `application_configs` row (masked; plaintext never stored — it rides the relay write-through/pending-secret vault instead) | That customer's running deployment (CONFIG_UPDATE write-through), or the pending-secret vault when no relay can act on it yet. |

- Secret values are never returned by a vendor-facing API, logged, written
  to events or telemetry, or sent to an AI prompt. The one plaintext-bearing
  response is the relay's authenticated `GET /api/relay/config` read. One
  exception to "not in the job payload": a CONFIG_UPDATE for a deployment
  whose relay is **already connected** carries the new values through SQS
  and `deployment_jobs.payload` until the relay claims the job, after which
  the stored payload is redacted (`docs/pending-secret-delivery.md`,
  *Accepted plaintext paths*). Values for deployments without a relay go
  through the encrypted vault instead.
- A vendor secret saved before encrypted storage existed has no value that
  Deployz can deliver. The page flags it **Re-enter this secret**, and it
  does not count as provided.

## Effect of later edits

- Decisions and vendor values apply to **new release builds** (build
  values) and **new installations** (runtime values). Saving them does not
  start an update on existing customer deployments. A changed vendor
  default reaches an existing deployment only at its next configuration
  update (for example, when a customer override for it is saved).
- A customer override that the vendor edits reaches that customer's running
  deployment.
- Known gap: when a decision changes so that a value is no longer delivered,
  the value stays on a deployment that is already running. Later
  configuration passes do not apply it again, but they do not remove it.
  Remove it with the customer override editor, or reinstall.

## Security notes

- A vendor runtime secret is written into each customer's AWS account. The
  account owner can read it. Masking in the Deployz UI does not change
  this. Use **Set by customer** for values that the customer must not see,
  or for credentials that the customer owns.
- Build values are baked into the release image. Anyone who can pull the
  image can possibly read them. They are also visible in the CodeBuild build
  record in the Deployz control-plane account.

## Unsupported (post-MVP)

- Customer-provided **build** values (a per-customer build does not exist).
- Per-customer different values for a vendor-provided variable, except
  through the existing customer-override editor.
- Pushing changed vendor defaults to existing deployments.
- Detection of Dockerfile `ARG` names, and of variables read only
  indirectly (for example through a dynamic key or a config file that is
  loaded at runtime). The vendor can add these keys by hand in the values
  editor.
- Format validation beyond names ending in `_URL`/`_URI`, `_EMAIL`, `_PORT`.
