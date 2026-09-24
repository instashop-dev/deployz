## Language Rules

- Always output the instructions in Simplified Technical English ASD-STE100.

## Deployz MVP

Deployz is currently an MVP. Make all product, engineering, architecture, infrastructure, and UX decisions for the current MVP stage.

- Prefer the simplest reliable solution that meets current requirements.
- Prioritize deployment reliability, security, usability, low AWS cost, maintainability, and fast iteration.
- Avoid over-engineering, premature abstractions, speculative scalability, and infrastructure or features for possible future needs.
- Preserve current MVP boundaries unless the task explicitly changes them.
- Reuse existing architecture, components, and patterns when practical.
- When multiple solutions are valid, choose the solution with the lowest implementation and operational complexity.
- Give the core deployment flow higher priority than architectural elegance or future extensibility.
- Do not add Azure, GCP, enterprise, multi-cloud, or other post-MVP complexity unless the task explicitly requires it.
- If a useful capability is not required for the MVP, defer it and state that it is a post-MVP item.

## Agent Behavior

- Make the smallest necessary change; do not touch, refactor, rename, reorganize, or reformat unrelated code.
- Match existing style and patterns.
- Prefer simple solutions; avoid unnecessary abstractions.
- Leave no redundant comments, dead code, placeholders, debug code, or unused imports/variables.

## Frontend UI

For changes under apps/web, follow docs/ui-system.md.

- Use existing shadcn/ui components first.
- Follow shadcn's documented composition and variants.
- Prefer direct shadcn composition over custom wrappers.
- Create custom/domain components only when repeated product-specific logic or behavior justifies them.
- Use semantic theme tokens; avoid arbitrary palette colors.
- Use className primarily for layout, not to redesign shadcn components.
- Do not introduce another UI framework.
- Use Lucide icons.
- Preserve shadcn/Radix accessibility behavior.
- Keep raw AWS/CloudFormation states out of primary customer UI.
- Do not change application logic unless the task explicitly requires it.

## Documentation

docs/README.md is the index; it names the authoritative document for each
area. Update the authoritative document when behavior changes. Do not add
implementation plans, phase ledgers, or run reports under docs/.

## Deployment Logic

For the current live architecture and MVP support boundary, read
docs/architecture.md and docs/product/mvp-scope.md.

Before changing deployment, job, relay, worker, reconciliation, or watchdog
logic, read docs/deployment-resilience.md. Preserve its documented invariants,
including failed-update semantics, operation exclusivity, reconcile-before-fail,
and the relay trust boundary.

For work that changes the MVP boundary, update docs/product/mvp-scope.md and
record the reasoning in docs/decisions/README.md.

## E2E testing

Simulated E2E is the default (`pnpm e2e`). Do not invoke real AWS E2E
(`pnpm e2e:canary`, `pnpm e2e:fresh`) unless required. Escalation order:
targeted vitest → targeted scenario (`pnpm e2e --scenario=<id>`) →
full simulated suite (`pnpm e2e:scenarios`) → real AWS only as
escalation. Use `pnpm test:affected` and `pnpm test:escalation` for
guided selection. Full policy at `docs/testing/ai-agent-testing-guide.md`.
