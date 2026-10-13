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
| REM-101 | ANALYSIS | Existing health routes not found (Express router mount, Go `/healthz`, Next.js `/api/health`) | Open |
| REM-102 | ANALYSIS | Startup migrations not found (Go `migrations.Up`, `CREATE TABLE IF NOT EXISTS` at boot, `prisma db push` in the start script) | Open |
| REM-103 | ANALYSIS | A job library alone raises `worker-command` although jobs run in the web process | Open; generator asks instead of acting |
| REM-104 | ANALYSIS | Loopback binding found only in dev or desktop entry points | Open |
| REM-105 | ANALYSIS | Runtime and framework misdetected (paperless-ngx as Node, coder as Express, searxng as Go); suggested Django migrate path ignores the image working directory | Open |
| REM-106 | ANALYSIS | A compose database service counted as an application service (lobehub) | Open; generator reads it as configuration |
