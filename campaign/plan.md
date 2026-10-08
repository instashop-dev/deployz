# Deployz — Sequential Local Routine Setup
Use one local Claude Code Desktop routine with Opus coordinating and one foreground Sonnet worker. Each scheduled run starts a fresh parent session and carries state through this dedicated checkout. No Python session runner.

## Campaign phases
| Phase | Work | Gate |
|---|---|---|
| 0 | Inspect code/docs, verify recent hardening, freeze commit/analysis/compiler/profile/AI settings, check harnesses and prerequisites | Known baseline; relevant checks pass or pre-existing failures isolated |
| 1 | Exclude all prior corpus/audit/canary families; select 70 realistic, 20 messy and 10 unsupported-boundary apps; pin commits; independently label expected behavior | 100 genuinely fresh families; source-backed labels; stratified 80 improvement / 20 holdout |
| 2 | Extend existing benchmark harness for the campaign; production-equivalent inputs, stage evidence, timeouts and resume | Smoke run works; no new testing framework |
| 3 | Evaluate first 80: analysis, normal vendor config, build every eligible app, run successful builds and applicable functional probes | Evidence for every attempt; unsupported/unverified reported honestly |
| 4 | Group failures by cause; fix systemic MVP defects; add deterministic regressions; focused PRs/CI; rerun 80 | Candidate checks pass; critical defects resolved or block release |
| 5 | Exercise 10–12 representative vendor/customer workflows; use existing simulated scenarios for lifecycle bugs | No critical workflow inconsistencies |
| 6 | Freeze candidate and evaluate untouched 20 once | Separate first holdout results; no tuning during evaluation |
| 7 | Qualify 6–8 representative apps on real AWS, selected day-2 operations on 2–3, required canary checks and cleanup | Tested remote candidate is known; HTTPS/functional/lifecycle success and clean leak audit |
| 8 | Consolidate stage metrics, first/final/pristine/remediated/holdout evidence, fixes and remaining gaps | Launch/harden/expand recommendation with no unresolved critical failures |

## Testing contract
Read AGENTS.md, docs/product/mvp-scope.md, docs/architecture.md, docs/deployment-resilience.md, docs/testing/strategy.md and docs/testing/compatibility.md.
Reuse production source collection, analysis, readiness, preflight, graph/planner/compiler and supported build/configuration transformations. Use production-equivalent AI settings; diagnostic AI-off runs are separate.
Expectation verification inspects source before seeing Deployz outputs. Never modify labels to fit outputs. Initial repository validity is checked before freezing; do not replace an app simply because Deployz cannot handle it.
Build inputs must match production source packaging, platform and Dockerfile/context selection. Use isolated disposable runners without host credentials for untrusted app code. Probe DB writes, migrations, Redis/worker jobs and storage where applicable.
Record source changes/Dockerfile additions as remediation, separately from the pristine result. No missing credentials, skipped probes, compile-only graphs or mocked AWS behavior counts as deployment success.
Local substitutes establish application behavior only. Real AWS requires the existing harness safeguards, permitted test account, known deployed revision, unique installation per new deployment, resource ledger, interrupted-run reconciliation and cleanup. Preserve unrelated resources. If this stage is unavailable, report AWS qualification pending.
No Phase 6 additions just to improve scores; no repo-name special cases. Every fix gets focused deterministic regression coverage and required checks.
Release criteria: no unresolved critical silent config/data errors, migration-result failures, operation races or cleanup defects; required regression and representative AWS evidence pass. Report explicit denominators rather than a single overall pass percentage.

## Step 1 — Prepare the workspace
1. Use a dedicated checkout/branch for this campaign; do not run other manual sessions against it while the routine is active.
2. Save this guide as campaign/plan.md in that checkout.
3. Open the checkout in Claude Desktop's Code tab. Confirm Node/pnpm, Git/GitHub access and Docker execution are usable from that session. For Windows, use the environment where Docker and the repo already work, and verify paths there.
4. Keep secrets in existing local credential mechanisms, not campaign files. AWS prerequisites are only required when the AWS stage becomes eligible.
5. Do not auto-upgrade models, dependencies or candidate code during a measurement run; record intentional changes.

