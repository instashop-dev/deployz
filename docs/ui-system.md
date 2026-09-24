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
- `AppSidebar` carries the brand (SidebarHeader), `OrgSwitcher` and
  `DashboardNav` (SidebarContent: the organization row, then groups: main +
  Management), and the account menu (SidebarFooter).
- `SiteHeader` carries the `SidebarTrigger` and a compact section label on
  nested routes only — index routes where the label would repeat the page's
  own title suppress it, and the top bar carries no user identity. No
  duplicate large page titles in header and body.
- Screen padding and base spacing come from the shell's single `<main>`
  (`flex flex-col gap-6 p-4 md:p-6 lg:p-8`). Pages do not add shell padding.
- No parallel custom responsive navigation; mobile behavior comes from the
  shadcn Sidebar.

## Brand

- Use `DeployzBrand` (icon + "Deployz") or `DeployzIcon` from
  `components/deployz-brand.tsx` for each brand mark. Do not paste the SVG
  into a different component and do not use a letter as a placeholder mark.
- The symbol uses `currentColor`. It follows the text color in light and dark
  mode.
- The asset rules and the drift test are in `apps/web/brand/deployz/README.md`.

## Status vocabulary

- User-facing deployment states come from
  `@/lib/deployment-vocabulary` (`DEPLOYMENT_STATE_LABELS`,
  `DEPLOYMENT_STATE_BADGE`) — rendered via `DeploymentStatusBadge`.
- Never show raw lifecycle terms (`CREATE_IN_PROGRESS`,
  `UPDATE_ROLLBACK_COMPLETE`) as primary labels; they may appear under
  advanced/diagnostic disclosures only.
- Never communicate state by color alone — pair color with label text (and
  icon/dot where the badge carries one).
- The Customers list says one thing per customer instead of a per-deployment
  state: `CUSTOMER_DEPLOYMENT_STATUS_LABELS` / `_BADGE` in
  `@deployz/copy-map`, derived by `customerDeployment` in `@/lib/customers`.
  It is a projection of the §46 `state` plus `attentionReason`, never a new
  lifecycle and never a second mapping of raw AWS statuses — extend the
  projection, not the vocabulary, when a case is missing.

## Deployment detail

The vendor deployment detail page (`app/dashboard/deployments/[id]`) is a
status page, not a console. Top to bottom:

1. Compact header — breadcrumb, application name, status/health badges,
   customer and running version on one muted line.
2. `DeploymentHero` — one state-aware card whose headline is the page's only
   `aria-live` element. The words come from `lib/deployment-hero.ts`
   (`deriveHero`), which only chooses copy for what the API already derived
   (`state`, `deploymentStatus`, `jobs`). A failed day-2 operation reads
   "Update failed … Release vX is still live and unaffected", never as the
   deployment being down; DELETING is "Removing this deployment", never
   failed. The install step list (first → last) shows only while an install
   is in flight or failed; the live URL block shows once the app is reachable.
3. Contextual actions in the hero footer — one primary action per state
   (Open application / Deploy Update / Retry deployment), Diagnostics and
   Configuration as outline buttons, and Restart / Rollback / Disconnect
   behind a "More actions" menu. Day-2 actions are not rendered before an
   install has completed.
4. Compact metadata `dl` (customer, region label, release, created, URL,
   custom domain). AWS account, stack status and version identifiers live
   under the collapsed "Advanced details" at the bottom, together with the
   raw CloudFormation event feed.
5. `InfrastructureSummary` — one row per service with a plain-English
   status; services the application does not need read "Not required". The
   resource-level inventory (`InfrastructureSection`) opens from
   "View N resources".
6. Recent activity — newest first, five rows by default, "View full
   activity" for the rest. The classified failure's plain-English summary is
   the only failure text at the top level; the relay's raw error stays inside
   the row's disclosure.

## Application page

The vendor application page (`app/dashboard/applications/[id]`) has three
route tabs, controlled by the URL (shadcn `Tabs`, `role="tab"` links, not
plain links):

