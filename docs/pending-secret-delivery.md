# Pending-secret delivery — threat model and sequence (DEPLOY-027)

How a secret a customer enters *before* the relay connects reaches the
running application. Closes DEPLOY-027 ("secret values typed before the
customer's relay connects never reach the install, and minted replacements
ignore the application's format").

## Threat model

**Defend against:**

- **Control-plane DB attacker** — `pending_secrets` holds KMS ciphertext
  only; the key never lives in the database.
- **Stolen relay bearer token / hostile relay** — the KMS encryption context
  binds organization + deployment + key, so one deployment's ciphertext
  cannot be replayed as another's; values are served only over the
  authenticated relay channel (`GET /api/relay/config`).
- **Control-plane insiders / log and event readers** — plaintext never
  enters `event_logs`, job payloads, API responses, logs, or errors. Proven
  by redaction tests (`apps/api/src/pending-secret-delivery.integration.test.ts`).
- **SQS/queue readers** — pre-relay values do not ride SQS at all; the
  write-through enqueue is skipped when no deployment can receive the value.

**Accept (documented trade-offs):**

- Relay-host compromise (the relay legitimately receives plaintext and
  writes it into the customer's own Secrets Manager — the trust boundary in
  `docs/deployment-resilience.md`).
- Vendor-account compromise (the vendor owns the configuration).
- Loss of a value whose delivery waited longer than the TTL — surfaced as
  `unboundSecretKeys`; the customer re-enters it.
- KMS-key compromise (standard AWS key custody, out of scope).

## Storage

`pending_secrets` (`packages/db/src/schema/pending-secrets.ts`, migration
`0045`): `ciphertext` + `encryption_context` (the exact KMS AAD), `key`,
scope (`organization_id`, `application_id`, `customer_id?`,
`deployment_id?`), `expires_at` (default 24 h, `DEFAULT_PENDING_SECRET_TTL_MS`),
and delivery metadata (`delivered_at`, `delivered_deployment_id`,
`delivery_attempts`). Unique staged index `(application_id, customer_id,
key) WHERE deployment_id IS NULL`; unique bound index `(deployment_id, key)`.

## Sequence

```text
customer types secret (confirm or config save)
→ KMS-encrypt with the scope context (ciphertext only persists)
→ staged row (no deployment yet) OR bound rows (pre-relay deployments)
→ deployment created
→ staged rows materialize into bound rows (deployment context) — outside the tx
→ relay enrollment → INSTALL with task count 0 when configuration is pending
→ relay fetches effective config (GET /api/relay/config)
→ control plane decrypts bound rows ONLY in that response, stamps delivery
→ CONFIG_UPDATE applies the value into the customer's Secrets Manager
→ relay ack (job result) → bound rows deleted
→ DEPLOY_RELEASE / normal task count — no task starts unconfigured
```

## Expiry and cleanup

- The watchdog tick (`packages/cdk/src/lambda/worker.ts`) sweeps expired
  rows — pure SQL, no decryption. After expiry the customer must re-enter
  the value.
- Bound rows are deleted on CONFIG_UPDATE success, DESTROY success
  (including the never-installed path), force-complete, and PURGE success.
- Lost acks are safe: rows survive until the real settlement; the executor
  is idempotent and a late duplicate result is ignored.

## Cipher contract

`SecretCipher` (`apps/api/src/pending-secrets.ts`) is the only code that
touches plaintext. One function selects it for both Lambdas:
`createSecretCipherFromEnv`.

| Where | `DEPLOYZ_KMS_KEY_ARN` | Cipher |
|---|---|---|
| AWS Lambda (`AWS_LAMBDA_FUNCTION_NAME` set) | valid key ARN | KMS |
| AWS Lambda | absent, empty, or not a key ARN | **throws**. The API fails INIT, so the deploy readiness check fails. The worker fails only the work that needs a secret, and its watchdog continues to run. |
| Local dev / tests | absent | stub (no confidentiality) |
| Local dev / tests | set | KMS (an invalid ARN throws) |

- **KMS format:** `kms1:` + base64(KMS `CiphertextBlob`). The cipher uses
  direct `Encrypt`/`Decrypt` (no envelope), so the plaintext limit is 4096
  bytes. Both write paths refuse a larger value with
  `SECRET_VALUE_TOO_LARGE`. The KMS cipher refuses to decrypt a value
  without the `kms1:` prefix, so it never delivers a legacy stub value.
- **Stub format (local only):** `enc:<base64 context>:<base64 plaintext>`.
  Anyone who can read the value can reverse it.
- **Encryption context:** the caller's scope context plus a fixed
  `purpose: deployz-config-secret` that the cipher adds. Callers never pass
  `purpose`. The only allowed keys are `scope`, `organizationId`,
  `applicationId`, `customerId`, `deploymentId`, and `key`
  (`CONFIG_SECRET_KMS_CONTEXT_KEYS`). Each value is an opaque ID or an
  env-var name. CloudTrail logs the context, so it never contains a secret
  or an email.
  - Vendor secret: `{organizationId, applicationId, key, scope: 'vendor'}`.
    The code computes it again at read time and does not store it.
  - Pending secret: `{organizationId, applicationId, key, customerId[, deploymentId]}`.
    It is stored in `pending_secrets.encryption_context`.
- **IAM:** the API and worker roles have only `kms:Encrypt` and `kms:Decrypt`
  on this one key. The condition requires `kms:EncryptionContext:purpose`
  and allows only the context keys in the list above.

## KMS key

`ConfigSecretsKey` in the control-plane stack
(`packages/cdk/src/deployz-stack.ts`) is a symmetric customer-managed key.
It has automatic rotation and the alias `alias/deployz-config-secrets`. Its
ARN is the stack output `ConfigSecretsKeyArn`. Its deletion and replace
policies are both `RETAIN`. All stored values are unreadable without this
key, so:

- Do not change the construct ID. A new ID creates a new key, and the rows
  encrypted with the old key become unreadable.
- A stack delete does not delete the key. Do not schedule key deletion
  while a `kms1:` row exists (see the inventory below).
- Rotation keeps the old key material, so old ciphertext still decrypts.

**If KMS becomes unavailable**, or the key is disabled or access is denied:

- Config save fails with `502 CONFIG_WRITE_FAILED`. Nothing is stored.
- The relay config fetch leaves the value out and keeps the row. It logs
  only IDs. The next relay cycle tries again.
- The build worker leaves the value out of the build variables.
- Deployment creation fails if staged rows cannot materialize.

No path falls back to the stub or returns plaintext. When KMS is available
again, delivery continues. A pending row that is still undelivered after its
24-hour expiry must be entered again.

## Legacy rows and rollout

Before this fix, production had no key. Both Lambdas used the stub, so the
stored "ciphertext" was reversible base64. The fix shipped in three phases,
and CI deployed each phase:

1. **Key only.** Create the key and the IAM grants, and add the count-only
   inventory log (`watchdog:config-secret-inventory`). There is no runtime
   change.
2. **Switch and migrate.** The stack passes `DEPLOYZ_KMS_KEY_ARN` to both
   Lambdas. New writes are `kms1:`. Each delivery path refuses a legacy
   value. Each watchdog tick (every 15 minutes) runs
   `migrateLegacyConfigSecrets` (`apps/api/src/legacy-secret-migration.ts`)
   and logs `watchdog:legacy-secret-migration` counts:
   - A vendor `enc:` row is decoded with its computed context and encrypted
     again with KMS. The write is conditional on the old ciphertext, so a
     concurrent vendor edit wins.
   - An active pending `enc:` row is encrypted again with its stored
     context and the same conditional write. The row keeps its expiry, so a
     delivery in progress continues.
   - A row that cannot be decoded (malformed, or a context mismatch) is not
     delivered. For a vendor row, `encrypted_value` becomes `NULL`. The
     config page then shows **Needs re-entry**, and readiness does not count
     the key. A pending row is deleted. The key then shows as unbound, and
     the customer enters the value again.
   - An expired pending row is not migrated. Reads already refuse it, and
     the expiry sweep deletes it.
   - Each batch has a maximum of 100 rows per table. You can run the
     migration again safely, and it continues from where it stopped. It
     logs only counts. It never logs a value, an ID, or error text.
   - Between the deploy and the first tick (a maximum of 15 minutes), a
     legacy value is left out of builds and relay fetches. It is never
     delivered through the stub.
3. **Retire legacy.** When the inventory shows `stub` = 0 for vendor rows
   and for active pending rows, remove the migration module and the
   worker's `kms:Encrypt` grant. After that, no production code can decode
   the stub format. The worker now has only `kms:Decrypt`.

**Production result (2026-09-24).** Before Phase 2, the inventory showed
these rows:
- vendor secrets: 1 `stub` and 1 `none` (a legacy row that already needed
  re-entry)
- customer-scope ciphertext: 0
- `pending_secrets`: 0 rows

The first Phase 2 tick recorded these counts:
- vendor: 1 migrated, 0 unusable, 0 skipped, 0 failed
- pending: 0

The next inventory recorded these counts:
- vendor: 1 `kms1` and 1 `none`
- `stub`: 0

The `none` row needs vendor re-entry. It already needed re-entry before
this fix, and the fix did not change it.

The inventory log (`watchdog:config-secret-inventory`) stays on as a
count-only monitor. A `stub` or `other` count greater than zero in
production is a defect.

**Recovery.** If the Phase 2 deploy check fails, CI stops. A stack
rollback restores the previous Lambda code and environment, and the key
stays. After the migration runs, the migrated rows are `kms1:`, and only
the KMS cipher can read them. Thus, do not roll back to code from before
Phase 2 after the migration has run. Fix forward.

**Vendor re-entry.** Open the application's environment configuration and
enter the secret again. The new value is written in `kms1:` format.

## Prior exposure

Re-encryption protects the values from now on. It does not undo the
exposure that occurred before. Before the migration, anyone with read
access to one of these could decode each legacy value:

- the production database
- its snapshots and automated backups (7-day retention)
- query logs
- a copy of any of these

Deployz does not rotate external credentials automatically. Rotate the
underlying vendor or customer credential if one of these conditions is true:

- A person outside the operator team had access to the database, a
  snapshot, a backup, or a log that contained such a row.
- A database dump or export was shared or kept outside the account.
- The credential has a high impact (for example, a payment or
  cloud-provider key), and you cannot exclude such access.

The automated backups from before the migration contain the legacy values
until they expire (7 days after the migration). Manual snapshots keep them
until someone deletes the snapshots.