## Step 2 — Bootstrap once
Start a normal Opus session in this checkout. Paste the bootstrap prompt below. It creates the queue/checkpoints/worker; it does not run the campaign.

### Bootstrap prompt
Set up the sequential Deployz fresh-100-repo campaign in this checkout using campaign/plan.md. Read AGENTS.md and relevant product/testing docs first. Do setup only; do not run the corpus, provision AWS or publish anything.

Create:
- campaign/tasks.json: ordered bounded tasks with phase, id, prerequisites, expected artifacts and concrete completion checks.
- campaign/state.json: READY status, phase, current task, baseline/candidate commits, attempt counters, last result and next action.
- campaign/handoff.md: concise current state and exact continuation.
- campaign/results/: redacted per-task/per-repo evidence.
- .claude/agents/campaign-worker.md: project subagent with model: sonnet; executes one assigned task, no nested/background agents, does not edit campaign state or task queue. Give it the tools needed for the campaign within existing permission rules.
- Scoped gitignore entries for caches, snapshots, raw logs, temporary containers and local runtime metadata; preserve tracked manifests, expectations and redacted results.

Use existing benchmark/simulator/canary harnesses. Keep initial selection and independent expectation verification separate, with no Deployz output provided to the verifier. Keep holdout outputs out of execution/fix tasks until its phase.

Use one dedicated campaign branch; preserve current changes and do not reset anything. No Python runner, new orchestration framework or new paid service. Add a smoke task that reads a known file and writes one small evidence result. Validate JSON and report the exact checkout, branch, model configuration, prerequisites and missing capabilities. Do not schedule the routine.

Opus must create tasks small enough for a run: source inspection/verification in batches of 5–10, compatibility batches of 10, heavy builds/runtime checks initially 2–3 apps, one root-cause family per fix, one AWS app per deployment task. Adjust from measured duration. Queue phase reviews explicitly.
Use one tracked checkpoint set; raw logs/caches remain ignored. Worker outputs carry task id, tested commit, commands/results and evidence paths. Status writes use temporary files plus atomic rename.
Write campaign policy into plan/state: TEST-only resources, selected environment/account/regions, publication/merge permissions, retry limits and current candidate version. Missing required authorization or credentials is a concrete blocked prerequisite, not implicit permission.

## Step 3 — Create the routine
In Code → Routines → New routine → Local:
| Setting | Value |
|---|---|
| Name | deployz-fresh-100 |
| Model | Opus |
| Folder | Dedicated campaign checkout |
| Worktree isolation toggle | Off — this checkout is already isolated; each run must see the same state |
| Initial schedule | Manual |
| Instructions | Routine prompt below |

Choose the permission mode available in your installation. During the smoke run, allow only intended commands/tools; save appropriate permissions for subsequent runs. Do not use a global permission bypass.
The project worker uses model: sonnet in .claude/agents/campaign-worker.md. Ensure no global model override forces it back to Opus. Confirm actual delegation in the smoke run; if unavailable, fix configuration before enabling recurrence.

### Routine prompt
Continue the Deployz fresh-100-repo campaign in this checkout. You are the Opus coordinator. Read AGENTS.md, campaign/plan.md, campaign/state.json, campaign/tasks.json and campaign/handoff.md.

Use one execution task per run. Resume unfinished work before claiming a new task. Confirm the recorded checkout/commit and reconcile interrupted processes or AWS resources before repeating operations. Never reset changes or advance from another task's incomplete state.

For READY/CONTINUE, choose the earliest eligible task. Execute coordination/review tasks yourself; delegate execution to campaign-worker (Sonnet) in the foreground, at most one agent at a time. No parallel, nested or background agents. Give only relevant task/source/evidence paths; do not expose holdout results early.

