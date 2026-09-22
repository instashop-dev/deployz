# Regional HTTPS certificates — design and implementation notes

Status: implementation in progress (branch `claude/regional-https-certificates`).

## Goal

Replace the per-deployment ACM certificate with one persistent wildcard
certificate per **customer + AWS account + region**, reused by every
deployment in that scope, requested lazily right after the bootstrap stack
enrolls and **in parallel** with infrastructure provisioning.

```text
Customer namespace       c-<scope>.deployz.dev
Regional ACM certificate *.c-<scope>.deployz.dev        (one per customer+account+region)
Deployment URL           https://d-<deploymentId>.c-<scope>.deployz.dev
```

Out of scope, by decision: Route 53, CloudFront, Cloudflare proxying of the
new records, Origin CA, ACME, imported private keys, changes to the
application CloudFormation templates.

## Phase 1 — audit findings (the dependency chain today)

Read together with `docs/mvp-default-https-status.md` and
`docs/deployment-resilience.md`.

- The bootstrap stack and its relay are **per deployment**. Two deployments
  for one customer in one AWS account and region are two bootstrap stacks and
  two relays. ACM certificates are account+region scoped, so any relay in the
  scope can describe and attach a certificate another relay requested — if IAM
  allows it.
- Today every deployment gets its own certificate for `d-<id>.deployz.dev`,
  requested by the relay's `CONFIGURE_DOMAIN` executor, tagged
  `deployz:installation=<installationId>`. IAM scopes every ACM action to that
  tag, so a sibling relay cannot even describe it. The routing record is a
  **proxied** Cloudflare CNAME; the ACM DNS-01 validation record is unproxied.
- HTTPS is serialized after infrastructure for structural reasons, not ACM
  ones: the machine (`apps/api/src/default-https.ts`) only starts after INSTALL
  succeeds, only advances on the 5-minute relay heartbeat, and each of the
  three state transitions costs a full poll round trip. That is the
  "3–4 polls ≈ 35 minutes" first-deployment cost.
- `deployment_jobs.deployment_id` is NOT NULL; there is no customer-scoped job.
  `CONFIGURE_DOMAIN`/`REMOVE_DOMAIN` are outside the one-active-mutating-job
  index, so a certificate job can run concurrently with INSTALL without
  touching that invariant.
- The relay executes a poll's commands sequentially in one invocation and
  never polls ACM internally; the SSM pending marker (4 KB) only checkpoints
  the deferred INSTALL/DESTROY/PURGE work.
- The purge sweep deletes every certificate tagged with the deployment's
  installation id. DESTROY never touches ACM.
- No `default_https.*` event family exists; the only timestamps are the
  write-once `stepTimings`.

## Decisions

1. **Customer scope** — a new `customers.dns_scope` column: 12 lowercase hex
   characters minted at row creation (SQL default from `gen_random_uuid()`),
   unique, never changed. Not derived from email or company. Existing
   customers are backfilled by the migration. The DNS label is `c-<dns_scope>`.
2. **Hostname generation is centralized** in `@deployz/contracts`
   (`packages/contracts/src/hostnames.ts`): `customerScopeLabel`,
   `regionalCertificateDomain`, `scopedDeploymentHostname`, parsers, and the
   legacy `d-<id>.<zone>` helpers. `apps/api`, `apps/web`, `scripts/*` and
   `e2e/*` import from there; no other string construction of these names.
3. **Regional TLS state** — new table `customer_regional_certificates`, one
   row per `(customer_id, aws_account_id, region)` (unique index). Columns:
   `certificate_domain`, `certificate_arn`, `certificate_status`
   (`REQUESTING | DNS_VALIDATION_PENDING | ISSUED | ERROR`; no row = not
   created), `validation_record_name/value/type`, `cloudflare_record_id`,
   `last_verified_at`, `last_error`, `requested_at`,
   `validation_dns_ready_at`, `issued_at`, `check_cycle`, `attempts`, audit
   fields. The row insert (`ON CONFLICT DO NOTHING` on the scope key) is the
   lock that makes concurrent first deployments converge on one record.
