# Stage B hardening — implementation notes (Phase 0)

Plan: 100-repository Stage A follow-up ("repository analysis & configuration
hardening"). This note maps what exists on `main` (analysis version 10,
`bbc1afb`), what is still missing, and where each planned phase lands.
It is the anti-duplication map for every later phase.

Baseline at audit time: verdict accuracy 49/100, boundary accuracy 73/100
(realistic 76.3%), false rejections 12/55, false acceptances 15/45.
Open findings: COMP-005, 010, 014, 017, 021, 022, 025, 030, 031, 033
(all `MISSING_SIGNAL`). Everything else is fixed with regression tests.

## Architecture map (what exists)

- Pure pipeline: `analyseRepo(tree)` in `packages/analysis/src/analyser.ts`
  runs 14 detectors (`detectors.ts`), 18 rejection checks (`rejection.ts`),
  `assessRedis` (`redis.ts`, tiered signals + confidence), `assessPostgres`.
  Output `AnalysisResult.metadata` is the normalized evidence store.
- Verdict stack: `buildReadinessReport` (`readiness-report.ts`, findings with
  `confirmed|likely|needs_confirmation` confidence) → `evaluateCompatibility`
  (`rules.ts`) → persisted verdict. A second gate
  (`normalizeDeploymentManifest` + `evaluateManifestReadiness`, `manifest.ts`)
  runs at deployment creation and can return `NEEDS_CONFIGURATION`.
- Env-var model: `detectEnvVarModel` (`detectors.ts`) — per-var
  `{key, required, secret, source[]}` for JS/TS, Python, Ruby.
- AI: `repository-ai.ts` — `collectUnresolvedQuestions` (ambiguity gate),
  `selectAiContextFiles` (redacted bounded context), strict zod schema,
  `mergeAiAnalysis` (deterministic always wins). Gateway: `ai-gateway.ts`
  (injectable, spend limits, schema-repair retry). Wired in
  `apps/api/src/analysis.ts` `applyAiFallback`; fixture replay in
  `apps/api/src/ai-fixture.ts`.
- Configuration flow: `application_configs` table (vendor defaults + customer
  overrides) → `applicationToManifestOverrides` →
  `normalizeDeploymentManifest` → `deployments.desired_state.manifest` →
  relay install → CDK `application-stack.ts` env/secret injection.
- Infra env names today: `DATABASE_URL` (+ host/port/name/user/password),
  `databaseUrlEnvNames` prop (Documenso preset uses
  `NEXT_PRIVATE_DATABASE_URL` — existing alias precedent, synth-time only),
  Redis via `resolveRedisEnvBindings` (`REDIS_URL|HOST|PORT` or detected),
  S3 fixed set (`STORAGE_BUCKET|S3_BUCKET|AWS_S3_BUCKET|AWS_REGION`).
- Secrets: control plane stores mask only; plaintext rides SQS to the
  customer's Secrets Manager. Generators exist for install parameters
  (`randomBytes`), not for application secrets.
- Re-analysis gating: `ANALYSIS_VERSION = 10` + `analysisCommitSha` cache in
  `apps/api/src/analysis.ts`. Bump when persisted verdicts can change.
- Benchmark: `scripts/repository-compatibility/` + `pnpm benchmark:compat`;
  100 pinned repos in `benchmark.yaml`; snapshots cached under
  `.cache/` (gitignored, per-machine); `runs/` artifacts committed.

## Phase-by-phase plan

Status is at analysis version 11 (`1e6ad171`); the frozen v11 corpus run
is the phase-12 rerun artifact. The AI resolver phases 8–10 are shipped
but were unconfigured in this run, so their consumers contributed nothing
to the measured verdicts.

