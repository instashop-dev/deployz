'use client';

import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { EvaluationNotice } from '@/components/evaluation-notice';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { PublicInstallLinkCard } from '@/components/public-install-link-card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  deleteApplication,
  fetchApplication,
  fetchApplicationPlan,
  triggerAnalysis,
  updateApplication,
  type Application,
} from '@/lib/applications';
import type { DeploymentPlan } from '@deployz/contracts';

import { fetchDeploymentsForApplication, type FleetDeployment } from '@/lib/deployments';
import { DEPLOYMENT_STATE_LABELS } from '@/lib/deployment-vocabulary';
import {
  ANALYSIS_TAKING_LONGER_MS,
  READINESS_SUPPORT_TAKING_LONGER,
  deriveLifecycleSteps,
  deriveReadinessRows,
  fetchReadiness,
  readinessHeaderPresentation,
  type ApplicationReadiness,
  type EditableReadinessField,
} from '@/lib/readiness';
import {
  EditDialog,
  ReadinessTable,
  RequirementDriftNotice,
} from './readiness-components';

/** How often to re-check a still-running analysis (§19). */
const ANALYSIS_POLL_MS = 2000;

type PageData = {
  application: Application;
  readiness: ApplicationReadiness;
  deployments: FleetDeployment[];
  /** INSTALL plan for the application's current effective manifest. Null while analysis is incomplete or the plan cannot be fetched. */
  plan: DeploymentPlan | null;
};

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: PageData };

/** Fetch the install plan only when analysis has completed — the endpoint
 *  returns 409 while analysis is still running. */
async function fetchPlanIfComplete(id: string, application: Application): Promise<DeploymentPlan | null> {
  if (application.analysisStatus !== 'COMPLETE') return null;
  try {
    return await fetchApplicationPlan(id);
  } catch {
    return null;
  }
}

// Application readiness page — redesigned into a single deployment-readiness
// table, a compact four-step lifecycle, and contextual header actions.
export default function ApplicationReadinessPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [retrying, setRetrying] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const [application, readiness, deployments] = await Promise.all([
        fetchApplication(id),
        fetchReadiness(id),
        fetchDeploymentsForApplication(id),
      ]);
      const plan = await fetchPlanIfComplete(id, application);
      setState({ status: 'loaded', data: { application, readiness, deployments, plan } });
    } catch {
      setState({
        status: 'error',
        message: "We couldn't load this application. Try again in a moment.",
      });
    }
  };

  useEffect(() => {
    void load();
  }, [id]);

  const analysisStatus = state.status === 'loaded' ? state.data.readiness.analysisStatus : null;

  // Analysis runs in the background on the API, so the first load can land
  // while it is still PENDING/ANALYZING. Poll until it settles.
  useEffect(() => {
    if (analysisStatus !== 'PENDING' && analysisStatus !== 'ANALYZING') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchAnalysedState(id)
        .then((next) => {
          if (cancelled) return;
          setState((prev) =>
            prev.status === 'loaded'
              ? {
                  ...prev,
                  data: { ...prev.data, ...next },
                }
              : prev,
          );
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

  // A background refresh (re-analysis, or a manual retry from the error
  // state) must not wipe good content already on screen: on failure it keeps
  // whatever is currently shown and reports the failure with a toast instead.
  async function refresh(): Promise<void> {
    try {
      const [application, readiness, deployments] = await Promise.all([
        fetchApplication(id),
        fetchReadiness(id),
        fetchDeploymentsForApplication(id),
      ]);
      const plan = await fetchPlanIfComplete(id, application);
      setState({ status: 'loaded', data: { application, readiness, deployments, plan } });
    } catch {
      toast.error("We couldn't refresh this application. Try again in a moment.");
    }
  }

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/applications">
            <ArrowLeft aria-hidden className="size-4" />
            Applications
          </Link>
        </Button>
      </div>

      {/* Paddle migration Phase 11 — the same evaluation line as the
          homepage, on the screen where a vendor decides an application is
          ready for its first customer. Gone once a subscription exists. */}
      <EvaluationNotice />

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
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => void handleRetry()}
            loading={retrying}
            loadingText="Trying again…"
          >
            Try again
          </Button>
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <ReadinessBody
          data={state.data}
          onApplicationUpdated={(application) =>
            setState((prev) =>
              prev.status === 'loaded' ? { ...prev, data: { ...prev.data, application } } : prev,
            )
          }
          onRefresh={refresh}
        />
      ) : null}
    </div>
  );
}

