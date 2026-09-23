'use client';

import type { DeploymentPlan } from '@deployz/contracts';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
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

// The simplified "Planned infrastructure" section for the vendor application
// Configuration tab — a plain-English component list, generic over the
// footprint (see footprintComponentRows), with the exact AWS resource
// inventory tucked behind the existing collapsed disclosure below it.
export function PlannedInfrastructure({ plan }: { plan: DeploymentPlan | null }) {
  const rows = plan?.footprint ? footprintComponentRows(plan.footprint) : null;
  const resourceCount = plan?.awsResources.length ?? 0;

  return (
    <section aria-labelledby="planned-infrastructure" className="flex flex-col gap-3">
      <h2 id="planned-infrastructure" className="text-base font-semibold">
        Planned infrastructure
      </h2>
      {rows === null || rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="planned-infrastructure-empty">
          The plan shows here after a successful analysis.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Each customer deployment gets these components in the customer&apos;s AWS account. One
            component can group several AWS resources — see the details below for the exact list.
          </p>
          <Card className="py-0">
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="planned-infrastructure-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead>Provisioned as</TableHead>
                    <TableHead>Configuration</TableHead>
                    <TableHead>On uninstall</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} data-testid={`planned-component-${row.id}`}>
                      <TableCell className="font-medium">{row.component}</TableCell>
                      <TableCell>{row.provisionedAs}</TableCell>
                      <TableCell className="text-muted-foreground">{row.configuration ?? 'Standard'}</TableCell>
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
          <p className="text-xs text-muted-foreground">
            &quot;On uninstall&quot; describes what happens to each component when a customer
            uninstalls the deployment — kept components stay in the customer&apos;s AWS account.
          </p>
          <AwsInfrastructureDetails
            plan={plan}
            triggerLabel={`AWS resource details · ${resourceCount} resource${resourceCount === 1 ? '' : 's'}`}
          />
        </>
      )}
    </section>
  );
}
