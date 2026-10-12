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
import { buildAwsResourceSections } from '@/lib/customer-install-resources';

/**
 * The complete customer AWS resources table: every resource the plan
 * carries, grouped, with its purpose, configuration and per-row cost when
 * the cost model supplies one. The customer review shows it inside the
 * "View AWS resources" disclosure, under the compact category summary.
 */
export function AwsResourcesTable({ plan }: { plan: DeploymentPlan | null }) {
  const sections = buildAwsResourceSections(plan);
  if (sections.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto rounded-md border" data-testid="aws-resources-table-wrapper">
      <Table data-testid="aws-resources-table">
        <TableHeader>
          <TableRow>
            <TableHead>AWS resource</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead>Configuration</TableHead>
            <TableHead className="text-right">Est. cost / month</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map((section) => (
            <TableSection key={section.group} group={section.group} label={section.label} rows={section.rows} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TableSection({
  group,
  label,
  rows,
}: {
  group: string;
  label: string;
  rows: ReturnType<typeof buildAwsResourceSections>[number]['rows'];
}) {
  return (
    <>
      <TableRow data-testid={`aws-resources-group-${group}`}>
        <TableCell colSpan={4} className="bg-muted/40 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </TableCell>
      </TableRow>
      {rows.map((row) => (
        <TableRow key={row.id} data-testid={`aws-resource-row-${row.id}`}>
          <TableCell className="font-medium">{row.name}</TableCell>
          <TableCell className="text-muted-foreground">{row.purpose}</TableCell>
          <TableCell className="text-muted-foreground">{row.configuration}</TableCell>
          <TableCell className="text-right">
            {row.cost ? <CostBadge status={row.cost} /> : <span aria-hidden>{'\u2014'}</span>}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function CostBadge({ status }: { status: { kind: string; label: string } }) {
  switch (status.kind) {
    case 'included':
      return <Badge variant="secondary">{status.label}</Badge>;
    case 'usage_based':
      return <Badge variant="outline">{status.label}</Badge>;
    case 'unpriced':
      return <Badge variant="outline">{status.label}</Badge>;
    case 'estimated':
    default:
      return <span className="text-sm font-medium">{status.label}</span>;
  }
}