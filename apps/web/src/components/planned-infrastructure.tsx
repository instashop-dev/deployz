'use client';

import type { DeploymentPlan } from '@deployz/contracts';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { TechnicalDetails } from '@/components/technical-details';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { footprintComponentRows } from '@/lib/footprint';

// What customers get in Configuration › Services: each component and whether
// it is kept or removed when a deployment is removed (primary decision
// information, ux-guidelines §8). AWS sizing and the resource inventory sit
// under Technical details.
export function PlannedInfrastructure({ plan }: { plan: DeploymentPlan | null }) {
  const rows = plan?.footprint ? footprintComponentRows(plan.footprint) : null;
  const resourceCount = plan?.awsResources.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      {rows === null || rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="planned-infrastructure-empty">
          The plan shows here after a successful analysis.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Kept components stay in the customer&apos;s AWS account after the deployment is removed,
            and can keep costing money until the retained data is deleted.
          </p>
          <Card className="py-0">
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="planned-infrastructure-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead>After removal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} data-testid={`planned-component-${row.id}`}>
                      <TableCell className="font-medium">{row.component}</TableCell>
                      <TableCell>
                        <Badge variant={row.retention === 'Retained' ? 'secondary' : 'outline'}>
                          {row.retention === 'Retained' ? 'Kept' : 'Removed'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <TechnicalDetails>
            <Card className="py-0">
              <CardContent className="overflow-x-auto p-0">
                <Table data-testid="planned-infrastructure-sizing">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Component</TableHead>
                      <TableHead>Provisioned as</TableHead>
                      <TableHead>Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.component}</TableCell>
                        <TableCell>{row.provisionedAs}</TableCell>
                        <TableCell className="text-muted-foreground">{row.configuration ?? 'Standard'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <AwsInfrastructureDetails
              plan={plan}
              triggerLabel={`AWS resources · ${resourceCount} resource${resourceCount === 1 ? '' : 's'}`}
            />
          </TechnicalDetails>
        </>
      )}
    </div>
  );
}