| Phase | Gap (existing → planned) | Module | Protected by | Status |
|---|---|---|---|---|
| 1 Evidence/ambiguity | `collectUnresolvedQuestions` returns loose strings; no typed ambiguity, no cross-detector evidence record | `packages/analysis/src/evidence.ts` (new, small): typed `AnalysisAmbiguity` + `EvidenceItem` reuse of existing findings; no parallel canonical state | new `evidence.test.ts`; existing suites must stay green | Done (`9e7df6d`) |
| 2 Binding aliases | Provisioned values land only under standard names; alias list is a synth-time CDK prop | `InfrastructureBinding` on the manifest (`contracts`), detection of app-read variable names per resource (postgres/redis/s3), persistence with analysis, CDK injection reusing `databaseUrlEnvNames`/`envBindings` machinery, vendor override in config UI | `stage-a`-style fixtures: MEMOS_DSN, PAPERLESS_*, GF_DATABASE_*, SQLALCHEMY_DATABASE_URI, CELERY_BROKER_URL, S3_ATTACHMENTS_BUCKET; e2e config spec | Done (`4f38a8e`, relay `44ac74a`) |
| 3 Required config | Helper/schema reads invisible (COMP-017): zod, envalid, Pydantic BaseSettings, JVM `@Value`, Go `os.Getenv`/envconfig, .NET Options | extend `detectEnvVarModel` per language, conservative `required` | `phase7.test.ts` + new fixture trees from COMP-017 repos | Done (`4e318b7`) |
| 4 Secret generation | No product-generated internal secrets | `generatable` classification (semantic, name+context) in env model; secure generation at deployment/relay boundary reusing install-parameter machinery; never logged/AI-prompted | new tests: generate/refuse/persist/no-log/override | Done (`2e8078b`) |
| 5 Health path | COMP-005: JS-only route detection; silent `/health` default | extend `detectHealthEndpoint` across frameworks; explicit health mode (explicit/root/vendor_required); evidence precedence + confidence | COMP-005 fixtures; readiness-report copy tests | Done (`f395218`) |
| 6 Migrations | COMP-014: package.json only; startup migrations invisible | `migration.mode = pre_deploy|startup|none|unknown`; entrypoint/start-script/Dockerfile CMD evidence; never invent commands | COMP-014 fixtures; manifest + readiness tests | Done (`aaaefa4`) |
| 7 Ports | COMP-030: no EXPOSE → null | precedence: vendor > EXPOSE > compose mapping > runtime literal > framework default (low confidence); low confidence ⇒ NEEDS_CONFIGURATION, never a guess | COMP-030 fixtures | Done (`b33ddb5`) |
| 8 AI resolver | Existing AI fills a fixed question set; needs typed ambiguity input + consolidated single request | extend `repository-ai.ts`: ambiguity-driven prompt, per-field `{value,confidence,evidencePaths,explanation}`, max 2 calls incl. repair, failure-safe | `repository-ai.test.ts`; fixture gateway | Done (`928433a`); inactive when unconfigured |
| 9 AI bindings | Deterministic aliases unresolved → AI selects semantic alias only | phase-8 resolver + confidence policy (≥0.9 auto, 0.7–0.89 prefill, else no guess) | synthetic ambiguous configs | Done (`8a95acd`); inactive when unconfigured |
| 10 AI architecture | Worker/compose/storage required-vs-optional ambiguity (COMP-010/031 residuals) | architecture requirement schema; deterministic policy still decides NOT_COMPATIBLE | COMP-010/025/031/033 reruns | Done (`8a95acd`); inactive when unconfigured |
| 11 UX | NEEDS_CONFIGURATION surfaces only as a 422 at deployment creation | readiness page hierarchy (understood → automatic → needs input → issues), generatable-secret + binding display | web unit tests + `e2e/scenario-sweep.spec.ts` | Done (`3e0514a`, specs `9cf98aa`) |
| 12 Rerun | — | `pnpm benchmark:compat` full corpus, append comparison section | harness determinism tests | Done — v11 run at `1e6ad171`; comparison appended to findings.md and final-report.md |
| 13 Fresh 20 | — | new `set: unseen2` entries, pinned SHAs, two independent ground-truth passes | new run artifact | Not started |
| 14 Hardening | — | generalizable fixes only, each with regression fixture | full analyzer suite | Done — the deterministic batch (`0a640dd`) plus the final COMP-021/COMP-025 corrections (`cee068c`, `1e6ad17`); COMP-021 accepted as a documented limitation |
| 15 Docs | — | consolidate README/findings/final-report/mvp-status/ui-system | docs link checks | Partial — findings.md, final-report.md and implementation-notes.md updated for analysis version 11; mvp-status/ui-system consolidation not in this phase |

## Deterministic finding assignment

- COMP-030 → phase 7. COMP-005 → phase 5. COMP-014 → phase 6.
  COMP-017 → phase 3.
- COMP-010 (optional compose worker) + COMP-031 (required third-party
  service) → deterministic classification in the architecture evidence
  (phase 1/10 deterministic part); AI only for true residuals.
- COMP-021 (COPY of missing artifact), COMP-022 (engine chosen by env
  value), COMP-025 (durable dir without mount), COMP-033 (dropped
  descriptors) → rejection/env analysis extensions, phase 3–7 batch.

## Version policy

One bump (10 → 11) when the deterministic batch changes persisted verdicts
(first behavior-changing phase), one further bump only if the AI resolver
changes stored analyses. UI-only and evidence-only phases do not bump.

## Non-goals (unchanged)

Workers/second services, multi-container, MySQL/Mongo/etc., EFS/persistent
local disk, Kubernetes/IaC stacks, Dockerfile generation, other clouds.
Deterministic policy keeps authority: AI interprets evidence, never policy.
