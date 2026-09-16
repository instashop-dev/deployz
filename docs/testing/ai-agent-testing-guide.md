# Deployz AI Agent Testing Policy

## Mandatory escalation order

Follow these steps in order. Do not skip a layer unless you are confident
the current layer cannot establish confidence.

1. **Targeted unit/integration tests** — Run only the relevant tests for the
   package you changed, e.g.
   `pnpm --filter @deployz/<package> exec vitest run <test-file>`.
   Do not run the full test suite during each fix iteration.

2. **Targeted simulated E2E** — Run only the affected product flows via the
   scenario flag: `pnpm e2e --scenario=<scenario-id>`. Choose the scenario
   closest to the behaviour under test, e.g. `--scenario=happy-path` for a
   golden-path deployment, `--scenario=cloudformation-rollback` for rollback
   handling, `--scenario=ecs-failure` for ECS provisioning errors. You can
   also run a single Playwright spec directly:
   `pnpm e2e e2e/<spec>.spec.ts`. Do not run the entire E2E suite during
   each fix iteration.

3. **Simulated regression suite before merge** — Run the full simulated
   scenario suite: `pnpm e2e:scenarios`. CI runs this suite for every
   critical deployment PR and for every push to `main`; other PRs run the
   risk-based subset selected by `pnpm test:affected`.

4. **Real AWS escalation** — Only where simulated tests cannot establish
   confidence. Always set `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`. Do not launch
   fresh AWS infrastructure merely because deployment-related code changed.

Escalate to AWS canary when changes affect:

- relay/AWS interaction
- CloudFormation polling
- resource discovery
- bootstrap
- ECS
- RDS
- Redis/Valkey
- ALB
- ACM
- IAM
- infrastructure health
- application-stack behaviour

Escalate to fresh AWS only when:

- explicitly requested;
- fundamental provisioning behaviour changed;
- validating a release;
- validating cleanup/destruction;
- canary cannot provide adequate confidence.

Real AWS execution requires:

```
DEPLOYZ_E2E_ALLOW_REAL_AWS=1
```

Never bypass this safeguard. A refusal is signal, not friction — never set
the variable merely to get past a refusal you don't understand.

Do not modify tests merely to make a failing implementation pass.
Diagnose the implementation first.

## AWS failure → simulator regression rule

When a real AWS failure occurs (canary, fresh, version canary, Stage B
repository deployments, or manual AWS testing):

1. Capture the exact AWS state, SDK response, or event sequence.
2. Add a deterministic simulator scenario under
   `e2e/simulation/scenarios/` that reproduces the failure. Reuse
   `SimulatedCustomerAccount`, the relay-harness, and the existing
   scenario registration pattern in `scenarios/index.ts`.
3. Reproduce the failure locally through the simulator.
4. Fix the root cause locally.
5. Rerun the simulator to confirm the fix.
6. Confirm once on real AWS.

Scenario files use problem-oriented names, e.g. `ecs-target-timeout.ts`,
`missing-stack-output.ts`, `relay-disconnect-during-destroy.ts`.

For every AWS bug, explicitly decide: "Can this AWS failure be represented
in the simulator?" If yes, add the regression scenario before closing the
bug. If no, document why in the bug report.

## Mapping the ladder to this repository

- Unit/integration tests: `pnpm vitest run` (or a scoped `--filter` /
  single test file while iterating).
- Simulated E2E: `pnpm e2e`, one scenario via `pnpm e2e --scenario=<id>`,
  the full simulated regression suite via `pnpm e2e:scenarios`.
- Canary (real AWS, read-only): `pnpm e2e:canary` — see
  [`aws-canary.md`](aws-canary.md).
- Fresh (real AWS, create + destroy): `pnpm e2e:fresh` — see
  [`aws-fresh.md`](aws-fresh.md).
- Version canary (real AWS, full product, automated):
  `pnpm e2e:canary:versions core` or the `AWS version canary` workflow — see
  [`version-rollback-canary.md`](version-rollback-canary.md). Required for
  changes to release/rollback logic, deployment orchestration, the relay's
  deploy/destroy/purge executors, and before an MVP release (three
  consecutive passes).
- Full-product canary (manual, deployed control plane + real customer
  install): [`aws-full-product-canary.md`](aws-full-product-canary.md) —
  required before calling a release ready; it is the only check that runs
  the published templates and the customer-side relay Lambda together with
  the control plane. Its §6 lists the failure modes the simulated suite
  cannot reproduce (multi-invocation deferral, image entrypoints, template
  drift).

For the regression-scenario step: add a fixture under
`e2e/simulation/scenarios/` reproducing the failing
CloudFormation/ECS/ELB shape deterministically (see
[`e2e-scenarios.md`](e2e-scenarios.md) — "how to add a scenario"), assert
the correct outcome in a scenario spec, and register it so it runs on
every future `pnpm e2e:scenarios` / CI `e2e-simulated` run — the
regression becomes permanent and free to re-check.

See [`e2e-testing.md`](e2e-testing.md) for the commands and environment
variables this policy refers to, and [`e2e-scenarios.md`](e2e-scenarios.md)
for the existing scenario catalogue to extend rather than duplicate.

## Validating Team Admin changes

Team Admin (`docs/admin/team-admin.md`) is simulated-mode only — it never
needs real AWS, since it reads/acts on the same DB and domain workflows the
vendor surfaces already exercise. Validate a change with `apps/api/src/admin/
*.test.ts` (Vitest) for the API layer plus `pnpm e2e e2e/admin.spec.ts` for
browser coverage (authorization, search, View as Vendor, failed-deployment
diagnosis/recovery). Escalate past simulated E2E only if the change also
touches the underlying domain workflow's real AWS behaviour — the escalation
ladder above still applies to that workflow, not to the admin wrapper around
it.
