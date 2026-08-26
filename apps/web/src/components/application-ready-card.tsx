import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import type { Application } from '@/lib/applications';

// State C — the application is ready and no customer has a deployment yet.
// High-level facts only: the AWS resources behind them stay one click deeper,
// on the application's own setup page.
export function ApplicationReadyCard({ application }: { application: Application }) {
  const runtime = application.detectedMetadata?.['hasDockerfile'] === true ? 'Docker' : null;
  const facts: { label: string; value: string }[] = [
    ...(runtime === null ? [] : [{ label: 'Runtime', value: runtime }]),
    { label: 'Database', value: application.databaseRequired ? 'PostgreSQL' : 'Not required' },
    { label: 'Redis', value: application.redisRequired ? 'Managed automatically' : 'Not required' },
    { label: 'Cloud', value: 'AWS' },
  ];

  return (
    <section aria-labelledby="ready" className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 id="ready" className="text-2xl font-semibold tracking-tight">
          Your application is ready
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {application.name} can be deployed into a customer&apos;s own AWS account.
        </p>
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        {facts.map((fact) => (
          <div key={fact.label} className="flex items-baseline justify-between gap-4 border-b pb-2 last:border-0">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="font-medium">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <p className="flex items-center gap-2 text-sm font-medium">
        <Check className="size-4 shrink-0" aria-hidden />
        Deployment setup ready
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href={`/dashboard/deployments/new?applicationId=${encodeURIComponent(application.id)}`}>
            Deploy first customer
            <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/dashboard/applications/${application.id}`}>View technical setup</Link>
        </Button>
      </div>
    </section>
  );
}
