'use client';

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
import { installPlanRowGroups } from '@/lib/install-plan';

/**
 * The grouped "Deployz will create" component table shared by the public
 * install flow and the hosted deploy page. Rows come from the plan's CREATE
 * components, grouped by their presentation group, in canonical order.
 */
export function InstallPlanComponentTable({ plan }: { plan: DeploymentPlan | null }) {
  const groups = installPlanRowGroups(plan);
  if (groups.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead>What happens</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <Fragment key={group.group}>
            <TableRow className="bg-muted/40">
              <TableCell
                colSpan={2}
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {group.label}
              </TableCell>
            </TableRow>
            {group.rows.map((row, index) => (
              <TableRow key={`${row.kind}-${index}`}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-muted-foreground">{row.whatHappens}</TableCell>
              </TableRow>
            ))}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
