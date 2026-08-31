import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Button } from '@/components/ui/button';
import type { FleetDeployment } from '@/lib/deployments';

// State D — the organization's only deployment is still being set up, so the
// homepage follows it instead of showing a one-row fleet. The stage shown is
// the deployment's real §46 state; no invented progress steps.
export function FirstDeploymentCard({ deployment }: { deployment: FleetDeployment }) {
  const waiting =
    deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY';

  return (
    <section aria-labelledby="first-deployment" className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 id="first-deployment" className="text-2xl font-semibold tracking-tight">
          {waiting
            ? `Waiting for ${deployment.customerName} to install`
            : `Deploying ${deployment.customerName}`}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{deployment.applicationName}</p>
      </div>

      <div className="flex items-center gap-3">
        <DeploymentStatusBadge state={deployment.state} />
        <p className="text-sm text-muted-foreground">
          {waiting
            ? 'Send them their install link, then this deployment sets itself up.'
            : 'Setting up this deployment in your customer’s AWS account.'}
        </p>
      </div>

      <div>
        <Button asChild>
          <Link href={`/dashboard/deployments/${deployment.id}`}>
            View deployment
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </section>
  );
}
