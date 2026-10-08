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
The saved routine prompt (`~/.claude/scheduled-tasks/deployz-fresh-100/SKILL.md`) and this copy must be identical. Change both together.

```text
Continue the Deployz fresh-100 campaign in C:/Users/Tejas/Desktop/deployz-mvp-test. You are the Opus coordinator. Run tasks one after another until the budget ends or no eligible task remains.

LOCK (do this first; do not change a campaign file before it)
1. Record the run start time T0 (now, UTC). Call get_session "self" to get your Desktop session id (if that tool is not available, use "unavailable"; then only the user can recover your lock).
2. Run `node campaign/lock.mjs acquire --role routine --desktop-session <id> --note "routine run"`. Keep the token.
3. Exit code 1: report the error and stop. Do not change campaign files.
4. Exit code 3: another coordinator owns the lock. Call get_session <owner.desktopSessionId>. If isRunning is true, or you cannot check it, report the owner and stop without changes. Recover only with evidence that the owner is not active: owner role "routine", get_session isRunning false, and list_task_runs shows that run is not "running"; owner role "manual": only if the session is archived or not found. Then run `node campaign/lock.mjs recover --token <owner token> --evidence "<the facts>"` and acquire again. Elapsed time is never evidence. If you are not sure, stop and report.
5. Release on every exit path after a successful acquire, after the last commit: `node campaign/lock.mjs release --token <token>`.

START
- Read AGENTS.md, campaign/plan.md, campaign/state.json, campaign/tasks.json and campaign/handoff.md. Missing or corrupt state: report BLOCKED, release, stop; do not reconstruct progress from guesses. Status COMPLETE: release and stop.
- Confirm the checkout, branch and recorded baseline/tested commit.
- Reconcile before you repeat any operation: interrupted processes, containers with label deployz-campaign=fresh-100, and pending AWS ledger cleanup. Never discard a pending cleanup.
- A task left IN_PROGRESS by an earlier run: read campaign/results/<id>/ and git status. Worker progress recorded (proposedStatus CONTINUE or a progress block) = continuation: resume from it; do not increment attempts. Finished result not yet verified = verify it now. No result and no progress = interrupted attempt: reconcile, then a new attempt counts against the retry limit.

LOOP
a. Select the earliest eligible task by tasks.json "eligibility". Skip BLOCKED tasks whose prerequisite did not change. A RETRYABLE task at the retry limit becomes BLOCKED with its cause. Continue with other eligible tasks when one is blocked. If no task is eligible, record "no eligible work" and the blockers in nextAction, checkpoint and go to END.
b. Budget: elapsed = now - T0. Start the task only if elapsed + timeboxMinutes <= 38. Exception: the first task of a run always starts. If its timeboxMinutes is more than 38 and it has no resumable steps, record a long-run exception in state.json runExceptions (task, run start, reason). If the check fails, go to END.
c. Mark the task IN_PROGRESS in tasks.json and state.json (currentTask). Increment attempts only for a new attempt (initial or retry); increment continuations[task] for a resume. Write atomically.
d. Coordination and review tasks: do them yourself. Execution tasks: one foreground campaign-worker (Sonnet), a fresh invocation for each task. Give only: task id, the task definition, tested commit, its permitted inputs and forbiddenInputs, stopBy = T0 + 38 min (ISO, only for tasks with resumable steps), and the recorded progress for a continuation. No other task, no earlier conversation, no Deployz output for labeling or verification tasks, no holdout paths before Phase 6. No parallel, nested or background agents.
e. Verify independently: run the task's completionChecks yourself and check git status for unexpected changes. The worker's proposedStatus is a proposal. A recorded repository failure can complete an audit task; missing evidence cannot. Keep first-run, remediated, final and holdout results separate.
f. Checkpoint: update tasks.json, state.json (status, attempts, continuations, progress, lastResult, nextAction, testedCommits, updatedAt) and handoff.md. Write each JSON to <file>.tmp, validate, rename over the file. Commit only this task's campaign files: "chore(campaign): complete|continue|block <task id> (...)". Then go to step a immediately.

STATUS
COMPLETE; CONTINUE (resumable progress, next pick resumes it); RETRYABLE (known transient error, at most two retries after the initial attempt, counted across runs); BLOCKED (record the cause; do not retry until the prerequisite changes or the user marks it READY). Never mark a task COMPLETE to pass a failure.

END
- 45 minutes from T0 is the soft budget; 7 minutes are reserved for verification, checkpoint and cleanup. After 38 minutes do not start a new task. Let an active task reach a safe checkpoint and finish its cleanup.
- Make sure no campaign container, command or AWS operation stays active without supervision.
- Update handoff.md, commit, release the lock. Final message: tasks done this run, evidence, checks, blockers and the exact next action.
- When the whole campaign is done: write campaign/report.md, mark COMPLETE, commit, release, then pause this routine with update_scheduled_task enabled=false.

RULES
Follow plan.md, the MVP boundaries, state.json policy (resources, AWS, publication, merge procedure, retry, holdout, labels) and the phase gates. Verify a phase gate before you advance. Only Opus edits tasks.json, state.json and handoff.md. No gate bypasses, guessed credentials, repository-specific hacks or new Phase 6 infrastructure. Merge or publish only as policy.publication permits.
```

