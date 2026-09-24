# Testing

How Deployz is tested, and which layer to reach for. The escalation policy
for coding agents is [`ai-agent-testing-guide.md`](ai-agent-testing-guide.md).

## Philosophy

Most behaviour — the deployment state machine, status derivation,
stack-event ingest, the relay protocol, the UI's rendering of all of it —
is proven without a real AWS account. A simulated customer AWS account plays
back deterministic CloudFormation/ECS/ELB responses to the **real relay
code**, over the **real relay HTTP protocol**, into the **real control-plane
API and database**. Only the AWS SDK calls are replaced.

**Real AWS is an escalation mechanism, not the default loop.** Reach for it
when a change touches the AWS integration boundary (CDK templates, the
relay's AWS SDK adapters, the bootstrap stack) in a way the simulator cannot
exercise. Two production outages ("every install failed": a bootstrap
template `GetAtt` on a non-existent attribute, and a relay credential stored
in a shape the relay could not parse) were caught only by real-AWS runs, so
a change to the bootstrap template or the relay's enrollment path always
gets a real-AWS smoke before it reaches customers.

## The ladder

Use the cheapest layer that can establish confidence:

| Layer | Proves | AWS | Command |
| --- | --- | --- | --- |
| Unit / integration (Vitest) | Pure functions, DB constraints, CDK template synthesis, injectable-seam logic, manifest-to-plan/verify contracts, parity of catalogs and sizing with the committed templates | No | `pnpm vitest run` (or `pnpm vitest run --project <package>`, or a single file) |
| Simulated E2E (default) | The full pipeline — relay, API routes, DB, status derivation, inventory, both UIs — against a simulated AWS account | No | `pnpm e2e`, `pnpm e2e --scenario=<id>`, `pnpm e2e:scenarios` |
| Version canary (real AWS, full product) | Release build → install → deploy → failed release → rollback → recovery → persistence → destroy → purge → leak audit, through the deployed control plane and a transient customer install | Opt-in | `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary:versions core` or the `AWS version canary` workflow |
| Fresh (real AWS, bootstrap only) | The bootstrap stack's real create → verify → destroy path | Opt-in | `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:fresh` |
| Persistent canary (real AWS, read-only) | The relay's real AWS SDK reads against a standing installation | Opt-in | `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 pnpm e2e:canary` (no standing installation is currently provisioned; see [`aws-canary.md`](aws-canary.md)) |
| Full-product walk (manual) | Everything above plus template publishing and an arbitrary application, driven through the real dashboard | Opt-in | [`aws-full-product-canary.md`](aws-full-product-canary.md) |
| Repository benchmarks | Stage A: analyzer accuracy over a pinned 120-repository corpus (no AWS). Stage B: the same corpus through the real production path | No / Opt-in | `pnpm benchmark:compat`, `pnpm benchmark:deploy` |

## When to use each

- **Everyday development:** `pnpm vitest run` scoped to the package, plus
  the `e2e/*.spec.ts` file or `--scenario` closest to the change.
- **Before merging a change to the relay, the deployment state machine, or
  stack-event/status derivation:** `pnpm e2e:scenarios`. CI runs it on
  every push to `main` and every critical pull request.
- **After changing the relay's AWS SDK adapters, the CDK templates or the
  bootstrap stack:** the version canary (`core`), and `fresh` when the
  bootstrap stack itself changed. Republish the templates first
  ([`../operations/control-plane.md`](../operations/control-plane.md)).
- **Verifying a production incident is fixed:** add a simulated regression
  scenario ([`e2e-scenarios.md`](e2e-scenarios.md#how-to-add-a-scenario))
  before reaching for real AWS; then confirm once on real AWS.
- **After changing the component catalog, the resource catalog, the sizing
  profile or the manifest's requirement fields:**
  `apps/api/src/requirements-contract.test.ts`,
  `packages/cdk/test/lifecycle-parity.test.ts` and
  `packages/cdk/test/sizing-parity.test.ts` (plain Vitest).
- **Team Admin changes:** simulated only — `apps/api/src/admin/*.test.ts`
  and `pnpm e2e e2e/admin.spec.ts`.

## What CI runs

`.github/workflows/ci.yml` (every push and pull request to `main`): a
`plan` job selects a risk level for pull requests with
`scripts/test-affected.mjs`; `test-build` runs build, the selected or full
Vitest projects, lint and `pnpm typecheck:scripts`; `e2e-simulated` runs
the selected specs and scenarios, and on pushes to `main` and critical pull
requests the core specs (`e2e-modes`, `admin`, `deployment-detail`), the
full scenario suite and the default-HTTPS scenarios. The remaining
Playwright specs run only when the plan selects them or through the manual
`e2e.yml` workflow; the visual suite never runs in CI (Windows-generated
snapshots). Real AWS never enters CI: `aws-canary.yml` (version canary) and
`aws-persistent-canary.yml` (read-only canary) are `workflow_dispatch` only.
The deploy workflows do not wait for CI.

## Documents

| Document | Contents |
| --- | --- |
| [`ai-agent-testing-guide.md`](ai-agent-testing-guide.md) | The escalation policy coding agents must follow |
| [`e2e-testing.md`](e2e-testing.md) | E2E architecture, the simulation seam and its design decisions, modes, CLI, environment variables, local execution, CI, debugging |
| [`e2e-scenarios.md`](e2e-scenarios.md) | The simulated-scenario catalogue and how to add one |
| [`version-rollback-canary.md`](version-rollback-canary.md) | The automated real-AWS version canary: product semantics, scenarios, safety, evidence, cleanup and leak audit |
| [`aws-fresh.md`](aws-fresh.md) | The real-AWS bootstrap create/destroy mode |
| [`aws-canary.md`](aws-canary.md) | The read-only canary against a standing installation |
| [`aws-full-product-canary.md`](aws-full-product-canary.md) | The manual full-product walk against the deployed control plane |
| [`../ai-analysis.md`](../ai-analysis.md#testing-ai-changes) | How to test analysis and AI changes without wording assertions |
| [`repository-compatibility/README.md`](repository-compatibility/README.md) | Stage A: the pinned OSS corpus, expected facts, findings COMP-nnn, `pnpm benchmark:compat` |
| [`repository-deployment/README.md`](repository-deployment/README.md) | Stage B: the same corpus through the real production path, findings DEPLOY-nnn, cleanup and leak-audit rules, `pnpm benchmark:deploy` |

The `findings.md` files under `repository-compatibility/` and
`repository-deployment/` are living registries that tests and harnesses
reference by id; the `runs/summary.md` files are generated by the harnesses.
