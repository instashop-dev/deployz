import Link from 'next/link';
import type { ReactNode } from 'react';

import type { DeploymentPlan } from '@deployz/contracts';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { FootprintCost } from '@/components/footprint-cost';
import { FootprintSummary } from '@/components/footprint-summary';
import { InstallPlanComponentTable } from '@/components/install-plan-component-table';
import { TablePanel } from '@/components/table-panel';
import { TechnicalDetails } from '@/components/technical-details';
import { Button } from '@/components/ui/button';
import { installPlanRetentionNote, RETENTION_CHARGES_NOTE } from '@/lib/install-plan';

// The customer's one pre-deploy review (ux-guidelines §1, §8), shared by the
// public install flow, the install page and the hosted deploy page: what is
// created (with Kept / Removed after removal), the estimated AWS cost, and
// what Deployz can access. AWS sizing and the resource inventory stay under
// Technical details. Everything renders from the API's plan.
export function CustomerInstallReview({
  plan,
  estimateUnavailable = false,
  securityHref,
  securityInNewTab = false,
  technicalExtra,
}: {
  plan: DeploymentPlan | null;
  /** The per-Region estimate could not be fetched — never show a stale one. */
  estimateUnavailable?: boolean;
  /** The Security details page for this link, when the link can open it. */
  securityHref: string | null;
  /** Keeps a half-filled form open behind the Security details page. */
  securityInNewTab?: boolean;
  /** Page identifiers that belong in the same one Technical details. */
  technicalExtra?: ReactNode;
}) {
  const retentionNote = installPlanRetentionNote(plan);

  return (
    <>
      <section aria-labelledby="install-resources" className="flex flex-col gap-3">
        <h2 id="install-resources" className="text-base font-semibold">
          What Deployz creates in your AWS account
        </h2>
        <TablePanel>
          <InstallPlanComponentTable plan={plan} />
        </TablePanel>
        <p className="text-sm text-muted-foreground">
          Deployz also creates the Deployz connector, which Deployz uses to create and update this
          deployment. It stays until you delete its stack.
        </p>
        {retentionNote ? (
          <p className="text-sm text-muted-foreground" data-testid="install-retention-warning">
            {retentionNote} {RETENTION_CHARGES_NOTE}
          </p>
        ) : null}
        {plan || technicalExtra ? (
          <TechnicalDetails>
            {plan ? (
              <>
                <FootprintSummary footprint={plan.footprint} stage="planned" />
                <AwsInfrastructureDetails plan={plan} />
              </>
            ) : null}
            {technicalExtra}
          </TechnicalDetails>
        ) : null}
      </section>

      {estimateUnavailable ? (
        <p className="text-sm text-muted-foreground" data-testid="footprint-cost-unavailable">
          AWS cost estimate unavailable for this Region.
        </p>
      ) : (
        <FootprintCost estimate={plan?.costEstimate} />
      )}

      <section aria-labelledby="install-access" className="flex flex-col gap-3">
        <h2 id="install-access" className="text-base font-semibold">
          What Deployz can access
        </h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            You approve the Deployz connector in your own AWS account. Deployz never sees or stores
            your AWS credentials.
          </li>
          <li>
            The connector creates, updates and removes this deployment&apos;s resources. It only
            calls out to Deployz; Deployz never connects in.
          </li>
          <li>Your application data and logs stay in your AWS account.</li>
        </ul>
        {securityHref ? (
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href={securityHref} {...(securityInNewTab ? { target: '_blank', rel: 'noreferrer' } : {})}>
              Security details
            </Link>
          </Button>
        ) : null}
      </section>
    </>
  );
}
