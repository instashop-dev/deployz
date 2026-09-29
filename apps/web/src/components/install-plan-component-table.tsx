'use client';

import { Fragment } from 'react';

import type { DeploymentPlan } from '@deployz/contracts';

import { Badge } from '@/components/ui/badge';
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
 * The customer's one resource summary (ux-guidelines §8): the plan's CREATE
 * components grouped under generic headings, each with Kept / Removed after
 * removal. AWS sizing and the resource inventory stay under Technical details.
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
          <TableHead>After removal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <Fragment key={group.group}>
            <TableRow className="bg-muted/40">
              <TableCell
                colSpan={3}
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {group.label}
              </TableCell>
            </TableRow>
            {group.rows.map((row, index) => (
              <TableRow key={`${row.kind}-${index}`}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-muted-foreground">{row.whatHappens}</TableCell>
                <TableCell>
                  <Badge variant={row.retained ? 'secondary' : 'outline'}>{row.retained ? 'Kept' : 'Removed'}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