1. **Overview** — one state-aware card (the primary card), the compact
   customer install-link card when the card's own primary action is not the
   link and a live link exists, and at most one recent-event line. An
   application that has never had an eligible install link (still inside the
   setup lifecycle, no live link yet) gets no separate card at all — the
   primary card names the reason in one line near the lifecycle instead.
2. **Releases** — version history. A failed release row offers "Review
   failure details": the stage, the earliest error the build log shows, who
   most likely has to act (repository, temporary, Deployz, or not
   determined), the relevant redacted log lines, and the actions View build
   logs, Copy technical details, Copy prompt for coding agent (an
   investigation prompt, never a claimed fix), Explain with AI (on demand),
   and — for a Deployz-side failure, instead of the prompt — Copy report for
   Deployz support. The buildspec's "The image build did not produce an
   image" is a final check and is never shown as the cause.
3. **Configuration** — the deployment-configuration table, planned
   infrastructure, environment variables, and general settings (rename,
   danger zone).

`lib/application-state.ts` (`deriveApplicationPresentation`) is the single
source of the page's state: badge, heading, message, actions, the setup
lifecycle, polling, the install-link presentation, and notices. No section
reads `analysisStatus`, a readiness finding, or a deployment `state` for
itself — extend the mapper when a case is missing, never add a second
derivation. Precedence: an active operation (analysis running, a test
deployment installing or removing) always wins over readiness data, because
readiness is only as new as the last analysis while the operation is
happening now.

- The primary card's heading is the page's only `aria-live` region.
- The setup lifecycle (Analyse → Configure → Test → Share) shows only before
  the first verified test deployment or customer deployment exists. After
  that it is `null` — never a completed stepper sitting on the page forever.
- Readiness copy never shows a passed-check count. It says "No blocking
  issues" or "N changes required" — the same rule as the Configuration
  table. It describes the analysis only.
