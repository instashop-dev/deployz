import { Fragment } from 'react';

import type { DeploymentPlan } from '@deployz/contracts';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { INSTALL_RESOURCE_REMOVAL_LABEL, installPlanResourceGroups } from '@/lib/install-plan';
import { formatMonthlyRange } from '@/lib/footprint';

const PERSISTENT_NOTE = 'Persistent · retained';

/** One row of the install plan table — desktop and stacked-mobile variants
 *  share these derived flags so neither presentation can drift. */
function isRetainedRow(row: { onRemoval: string }): boolean {
  return row.onRemoval === INSTALL_RESOURCE_REMOVAL_LABEL.retain;
}

/**
 * The install page's single infrastructure table: the Deployz connector's
 * resources and the application's, grouped by the shared catalog order. Every
 * row comes from the canonical resource model (`installPlanResourceGroups`),
 * so retention wording, sizing and future resource types need no page-level
 * changes. Renders as a real table at md+ and as stacked rows below it, with no
 * horizontal overflow on small screens. When a cost estimate is available, an
 * "Est. cost / month" column shows the per-row pricing the cost model already
 * has — never invented — and the table footer carries the authoritative total.
 * A concise "Persistent · retained" note tags the Configuration cell for any
 * resource whose lifecycle is `retain`, so the customer can spot retention
 * without a dedicated column.
 */
export function InstallPlanTable({
  plan,
  regionLabel,
}: {
  plan: DeploymentPlan | null;
  regionLabel: string | null;
}) {
  const groups = installPlanResourceGroups(plan);
  if (groups.length === 0) return null;

  const estimate = plan?.costEstimate ?? null;
  const totalLabel = estimate ? formatMonthlyRange(estimate.monthlyMin, estimate.monthlyMax) : null;
  const showCost = Boolean(estimate);

  return (
    <div className="flex flex-col gap-3">
      {regionLabel ? (
        <p className="text-sm text-muted-foreground">Region: {regionLabel}</p>
      ) : null}

      <div className="hidden overflow-x-auto rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[8rem]">AWS resource</TableHead>
              <TableHead>Purpose</TableHead>
              <TableHead>Configuration</TableHead>
              {showCost ? (
                <TableHead className="whitespace-nowrap text-right">Est. cost / month</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <Fragment key={group.group}>
                <TableRow className="bg-muted/40">
                  <TableCell
                    colSpan={showCost ? 4 : 3}
                    className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {group.label}
                  </TableCell>
                </TableRow>
                {group.rows.map((row) => {
                  const retained = isRetainedRow(row);
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium align-top">{row.name}</TableCell>
                      <TableCell className="whitespace-pre-line text-muted-foreground align-top">
                        {row.purpose}
                      </TableCell>
                      <TableCell className="whitespace-pre-line text-muted-foreground align-top">
                        {row.serviceAndConfiguration}
                        {retained ? (
                          <span
                            className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                            data-testid={`install-plan-row-retained-${row.id}`}
                          >
                            {PERSISTENT_NOTE}
                          </span>
                        ) : null}
                      </TableCell>
                      {showCost ? (
                        <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                          {row.costCell ?? '—'}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </Fragment>
            ))}
          </TableBody>
          {showCost && totalLabel ? (
            <tfoot>
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="border-t-2 pt-3 text-sm font-medium"
                  data-testid="install-plan-table-total-label"
                >
                  Estimated total
                </TableCell>
                <TableCell
                  className="border-t-2 pt-3 text-right text-sm font-semibold tabular-nums"
                  data-testid="install-plan-table-total"
                >
                  {totalLabel}
                </TableCell>
              </TableRow>
            </tfoot>
          ) : null}
        </Table>
      </div>

      <div className="flex flex-col gap-4 md:hidden">
        {groups.map((group) => (
          <section key={group.group} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h3>
            {group.rows.map((row) => {
              const retained = isRetainedRow(row);
              return (
                <div key={row.id} className="flex flex-col gap-1 rounded-md border p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">{row.name}</span>
                    {showCost ? (
                      <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                        {row.costCell ?? '—'}
                      </span>
                    ) : null}
                  </div>
                  <div className="whitespace-pre-line text-xs text-muted-foreground">{row.purpose}</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-pre-line text-xs text-muted-foreground">
                    <span>{row.serviceAndConfiguration}</span>
                    {retained ? (
                      <span
                        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                        data-testid={`install-plan-row-retained-${row.id}`}
                      >
                        {PERSISTENT_NOTE}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        {showCost && totalLabel ? (
          <div
            className="flex items-baseline justify-between gap-3 rounded-md border-t pt-3 text-sm"
            data-testid="install-plan-table-total"
          >
            <span className="font-medium">Estimated total</span>
            <span className="font-semibold tabular-nums">{totalLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
