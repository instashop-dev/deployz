import type { DeploymentPlan } from '@deployz/contracts';

import { AwsResourcesTable } from '@/components/aws-resources-table';
import { BeforeYouDeploySection } from '@/components/before-you-deploy-section';
import { EnvVarsTable } from '@/components/env-vars-table';

/**
 * The pre-launch review surface for the customer install page. Renders
 * the three required content blocks — AWS resources, environment
 * variables, Before you deploy — in the canonical order. Replaces the
 * previous four overlapping surfaces ("What Deployz creates", "Planned
 * infrastructure", "AWS infrastructure details", "Estimated AWS
 * infrastructure") plus the scattered "What Deployz can access" list.
 *
 * The vendor-facing CustomerInstallReview is untouched; this component
 * is the customer install page's own one-section assembler and never
 * shares that composition.
 */
export function CustomerInstallSections({
  plan,
  applicationName,
  securityHref,
  envVarInputs,
}: {
  plan: DeploymentPlan | null;
  applicationName: string;
  securityHref?: string;
  /** Read-only inputs the customer page already receives — never renders values. */
  envVarInputs?: ReadonlyArray<{
    key: string;
    required: boolean;
    secret: boolean;
    classification?: string;
    purpose?: string;
    label?: string;
  }>;
}) {
  return (
    <div className="flex flex-col gap-10" data-testid="customer-install-sections">
      <AwsResourcesTable plan={plan} />
      <EnvVarsTable
        inputs={envVarInputs ?? []}
        emptyState={
          <p className="text-sm text-muted-foreground">
            The publisher did not declare any environment variables for this deployment.
          </p>
        }
      />
      <BeforeYouDeploySection
        applicationName={applicationName}
        {...(securityHref ? { securityHref } : {})}
      />
    </div>
  );
}