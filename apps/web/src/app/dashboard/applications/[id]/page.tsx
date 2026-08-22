'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { OnboardingFlow } from '@/components/onboarding-flow';
import { ReadinessResult } from '@/components/readiness-result';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplication, type Application } from '@/lib/applications';
import { fetchDeploymentsForApplication } from '@/lib/deployments';
import { deriveOnboardingStep, fetchReadiness, type ApplicationReadiness } from '@/lib/readiness';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'loaded';
      application: Application;
      readiness: ApplicationReadiness;
      testDeploymentCreated: boolean;
    };

// Application readiness page — §42 steps 2-6 live here (step 1, Connect
// GitHub, lives on the Applications page). Renders the six-step onboarding
// flow with the current step derived from real state, then the §19
// deterministic verdict, then the §7 test-deployment CTA when the app is
// ready. All data is real: application + readiness + whether a test
// deployment already exists (no fixture fallback masking a 404).
export default function ApplicationReadinessPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [application, readiness, deployments] = await Promise.all([
          fetchApplication(id),
          fetchReadiness(id),
          fetchDeploymentsForApplication(id),
        ]);
        if (cancelled) return;
        setState({
          status: 'loaded',
          application,
          readiness,
          testDeploymentCreated: deployments.some((d) => d.isTestDeployment),
        });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load this application. Try again in a moment.",
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/applications">
            <ArrowLeft aria-hidden className="size-4" />
            Applications
          </Link>
        </Button>
      </div>

      {state.status === 'loading' ? <PageSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="readiness-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="readiness-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <ReadinessBody
          application={state.application}
          readiness={state.readiness}
          testDeploymentCreated={state.testDeploymentCreated}
        />
      ) : null}
    </div>
  );
}

function ReadinessBody({
  application,
  readiness,
  testDeploymentCreated,
}: {
  application: Application;
  readiness: ApplicationReadiness;
  testDeploymentCreated: boolean;
}) {
  const currentStep = deriveOnboardingStep({
    analysisStatus: readiness.analysisStatus,
    verdict: readiness.verdict,
    testDeploymentCreated,
  });

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{application.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{application.repoFullName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/dashboard/applications/${application.id}/releases`}>Releases</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/dashboard/applications/${application.id}/config`}>Configuration</Link>
          </Button>
        </div>
      </div>

      <section aria-labelledby="onboarding" className="flex flex-col gap-3">
        <h2 id="onboarding" className="text-base font-semibold">
          Getting your app ready
        </h2>
        <OnboardingFlow currentStep={currentStep} />
      </section>

      <ReadinessResult readiness={readiness} />

      {readiness.verdict === 'READY' && !testDeploymentCreated ? (
        <TestDeploymentCard applicationId={application.id} />
      ) : null}
    </>
  );
}

// §7 the vendor's own test deployment is not charged (isTestDeployment) —
// only customer deployments are billed.
function TestDeploymentCard({ applicationId }: { applicationId: string }) {
  return (
    <Card data-testid="test-deployment">
      <CardHeader>
        <CardTitle>Create test deployment</CardTitle>
        <CardDescription>
          Run your app as your own first deployment before your first customer installs it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <Button asChild>
            <Link href={`/dashboard/deployments/new?applicationId=${applicationId}&test=true`}>
              Create test deployment
            </Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Your own test deployment is not charged — the per-deployment fee only applies to
          customer deployments.
        </p>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="readiness-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