4. **Two new relay job types**, both outside the one-active-job index like the
   domain jobs and both never touching `deployments.state` on failure:
   - `ENSURE_CERTIFICATE` — payload `{ certificateDomain, customerScope,
     certificateArn?, idempotencyToken }`. The relay: describe the given ARN
     (NotFound → treat as absent) → else list certificates for the domain
     that carry `deployz:customer-scope=<scope>` and adopt one → else
     `RequestCertificate` (DNS validation, `IdempotencyToken`, tags
     `deployz:customer-scope`, `deployz:installation` (the requester),
     `deployz:component=regional-tls`, `deployz:managed-by=deployz`) → wait
     up to ~30 s for the validation record → return
     `{ certificateArn, certificateStatus, validationRecordName?,
     validationRecordValue?, validationRecordType?, failureReason? }`.
   - `ATTACH_CERTIFICATE` — payload `{ certificateArn, hostname }`. The relay
     finds its own ALB by tag, creates the 443 listener with the ARN (or adds
     the certificate to an existing listener), tags the listener, flips 80 to
     a 301 redirect, and returns `{ routingTarget, httpsConfigured: true,
     listenerArn? }`.
   The INSTALL payload may also carry `regionalCertificateArn`; when present
   and the certificate is ISSUED, the install executor attaches it right
   after the stack succeeds, saving one poll round trip. The pending marker
   keeps the ARN through compaction.
5. **Certificate deletion rides PURGE.** The purge payload carries
   `regionalCertificates: [{ certificateArn }]` only when the purged
   deployment is the last non-DELETED deployment in its scope. The relay's
   purge executor deletes those ARNs (NotFound tolerated, `ResourceInUse`
   retried). The purge sweep never deletes certificates tagged
   `deployz:customer-scope`. Existing legacy per-deployment certificates keep
   the existing REMOVE_DOMAIN/purge-sweep behaviour.
6. **IAM** (`packages/cdk/src/bootstrap/bootstrap-stack.ts`): new
   `CustomerScope` template parameter (default `none`), passed through the
   Quick Create URL as `param_CustomerScope` and into the relay as
   `DEPLOYZ_CUSTOMER_SCOPE`. The relay's permissions boundary is a single
   managed policy already close to the IAM 6,144-character quota, so the
   change adds exactly one statement: `acm:DescribeCertificate` and
   `acm:DeleteCertificate` with `aws:ResourceTag/deployz:customer-scope =
   <CustomerScope>`. The request itself goes through the existing
   installation-scoped `acm:RequestCertificate` statement: the regional
   certificate is tagged `deployz:installation=<requesting installation>` as
   well as `deployz:customer-scope`, `deployz:component=regional-tls` and
   `deployz:managed-by=deployz`. The requester therefore manages it through
   its installation tag and every sibling through the scope tag. The purge
   sweep never deletes a certificate that carries a `deployz:customer-scope`
   tag, whatever its installation tag says. `acm:ListCertificates` and
   `acm:ListTagsForCertificate` are already condition-free. ELBv2 statements
   are unchanged (each relay only ever touches its own ALB). The default
   `none` can never equal a real scope, so an unscoped installation's
   statement matches nothing.
7. **Flow selection (backwards compatibility).** The relay reports
   `customerScope` and the capability `regionalCertificate` in its identity.
   At enrollment the control plane uses the regional flow only when the
   reported scope equals the customer's `dns_scope`; otherwise the legacy
   `d-<id>.deployz.dev` flow runs unchanged. A deployment's `default_https`
   JSON carries `mode: 'regional' | 'legacy'`; a missing `mode` is legacy.
   Existing live deployments are grandfathered: nothing renames their
   hostnames or touches their certificates.
8. **Deployment DNS is DNS-only (unproxied).** Cloudflare Universal SSL only
   covers one label below the zone, so a proxied `d-x.c-y.deployz.dev` record
   cannot terminate TLS at the edge. The browser talks to the ALB directly and
   the wildcard certificate is the serving certificate (end-to-end TLS).
9. **READY for regional deployments** requires `default_https.status ===
   'ACTIVE'`, which the control plane sets only after its HTTPS probe of the
   real hostname succeeds (DNS resolves, TLS handshake, hostname matches,
   health path returns an accepted response) on top of the existing HEALTHY
   gate. Legacy deployments keep the existing CONFIGURING rule.

