import Link from 'next/link';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import type { FleetDeployment } from '@/lib/deployments';

// The homepage's compact customer-deployment list. A list of full-width links
// rather than a table, so every row is clickable and stacks cleanly on a
// phone. The full Customer/Version/Region/Status table lives on the
// deployments page.
export function DeploymentList({
  deployments,
  showApplication,
}: {
  deployments: FleetDeployment[];
  /** Name the application per row — only useful when the org has several. */
  showApplication: boolean;
}) {
  return (
    <ul className="flex flex-col" data-testid="home-deployment-list">
      {deployments.map((deployment) => (
        <li key={deployment.id} className="border-b last:border-0">
          <Link
            href={`/dashboard/deployments/${deployment.id}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-3 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="min-w-0 flex-1 font-medium">{deployment.customerName}</span>
            {showApplication ? (
              <span className="text-sm text-muted-foreground">{deployment.applicationName}</span>
            ) : null}
            {deployment.version === null ? null : (
              <span className="text-sm text-muted-foreground tabular-nums">
                {deployment.version}
              </span>
            )}
            <DeploymentStatusBadge state={deployment.state} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
