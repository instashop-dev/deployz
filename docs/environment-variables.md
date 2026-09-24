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
   saved until the vendor saves. Unresolved required rows come first.
   Optional and uncertain rows are collapsed. The vendor can search, filter
   and bulk-classify rows.
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
   secondary. Installation is refused while a required value is missing.

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
  supplies: managed bindings (database, cache, storage, port) and
  app-internal secrets that the relay generates.
- **Set by customer** and **Managed by Deployz** are runtime only.
- A variable without a saved decision keeps the behaviour it had before
  this feature (legacy default). Existing applications keep working without
  migration.

Suggestions come from the analysis evidence (code reads, `.env.example`,
the service catalog) and show their source. Uncertain detections (sample
file only, low confidence) are marked **Uncertain**. Build-time suggestions
come from well-known name prefixes (`NEXT_PUBLIC_`, `VITE_`,
`REACT_APP_`, …). The vendor confirms them.

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

- Secret values are never returned by an API, logged, written to events or
  telemetry, or sent to an AI prompt. The CONFIG_UPDATE job payload never
  carries a value — only key names; the one plaintext-bearing response is
  the relay's authenticated `GET /api/relay/config` read.
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
