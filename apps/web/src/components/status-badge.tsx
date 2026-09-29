import { Badge } from '@/components/ui/badge';
import { deploymentDisplayStatus } from '@/lib/deployment-status-groups';
import type { FleetDeployment } from '@/lib/deployments';

// The vendor deployment status (ux-guidelines §5): one classifier, the same
// words on Home, lists and the detail page.
export function StatusBadge({ deployment, className }: { deployment: FleetDeployment; className?: string }) {
  const status = deploymentDisplayStatus(deployment);
  return (
    <Badge variant={status.badge} className={className} data-testid="deployment-status-badge">
      {status.label}
    </Badge>
  );
}
