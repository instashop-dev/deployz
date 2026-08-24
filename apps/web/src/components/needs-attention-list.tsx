import { ArrowRight, TriangleAlert } from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';
import type { AttentionItem } from '@/lib/home-state';

// The deployments a vendor has to act on, ahead of the full list. Rendered
// only when there is at least one — a "nothing is wrong" card would be noise.
export function NeedsAttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="needs-attention" className="flex flex-col gap-3">
      <h2 id="needs-attention" className="text-base font-semibold">
        Needs attention
      </h2>
      <div className="flex flex-col gap-2" data-testid="needs-attention">
        {items.map(({ deployment, reason }) => (
          <Card key={deployment.id} size="sm">
            <CardContent>
              <Link
                href={`/dashboard/deployments/${deployment.id}`}
                className="flex items-start gap-3 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{deployment.customerName}</span>
                  <span className="block text-sm text-destructive">{reason}</span>
                  <span className="block text-xs text-muted-foreground">
                    {deployment.applicationName}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
                  View
                  <ArrowRight className="size-3.5" aria-hidden />
                </span>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
