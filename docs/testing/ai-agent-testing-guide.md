# Deployz AI Agent Testing Policy

Use the cheapest test capable of establishing confidence.

Default:

1. Run targeted unit/integration tests.
2. Run simulated E2E for affected product flows.
3. Run relevant simulated failure scenarios.

Do not provision fresh AWS infrastructure by default.

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

When a new real-world AWS failure is discovered:

1. reproduce;
2. understand root cause;
3. fix;
4. add a deterministic regression scenario where feasible.

## Mapping the ladder to this repository

- Unit/integration tests: `pnpm vitest run` (or a scoped `--filter` /
  single test file while iterating).
- Simulated E2E: `pnpm e2e`, one scenario via `pnpm e2e --scenario=<id>`,
  the full simulated regression suite via `pnpm e2e:scenarios`.
- Canary (real AWS, read-only): `pnpm e2e:canary` — see
  [`aws-canary.md`](aws-canary.md).
- Fresh (real AWS, create + destroy): `pnpm e2e:fresh` — see
  [`aws-fresh.md`](aws-fresh.md).

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