- The header shows two badges: the application state ("Analysis complete"
  when the analysis passed and no test deployment exists) and, separately,
  release readiness ("Release ready", "Release building", "Release build
  failed", "No deployable release", "No release yet"). An older READY release
  keeps the application deployable when a newer build failed. With no
  deployable release, the primary card never offers "Start test deployment".
- The Configuration table's result vocabulary is Ready / Not used / Change
  required / Recommended / Needs review — never "Passed", never a percentage.
  Ready and Not used show no badge, because the value already says it. Its
  action column reads Add for an unset optional field and Edit once a value
  exists. Raw detection evidence (file + reason) lives only under the
  collapsed "Analysis details" disclosure, never in the table itself.
- Required findings also show in a "Required changes" panel above the table
  (`#required-changes`, focused when the URL has that hash). Fix routes by
  `requiredChangeFix`: only `port-unresolved` opens a setting editor; every
  other finding needs a repository change and a new analysis, so it opens the
  fix instructions.
- Planned infrastructure comes from the plan's `footprint` through
  `footprintComponentRows` (`lib/footprint.ts`), generic over `service`/
  `category` — a new resource kind renders through the same rows with no
  page change.
- The install-link card shows one status badge, Copy link, Preview, and an
  overflow menu (copy HTML snippet, toggle enabled/disabled, regenerate,
  revoke) behind a visible "Manage" button. Regenerate and revoke both require confirmation. A live
  link stays visible in every state except the page's own `unavailable`/
  `unknown` states — it is never hidden or invalidated silently. On an
  application that is not ready to share, its warning states what a
  customer gets right now from the newest READY release (or that installs
  are refused when there is none), never a claim that a test must pass
  again.
- Configuration-required shows the required findings as plain-language
  labels (`requiredChangeLabel`) and one action, "Review required changes",
  linking to the Configuration tab's `#required-changes` anchor.
- Ready-to-share and customers-active name the release customers actually
  get (the newest READY release) when releases loaded successfully; a newer
  release that failed to build is called out as a separate notice, never
  implied to be what customers get. Releases that failed to load are never
  guessed at.
- Billing notices do not belong on this page.

## List views (Customers, Deployments)

The two lists answer different questions. Customers answers "which
relationships need attention?" with one row per customer. Deployments answers
"what is happening in each customer environment?" with one row per deployment.

- The status words come from `lib/deployment-status-groups`. That module holds
  the precise label of one deployment, the filter group of the status filter,
  the default sort rank, and the customer-level bucket the Customers summary
  counts. Do not classify a status anywhere else.
- The Customers summary is a projection of the customer's deployments. It is
  never a stored status.
- A state that the app does not know shows as "Unknown status" and counts as
  "Needs attention". It never shows a raw enum value.
- Search, filters, and sort live in the URL query (`q`, `status` or `state`,
  `application`, `region`, `sort`, `dir`). Use `useListParams`. A default value
  leaves no trace in the URL. Back from a detail page restores the view.
- Search waits 250 ms before it writes to the URL (`ListSearchInput`). Filters
  and sort apply at once. "Clear filters" shows only when a filter is active.
- A list that has no rows because of a filter shows `NoMatchesState`. A list
  that is empty shows its own first-use state. Never mix the two.
- Region codes show with a friendly name (`lib/regions`). An unknown region
  shows its code.
- Tables choose their columns from their own width with container queries
  (`@container`, `@2xl:`, `@4xl:`), not from the viewport, because the sidebar
  changes the space that is available. A hidden column moves under the
  customer instead of disappearing.

## Plan-driven surfaces

Some pages show what will happen to infrastructure: the install page, the
disconnect dialog, and the deploy-update dialog. Each page shows the
`DeploymentPlan` that the API sends. The API builds this plan from the
deployment's manifest. The page does not build its own plan. The page does
not guess which resources exist. The page only shows the plan's data.

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

## Loading

- Use `Spinner` (`components/ui/spinner.tsx`) for a user-triggered action.
  Show it inside the control that started the action (for example, the
  submit `Button`).
- Use `Skeleton` for initial data on a route or a section. Match the
  skeleton shape to the real layout. Set `aria-busy` on the loading
  container.
- Do not replace visible content with a skeleton during a background
  refresh or a poll. Keep the current content on screen and update it
  when new data arrives.
- Write specific loading text: a verb, an object, and "…". Examples:
  "Analyzing application…", "Saving configuration…". Do not use a generic
  "Loading…" when the operation is known.
- Accessibility: set `aria-hidden` on the `Spinner` when adjacent text
  already states the operation. Set `aria-busy` on the control or the
  container. Keep the text readable during the load. Do not show status
  by color alone. Keep focus on the control that started the action. The
  `animate-spin` rule slows under `prefers-reduced-motion: reduce`, but it
  does not stop, so the spinner still shows activity.
- `Button` example:
  `<Button loading={pending} loadingText="Saving configuration…">Save</Button>`.
  For a native control that is not a `Button`, add `<Spinner aria-hidden />`
  next to it, and set `disabled` and `aria-busy` on the control.
- Multi-action forms: track which action is pending. Show the spinner only
  on that action's control. Disable the other actions while one is
  pending.
- Error recovery: clear the loading state in a `finally` block. Show an
  actionable failure in an inline `Alert`. Use a toast only for a
  short-lived success message.
- Long-running server work: end the button's loading state when the
  server accepts the request. Hand off to the existing status or
  progress UI for the rest of the operation.
- Anti-patterns: a full-screen blocking overlay, a global loading store, a
  generic "Loading…" label, a spinner that hides an error, an artificial
  delay, or two buttons spinning at the same time.

## Feedback

- Short-lived operation feedback: Sonner toast (`toast.success(...)` etc.).
- Persistent or actionable failures: inline `Alert`. Important deployment
  failures are never toast-only.
- For in-progress states, see Loading above.

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
