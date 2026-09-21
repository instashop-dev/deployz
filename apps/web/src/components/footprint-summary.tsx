'use client';

import type { DeploymentFootprint } from '@deployz/contracts';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { footprintRows } from '@/lib/footprint';

// The deployment footprint summary shared by the vendor application page and
// the customer install/deploy surfaces. Renders `footprint.workloads` and
// `footprint.resources` verbatim — one row per workload or managed resource,
// generic over role/category, so a future resource type renders without new
// display code (unknown entries fall back to their label and service name).
// Sizing, lifecycle wording and AWS identifiers all come from the footprint;
// this component adds none.
export function FootprintSummary({
  footprint,
  stage = 'planned',
}: {
  footprint: DeploymentFootprint | null | undefined;
  /** Planned: before provisioning. Deployed: the configuration that is running. */
  stage?: 'planned' | 'deployed';
}) {
  if (!footprint || (footprint.workloads.length === 0 && footprint.resources.length === 0)) return null;

  const rows = footprintRows(footprint);

  return (
    <div className="flex flex-col gap-3" data-testid={`footprint-summary-${stage}`} data-stage={stage}>
      <h3 className="text-sm font-medium">{stage === 'deployed' ? 'Deployed infrastructure' : 'Planned infrastructure'}</h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resource</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>When removed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-testid={`footprint-row-${row.id}`}>
                <TableCell>
                  <div className="font-medium">{row.title}</div>
                  {row.detail ? <div className="text-xs text-muted-foreground">{row.detail}</div> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">{row.primary}</TableCell>
                <TableCell className="text-muted-foreground">{row.lifecycle ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
