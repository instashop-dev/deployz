# Standardize Table Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Home, Applications, Deployments, and Customers all render their list data as a real `<table>` built on one shared shadcn Table primitive, so headers, cell padding, borders, and hover states are identical across the four screens.

**Architecture:** Add `apps/web/src/components/ui/table.tsx` (the standard shadcn Table/TableHeader/TableBody/TableRow/TableHead/TableCell primitives — thin styled wrappers over native `<table>` elements, no logic). Swap each of the four screens onto these primitives one at a time, preserving every existing `data-testid`, `aria-label`, and link/checkbox behavior verbatim.

**Tech Stack:** Next.js 15 (App Router) + React 19, Tailwind v4, shadcn/ui on Radix, pnpm workspace. Playwright e2e tests live in `e2e/` at the repo root.

## Global Constraints

- Preserve every existing `data-testid` and `aria-label` string exactly — several are asserted by Playwright specs in `e2e/`.
- No sorting, filtering, or pagination — none of the four screens have this today; do not introduce it (see the spec's Non-goals).
- No change to empty-state JSX, Home's stat cards / "Needs attention" section, data fetching, or business logic (bulk-deploy, readiness badges, etc.) — out of scope.
- Use the shared Table primitives' own default padding/border/hover classes rather than each screen's old bespoke classes — that IS the standardization; don't re-apply legacy per-screen padding on top of it.
- Full design context: `docs/superpowers/specs/2026-08-28-standardize-table-display-design.md`.

---

## File Structure

- **Create:** `apps/web/src/components/ui/table.tsx` — shared Table primitives, no logic, matches the style of the existing `apps/web/src/components/ui/card.tsx` / `badge.tsx` (data-slot attributes, `cn()` from `@/lib/utils`).
- **Modify:** `apps/web/src/app/dashboard/deployments/page.tsx` — swap `FleetTable`'s raw `<table>` for the primitives.
- **Modify:** `apps/web/src/app/dashboard/customers/page.tsx` — swap the raw `<table>` for the primitives.
- **Modify:** `apps/web/src/app/dashboard/applications/page.tsx` — replace the `ApplicationCard` list with a table (`ApplicationList` + `ApplicationRow`).
- **Modify:** `apps/web/src/components/deployment-list.tsx` — replace the `<ul>/<li>` list with a table.
- **Modify:** `e2e/home.spec.ts` — update the one assertion that queries `listitem` role, to match the new table structure.

---

## Task 1: Shared Table primitive

**Files:**
- Create: `apps/web/src/components/ui/table.tsx`

**Interfaces:**
- Produces: `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption` — all standard React components accepting `React.ComponentProps<'table'|'thead'|'tbody'|'tfoot'|'tr'|'th'|'td'|'caption'>` respectively (so `className`, `data-testid`, `children`, etc. all pass through). Every later task imports from `@/components/ui/table`.

- [ ] **Step 1: Create the primitive file**

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
```

- [ ] **Step 2: Type-check and lint**

Run: `pnpm --filter @deployz/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @deployz/web lint`
Expected: no errors (the file isn't imported anywhere yet, so this only checks the new file itself is clean).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/table.tsx
git commit -m "feat(web): add shared Table UI primitive"
```

---

## Task 2: Convert Deployments to the shared Table

**Files:**
- Modify: `apps/web/src/app/dashboard/deployments/page.tsx:1-16` (imports), `:206-255` (the raw `<table>` inside `FleetTable`)

**Interfaces:**
- Consumes: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell` from `@/components/ui/table` (Task 1).

This screen already renders correct data — only the markup changes. The `data-testid="deployment-list"`, both checkbox `aria-label`s, and the `tbody > tr` DOM structure are asserted directly by `e2e/fleet.spec.ts` and must be preserved exactly.

- [ ] **Step 1: Add the import**

In `apps/web/src/app/dashboard/deployments/page.tsx`, add to the top import block (after the `Skeleton` import):

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
```

- [ ] **Step 2: Replace the raw `<table>` markup**

Replace this block (currently lines 206-255):

```tsx
          <table className="w-full text-sm" data-testid="deployment-list">
            <thead>
              <tr className="border-b text-left">
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all deployable customers"
                    checked={allDeployableSelected}
                    disabled={deployableIds.size === 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-2 py-2.5 font-medium">Customer</th>
                <th className="px-2 py-2.5 font-medium">Version</th>
                <th className="px-2 py-2.5 font-medium">Region</th>
                <th className="px-2 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.id} className="border-b last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${deployment.customerName}`}
                      checked={selected.has(deployment.id)}
                      disabled={!deployableIds.has(deployment.id)}
                      onChange={() => toggleOne(deployment.id)}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <Link
                      href={`/dashboard/deployments/${deployment.id}`}
                      className="font-medium hover:underline"
                    >
                      {deployment.customerName}
                    </Link>
                    <p className="text-xs text-muted-foreground">{deployment.applicationName}</p>
                  </td>
                  <td className="px-2 py-3 text-muted-foreground">
                    {deployment.version ?? '—'}
                  </td>
                  <td className="px-2 py-3 text-muted-foreground">{deployment.region}</td>
                  <td className="px-2 py-3">
                    <DeploymentStatusBadge state={deployment.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```

with:

```tsx
          <Table data-testid="deployment-list">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all deployable customers"
                    checked={allDeployableSelected}
                    disabled={deployableIds.size === 0}
                    onChange={toggleAll}
                  />
                </TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((deployment) => (
                <TableRow key={deployment.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${deployment.customerName}`}
                      checked={selected.has(deployment.id)}
                      disabled={!deployableIds.has(deployment.id)}
                      onChange={() => toggleOne(deployment.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/dashboard/deployments/${deployment.id}`}
                      className="font-medium hover:underline"
                    >
                      {deployment.customerName}
                    </Link>
                    <p className="text-xs text-muted-foreground">{deployment.applicationName}</p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {deployment.version ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{deployment.region}</TableCell>
                  <TableCell>
                    <DeploymentStatusBadge state={deployment.state} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
```

- [ ] **Step 3: Type-check and lint**

Run: `pnpm --filter @deployz/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @deployz/web lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/dashboard/deployments/page.tsx
git commit -m "refactor(web): use shared Table primitive on Deployments"
```

---

## Task 3: Convert Customers to the shared Table

**Files:**
- Modify: `apps/web/src/app/dashboard/customers/page.tsx:1-6` (imports), `:48-69` (the raw `<table>`)

**Interfaces:**
- Consumes: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell` from `@/components/ui/table` (Task 1).

No e2e coverage references this table's DOM structure, so this is a pure markup swap.

- [ ] **Step 1: Add the import**

In `apps/web/src/app/dashboard/customers/page.tsx`, add after the existing `@/components/ui/card` import:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
```

- [ ] **Step 2: Replace the raw `<table>` markup**

Replace (currently lines 48-69):

```tsx
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Company</th>
                  <th className="pb-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className="border-b last:border-0">
                    <td className="py-2.5 font-medium">{customer.name}</td>
                    <td className="py-2.5 text-muted-foreground">{customer.email}</td>
                    <td className="py-2.5 text-muted-foreground">{customer.company}</td>
                    <td className="py-2.5 text-muted-foreground">
                      {formatDate(customer.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
```

with:

```tsx
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell className="font-medium">{customer.name}</TableCell>
                    <TableCell className="text-muted-foreground">{customer.email}</TableCell>
                    <TableCell className="text-muted-foreground">{customer.company}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(customer.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
```

- [ ] **Step 3: Type-check and lint**

Run: `pnpm --filter @deployz/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @deployz/web lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/dashboard/customers/page.tsx
git commit -m "refactor(web): use shared Table primitive on Customers"
```

---

## Task 4: Convert Applications' card list to a table

**Files:**
- Modify: `apps/web/src/app/dashboard/applications/page.tsx:1-32` (imports), `:214-248` (`ApplicationList` / `ApplicationCard`)

**Interfaces:**
- Consumes: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell` from `@/components/ui/table` (Task 1). `Badge` from `@/components/ui/badge` (already imported). `applicationBadgeLabel(app: Application): string` (already defined below, unchanged).
- Produces: `ApplicationRow` (replaces `ApplicationCard` — same single call site inside `ApplicationList`, no external consumers of the old name).

`e2e/applications.spec.ts` asserts `getByTestId(/^app-card-[0-9a-f-]{36}$/)` is visible — it only checks visibility, not the element's tag, so keeping the same `data-testid` values on the new `<tr>`/link/badge keeps that spec passing unchanged.

- [ ] **Step 1: Add the import**

In `apps/web/src/app/dashboard/applications/page.tsx`, add after the `@/components/ui/card` import block:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
```

- [ ] **Step 2: Replace `ApplicationList` and `ApplicationCard`**

Replace (currently lines 214-248):

```tsx
function ApplicationList({ applications }: { applications: Application[] }) {
  return (
    <div className="flex flex-col gap-3">
      {applications.map((app) => (
        <ApplicationCard key={app.id} application={app} />
      ))}
    </div>
  );
}

function ApplicationCard({ application }: { application: Application }) {
  const label = applicationBadgeLabel(application);
  return (
    <Card data-testid={`app-card-${application.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>
              <Link
                href={`/dashboard/applications/${application.id}`}
                data-testid={`app-card-name-${application.id}`}
              >
                {application.name}
              </Link>
            </CardTitle>
            <CardDescription>{application.repoFullName}</CardDescription>
          </div>
          <Badge variant="secondary" data-testid={`app-card-badge-${application.id}`}>
            {label}
          </Badge>
        </div>
      </CardHeader>
    </Card>
  );
}
```

with:

```tsx
function ApplicationList({ applications }: { applications: Application[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((app) => (
              <ApplicationRow key={app.id} application={app} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ApplicationRow({ application }: { application: Application }) {
  const label = applicationBadgeLabel(application);
  return (
    <TableRow data-testid={`app-card-${application.id}`}>
      <TableCell className="font-medium">
        <Link
          href={`/dashboard/applications/${application.id}`}
          data-testid={`app-card-name-${application.id}`}
          className="hover:underline"
        >
          {application.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{application.repoFullName}</TableCell>
      <TableCell>
        <Badge variant="secondary" data-testid={`app-card-badge-${application.id}`}>
          {label}
        </Badge>
      </TableCell>
    </TableRow>
  );
}
```

`CardContent` is already imported in this file (used by `RepoList`); `CardHeader`, `CardTitle`, `CardDescription` stay imported too since `RepoList` still uses them — do not remove any existing imports in this task.

- [ ] **Step 3: Type-check and lint**

Run: `pnpm --filter @deployz/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @deployz/web lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/dashboard/applications/page.tsx
git commit -m "refactor(web): render Applications as a table instead of cards"
```

---

## Task 5: Convert Home's DeploymentList to a table

**Files:**
- Modify: `apps/web/src/components/deployment-list.tsx` (full rewrite, 42 lines)
- Modify: `e2e/home.spec.ts:138-139`

**Interfaces:**
- Consumes: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell` from `@/components/ui/table` (Task 1). `Card, CardContent` from `@/components/ui/card`. `DeploymentStatusBadge` (unchanged). `FleetDeployment` type (unchanged).
- Produces: `DeploymentList({ deployments, showApplication })` — same props and same call site in `apps/web/src/app/dashboard/page.tsx:138`, no changes needed there.

The `version` cell must render in every row even when `deployment.version` is `null` (showing `—`), matching how Deployments already handles it — omitting a `<TableCell>` per-row (the old link's conditional rendering) would misalign columns between rows in an actual table. The `showApplication` column, by contrast, is applied uniformly to the whole list (same prop for every row), so it's safe to include/exclude that whole column.

- [ ] **Step 1: Rewrite `deployment-list.tsx`**

Replace the full file content with:

```tsx
import Link from 'next/link';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { FleetDeployment } from '@/lib/deployments';

// The homepage's compact customer-deployment table — the same shared Table
// primitive as every other list screen. The full Customer/Version/Region/
// Status table (plus bulk actions) lives one click deeper, on
// /dashboard/deployments.
export function DeploymentList({
  deployments,
  showApplication,
}: {
  deployments: FleetDeployment[];
  /** Name the application per row — only useful when the org has several. */
  showApplication: boolean;
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="home-deployment-list">
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              {showApplication ? <TableHead>Application</TableHead> : null}
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.map((deployment) => (
              <TableRow key={deployment.id}>
                <TableCell className="font-medium">
                  <Link href={`/dashboard/deployments/${deployment.id}`} className="hover:underline">
                    {deployment.customerName}
                  </Link>
                </TableCell>
                {showApplication ? (
                  <TableCell className="text-muted-foreground">
                    {deployment.applicationName}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground tabular-nums">
                  {deployment.version ?? '—'}
                </TableCell>
                <TableCell>
                  <DeploymentStatusBadge state={deployment.state} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Update the e2e assertion for the new structure**

In `e2e/home.spec.ts`, replace (currently lines 138-139):

```ts
  const list = page.getByTestId('home-deployment-list');
  await expect(list.getByRole('listitem')).toHaveCount(2);
```

with:

```ts
  const list = page.getByTestId('home-deployment-list');
  await expect(list.locator('tbody tr')).toHaveCount(2);
```

(This mirrors the existing pattern in `e2e/fleet.spec.ts:260`, which already queries `[data-testid="deployment-list"] tbody tr` directly rather than by ARIA role.)

- [ ] **Step 3: Type-check and lint**

Run: `pnpm --filter @deployz/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @deployz/web lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/deployment-list.tsx e2e/home.spec.ts
git commit -m "refactor(web): render the homepage deployment list as a table"
```

---

## Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Type-check and lint the whole web app**

Run: `pnpm --filter @deployz/web exec tsc --noEmit && pnpm --filter @deployz/web lint`
Expected: no errors.

- [ ] **Step 2: Build the workspace packages the e2e API server depends on**

Run: `pnpm build`
Expected: succeeds (this is required before `pnpm test:e2e` per `playwright.config.ts`'s header comment — the API needs `@deployz/db`'s `dist` output).

- [ ] **Step 3: Run the affected e2e specs on isolated ports**

Per project history, Playwright can silently reuse an already-running dev server on the default ports and test the wrong build — always override `WEB_PORT`/`API_PORT` to ports nothing else is using locally.

Run (PowerShell):
```powershell
$env:WEB_PORT="3110"; $env:API_PORT="3111"; pnpm test:e2e -- e2e/fleet.spec.ts e2e/applications.spec.ts e2e/home.spec.ts e2e/customers.spec.ts
```

Expected: all tests in those four spec files pass. (`e2e/customers.spec.ts` may not exist — if `pnpm test:e2e` errors that the file is missing, drop it from the command and run the other three; there was no existing e2e coverage for the Customers table before this change.)

If the sandbox can't boot the API/web dev servers at all (e.g. no network egress, no local Postgres and PGlite unavailable), fall back to manual verification: use the `run` skill to start `apps/web` (`pnpm --filter @deployz/web dev`) and visually check all four screens (Home, Applications, Deployments, Customers) render as tables with correct data, working links, and — on Deployments — working checkboxes and bulk-deploy bar.

- [ ] **Step 4: Manual visual check in the browser**

Using the `run` skill (or the already-booted dev server from Step 3), open each of the four screens and confirm:
- All four render an actual `<table>` with consistent header/row styling.
- Deployments: checkboxes still select rows and reveal the bulk-deploy bar; row links still navigate.
- Applications: name links still navigate to the application detail page; status badges still show.
- Customers: all four columns (Name, Email, Company, Created) still show correct data.
- Home: customer/application/version/status columns render, row links navigate to the deployment detail page, and the "View all deployments" link below the table still works.

No commit for this task — it's verification only. If any check fails, fix it in the relevant task's files and re-commit there (do not create a new fixup task).

---

## Self-Review Notes

- **Spec coverage:** every row of the spec's "Per-screen mapping" table has a corresponding task (Deployments → Task 2, Customers → Task 3, Applications → Task 4, Home → Task 5); the shared primitive is Task 1; the required `e2e/home.spec.ts` update is folded into Task 5 per the Task Right-Sizing rule (its test cycle is the same commit as the markup it verifies).
- **Testids preserved:** `deployment-list`, `bulk-deploy-bar`, `home-deployment-list`, `app-card-${id}`, `app-card-name-${id}`, `app-card-badge-${id}` all carried over unchanged — confirmed against every `data-testid`/`getByTestId` usage found in `e2e/fleet.spec.ts` and `e2e/applications.spec.ts`.
- **Out of scope confirmed untouched:** no task modifies empty-state sections, `FleetSummary`, `NeedsAttentionList`, or any `/lib` data-fetching code.
