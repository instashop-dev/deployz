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

## Configuration

`DEPLOYZ_KMS_KEY_ARN` selects real AWS KMS; without it the API uses a dev
cipher stub (never in production). Redaction guarantees and KMS failure
paths are covered by the integration suite; real KMS is exercised by the
AWS canary.
