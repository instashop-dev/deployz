# Deployz AI MVP (P0/P1) — implementation record

The per-phase record for the P0/P1 AI capabilities: repository understanding,
structured requirement extraction, blocker detection, fix instructions,
failure diagnosis, error simplification, environment-variable intelligence
and the preflight gate. It follows the same conventions as
`docs/mvp-implementation-status.md`: audit first, extend what exists, one
reviewable PR per phase.

Operating principle for every phase:

> AI infers and explains. Deterministic Deployz systems provision and mutate
> AWS infrastructure.

## Phase 0 — Repository audit and gap map (2026-09-05)

The audit covered `packages/analysis`, `apps/api` (analysis, readiness gate,
config, diagnostics), `packages/relay` and the worker (failure evidence),
`packages/copy-map`, `apps/web` (readiness, configuration, deployment
detail, install and deploy-link pages), the test infrastructure, fixtures
and the existing AI documentation. Nothing was changed by the audit.

### What already exists (reuse, do not rebuild)

| Area | Where | State |
|---|---|---|
| Deterministic analysis | `packages/analysis/src/analyser.ts`, `detectors.ts`, `rejection.ts`, `redis.ts` | Live. 14 detectors, 19 rejection checks, Redis/Postgres requirement assessment, flat `detected_metadata` JSONB |
| Semantic readiness report | `packages/analysis/src/readiness-report.ts`, `rules.ts` | Live. 17 finding ids with `required`/`recommended` severity, `blocking` flag and `confirmed`/`likely`/`needs_confirmation` confidence; state READY / ALMOST_READY / NEEDS_CHANGES |
| Deployment manifest + gate | `packages/analysis/src/manifest.ts`, `apps/api/src/deploy-links.ts`, `apps/api/src/manifest.ts` | Live. `evaluateManifestReadiness` refuses deployment creation (422), install launch and relay enrolment for non-READY manifests |
| AI gateway | `packages/analysis/src/ai-gateway.ts`, `apps/api/src/ai-config.ts` | Live. Cloudflare AI Gateway via the Vercel AI SDK, strict Zod output, bounded retries, spend caps, fixture mode (`AI_FIXTURE_MODE`) |
| AI repository fallback | `packages/analysis/src/repository-ai.ts`, `apps/api/src/analysis.ts` | Live. Runs only for one of seven unresolved questions; deterministic-always-wins merge; any AI failure degrades to deterministic output |
| Commit-SHA analysis cache | `apps/api/src/analysis.ts` (`ANALYSIS_VERSION`, `isCommitShaCacheHit`) | Live |
| Fix instructions | `packages/analysis/src/fix-instructions.ts`, `POST /api/applications/:id/fix-instructions`, `apps/web/src/components/fix-instructions-dialog.tsx` | Live. Deterministic document with AI guidance per finding, guardrail text, CTA placed below the findings |
| Env-var model | `detectEnvVarModel` (`detectors.ts`), `application_configs`, `apps/web/src/app/dashboard/applications/[id]/config/page.tsx` | Live. `key/required/secret/source`; masked write-only secrets; required-env gate at deployment creation |
| Failure taxonomy | `packages/db/src/enums.ts`, `packages/copy-map/src/index.ts`, `apps/api/src/failure-classification.ts`, `packages/relay/src/deploy.ts` | Live. 23 failure codes mirrored in five places with parity tests; relay classifies at the executor boundary, the API refines coarse codes from stack events and error text |
| Sanitisation | `packages/analysis/src/redact.ts` | Live. Applied at stack-event ingest and inside every AI prompt builder |
| AI failure diagnosis | `packages/analysis/src/diagnostic-explainer.ts`, `apps/api/src/ai-explanation.ts`, `GET /api/deployments/:id/diagnostics` | Live. Deterministic what/why/fix for every known code; AI only for `UNKNOWN`; cached per job with single-flight claim |
| Jargon boundary | `packages/copy-map`, `docs/ui-system.md`, ESLint rule in `eslint.config.mjs` | Live. Raw CloudFormation/ECS text reaches vendor UI only behind "Advanced details" / "Technical detail" disclosures; customer surfaces get translated phrases |
| Test corpus | `packages/analysis/test/*`, `apps/api/src/github.ts` fixture repos, `docs/testing/repository-compatibility/` (100 pinned repositories, Documenso = repo-006) | Live |

### Gap matrix