async function fetchAnalysedState(
  id: string,
): Promise<{ application: Application; readiness: ApplicationReadiness; plan: DeploymentPlan | null }> {
  const [application, readiness] = await Promise.all([fetchApplication(id), fetchReadiness(id)]);
  const plan = await fetchPlanIfComplete(id, application);
  return { application, readiness, plan };
}

function ReadinessBody({
  data,
  onApplicationUpdated,
  onRefresh,
}: {
  data: PageData;
  onApplicationUpdated: (next: Application) => void;
  onRefresh: () => Promise<void>;
}) {
  const { application, readiness, deployments, plan } = data;
  const rows = deriveReadinessRows(application, readiness);
  const [reanalysing, setReanalysing] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [editingField, setEditingField] = useState<EditableReadinessField | null>(null);
  const [restartCount, setRestartCount] = useState(0);
  const [takingLonger, setTakingLonger] = useState(false);

  const analyzing = application.analysisStatus === 'ANALYZING';

  // The request loader ends when the API accepts the analysis; the page then
  // shows the server-side run as an in-progress state. After a while it
  // offers a restart, because the worker can leave an application at
  // ANALYZING with no further updates.
  useEffect(() => {
    setTakingLonger(false);
    if (!analyzing) return;
    const timer = setTimeout(() => setTakingLonger(true), ANALYSIS_TAKING_LONGER_MS);
    return () => clearTimeout(timer);
  }, [analyzing, restartCount]);

  const header = readinessHeaderPresentation(readiness);
  const supportingLine =
    analyzing && takingLonger ? READINESS_SUPPORT_TAKING_LONGER : header.supportingLine;
  const lifecycle = deriveLifecycleSteps({
    analysisStatus: application.analysisStatus,
    readiness,
    deployments,
  });

  const testDeployment = deployments
    .filter((d) => d.deploymentType === 'TEST' && d.deletedAt === null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

  const requiredFindings = readiness.findings.filter((f) => f.severity === 'required');
  const firstBlockerId = requiredFindings[0]?.id;

  async function handleReanalyse(): Promise<void> {
    setReanalysing(true);
    try {
      await triggerAnalysis(application.id, { force: true });
      setRestartCount((count) => count + 1);
      await onRefresh();
    } catch {
      toast.error("We couldn't start the analysis. Try again in a moment.");
    } finally {
      setReanalysing(false);
    }
  }

  const primaryAction = (() => {
    if (application.analysisStatus === 'FAILED') {
      return (
        <Button
          onClick={() => void handleReanalyse()}
          loading={reanalysing}
          loadingText="Retrying analysis…"
          data-testid="readiness-retry"
        >
          Try analysis again
        </Button>
      );
    }

    if (analyzing && takingLonger) {
      return (
        <Button
          onClick={() => void handleReanalyse()}
          loading={reanalysing}
          loadingText="Restarting analysis…"
          data-testid="readiness-restart"
        >
          Restart analysis
        </Button>
      );
    }

    if (analyzing) {
      return (
        <Button loading loadingText="Analyzing application…" data-testid="readiness-analyzing">
          Analyze application
        </Button>
      );
    }

    if (application.analysisStatus !== 'COMPLETE') {
      return (
        <Button
          onClick={() => void handleReanalyse()}
          loading={reanalysing}
          loadingText="Analyzing application…"
          data-testid="readiness-analyze"
        >
          Analyze application
        </Button>
      );
    }

    if (requiredFindings.length > 0 && firstBlockerId) {
      return (
        <Button asChild data-testid="readiness-review-blocker">
          <a href={`#readiness-row-${firstBlockerId}`}>Review blocking issue</a>
        </Button>
      );
    }

    if (!testDeployment) {
      return (
        <Button asChild data-testid="readiness-create-test">
          <Link href={`/dashboard/deployments/new?applicationId=${application.id}&test=true`}>
            Create test deployment
          </Link>
        </Button>
      );
    }

    return (
      <Button asChild data-testid="readiness-view-deployment">
        <Link href={`/dashboard/deployments/${testDeployment.id}`}>View deployment</Link>
      </Button>
    );
  })();

  return (
    <>
      {/* Header */}
      <section className="flex flex-col gap-4" aria-labelledby="app-name">
        <div className="flex items-start justify-between gap-4">
          <EditableName application={application} onUpdated={onApplicationUpdated} />
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/applications/${application.id}/releases`}>Releases</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/applications/${application.id}/config`}>Configuration</Link>
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{application.repoFullName}</p>

        <div
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm"
          aria-busy={analyzing || undefined}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1
                className="flex items-center gap-2 text-2xl font-semibold tracking-tight"
                data-testid="readiness-heading"
              >
                {analyzing ? <Spinner aria-hidden className="size-5 text-primary" /> : null}
                {header.heading}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{supportingLine}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">{primaryAction}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span data-testid="readiness-commit">
              Analysed commit {readiness.analyzedCommitSha?.slice(0, 7) ?? '—'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleReanalyse()}
              loading={reanalysing}
              loadingText="Analyzing application…"
              disabled={analyzing}
              data-testid="app-details-reanalyse"
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Re-analyse
            </Button>
          </div>
        </div>
      </section>

      {/* Lifecycle stepper */}
      <section aria-labelledby="lifecycle-heading" className="flex flex-col gap-3">
        <h2 id="lifecycle-heading" className="text-base font-semibold">
          Lifecycle
        </h2>
        <LifecycleStepper steps={lifecycle} />
      </section>

      {/* Deployment readiness table */}
      <section aria-labelledby="readiness-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="readiness-heading" className="text-base font-semibold">
            Deployment readiness
          </h2>
          <p className="text-sm text-muted-foreground">
            Deployz checked your application and configured the settings needed to deploy it.
          </p>
        </div>
        <ReadinessTable
          rows={rows}
          application={application}
          onEdit={(field) => setEditingField(field)}
          onShowFix={() => setFixOpen(true)}
        />
      </section>

      {/* Existing deployments that no longer match the current requirements */}
      <RequirementDriftNotice drifts={readiness.deploymentRequirementDrift} />

      {/* AWS resources a new deployment will create */}
      <AwsInfrastructureDetails plan={plan} />

      {/* Latest test deployment */}
      <LatestDeploymentSection application={application} testDeployment={testDeployment} />

      {/* Public "Deploy to AWS" link customers can open themselves */}
      <PublicInstallLinkCard applicationId={application.id} />

      {/* Danger zone */}
      <DangerZone application={application} />

      <FixInstructionsDialog
        open={fixOpen}
        applicationId={application.id}
        onClose={() => setFixOpen(false)}
        onReanalyse={() => {
          void handleReanalyse();
          setFixOpen(false);
        }}
      />

      <EditDialog
        field={editingField}
        application={application}
        readiness={readiness}
        onClose={() => setEditingField(null)}
        onSaved={onRefresh}
      />
    </>
  );
}

