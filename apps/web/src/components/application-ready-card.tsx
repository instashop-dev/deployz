import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import type { Application } from '@/lib/applications';
import { databaseEngineName } from '@/lib/readiness';

// State C — the analysis passed and no customer has a deployment yet. The
// application page owns the next step (test, then share); this card only
// points there.
export function ApplicationReadyCard({ application }: { application: Application }) {
  const runtime = application.detectedMetadata?.['hasDockerfile'] === true ? 'Docker' : null;
  const facts: { label: string; value: string }[] = [
    ...(runtime === null ? [] : [{ label: 'Runtime', value: runtime }]),
    {
      label: 'Database',
      value: application.databaseRequired ? databaseEngineName(application.detectedMetadata?.['databaseState']) : 'Not required',
    },
    { label: 'Redis', value: application.redisRequired ? 'Managed automatically' : 'Not required' },
    { label: 'Cloud', value: 'AWS' },
  ];

  return (
    <section aria-labelledby="ready" className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 id="ready" className="text-2xl font-semibold tracking-tight">
          Your application is analysed
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Next, test {application.name} in your own AWS account, then share the install link with
          customers.
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

      <div>
        <Button asChild>
          <Link href={`/dashboard/applications/${application.id}`}>
            Continue setup
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </section>
  );
}