| Capability | Existing | Partial | Missing | Changes needed (phase) |
|---|---|---|---|---|
| Runtime detection | | ✓ | | `manifest.runtime` is `node` or `unknown`; no language detector. Add a deterministic runtime detector (Node, Python, Ruby, Go, JVM, .NET, PHP, Elixir, Rust) from manifests and the Dockerfile base image (1) |
| Build command | ✓ | | | `detectBuildCommand` (package.json only). Expose with source and evidence (1) |
| Start command | ✓ | | | `detectStartupCommand` (Dockerfile CMD/ENTRYPOINT, `scripts.start`). Expose with source and evidence (1) |
| Port | ✓ | | | `detectPort` six-tier cascade. Expose with source and evidence (1) |
| Bind address | | | ✓ | No localhost-binding detector. Add `detectBindAddress` and the `localhost-binding` finding (1, 2) |
| DB | ✓ | | | `assessPostgres` with evidence. Expose in the canonical view (1) |
| Redis | ✓ | | | `assessRedis` with confidence, purpose, evidence. Expose in the canonical view (1) |
| Storage | ✓ | | | `detectLocalFilesystem` (declared state only) and `detectS3`. Expose in the canonical view (1) |
| Health endpoint | ✓ | | | `detectHealthEndpoint`. Expose with source and evidence (1) |
| Migrations | | ✓ | | Node tools only. Expose in the canonical view; framework label (1) |
| Env vars | | ✓ | | Model has `required`/`secret`/`source`, no classification, no aliasing, no description. Add `classification` (Deployz-managed, Deployz-generated, customer-required, optional, unknown) and the split UI (4) |
| Canonical analysis | | ✓ | | Storage is a flat JSONB record; per-field evidence and confidence exist only for Postgres and Redis. Add one typed `ApplicationAnalysis` projection built at analysis time and served on the readiness endpoint (1) |
| Compatibility blockers | ✓ | | | Severity/blocking model and stable ids exist. Add the findings the deployment gate enforces but the report never shows (`port-unresolved`, `start-command-missing`) and the new `localhost-binding` finding; show detected facts on the readiness page (2) |
| Fix guidance | ✓ | | | Regenerated on every request. Add a cache keyed on commit SHA, analysis version and the finding set (3) |
| Failure diagnosis | ✓ | | | AI output is `what/why/fix` with no confidence. Add `confidence` and the low-confidence wording; keep AI limited to `UNKNOWN` (7) |
| Error simplification | ✓ | | | Vendor and customer surfaces already translate. Audit the remaining interpolated raw values (release build failure text names CodeBuild; admin progress card) (8) |
| Preflight | | ✓ | | The manifest gate runs at three boundaries, but the required-env check runs only at creation and there is no preflight endpoint or pre-deploy summary. Add one `evaluatePreflight` used by all three boundaries and by a `GET .../preflight` route with a UI summary (5) |
| Error normalisation | ✓ | | | `refineFailureCode` + `StructuredEvent` + redaction. Add a regional-artifact mismatch mapping if a code fits without a new enum value; otherwise record the mapping table (6) |

### Architectural decisions

1. **No second analysis pipeline.** `runApplicationAnalysis` stays the only
   orchestrator. The canonical `ApplicationAnalysis` is a typed projection
   built from the same detector output at persist time and stored beside the
   flat metadata (`detected_metadata.application`). The flat keys keep
   feeding the manifest, contract fields and the compatibility benchmark
   unchanged.
2. **Keep the existing severity vocabulary.** `required` + `blocking` is the
   spec's BLOCKER, `required` alone is its WARNING, `recommended` is its
   RECOMMENDATION. Renaming would churn copy-map, the web mirror and the E2E
   suite for no user-visible gain. The eligibility states map as READY →
   READY (with recommended findings → READY_WITH_WARNINGS), ALMOST_READY →
   ACTION_REQUIRED, NEEDS_CHANGES → UNSUPPORTED.
3. **No new failure codes unless a live producer exists.** Adding a code
   touches five mirrors and a Postgres enum migration. Phase 6 maps new
   signatures onto existing codes first.
4. **Generated secrets stay deterministic.** The Documenso preset already
   generates its auth secrets per install with `crypto.randomBytes`. Phase 4
   generalises that path; the LLM never produces a secret value.
5. **AI stays behind the readiness endpoint and the diagnostics endpoint.**
   No LLM call per lifecycle event, no LLM call on the deploy button when
   the commit SHA and analysis version are unchanged.
6. **Persistence stays in `detected_metadata` and `deployment_jobs`.** No
   new tables; a new column is added only if a JSONB field cannot carry the
   data safely.

### Duplication risks noted

- `apps/web/src/lib/readiness.ts` mirrors the analysis types by hand and
  `apps/web/src/lib/diagnostic-vocabulary.ts` mirrors copy-map; every new
  field must be added on both sides and covered by the parity tests.
- Two readiness evaluations exist by design (semantic report vs manifest
  gate). Phase 2 and Phase 5 align them rather than merging them.
- Contract-field vendor edits (`PATCH /api/applications/:id`) do not rebuild
  the stored readiness report; Phase 2 must keep the page and the gate
  consistent after an edit.

### Verification

Baseline on the merge base (`ee7aa01`): `pnpm build` passed (9 tasks);
`pnpm vitest run` recorded below in the Phase 1 entry. No production
behaviour changed in Phase 0.
