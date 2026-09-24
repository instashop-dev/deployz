# Secrets and KMS — config secrets and pending-secret delivery

How Deployz stores secret configuration values, how a secret a customer
enters *before* the relay connects reaches the running application, and the
threat model behind both. Code: `apps/api/src/pending-secrets.ts` (the only
code that touches plaintext), `apps/api/src/config.ts`,
`packages/cdk/src/deployz-stack.ts` (the key and IAM). The overall
configuration flow is in [`environment-variables.md`](environment-variables.md);
the trust boundary summary is in [`architecture.md`](architecture.md#secrets-and-configuration-values).

## What is encrypted

| Value | Table | Encryption context |
| --- | --- | --- |
| Vendor secret values | `application_configs.encrypted_value` | `{ organizationId, applicationId, key, scope: 'vendor' }`, recomputed at read time |
| Customer secret values typed before the relay connects | `pending_secrets.ciphertext` | `{ organizationId, applicationId, key, customerId[, deploymentId] }`, stored on the row |

Both use the same cipher and the same key. Deployz-generated secrets are
minted by the relay inside the customer account and never enter the control
plane. Customer values typed once the relay is connected are delivered
directly (see *Accepted plaintext paths*).

## Cipher contract

`createSecretCipherFromEnv` selects the cipher for both Lambdas from
`DEPLOYZ_KMS_KEY_ARN`:

| Where | `DEPLOYZ_KMS_KEY_ARN` | Cipher |
| --- | --- | --- |
| AWS Lambda (`AWS_LAMBDA_FUNCTION_NAME` set) | valid key ARN | KMS |
| AWS Lambda | absent, empty, or not a key ARN | **throws**. The API fails initialization, so the deploy readiness check fails. The worker fails only the work that needs a secret; its watchdog keeps running. |
| Local development and tests | absent | stub (`enc:<base64 context>:<base64 plaintext>`, no confidentiality) |
| Local development and tests | set | KMS (an invalid ARN throws) |

- **Format:** `kms1:` + base64(KMS `CiphertextBlob`), direct `Encrypt` /
  `Decrypt` (no envelope), so a value is at most 4096 bytes; both write
  paths refuse larger values with `SECRET_VALUE_TOO_LARGE`. The KMS cipher
  refuses to decrypt anything without the `kms1:` prefix, so a legacy stub
  value can never be delivered in production.
- **Encryption context:** the caller's scope context plus a fixed
  `purpose: deployz-config-secret` that the cipher adds. Allowed keys:
  `scope`, `organizationId`, `applicationId`, `customerId`, `deploymentId`,
  `key` (`CONFIG_SECRET_KMS_CONTEXT_KEYS`). Every value is an opaque id or a
  variable name; CloudTrail logs the context, so it never contains a secret
  or an email.
- **IAM:** the API role has `kms:Encrypt` and `kms:Decrypt`; the worker role
  has `kms:Decrypt` only. Both are conditioned on
  `kms:EncryptionContext:purpose` and on the allowed context keys.
- **Where encryption happens:** the API only (config save; re-encryption of
  staged rows into bound rows when a deployment is created).
- **Where decryption happens:** the API, in the authenticated
  `GET /api/relay/config` response (bound pending rows and vendor secrets)
  and when staged rows materialize at deployment creation; the worker, for
  vendor build-time values passed to CodeBuild.

## The key

`ConfigSecretsKey` (`alias/deployz-config-secrets`) is a symmetric
customer-managed key with automatic rotation, `RemovalPolicy.RETAIN` for
both deletion and replacement, exported as the stack output
`ConfigSecretsKeyArn` and injected into both Lambdas as `DEPLOYZ_KMS_KEY_ARN`.
Every stored value is unreadable without it:

- Never change the construct id; a new id is a new key and every existing
  row becomes unreadable.
- A stack delete does not delete the key. Never schedule key deletion while
  a `kms1:` row exists.
- Rotation keeps old key material, so old ciphertext still decrypts.
- Fixes go forward: the legacy stub rows were migrated once (2026-09-24) and
  the migration module was removed; code from before the migration cannot
  read `kms1:` rows.

**If KMS is unavailable**, or the key is disabled, or access is denied:
config save fails with `502 CONFIG_WRITE_FAILED` and nothing is stored; the
relay config fetch omits the value, keeps the row, logs only ids and retries
next cycle; the build worker omits the value; deployment creation fails if
staged rows cannot materialize. No path falls back to the stub or returns
plaintext. A pending row still undelivered at its 24-hour expiry must be
entered again.

**Monitoring:** the worker's 15-minute inventory
(`watchdog:config-secret-inventory`) logs counts only, per format
(`none` / `stub` / `kms1` / `other`) and age bucket. A `stub` or `other`
count greater than zero in production is a defect.

## Pending-secret delivery (DEPLOY-027)

A secret typed before the relay connects is staged, bound to the deployment
when it exists, delivered once through the authenticated relay channel, and
deleted on acknowledgement.

**Storage:** `pending_secrets` (`packages/db/src/schema/pending-secrets.ts`):
`ciphertext`, `encryption_context`, `key`, scope columns
(`organization_id`, `application_id`, `customer_id?`, `deployment_id?`),
`expires_at` (24 hours, `DEFAULT_PENDING_SECRET_TTL_MS`), and delivery
metadata (`delivered_at`, `delivered_deployment_id`, `delivery_attempts`).
Unique staged index `(application_id, customer_id, key) WHERE deployment_id IS NULL`;
unique bound index `(deployment_id, key)`.

```text
customer types secret (invitation confirm or config save)
→ KMS-encrypt with the scope context; ciphertext only persists
→ staged row (no deployment yet) OR bound rows (pre-relay deployments)
→ deployment created → staged rows re-encrypted into bound rows (deployment context)
→ relay enrollment → INSTALL with desired count 0 when configuration must precede the first start
→ relay fetches effective config (GET /api/relay/config); the API decrypts bound rows in that response and stamps delivery
→ CONFIG_UPDATE writes the value into the customer's Secrets Manager secret
→ relay result → bound rows deleted
→ auto-deploy of the newest READY release scales the service up
```

**Cleanup:** bound rows are deleted on CONFIG_UPDATE success, PURGE
success, a never-installed disconnect, and force-complete; the watchdog
deletes expired rows with pure SQL. A normal relay DESTROY success does not
delete them; they expire by TTL. Lost acknowledgements are safe: rows
survive until the real settlement, the executor is idempotent, and a late
duplicate result is ignored.

## Threat model

**Defended against:**

- **Control-plane database attacker** — the tables hold KMS ciphertext
  only; the key never lives in the database; backups and snapshots taken
  after the migration are ciphertext.
- **Stolen relay bearer token or hostile relay** — the encryption context
  binds organisation, deployment and key, so one deployment's ciphertext
  cannot be replayed as another's; values are served only over the
  authenticated relay channel.
- **Log, event and API readers** — plaintext never enters `event_logs`,
  API responses, logs or errors (redaction tests:
  `apps/api/src/secret-delivery.integration.test.ts`).
- **Queue readers, for pre-relay values** — a value staged before the relay
  exists never rides SQS.

**Accepted (documented trade-offs):**

- Relay-host compromise: the relay legitimately receives plaintext and
  writes it into the customer's own Secrets Manager.
- Vendor-account compromise: the vendor owns the configuration.
- Loss of a value that waited longer than the TTL, surfaced as
  `unboundSecretKeys`; the customer re-enters it.
- KMS key compromise (standard AWS key custody).

**Accepted plaintext paths** (not KMS-protected; know them before extending
the threat model):

1. A CONFIG_UPDATE for a deployment whose relay is **already connected**
   carries the plaintext values through SQS (server-side encrypted, 3-day
   dead-letter retention) and `deployment_jobs.payload` until the relay
   claims the job, at which point the payload is redacted. If the relay is
   offline the plaintext stays in the row until claim.
2. The generated secret parameters of an INSTALL payload, until claim.
3. The relay credential in `deployments.relay_credential`, until the relay
   first registers (then nulled).
4. Vendor build-time secret values, passed to CodeBuild as plaintext
   environment overrides and readable by anyone with
   `codebuild:BatchGetBuilds` in the Deployz account.

## Prior exposure (history)

Before 2026-09-24 production had no key and stored values in the reversible
stub format. Anyone who could read the production database, its automated
backups (7-day retention), a manual snapshot or a query log before the
migration could decode those values; automated backups from before the
migration contain them until they expire. Rotate a vendor or customer
credential if such access by anyone outside the operator team cannot be
excluded, especially for high-impact credentials. The migration re-encrypted
one vendor row; one legacy row that already needed re-entry still does
(the config page shows **Needs re-entry**).
