## Language Rules

- Always output the instructions in Simplified Technical English ASD-STE100.

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

## Deployment logic

For the final live architecture and the MVP support boundary, read
docs/architecture.md. Before changing deployment/job/relay/watchdog logic, read
docs/deployment-resilience.md — it documents the invariants (failed-update
semantics, operation exclusivity, reconcile-before-fail, the relay trust
boundary) that code in apps/api, packages/relay and the worker must uphold.
The boundary-mvp implementation record lives in
docs/mvp-implementation-status.md; the launch report is
docs/mvp-boundary-implementation-report.md.

## E2E testing

Simulated E2E is the default (`pnpm e2e`). Do not invoke real AWS E2E
(`pnpm e2e:canary`, `pnpm e2e:fresh`) unless required. Policy at
`docs/testing/ai-agent-testing-guide.md`.