## The regional flow

```text
relay enrolls (bootstrap ready)
   ├─ ensureRegionalCertificate(scope)  → row upsert → ENSURE_CERTIFICATE job
   └─ INSTALL job (already queued)
relay poll: ENSURE_CERTIFICATE first (seconds), then INSTALL (deferred, resumes)
ENSURE result → persist ARN/status → write validation CNAME (DNS-only, exact
   record, conflict = ERROR with diagnostics) → if not ISSUED, queue the next
   ENSURE (re-describe) for the next poll
INSTALL success → albReadyAt; write d-<id>.c-<scope> CNAME → ALB (DNS-only);
   if certificate ISSUED → ATTACH_CERTIFICATE (or the install executor already
   attached it when the payload carried the ARN)
certificate ISSUED (later) → ATTACH_CERTIFICATE for every deployment in the
   scope waiting for it
ATTACH result → status CONFIGURING, httpsListenerReadyAt → probe on the
   result and on every heartbeat → ACTIVE (httpsFirstSuccessAt) → READY
```

The control-plane driver (`runDefaultHttpsCheck`) reconciles the same steps
on every heartbeat, so a crash, a retry, a browser refresh or a relay
reconnect only resumes; it never requests a second certificate while one is
stored. Drift: a stored ARN that no longer exists → new request in place
(`ERROR`/`ISSUED` → `REQUESTING`, attempts bumped); a missing validation CNAME
is re-upserted on every cycle; a modified listener is repaired by ATTACH
(describe-first); ACM `FAILED` (CAA, terminal) → `ERROR` with the ACM reason,
retryable through the existing retry route; a slow `PENDING_VALIDATION` stays
in progress with a "taking longer than usual" hint after 30 minutes and only
becomes `ERROR` (`VALIDATION_TIMEOUT`) after 4 hours.

## Telemetry

`default_https` JSON (regional mode) records `bootstrapReadyAt`,
`albReadyAt`, `httpsListenerReadyAt`, `deploymentDnsCreatedAt`,
`deploymentDnsResolvedAt`, `httpsFirstSuccessAt`; the certificate row records
`requested_at`, `validation_dns_ready_at`, `issued_at`; `target_healthy_at` is
`deployments.last_health_at` and `deployment_ready_at` is the READY step
timing. Event family `default_https.*` (certificate_requested,
validation_dns_ready, certificate_issued, certificate_failed, listener_ready,
dns_created, active, failed, certificate_removed) with `deploymentId`,
`customerId` and a payload of `{ awsAccountId, region, certificateArn,
certificateDomain }`. Structured logs use `request.log` with the same fields.

## UX

Customer and vendor status payloads carry `httpsProgress`: the state, the
mode, three sub-steps (`CERTIFICATE_REQUESTED`, `DOMAIN_VERIFICATION_CONFIGURED`,
`WAITING_FOR_READY`) and a `slow` flag. The TLS rung reads "Preparing secure
access"; a first regional deployment shows the three sub-steps and the note
"This AWS step can occasionally take several minutes. No action is
required."; a deployment that reuses an issued certificate moves through the
rung quickly. A terminal failure renders the rung in the attention state (no
spinner) with the existing "Retry HTTPS setup" action. Raw AWS detail
(certificate ARN, validation record, timestamps) stays in the vendor's
Advanced details.

## Verification plan (Phase 14)

Small controlled test against the deployed control plane and test account
151955775369 using `scripts/version-canary`:

- A: first deployment (fresh customer) — one certificate request, validation
  record created, overlap of certificate and infrastructure, HTTPS on the
  scoped hostname, no duplicate certificate, timings captured.
- B: second deployment, same customer and region — same ARN, no new request,
  no new validation record, faster HTTPS.
- C: new region — a second certificate row, same namespace, deployment OK.
- D: recovery — delete the regional certificate out of band; the next
  cycles request a replacement and the deployment returns to ACTIVE.

All test resources are removed afterwards (Disconnect, Purge, bootstrap
stacks, Cloudflare records, ECR tags).
