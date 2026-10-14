# Remediation benchmark findings

Confirmed defects found by the benchmark and the coding-agent execution
tests. `GEN` defects are fixed in the generator and have a regression test in
`packages/analysis/test/fix-instructions.test.ts`. `ANALYSIS` defects are in
the analysis; the generator's conditional actions let the agent conclude "no
change", but the finding is still raised.

| Id | Type | Defect | Status |
| --- | --- | --- | --- |
| REM-001 | GEN | Informational findings ("No change needed", a declared worker) were listed as blockers | Fixed: `ALREADY_SUPPORTED`, "keep as is" |
| REM-002 | GEN | Worker findings told the agent to run jobs inside the web process or remove job code | Fixed: `NEEDS_INPUT`, declare a worker, never merge |
| REM-003 | GEN | Message-queue findings told the agent to replace the queue with in-process jobs | Fixed: `DEPLOYZ_LIMITATION`, verify and report |
| REM-004 | GEN | Architecture findings told the agent to remove infrastructure files | Fixed: `UNSUPPORTED`, never delete or move |
| REM-005 | GEN | Database findings told the agent to move the data layer to PostgreSQL; MySQL was ignored | Fixed: limitation, vendor decision; MySQL named |
| REM-006 | GEN | MySQL apps were described as having no database | Fixed: `database` fact names the engine |
| REM-007 | GEN | The health outcome asked for a Dockerfile HEALTHCHECK that the guidance said was not needed | Fixed: one constraint, no HEALTHCHECK |
| REM-008 | GEN | "One container per deployment" contradicted declared workers | Fixed: capabilities list workers |
| REM-009 | GEN | Two contradicting migration findings reached the agent | Fixed: merged into one decision |
| REM-010 | GEN | A case-insensitive `HOST` match read any "host" text as configuration (found on the holdout) | Fixed |
| REM-011 | GEN | A new container configuration defaulted allowed hosts to `*`, dropped the frozen lockfile install, and lost the static files a reference nginx served (execution) | Fixed: packaging rules |
| REM-012 | GEN | Cached documents survived a model change | Fixed: model and generator version in the cache key |
| REM-101 | ANALYSIS | Existing health routes not found (Express router mount, Go `/healthz`, Next.js `/api/health`) | Fixed (v54): exported-router mounts with the shortest prefix (kutt), Go `URL.Path ==` checks (coder), a HEALTHCHECK shared by every target (karakeep), NestJS sub-routes. Open: immich, where two apps register routes and the start script is not fetched |
| REM-102 | ANALYSIS | Startup migrations not found (Go `migrations.Up`, `CREATE TABLE IF NOT EXISTS` at boot, `prisma db push` in the start script) | Fixed (v54): only the real start path counts (binary `migrate` subcommand, `migrate deploy` wrapper, Procfile `web:`, s6 init scripts, Go start-path migrators); a declaration, browser, CLI or test code, a Procfile `release:` line and `CREATE TABLE IF NOT EXISTS` never count. Open: in-process migrators whose start-path call the bounded fetch cannot show stay unknown |
| REM-103 | ANALYSIS | A job library alone raises `worker-command` although jobs run in the web process | Fixed (v54): a Node job library or `worker_threads` alone raises no question (`workerNeedsProcess`); Celery, RQ, Sidekiq and declared workers still do |
| REM-104 | ANALYSIS | Loopback binding found only in dev or desktop entry points | Fixed (v54): the production start text overrides a source loopback; desktop and Electron files and Python modules the image does not run never count. Open (validation gap): Django `runserver`, Spring `server.address` and Rust bind defaults are not detected |
| REM-105 | ANALYSIS | Runtime and framework misdetected (paperless-ngx as Node, coder as Express, searxng as Go); suggested Django migrate path ignores the image working directory | Fixed (v54): runtime from the production FROM lineage, tooling manifests skipped, no Node framework on a non-Node image, Dockerfile tie-break (searxng `dist.dockerfile`, immich `server/Dockerfile`), migrate path inside the image |
| REM-106 | ANALYSIS | A compose database service counted as an application service (lobehub) | Fixed (v54): a service whose command, probe or data volume is a database server is infrastructure; a ParadeDB, TimescaleDB or Citus image is `other-database` (lobehub stays NOT_COMPATIBLE for its `pg_search` extension) |

## Analysis v54 benchmark notes

- The truth-agreement figure counts a finding that the analysis no longer
  raises as a disagreement. At v54 it is 51/93, the same as before. Of the 42
  disagreements, 16 are findings no longer raised whose truth is
  `ALREADY_SUPPORTED`, and 20 differ in class (41 before). Six findings are no
  longer raised although their truth asks for an action: RB-13
  `unsupported-architecture` (the truth label says the dogfood Terraform makes
  coder unsupported; the Stage A label and COMP-040 say it does not) and the
  `health-check` of five kutt mutations (RB-28, RB-29, RB-31, RB-33, RB-36),
  whose truth is `CONFIGURATION_FIX` while RB-01 says kutt already serves
  `/api/health`. The labels are kept as written.
- The classes of findings v54 no longer raises were removed from `cases.yaml`;
  the classes that changed because the evidence changed are adjudicated in its
  header.
