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
import { buildAwsResourceSections, retentionSummary } from '@/lib/customer-install-resources';
import { formatMonthlyRange } from '@/lib/footprint';

/**
 * The canonical customer AWS resources table — replaces the prior
 * "What Deployz creates" / "AWS infrastructure details" / "Planned
 * infrastructure" / "Estimated AWS infrastructure" surfaces with one
 * visible table. Every detailed AWS resource the plan carries is shown
 * by default (no accordion). Cost per row is only rendered when the
 * existing cost model already supplies it. Total cost lives inside this
 * section, below the table.
 */
export function AwsResourcesTable({ plan }: { plan: DeploymentPlan | null }) {
  const sections = buildAwsResourceSections(plan);
  if (sections.length === 0) {
    return null;
  }
  const totalRange = formatMonthlyRange(
    plan?.costEstimate?.monthlyMin ?? null,
    plan?.costEstimate?.monthlyMax ?? null,
  );
  const estimateIncomplete = plan?.costEstimate ? !plan.costEstimate.complete : false;
  const retention = retentionSummary(plan);

  return (
    <section aria-labelledby="aws-resources" className="flex flex-col gap-3">
      <h2 id="aws-resources" className="text-base font-semibold">
        AWS resources
      </h2>
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
      {retention ? (
        <p className="text-sm text-muted-foreground" data-testid="aws-resources-retention">
          {retention}
        </p>
      ) : null}
      <div className="flex flex-col gap-1" data-testid="aws-resources-total">
        <p className="text-sm font-medium">Estimated total</p>
        {totalRange ? (
          <p className="text-2xl font-semibold tracking-tight">{totalRange}</p>
        ) : (
          <p className="text-sm text-muted-foreground">AWS cost estimate unavailable.</p>
        )}
        {estimateIncomplete ? (
          <p className="text-xs text-muted-foreground">
            Estimate is incomplete — some resources could not be priced.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Estimated AWS cost. AWS bills your account directly; actual charges depend on usage.
        </p>
      </div>
    </section>
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