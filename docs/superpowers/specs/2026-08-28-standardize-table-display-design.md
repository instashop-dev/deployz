# Standardize table display across Home, Applications, Deployments, Customers

## Problem

The four dashboard screens display list data with four different, inconsistent markup patterns:

- **Home** (`apps/web/src/app/dashboard/page.tsx`): renders `<DeploymentList>` (`apps/web/src/components/deployment-list.tsx`), a `<ul>/<li>` of link rows.
- **Applications** (`apps/web/src/app/dashboard/applications/page.tsx`): a vertical stack of `<Card>` components (`ApplicationCard`).
- **Deployments** (`apps/web/src/app/dashboard/deployments/page.tsx`): a hand-rolled raw `<table>`.
- **Customers** (`apps/web/src/app/dashboard/customers/page.tsx`): a second, independently hand-rolled raw `<table>` with different classes than Deployments'.

There is no shared table component in `apps/web/src/components/ui/` — shadcn's `Table` primitive was never added to this project, so the two existing tables duplicate markup with drifting styles.

## Goal

All four screens present their list data as an actual `<table>`, built on one shared set of shadcn `Table` primitives, so headers, cell padding, borders, and hover states look and behave identically across the app.

## Non-goals

- No sorting, filtering, or pagination — none of the four screens have this today; not introducing it.
- No change to the empty-state JSX blocks (already visually consistent, copy-pasted per screen) or to Home's stat cards / "Needs attention" section — out of scope for a table-display standardization.
- No change to data fetching, API shapes, or business logic (bulk-deploy, readiness badges, etc.).

## Design

### 1. Shared primitive

Add `apps/web/src/components/ui/table.tsx`: the standard shadcn `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption` components — thin styled wrappers over native `<table>` elements, no logic, matching the existing style of other primitives in that directory (`badge.tsx`, `card.tsx`, etc.).

### 2. Per-screen changes

**Deployments** (`apps/web/src/app/dashboard/deployments/page.tsx`, `FleetTable`, lines ~155-260)
Replace raw `<table>/<thead>/<tbody>/<tr>/<th>/<td>` tags with the new primitives, 1:1. No column, data, or behavior changes. Must preserve exactly:
- `data-testid="deployment-list"` on the table
- select-all checkbox `aria-label="Select all deployable customers"`
- per-row checkbox `aria-label={\`Select ${customerName}\`}`
- `tbody > tr` structure (asserted directly by `e2e/fleet.spec.ts:260`)
- `data-testid="bulk-deploy-bar"` and the release `combobox` aria-label, unchanged (outside the table itself)

**Customers** (`apps/web/src/app/dashboard/customers/page.tsx`, lines ~40-71)
Replace raw `<table>` tags with the primitives. Same 4 columns (Name, Email, Company, Created), same `formatDate` usage, no behavior change. No existing e2e coverage on this table to preserve.

**Applications** (`apps/web/src/app/dashboard/applications/page.tsx`, `ApplicationCard`/list, lines ~214-248)
Replace the `<Card>`-per-application stack with a table: one row per application, columns Name (linked to `/dashboard/applications/${id}`), Repository (`repoFullName`), Status (existing badge via `applicationBadgeLabel()`). Preserve the exact existing `data-testid` values on the equivalent elements (`app-card-${id}` on the row, `app-card-name-${id}` on the name link, `app-card-badge-${id}` on the status badge) so `e2e/applications.spec.ts`'s testid regex (`/^app-card-[0-9a-f-]{36}$/`) keeps matching unchanged.

**Home** (`apps/web/src/components/deployment-list.tsx`, invoked from `apps/web/src/app/dashboard/page.tsx`)
Convert `<DeploymentList>` from a `<ul>/<li>` of link-rows into a table: columns Customer (linked to `/dashboard/deployments/${id}`), Application (only when `showApplication` prop is true, matching current conditional), Version (only when present, matching current conditional), Status (`DeploymentStatusBadge`). No checkbox column (Home is read-only, unlike Deployments). Keep `data-testid="home-deployment-list"` on the table itself.

Update `e2e/home.spec.ts:138-143,190`: replace `getByRole('listitem')` / `getByRole('link', { name: ... })` assertions on the list with row-based queries (`getByRole('row')`, `getByRole('link', ...)` scoped to a row) to match the new table structure. This is a required consequence of the Home markup change, not incidental cleanup.

## Testing

- Existing Playwright specs (`e2e/fleet.spec.ts`, `e2e/applications.spec.ts`, `e2e/home.spec.ts`) must pass with only the Home spec's list-role assertions updated to row-based queries; everything else in those specs should require no changes because testids/aria-labels are preserved verbatim.
- Manually verify all four screens render correctly in the browser (light/dark if applicable) after the change.
