import Link from 'next/link';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isTestDeployment } from '@/lib/deployment-billing';
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
    <Card className="py-0">
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="home-deployment-list">
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              {showApplication ? <TableHead>Application</TableHead> : null}
              <TableHead>Version</TableHead>
              <TableHead>Region</TableHead>
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
                  {/* Phase 11: a test deployment is free — say so where the
                      vendor scans the fleet, not only on the detail page. */}
                  {isTestDeployment(deployment) ? (
                    <Badge variant="secondary" className="ml-2">
                      Test · Free
                    </Badge>
                  ) : null}
                </TableCell>
                {showApplication ? (
                  <TableCell className="text-muted-foreground">
                    {deployment.applicationName}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground tabular-nums">
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
      </CardContent>
    </Card>
  );
}
