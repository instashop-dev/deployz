import type { FleetSummary as FleetSummaryCounts } from '@/lib/home-state';
import { cn } from '@/lib/utils';

// The one-line fleet health summary above the homepage deployment list.
// Deployment outcomes only — no vanity metrics, no charts. Counts that are
// zero are left out so the row stays quiet when nothing needs saying.
export function FleetSummary({ summary }: { summary: FleetSummaryCounts }) {
  const items: { label: string; value: number; tone?: 'attention' }[] = [
    { label: summary.total === 1 ? 'Customer' : 'Customers', value: summary.total },
    { label: 'Healthy', value: summary.healthy },
  ];
  if (summary.attention > 0) {
    items.push({ label: 'Needs attention', value: summary.attention, tone: 'attention' });
  }
  if (summary.deploying > 0) items.push({ label: 'Deploying', value: summary.deploying });
  if (summary.waiting > 0) items.push({ label: 'Waiting to install', value: summary.waiting });

  return (
    <dl
      data-testid="fleet-summary"
      className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm"
    >
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt className={cn('order-2 text-muted-foreground', item.tone === 'attention' && 'text-destructive')}>
            {item.label}
          </dt>
          <dd className={cn('order-1 font-semibold tabular-nums', item.tone === 'attention' && 'text-destructive')}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
