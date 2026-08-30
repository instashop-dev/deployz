# Deployz UI System

Deployz uses **shadcn/ui as the application design system**. This document is
the canonical, compact reference. It is intentionally short — it defines the
system, not a design handbook.

## Principles

1. Use existing shadcn components first (`apps/web/src/components/ui`).
2. Follow native shadcn composition (e.g. `Card > CardHeader > CardTitle`).
3. Prefer built-in variants (`<Button variant="outline">`) over restyling.
4. Use semantic theme tokens (`bg-background`, `text-muted-foreground`, …).
5. Use `className` primarily for layout (spacing, width, grid/flex, responsive).
6. Prefer direct composition in pages over wrappers.
7. Extract domain components only after real repetition (e.g. `DeploymentStatusBadge`).
8. No additional UI framework. Lucide icons only.
9. Preserve shadcn/Radix accessibility behavior.
10. Keep raw AWS/CloudFormation states out of primary customer UI.
11. Preserve application logic unless a task explicitly requires changing it.

Never build a second design system on top of shadcn. No `UniversalCard`,
`GenericDataTable<T>`, or `DashboardWidgetFactory` layers.

## Architecture

```text
shadcn/ui primitives (components/ui)
        ↓
direct page composition (app/dashboard/**)
        ↓
feature/domain components only where repeated logic justifies them
```

## Shell

- `DashboardShell` composes `SidebarProvider > AppSidebar + SidebarInset`.
- `AppSidebar` carries the brand, `OrgSwitcher` (SidebarHeader), and
  `DashboardNav` (SidebarContent, groups: main + Management).
- `SiteHeader` carries `SidebarTrigger`, a compact section label, and the
  `UserMenu`. No duplicate large page titles in header and body.
- Screen padding and base spacing come from the shell's single `<main>`
  (`flex flex-col gap-6 p-4 md:p-6 lg:p-8`). Pages do not add shell padding.
- No parallel custom responsive navigation; mobile behavior comes from the
  shadcn Sidebar.

## Status vocabulary

- User-facing deployment states come from
  `@/lib/deployment-vocabulary` (`DEPLOYMENT_STATE_LABELS`,
  `DEPLOYMENT_STATE_BADGE`) — rendered via `DeploymentStatusBadge`.
- Never show raw lifecycle terms (`CREATE_IN_PROGRESS`,
  `UPDATE_ROLLBACK_COMPLETE`) as primary labels; they may appear under
  advanced/diagnostic disclosures only.
- Never communicate state by color alone — pair color with label text (and
  icon/dot where the badge carries one).

## Typography

| Level | Classes |
| --- | --- |
| Page title | `text-2xl font-semibold tracking-tight` |
| Section title | `text-base font-semibold` |
| Body | `text-sm` |
| Secondary | `text-sm text-muted-foreground` |
| Metadata | `text-xs text-sm:text-muted-foreground` |

One `<h1>` per page.

## Page spacing

- Page root: `flex flex-col gap-6` (the shell already provides padding).
- Inside sections: `gap-2` / `gap-3` / `gap-4`.

## Destructive actions

- Use `AlertDialog` (destructive variant) for disconnect/remove flows.
- State actual consequences; avoid "Are you sure?".
- Keep the existing type-to-confirm pattern where present.

## Tables

- Use the shadcn `Table` primitives. Application-specific tables (e.g. the
  deployments table) may live as named components; no generic table
  abstraction.
- Wrap wide tables with `overflow-x-auto` for mobile.

## Feedback

- Short-lived operation feedback: Sonner toast (`toast.success(...)` etc.).
- Persistent or actionable failures: inline `Alert`. Important deployment
  failures are never toast-only.

## Responsive expectations

- Desktop: full sidebar, compact operational content.
- Tablet: collapsible sidebar.
- Mobile: shadcn Sidebar mobile behavior, stacked actions, responsive
  dialogs/sheets, horizontal table scrolling. Essential actions stay visible.

## Guardrails

- ESLint checks (root `eslint.config.mjs`) reject new arbitrary Tailwind
  palette colors and known raw CloudFormation statuses in customer-facing
  `apps/web/src` code.
- Visual regression: `e2e/visual.spec.ts` covers canonical pages; run
  `pnpm test:e2e -- e2e/visual.spec.ts` after UI changes.
