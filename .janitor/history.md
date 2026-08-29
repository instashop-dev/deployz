# Repository Janitor History

This file records completed repository-hardening runs and important deferred findings.

Keep entries compact. Do not use this as a detailed changelog.

## Initial State

No janitor run has been completed yet.

The first run should:

1. Establish the current Git commit as the baseline.
2. Perform the initial three-phase hardening:
   - Repository hygiene
   - Structural hardening
   - Guardrails
3. Run the full verification suite.
4. Record the completed commit range and meaningful findings below.
5. Update `.janitor/state.json`.

---

## Run History

### 2026-08-29

Reviewed: initial full-repository hardening at `6fa4111` (no prior checkpoint).

Cleanup:
- cdk: deleted three dead re-export barrels (`src/analysis/analyser.ts`, `detectors.ts`, `rejection.ts` — zero importers), removed unused deps `ai` + `@ai-sdk/openai-compatible` (analysis declares its own), deduplicated `toMessage` (`integration/runner.ts` now imports from `teardown.ts`), removed doc-only export `_LARGE_REPO_STREAMING_NOTE` in `pipeline/source-fetch.ts`.
- relay: extracted the 3x-duplicated `relay:command-executed` log block in `src/index.ts` into `logCommandExecuted`.
- analysis: `redis.ts` now imports `parsePackageJsons` from `detectors.ts` instead of a byte-identical copy.
- contracts: removed leftover `PACKAGE_NAME` scaffold export and its tautological test.
- api: removed dead exports `StripeClient` and `BillableDeployment` (`billing.ts`).
- web: removed orphaned `ROLE_DESCRIPTIONS`; unexported 8 symbols with zero external importers (`Me`, `OnboardingState`, `GithubSetupInput/Route`, `HostRouteInput/HostRoute`, `GithubStateSources`, `activeDeployments`, `InstallData`, `SETUP_STEPS`).
- AGENTS.md: fixed malformed `#$` heading.

Structure:
- api: `ReadyCheck`/`AttentionCheck`/`UnsupportedCheck` now defined once in `analysis.ts` and imported by `server.ts` (was a "must match EXACTLY" hand-synced duplicate).

Guardrails:
- None added. Knip and dependency-boundary tooling do not exist in this repo; recurring dead-export findings suggest adding Knip in a future run (deferred — needs a decision on config + CI wiring).

Verification:
- lint ✓, build ✓ (tsc via turbo), tests ✓ — all 85 vitest files / ~1,750 tests pass, zero failures. Note: on this machine a single full `pnpm test` run dies early with a vitest-worker RPC timeout (`Timeout calling "onTaskUpdate"`, environment flake); full coverage was confirmed across multiple partial runs plus targeted per-file runs.
- Baseline before this run: build and 22 test files failed purely from a stale `node_modules` (repo had not been `pnpm install`-ed after the AI-gateway merge); fixed by install. Lockfile updated only for the two removed cdk deps.

Deferred:
- api: `server.ts` is 2,809 lines — route registration for every domain plus embedded business logic (`computeReadiness`, `markJobRequested`, the relay-result state machine at the `POST /api/relay/commands/:id/result` handler). Split per domain in a deliberate refactor.
- api: `DELETE /api/applications/:id` writes the event log directly (bare `'APPLICATION_DELETED'` string not in `DeploymentEventType`; the file's only `request.user!` assertion) instead of `recordEvent`/`recordAuditEvent`; those two helpers themselves overlap and could be unified.
- web: 12 near-identical private `getJson`/`postJson` fetch wrappers across `lib/`; `organization-form.tsx` uses raw `fetch` instead of the shared `apiRequest`; `lib/applications.ts#deleteApplication` throws an ad-hoc `.code` Error instead of `ApiRequestError` (leads to unchecked casts in `applications/[id]/page.tsx:457`).
- relay: `src/index.ts` is 847 lines — the INSTALL-executor cluster could move to its own module; `domain.ts#readPayload` double-casts the payload without the field validation its sibling helpers perform; `rdsFake` test helper duplicated in two test files (consolidation needs a shared helper file + tsconfig exclude).
- cdk: `createRealQuotaChecker` (`jobs/preflight-engine.ts:812`) can never populate `exceeded` — the quota preflight is structurally a no-op (behavioral fix). Eight `ponytail:` comment markers look like a mis-substituted `PENDING-AWS`/`PENDING-DB` — confirm intent before editing. `application-stack.ts`/`bootstrap-stack.ts` are ~1,100-line constructs; splitting changes logical IDs, so only as a deliberate migration.
- contracts/copy-map/analysis: most contracts schemas have no consumers yet (looks like intentional scaffolding — confirm adoption); `COPY_RULES_65` is inert; the region list and `FAILURE_CODES` are intentionally duplicated under documented zero-dependency invariants (parity-tested, low drift risk).

<!--
Use this format for future entries:

### YYYY-MM-DD

Reviewed: `<start-commit>..<end-commit>`

Cleanup:
- ...

Structure:
- ...

Guardrails:
- ...

Deferred:
- ...
-->
