import { Badge } from '@/components/ui/badge';
import {
  DEPLOYMENT_STATE_BADGE,
  deploymentStateLabel,
} from '@/lib/deployment-vocabulary';

// §46 status badge — renders the 9 product-vocabulary states, never raw
// AWS/CFN/ECS lifecycle terms. The label + variant both come from
// @/lib/deployment-vocabulary (the single source of truth).
export function DeploymentStatusBadge({ state }: { state: string }) {
  return (
    <Badge variant={DEPLOYMENT_STATE_BADGE[state as keyof typeof DEPLOYMENT_STATE_BADGE] ?? 'secondary'}>
      {deploymentStateLabel(state)}
    </Badge>
  );
}
