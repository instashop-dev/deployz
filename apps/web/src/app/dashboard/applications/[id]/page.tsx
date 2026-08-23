'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { OnboardingFlow } from '@/components/onboarding-flow';
import { ReadinessResult } from '@/components/readiness-result';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  deleteApplication,
  fetchApplication,
  triggerAnalysis,
  updateApplication,
  type AnalysisStatus,
  type Application,
  type UpdateApplicationInput,
} from '@/lib/applications';
import { fetchDeploymentsForApplication } from '@/lib/deployments';
import { deriveOnboardingStep, fetchReadiness, type ApplicationReadiness } from '@/lib/readiness';

/** How often to re-check a still-running analysis (§19). */
const ANALYSIS_POLL_MS = 2000;

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

  const analysisStatus = state.status === 'loaded' ? state.readiness.analysisStatus : null;

  // Analysis runs in the background on the API, so the first load can land
  // while it is still PENDING/ANALYZING. Poll until it settles — otherwise the
  // page shows "Analysing your app" until the vendor reloads by hand.
  useEffect(() => {
    if (analysisStatus !== 'PENDING' && analysisStatus !== 'ANALYZING') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchReadiness(id)
        .then((readiness) => {
          if (cancelled) return;
          setState((prev) => (prev.status === 'loaded' ? { ...prev, readiness } : prev));
        })
        .catch(() => {
          /* A transient failure just means the next tick tries again. */
        });
    }, ANALYSIS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [analysisStatus, id]);

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
          onApplicationUpdated={(next) =>
            setState((prev) => (prev.status === 'loaded' ? { ...prev, application: next } : prev))
          }
          onReanalyseTriggered={() => {
            void fetchReadiness(id)
              .then((readiness) =>
                setState((prev) =>
                  prev.status === 'loaded' ? { ...prev, readiness } : prev,
                ),
              )
              .catch(() => {
                /* A transient failure just means the next poll tick tries again. */
              });
          }}
        />
      ) : null}
    </div>
  );
}

function ReadinessBody({
  application,
  readiness,
  testDeploymentCreated,
  onApplicationUpdated,
  onReanalyseTriggered,
}: {
  application: Application;
  readiness: ApplicationReadiness;
  testDeploymentCreated: boolean;
  onApplicationUpdated: (next: Application) => void;
  onReanalyseTriggered: () => void;
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

      <ApplicationDetailsSection
        application={application}
        analysisStatus={readiness.analysisStatus}
        onApplicationUpdated={onApplicationUpdated}
        onReanalyseTriggered={onReanalyseTriggered}
      />

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

      <DeleteApplicationPanel application={application} />
    </>
  );
}

