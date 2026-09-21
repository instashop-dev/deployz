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
import { installPlanResourceGroups } from '@/lib/install-plan';

/**
 * The install page's single infrastructure table: the Deployz connector's
 * resources and the application's, grouped by the shared catalog order. Every
 * row comes from the canonical resource model (`installPlanResourceGroups`),
 * so retention wording, sizing and future resource types need no page-level
 * changes. Renders as a real table at md+ and as stacked rows below it, with no
 * horizontal overflow on small screens.
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

  return (
    <div className="flex flex-col gap-3">
      {regionLabel ? (
        <p className="text-sm text-muted-foreground">Region: {regionLabel}</p>
      ) : null}

      <div className="hidden overflow-x-auto rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resource</TableHead>
              <TableHead>AWS service and configuration</TableHead>
              <TableHead>Purpose</TableHead>
              <TableHead>On removal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <Fragment key={group.group}>
                <TableRow className="bg-muted/40">
                  <TableCell
                    colSpan={4}
                    className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {group.label}
                  </TableCell>
                </TableRow>
                {group.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.serviceAndConfiguration}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.purpose}</TableCell>
                    <TableCell className="text-muted-foreground">{row.onRemoval}</TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-4 md:hidden">
        {groups.map((group) => (
          <section key={group.group} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h3>
            {group.rows.map((row) => (
              <div key={row.id} className="flex flex-col gap-1 rounded-md border p-3">
                <div className="text-sm font-medium">{row.name}</div>
                <div className="text-xs text-muted-foreground">{row.serviceAndConfiguration}</div>
                <div className="text-xs text-muted-foreground">{row.purpose}</div>
                <div className="text-xs text-muted-foreground">{row.onRemoval}</div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
