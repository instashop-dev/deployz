import { ArrowRight, Check, LoaderCircle, Minus } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import type { Application } from '@/lib/applications';
import { preparationChecks, type PreparationCheck } from '@/lib/home-state';

// State B — an application is connected, but it is not ready for a customer
// deployment yet. Every line comes from what the analyser actually persisted;
// nothing is reported as detected until analysis has finished.
export function ApplicationPreparingCard({ application }: { application: Application }) {
  const checks = preparationChecks(application);
  const action = requiredAction(application);

  return (
    <section aria-labelledby="preparing" className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 id="preparing" className="text-2xl font-semibold tracking-tight">
          Preparing {application.name}
        </h1>
        <a
          href={application.repoUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {application.repoFullName}
        </a>
      </div>

      <ul className="flex flex-col gap-2" data-testid="preparation-checks">
        {checks.map((check) => (
          <li key={check.label} className="flex items-center gap-3 text-sm">
            <CheckIcon state={check.state} />
            <span className={check.state === 'missing' ? 'text-muted-foreground' : undefined}>
              {check.label}
            </span>
            {check.detail === null ? null : (
              <span className="ml-auto truncate text-muted-foreground">{check.detail}</span>
            )}
            <span className="sr-only">{STATE_WORDS[check.state]}</span>
          </li>
        ))}
      </ul>

      {action === null ? (
        <p className="text-sm text-muted-foreground">
          Deployz is preparing your application for private deployment.
        </p>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-xl border p-4">
          <div>
            <h2 className="text-base font-semibold">{action.heading}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{action.detail}</p>
          </div>
          <Button asChild size="sm">
            <Link href={`/dashboard/applications/${application.id}`}>
              Review deployment setup
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}

const STATE_WORDS: Record<PreparationCheck['state'], string> = {
  complete: 'Done',
  pending: 'In progress',
  missing: 'Not detected',
};

function CheckIcon({ state }: { state: PreparationCheck['state'] }) {
  if (state === 'complete') return <Check className="size-4 shrink-0" aria-hidden />;
  if (state === 'pending') {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
  }
  return <Minus className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/** The one thing we need from the vendor, when the analysis cannot proceed alone. */
function requiredAction(application: Application): { heading: string; detail: string } | null {
  if (application.analysisStatus === 'FAILED') {
    return {
      heading: 'We could not finish preparing this application',
      detail:
        application.compatibilityReason ??
        'Check the repository we analysed, then try preparing it again.',
    };
  }
  if (application.analysisStatus !== 'COMPLETE') return null;
  if (application.compatibilityStatus === 'READY') return null;
  return {
    heading: 'We need a few details',
    detail:
      application.compatibilityReason ??
      'A few things about this application need your input before a customer can be deployed.',
  };
}