function ApplicationDetailsSection({
  application,
  analysisStatus,
  onApplicationUpdated,
  onReanalyseTriggered,
}: {
  application: Application;
  analysisStatus: AnalysisStatus;
  onApplicationUpdated: (next: Application) => void;
  onReanalyseTriggered: () => void;
}) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [version, setVersion] = useState(0);
  const [triggering, setTriggering] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const containerPortRaw = String(formData.get('containerPort') ?? '').trim();
    const input: UpdateApplicationInput = {
      name: String(formData.get('name') ?? '').trim(),
      containerPort: containerPortRaw === '' ? null : Number(containerPortRaw),
      healthPath: String(formData.get('healthPath') ?? '').trim() || null,
      migrationCommand: String(formData.get('migrationCommand') ?? '').trim() || null,
      workerCommand: String(formData.get('workerCommand') ?? '').trim() || null,
      databaseRequired: formData.get('databaseRequired') === 'on',
      storageRequired: formData.get('storageRequired') === 'on',
    };
    setSaveState('saving');
    try {
      const next = await updateApplication(application.id, input);
      onApplicationUpdated(next);
      setVersion((current) => current + 1);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  async function handleReanalyse(): Promise<void> {
    setTriggering(true);
    try {
      await triggerAnalysis(application.id);
      onReanalyseTriggered();
    } catch {
      setTriggering(false);
    }
  }

  const reanalyseDisabled = analysisStatus === 'ANALYZING' || triggering;

  return (
    <Card data-testid="app-details">
      <CardHeader>
        <CardTitle>Application details</CardTitle>
        <CardDescription>
          These settings control how Deployz runs your application. Changes apply to future
          deployments. Deployz detected some values automatically — your changes take precedence.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form
          key={version}
          onSubmit={handleSubmit}
          className="flex flex-col gap-5"
          data-testid="app-details-form"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-details-field-name">Name</Label>
            <Input
              id="app-details-field-name"
              name="name"
              data-testid="app-details-field-name"
              defaultValue={application.name}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="app-details-field-containerPort">Container port</Label>
              <Input
                id="app-details-field-containerPort"
                name="containerPort"
                type="number"
                data-testid="app-details-field-containerPort"
                defaultValue={application.containerPort ?? ''}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="app-details-field-healthPath">Health check path</Label>
              <Input
                id="app-details-field-healthPath"
                name="healthPath"
                data-testid="app-details-field-healthPath"
                defaultValue={application.healthPath ?? ''}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="app-details-field-migrationCommand">Migration command</Label>
              <Input
                id="app-details-field-migrationCommand"
                name="migrationCommand"
                data-testid="app-details-field-migrationCommand"
                defaultValue={application.migrationCommand ?? ''}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="app-details-field-workerCommand">Worker command</Label>
              <Input
                id="app-details-field-workerCommand"
                name="workerCommand"
                data-testid="app-details-field-workerCommand"
                defaultValue={application.workerCommand ?? ''}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <Label className="font-normal">
              <input
                type="checkbox"
                name="databaseRequired"
                data-testid="app-details-field-databaseRequired"
                defaultChecked={application.databaseRequired}
              />
              Database required
            </Label>
            <Label className="font-normal">
              <input
                type="checkbox"
                name="storageRequired"
                data-testid="app-details-field-storageRequired"
                defaultChecked={application.storageRequired}
              />
              Storage required
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" data-testid="app-details-save" disabled={saveState === 'saving'}>
              {saveState === 'saving' ? 'Saving…' : 'Save'}
            </Button>
            {saveState === 'saved' ? (
              <p role="status" className="text-sm text-muted-foreground">
                Saved.
              </p>
            ) : null}
            {saveState === 'error' ? (
              <p role="alert" className="text-sm text-destructive">
                We couldn&apos;t save these values. Try again in a moment.
              </p>
            ) : null}
          </div>
        </form>
        <div className="flex flex-col gap-3 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            data-testid="app-details-reanalyse"
            disabled={reanalyseDisabled}
            onClick={handleReanalyse}
          >
            {reanalyseDisabled ? 'Re-analysing…' : 'Re-analyse'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Avoid editing while analysis is in progress — Deployz may overwrite your changes if it
            re-analyses concurrently.
          </p>
        </div>
      </CardContent>
    </Card>
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

function DeleteApplicationPanel({ application }: { application: Application }) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText.trim() === application.repoFullName;

  async function onConfirm(): Promise<void> {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await deleteApplication(application.id);
      router.push('/dashboard/applications');
    } catch (err) {
      if ((err as { code?: string }).code === 'APPLICATION_HAS_DEPLOYMENTS') {
        setError((err as Error).message);
      } else {
        setError("We couldn't remove this application. Try again in a moment.");
      }
      setPending(false);
    }
  }

  return (
    <Card data-testid="delete-app-panel" className="border-destructive/40">
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="text-sm font-medium text-destructive">Remove this application?</p>
        <p className="text-sm text-muted-foreground">
          This permanently removes the application and its releases from Deployz. This cannot be
          undone.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delete-app-confirm">
            Type <span className="font-medium">{application.repoFullName}</span> to confirm.
          </Label>
          <Input
            id="delete-app-confirm"
            data-testid="delete-app-confirm"
            aria-label={`Type ${application.repoFullName} to confirm`}
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            className="max-w-xs"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="destructive"
            data-testid="delete-app-button"
            disabled={!confirmed || pending}
            onClick={onConfirm}
          >
            {pending ? 'Removing…' : 'Remove application'}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
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