function EditableName({
  application,
  onUpdated,
}: {
  application: Application;
  onUpdated: (next: Application) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(application.name);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || trimmed === application.name) {
      setEditing(false);
      setValue(application.name);
      return;
    }
    setSaving(true);
    try {
      const next = await updateApplication(application.id, { name: trimmed });
      onUpdated(next);
      setEditing(false);
    } catch {
      toast.error("We couldn't rename the application. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <h1 id="app-name" className="text-2xl font-semibold tracking-tight">
          {application.name}
        </h1>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Rename application"
          onClick={() => setEditing(true)}
          data-testid="app-name-edit"
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save();
          if (event.key === 'Escape') {
            setEditing(false);
            setValue(application.name);
          }
        }}
        className="h-8 w-64"
        autoFocus
        data-testid="app-name-input"
      />
      <Button
        size="sm"
        onClick={() => void save()}
        loading={saving}
        loadingText="Saving name…"
        data-testid="app-name-save"
      >
        Save
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={saving}
        onClick={() => {
          setEditing(false);
          setValue(application.name);
        }}
      >
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function LifecycleStepper({
  steps,
}: {
  steps: Record<'Analyze' | 'Prepare' | 'Test' | 'Customer ready', { state: string; label: string }>;
}) {
  const items = [
    { id: 'Analyze', ...steps.Analyze },
    { id: 'Prepare', ...steps.Prepare },
    { id: 'Test', ...steps.Test },
    { id: 'Customer ready', ...steps['Customer ready'] },
  ] as const;

  return (
    <ol
      aria-label="Application lifecycle"
      data-testid="lifecycle-steps"
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
    >
      {items.map((item, index) => {
        const isDone = item.state === 'done';
        const isCurrent = item.state === 'current';
        const isFailed = item.state === 'failed';
        return (
          <li
            key={item.id}
            data-testid={`lifecycle-step-${item.id}`}
            className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm"
          >
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
                isDone
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : isFailed
                    ? 'border-destructive text-destructive'
                    : isCurrent
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
              }`}
            >
              {isDone ? <Check className="size-3.5" /> : index + 1}
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">{item.id}</span>
              <span className="truncate text-xs text-muted-foreground">{item.label}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function LatestDeploymentSection({
  application,
  testDeployment,
}: {
  application: Application;
  testDeployment: FleetDeployment | undefined;
}) {
  const createLink = `/dashboard/deployments/new?applicationId=${application.id}&test=true`;

  return (
    <section aria-labelledby="latest-deployment-heading" className="flex flex-col gap-3">
      <h2 id="latest-deployment-heading" className="text-base font-semibold">
        Latest test deployment
      </h2>
      <Card data-testid="latest-test-deployment">
        <CardContent className="flex flex-col gap-3 py-4">
          {!testDeployment ? (
            <>
              <p className="text-sm font-medium">No test deployment yet</p>
              <p className="text-sm text-muted-foreground">
                Verify this application in AWS before enabling customer deployments.
              </p>
              <div>
                <Button asChild variant="outline" size="sm" data-testid="create-test-deployment">
                  <Link href={createLink}>Create test deployment</Link>
                </Button>
              </div>
            </>
          ) : testDeployment.state === 'HEALTHY' ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Test deployment healthy</span>
                <DeploymentStatusBadge state={testDeployment.state} />
              </div>
              <p className="text-sm text-muted-foreground">
                Version {testDeployment.version} ·{' '}
                {new Date(testDeployment.createdAt).toLocaleDateString()}
              </p>
              <div className="flex items-center gap-2">
                {testDeployment.observedState && typeof testDeployment.observedState === 'object' && testDeployment.observedState.url ? (
                  <Button asChild size="sm" variant="outline" data-testid="open-application">
                    <a href={String(testDeployment.observedState.url)} target="_blank" rel="noreferrer">
                      Open application
                      <ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="outline" data-testid="view-deployment">
                  <Link href={`/dashboard/deployments/${testDeployment.id}`}>View deployment</Link>
                </Button>
              </div>
            </>
          ) : testDeployment.state === 'FAILED' ? (
            <>
              <p className="text-sm font-medium text-destructive">Test deployment failed</p>
              <p className="text-sm text-muted-foreground">
                The test deployment did not complete. Review the deployment for details.
              </p>
              <Button asChild size="sm" variant="outline" data-testid="view-deployment-issue">
                <Link href={`/dashboard/deployments/${testDeployment.id}`}>View issue</Link>
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Deploying test deployment</span>
                <DeploymentStatusBadge state={testDeployment.state} />
              </div>
              <p className="text-sm text-muted-foreground">
                Current step: {DEPLOYMENT_STATE_LABELS[testDeployment.state] ?? testDeployment.state}
              </p>
              <Button asChild size="sm" variant="outline" data-testid="view-deployment">
                <Link href={`/dashboard/deployments/${testDeployment.id}`}>View deployment</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function DangerZone({ application }: { application: Application }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
    <section aria-labelledby="danger-heading" className="flex flex-col gap-3">
      <h2 id="danger-heading" className="text-base font-semibold">
        Danger zone
      </h2>
      <Card className="border-destructive/40">
        <CardContent className="flex flex-col gap-3 py-4">
          <p className="text-sm font-medium text-destructive">Remove this application?</p>
          <p className="text-sm text-muted-foreground">
            This permanently removes the application and its releases from Deployz. This cannot be
            undone.
          </p>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                data-testid="delete-app-trigger"
              >
                <Trash2 className="size-3.5" aria-hidden />
                Remove application
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove this application?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the application and its releases from Deployz. This
                  cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
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
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmText('')}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void onConfirm()}
                  loading={pending}
                  loadingText="Removing application…"
                  disabled={!confirmed}
                  data-testid="delete-app-button"
                >
                  Remove application
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </section>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="readiness-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
