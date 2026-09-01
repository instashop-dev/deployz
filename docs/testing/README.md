# Testing

How Deployz is tested, and which mode to reach for.

## Philosophy

Most behaviour — the deployment state machine, status derivation, stack-event
ingest, the relay protocol, the UI's rendering of all of it — can be proven
correct without touching a real AWS account. The E2E architecture is built
around that: a simulated customer AWS account plays back deterministic
CloudFormation/ECS/ELB responses to the **real relay code**, over the **real
relay HTTP protocol**, into the **real control-plane API and database**. Only
the AWS SDK calls themselves are replaced.

**Real AWS E2E is an escalation mechanism, not the default verification
loop.** Reach for it only when a change touches the actual AWS integration
boundary (CDK templates, the relay's AWS SDK adapters, the bootstrap stack) in
a way the simulator cannot exercise — see
[`ai-agent-testing-guide.md`](ai-agent-testing-guide.md) for the exact
escalation ladder.

## Test hierarchy

| Layer | Proves | AWS required | Command |
| --- | --- | --- | --- |
| Unit / integration (Vitest) | Pure functions, DB constraints, CDK template synthesis, injectable-seam logic | No | `pnpm vitest run` |
| Simulated E2E (default) | The full production pipeline — relay, API routes, DB, status derivation, resource inventory — against a simulated AWS account | No | `pnpm e2e` |
| Canary (real AWS, read-only) | The relay's real AWS SDK calls still work against a real, persistent installation | Yes (opt-in) | `pnpm e2e:canary` |
| Fresh (real AWS, create + destroy) | The bootstrap stack's real create/destroy golden path in a real account | Yes (opt-in) | `pnpm e2e:fresh` |

A full product-flow live install (install link → a real customer AWS account
→ HEALTHY → update → delete) is not automated in Phase 1. It stays a
documented manual escalation — see [`aws-canary.md`](aws-canary.md) and
[`aws-fresh.md`](aws-fresh.md) for what canary/fresh actually cover instead.

## When to use each

- **Everyday development**: `pnpm vitest run` plus the specific
  `e2e/*.spec.ts` file(s) touching your change. Both are fast and require no
  AWS credentials.
- **Before merging a change to the relay, the deployment state machine, or
  stack-event/status derivation**: run the full simulated scenario suite,
  `pnpm e2e:scenarios` — this is what CI's `e2e-simulated` job also runs on
  every PR.
- **After changing the relay's AWS SDK adapters or CDK infrastructure**: the
  canary suite verifies the real boundary still works against a standing
  installation, without creating or destroying anything.
- **After changing the bootstrap stack itself** (the CFN template a customer
  first deploys): the fresh suite runs a real create → verify → destroy cycle
  against a throwaway stack.
- **Verifying an actual production incident is fixed**: prefer adding a new
  simulated regression scenario (see
  [`e2e-scenarios.md`](e2e-scenarios.md#how-to-add-a-scenario)) over reaching
  for real AWS — it is faster, deterministic, and runs on every PR after
  that.

## Documents

| Document | Contents |
| --- | --- |
| [`e2e-testing.md`](e2e-testing.md) | E2E architecture, the simulation seam, CLI commands, environment variables, local execution, CI behaviour, debugging |
| [`e2e-scenarios.md`](e2e-scenarios.md) | The full simulated-scenario table, and how to add a new one |
| [`aws-canary.md`](aws-canary.md) | The read-only canary mode against the standing installation |
| [`aws-fresh.md`](aws-fresh.md) | The real-AWS bootstrap create/destroy mode |
| [`ai-agent-testing-guide.md`](ai-agent-testing-guide.md) | The escalation policy AI coding agents must follow |
| [`discovery/README.md`](discovery/README.md) | Point-in-time investigation reports behind the Phase 1 design — reference only, not maintained |
