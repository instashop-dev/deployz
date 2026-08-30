import { Card, CardContent } from '@/components/ui/card';
import type { FleetSummary as FleetSummaryCounts } from '@/lib/home-state';
import { cn } from '@/lib/utils';

// The fleet health summary above the homepage deployment list, as a row of
// compact cards. Deployment outcomes only — no vanity metrics, no charts.
// Counts that are zero are left out so the row stays quiet when nothing
// needs saying. Composed directly from Card — no metric-card abstraction.
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
    <div
      data-testid="fleet-summary"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      {items.map((item) => (
        <Card key={item.label} size="sm" className="gap-0">
          <CardContent className="flex flex-col gap-1 py-4">
            <p
              className={cn(
                'text-2xl font-semibold tabular-nums',
                item.tone === 'attention' && 'text-destructive',
              )}
            >
              {item.value}
            </p>
            <p
              className={cn(
                'text-sm text-muted-foreground',
                item.tone === 'attention' && 'text-destructive',
              )}
            >
              {item.label}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