### Coordinator lock
Every coordinator, scheduled or manual, runs `node campaign/lock.mjs acquire --role <routine|manual> --desktop-session <id>` before it changes a campaign file or dispatches a worker, and `release --token <token>` on exit. Exit code 3 means another coordinator owns `campaign/coordinator.lock`: exit without changes. The lock records the owner token, role, Desktop session id, Claude process id and creation time, host, user and cwd. `acquire` recovers a lock by itself only when the owner process is gone or its PID was reused. An idle Desktop session keeps its process alive, so a lock whose owner session stopped needs `recover --token <owner token> --evidence <facts>` (get_session isRunning false and the routine run not running). Elapsed time is not evidence. Recovered locks stay in `campaign/logs/locks/` for investigation. The lock file is ignored by git.

## Step 4 — Smoke-test before enabling recurrence
Click Run now. Only the smoke task should be eligible initially.
Check: new parent session uses Opus; campaign-worker uses Sonnet in the foreground; result artifact exists; Opus verifies the result; state/handoff update; no second execution task starts; no unapproved AWS/publication occurs.
Then mark the smoke task reviewed and the baseline task eligible. Run now again and inspect that it resumes from recorded state rather than rebuilding setup.

## Step 5 — Enable the 15-minute schedule
Ask Claude in Desktop: “Change the local routine deployz-fresh-100 to run every 15 minutes. Keep its folder, model and instructions unchanged.” Saved on 2026-10-08 as cron `*/15 * * * *`, paused.
Verify the saved schedule. If a custom interval is unavailable in your installed version, use Hourly initially.
Turn on Settings → This computer → System → Keep computer awake. Keep Desktop running; lid closure can still suspend the machine.
The interval starts a new session when due, not immediately after completion. Desktop adds a fixed dispatch delay of several minutes and may skip a fire while the previous run remains active; a run that finds the lock held exits without changes. Do not create separate phase routines, external schedulers or background runners that can compete for the same checkout.

## Step 6 — Monitor and recover
Read campaign/handoff.md for a short status and state.json/results for evidence. The routine history explains skipped runs and permissions stalls.
Transient errors get at most two automatic retries across sessions. A genuine blocker is recorded and pauses when no independent eligible work exists.
To recover: pause routine, resolve the recorded prerequisite, reconcile pending work/cleanup, mark the task READY, Run now, review, then re-enable recurrence. Never mark a task complete simply to move past a failure.
To stop safely: pause scheduling and allow the active run to checkpoint/finish cleanup. Pausing does not mean an active process has terminated. A manual session against this checkout must take the coordinator lock first; if the lock is held, wait for the owner to finish.
At completion, Opus writes campaign/report.md and marks COMPLETE. Routine pauses itself if supported; otherwise disable it manually and COMPLETE causes future runs to exit immediately.

## Expected behavior
Morning: open handoff/report to see completed tasks, tested repositories, fixes, checks, blockers and next action. Normal task progression requires no repeated prompt pasting.
One Opus scheduled parent session runs tasks one after another: one foreground Sonnet worker per task, then verification and checkpoint, then the next eligible task, until 38 minutes have elapsed or no eligible task remains. There is only one active execution task. The next scheduled parent is fresh and resumes from recorded state.
The 45-minute budget is advisory, not a hard process watchdog. This minimal setup relies on the native scheduler, the coordinator lock and evidence gates, not a custom durable workflow engine.

## Official references
- Desktop local routines: https://code.claude.com/docs/en/desktop-scheduled-tasks
- Project agents and model configuration: https://code.claude.com/docs/en/sub-agents