Review worker evidence and run the task's actual completion checks. A recorded repository failure can complete an audit task; missing evidence cannot. Preserve first-run, configured/remediated, final and holdout results separately.

Update state atomically after each checkpoint. Use COMPLETE, CONTINUE, RETRYABLE or BLOCKED per task. Retry known transient errors at most twice after the initial attempt, across runs. BLOCKED work is not retried unless its prerequisite changes or the user marks it ready. Save the cause and finish independent work allowed by phase dependencies. Pause when no eligible work remains.

Aim for 45 minutes of execution, treating this as a soft budget: checkpoint at repository boundaries and do not start new heavy work near the limit. Do not leave unsupervised commands running when the session exits. AWS work follows the existing harness's resume/resource-ledger/cleanup rules; never discard a pending cleanup.

Stay within MVP scope and the frozen campaign policy. No gate bypasses, guessed credentials, repository-specific detection hacks or new Phase 6 infrastructure. Open focused PRs and satisfy CI; merge or publish only when campaign policy explicitly permits it.

Finish with a concise handoff: phase/task, changes, evidence/checks, blocker and next action. Only Opus edits queue/state. At a phase boundary verify its gate before advancing. When finished, write campaign/report.md, mark the campaign COMPLETE and pause this routine if the scheduling tool is available; otherwise future runs must exit without work. If state is absent or corrupt, report BLOCKED rather than reconstructing progress from guesses.

## Step 4 — Smoke-test before enabling recurrence
Click Run now. Only the smoke task should be eligible initially.
Check: new parent session uses Opus; campaign-worker uses Sonnet in the foreground; result artifact exists; Opus verifies the result; state/handoff update; no second execution task starts; no unapproved AWS/publication occurs.
Then mark the smoke task reviewed and the baseline task eligible. Run now again and inspect that it resumes from recorded state rather than rebuilding setup.

## Step 5 — Enable the 30-minute schedule
Ask Claude in Desktop: “Change the local routine deployz-fresh-100 to run every 30 minutes. Keep its folder, model and instructions unchanged.”
Verify the saved schedule. If a custom interval is unavailable in your installed version, use Hourly initially.
Turn on Settings → This computer → System → Keep computer awake. Keep Desktop running; lid closure can still suspend the machine.
The interval starts a new session when due, not immediately after completion. Desktop may skip a scheduled fire while the previous run remains active. Do not create separate phase routines that can compete for the same checkout.

## Step 6 — Monitor and recover
Read campaign/handoff.md for a short status and state.json/results for evidence. The routine history explains skipped runs and permissions stalls.
Transient errors get at most two automatic retries across sessions. A genuine blocker is recorded and pauses when no independent eligible work exists.
To recover: pause routine, resolve the recorded prerequisite, reconcile pending work/cleanup, mark the task READY, Run now, review, then re-enable recurrence. Never mark a task complete simply to move past a failure.
To stop safely: pause scheduling and allow the active run to checkpoint/finish cleanup. Pausing does not mean an active process has terminated.
At completion, Opus writes campaign/report.md and marks COMPLETE. Routine pauses itself if supported; otherwise disable it manually and COMPLETE causes future runs to exit immediately.

## Expected behavior
Morning: open handoff/report to see completed tasks, tested repositories, fixes, checks, blockers and next action. Normal task progression requires no repeated prompt pasting.
One Opus scheduled parent session may invoke one Sonnet subagent and wait; there is only one active execution task. The next scheduled parent is fresh.
The 45-minute budget is advisory, not a hard process watchdog. This minimal setup relies on the native scheduler plus evidence gates, not a custom durable workflow engine.

## Official references
- Desktop local routines: https://code.claude.com/docs/en/desktop-scheduled-tasks
- Project agents and model configuration: https://code.claude.com/docs/en/sub-agents

