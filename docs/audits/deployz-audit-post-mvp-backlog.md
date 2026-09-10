# Post-MVP backlog — deferred audit findings

Created 2026-09-10 at the close of the audit remediation effort
(`docs/audits/deployz-full-repository-audit-2026-09-09-remediation.md`).
These items are deliberately **not implemented**; none blocks MVP launch.
Record format: audit ID, reason deferred, severity, recommended timing, dependency.

## Launch-gate actions (before first real customer install — NOT backlog)

| Action | Why | Source |
|---|---|---|
| Verify/republish the production bootstrap template (must carry the `RelayCredential` parameter from #265/#269) | New installs fail enrollment (401 `RELAY_CREDENTIAL_MISMATCH`) against a pre-Phase-4 template | Phase 4/8 |
| Run the real-AWS canary ladder (verify canary; `core` ×3 from fresh transient infra per the documented MVP gate; `resilience`; `cleanup`/`audit`) | Proves the repaired lifecycle against real AWS | Phase 8 handoff |
| Confirm production `DEPLOYABLE_AWS_REGIONS` and `BOOTSTRAP_REPUBLISH` values | Not repo-verifiable; drives region advertisement truth | DZ-AUDIT-005 |
| Stateless real-AWS install (canary B) | Operator decision: deferred post-launch; simulated coverage exists (@scenario:stateless) | Phase 8 |

## Deferred findings

| Audit ID | Sev | Finding (short) | Reason deferred | Recommended timing | Dependency |
|---|---|---|---|---|---|
| DZ-AUDIT-004 | P2 | Shared ECR repo lets customer accounts pull other tenants' images by tag guess | Materially mitigated by DZ-AUDIT-002's UUID-namespaced tags (unguessable); full fix is per-application repositories | Post-MVP (with build-pipeline work) | Per-app repo design |
| DZ-AUDIT-016 | P2 | Production AWS keys as workflow-level env in PR-triggered CI | Deliberate, documented; fork PRs receive no secrets | Near-term CI hygiene | None |
| DZ-AUDIT-021 | P3 | ECR grant read-modify-write unguarded; `policyRevision` unused | Self-heals on retry; installs are single-actor in practice | Post-MVP | None |
| DZ-AUDIT-022 | P3 | NAT + dedicated ALB dominate per-deployment cost (~$77-114/mo) | Structural per-deployment isolation decision, correct for MVP | Post-MVP cost review | Cost/positioning decision |
| DZ-AUDIT-023 | P3 | No ECR lifecycle policy; immutable tags grow storage unbounded | Vendor-account cost hygiene, not customer-facing | Soon after launch | None |
| DZ-AUDIT-025 | P3 | Dead relay token-rotation machinery | Dead code, zero runtime risk | Next cleanup pass | None |
| DZ-AUDIT-026 | P3 | Dead vocabulary (`DISCONNECTED`, `MIGRATION` job type, noop executors) | Dead code; stub comment already corrected (Phase 9) | Next cleanup pass | None |
| DZ-AUDIT-027 | P3 | No ANALYZING sweeper; killed worker strands app at "Analysing" | Manual re-analyse exists; no false state | Post-MVP | None |
| DZ-AUDIT-028 | P3 | `'***'` secret value on claim-loss + re-offer edge | Requires lost claim response AND re-offer; narrow | Post-MVP | None |
| DZ-AUDIT-029 | P3 | RESTART reports success without observing rollout | Bounded by honest heartbeats; no false HEALTHY | Post-MVP | None |
| DZ-AUDIT-030 | P3 | DESTROY stuck in DELETE_IN_PROGRESS lacks a product exit | Undocumented relay/reset two-step exists as escape | Post-MVP UX | Docs from Phase 9 |
| DZ-AUDIT-031 | P3 | INSTALLING has no timeout when app never healthy | Actionable exits exist; no false state | Post-MVP | None |
| DZ-AUDIT-034 | P3 | UI conformance: native `<select>`/`<details>`/checkbox instead of shadcn | Cosmetic conformance, accessibility preserved | With next UI work | docs/ui-system.md |
| DZ-AUDIT-035 (remainder) | P3 | Deployment-list error envelope parsing; `observedState.url` cast; deployments health column | Truthfulness part (healthy count) already fixed (Phase 6) | Post-MVP | None |
| DZ-AUDIT-036 | P3 | IAM containment notes (S3 tag scoping, two-phase IAM, public template bucket) | Documented and bounded by role trust policy | Optional | None |
| DZ-AUDIT-037 | P3 | CI: third-party actions pinned to major tags; e2e action versions drift; concurrency grouping | Hygiene | Near-term CI hygiene | None |
| DZ-AUDIT-039 | P3 | `pnpm vitest run` OOMs on Windows (scripts/* harness) | Environment-specific; workaround: per-file runs + CI (Linux) is authoritative | When Windows local runs matter | None |
