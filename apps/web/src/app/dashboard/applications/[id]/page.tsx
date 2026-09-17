'use client';

import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { EvaluationNotice } from '@/components/evaluation-notice';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  deleteApplication,
  fetchApplication,
  triggerAnalysis,
  updateApplication,
  type Application,
  type UpdateApplicationInput,
} from '@/lib/applications';
import { fetchDeploymentsForApplication, type FleetDeployment } from '@/lib/deployments';
import { DEPLOYMENT_STATE_LABELS } from '@/lib/deployment-vocabulary';
import {
  deriveLifecycleSteps,
  deriveReadinessRows,
  detectedFieldValue,
  fetchReadiness,
  isFieldOverridden,
  readinessHeaderPresentation,
  requirementSummaryKeyFor,
  type ApplicationReadiness,
  type EditableReadinessField,
  type ReadinessRow,
  type ReadinessTableFinding,
  type ReadinessTablePassed,
  type ReadinessTableSetting,
} from '@/lib/readiness';

/** How often to re-check a still-running analysis (§19). */
const ANALYSIS_POLL_MS = 2000;

type PageData = {
  application: Application;
  readiness: ApplicationReadiness;
  deployments: FleetDeployment[];
};

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: PageData };

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
      setState({ status: 'loaded', data: { application, readiness, deployments } });
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
      setState({ status: 'loaded', data: { application, readiness, deployments } });
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
): Promise<{ application: Application; readiness: ApplicationReadiness }> {
  const [application, readiness] = await Promise.all([fetchApplication(id), fetchReadiness(id)]);
  return { application, readiness };
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
  const { application, readiness, deployments } = data;
  const rows = deriveReadinessRows(application, readiness);
  const [reanalysing, setReanalysing] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [editingField, setEditingField] = useState<EditableReadinessField | null>(null);

  const header = readinessHeaderPresentation(readiness);
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

        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold tracking-tight">{header.heading}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{header.supportingLine}</p>
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
              disabled={application.analysisStatus === 'ANALYZING'}
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

      {/* Latest test deployment */}
      <LatestDeploymentSection application={application} testDeployment={testDeployment} />

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
        onSaved={onApplicationUpdated}
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

function ReadinessTable({
  rows,
  application,
  onEdit,
  onShowFix,
}: {
  rows: ReadinessRow[];
  application: Application;
  onEdit: (field: EditableReadinessField) => void;
  onShowFix: () => void;
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="readiness-table">
          <TableHeader>
            <TableRow>
              <TableHead>Check</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <ReadinessTableRow
                key={row.id}
                row={row}
                application={application}
                onEdit={onEdit}
                onShowFix={onShowFix}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReadinessTableRow({
  row,
  application,
  onEdit,
  onShowFix,
}: {
  row: ReadinessRow;
  application: Application;
  onEdit: (field: EditableReadinessField) => void;
  onShowFix: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (row.kind === 'finding') {
    const finding = (row as ReadinessTableFinding).finding;
    const isRequired = finding.severity === 'required';
    return (
      <TableRow
        id={`readiness-row-${finding.id}`}
        data-testid={`readiness-finding-${finding.id}`}
      >
        <TableCell>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{finding.title}</span>
            <span className="text-xs text-muted-foreground">
              {finding.plainEnglishExplanation}
            </span>
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">{finding.suggestedOutcome}</TableCell>
        <TableCell>
          <Badge variant={isRequired ? 'destructive' : 'outline'}>
            {isRequired ? 'Blocking issue' : 'Recommendation'}
          </Badge>
        </TableCell>
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            onClick={onShowFix}
            data-testid={`readiness-finding-fix-${finding.id}`}
          >
            {isRequired ? 'Fix issue' : 'Show fix'}
          </Button>
        </TableCell>
      </TableRow>
    );
  }

  if (row.kind === 'passed') {
    const check = (row as ReadinessTablePassed).check;
    return (
      <TableRow data-testid={`readiness-passed-${check.id}`}>
        <TableCell>{check.label}</TableCell>
        <TableCell className="text-muted-foreground">—</TableCell>
        <TableCell>
          <Badge variant="default">Passed</Badge>
        </TableCell>
        <TableCell />
      </TableRow>
    );
  }

  const setting = row as ReadinessTableSetting;

  return (
    <TableRow data-testid={`readiness-setting-${setting.id}`}>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{setting.label}</span>
          {setting.evidence.length > 0 ? (
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid={`readiness-setting-evidence-toggle-${setting.id}`}
                >
                  Why Deployz detected this
                  <ChevronDown
                    className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5 space-y-1">
                {setting.evidence.map((item, index) => (
                  <p
                    key={index}
                    className="text-xs text-muted-foreground"
                    data-testid={`readiness-setting-evidence-${setting.id}-${index}`}
                  >
                    {item.file ? <code className="font-mono">{item.file}</code> : null}
                    {item.file ? ' — ' : ''}
                    {item.reason}
                  </p>
                ))}
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span>{setting.value}</span>
          {setting.overridden ? (
            <span className="text-xs text-muted-foreground">
              Detected: {setting.detectedValue} · Overridden
            </span>
          ) : setting.detectedValue && setting.detectedValue !== setting.value ? (
            <span className="text-xs text-muted-foreground">Detected: {setting.detectedValue}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="default">Passed</Badge>
      </TableCell>
      <TableCell>
        {setting.editable && application.analysisStatus === 'COMPLETE' && setting.field ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(setting.field as EditableReadinessField)}
            data-testid={`readiness-setting-edit-${setting.id}`}
          >
            Edit
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
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

function EditDialog({
  field,
  application,
  readiness,
  onClose,
  onSaved,
}: {
  field: EditableReadinessField | null;
  application: Application;
  readiness: ApplicationReadiness;
  onClose: () => void;
  onSaved: (next: Application) => void;
}) {
  const [pendingAction, setPendingAction] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | number | boolean>(false);

  useEffect(() => {
    if (!field) return;
    setValue(getInitialValue(field, application));
    setError(null);
  }, [field, application]);

  if (!field) return null;
  const currentField = field;

  const config = FIELD_CONFIG[currentField];

  async function handleSave(): Promise<void> {
    setPendingAction('save');
    setError(null);
    try {
      const input = buildUpdateInput(currentField, value);
      const next = await updateApplication(application.id, input);
      onSaved(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save the change. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReset(): Promise<void> {
    setPendingAction('reset');
    setError(null);
    try {
      const input: UpdateApplicationInput = { [currentField]: null };
      const next = await updateApplication(application.id, input);
      onSaved(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't reset the value. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  // Database/redis/storage: the server-computed requirements summary is the
  // source of truth (it can represent an override to false, which the
  // detected/override OR-logic below cannot) — the same rule the readiness
  // table rows use, so the table and this dialog never disagree. Fall back
  // to the plain detected fact only when the API has not sent requirements.
  const requirementKey = requirementSummaryKeyFor(currentField);
  const requirement = requirementKey ? readiness.requirements?.[requirementKey] : undefined;
  const isOverridden = requirement
    ? requirement.overridden
    : isFieldOverridden(currentField, application, readiness.detected);
  const detectedValue = requirement
    ? requirement.detected
      ? 'Required'
      : 'Not required'
    : detectedFieldValue(currentField, readiness.detected);

  return (
    <Dialog
      open={currentField !== null}
      onOpenChange={(open) => !open && pendingAction === null && onClose()}
    >
      <DialogContent data-testid={`edit-dialog-${currentField}`}>
        <DialogHeader>
          <DialogTitle>{config.label}</DialogTitle>
          <DialogDescription>
            Changes affect future deployments. Existing deployments are not modified.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-field-${currentField}`}>Use for deployment</Label>
            {config.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  id={`edit-field-${currentField}`}
                  checked={Boolean(value)}
                  onChange={(event) => setValue(event.target.checked)}
                />
                {config.booleanLabel}
              </label>
            ) : (
              <Input
                id={`edit-field-${currentField}`}
                type={config.type === 'number' ? 'number' : 'text'}
                value={String(value ?? '')}
                onChange={(event) =>
                  setValue(
                    config.type === 'number'
                      ? event.target.value === ''
                        ? ''
                        : Number(event.target.value)
                      : event.target.value,
                  )
                }
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Detected: {detectedValue || '—'}
          </p>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          {isOverridden ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleReset()}
              loading={pendingAction === 'reset'}
              loadingText="Resetting to detected…"
              disabled={pendingAction === 'save'}
              data-testid={`edit-reset-${field}`}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to detected
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void handleSave()}
            loading={pendingAction === 'save'}
            loadingText="Saving value…"
            disabled={pendingAction === 'reset'}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_CONFIG: Record<
  EditableReadinessField,
  {
    label: string;
    type: 'text' | 'number' | 'boolean';
    booleanLabel?: string;
  }
> = {
  containerPort: { label: 'Container port', type: 'number' },
  healthPath: { label: 'Health check path', type: 'text' },
  migrationCommand: { label: 'Migration command', type: 'text' },
  databaseRequired: { label: 'Database', type: 'boolean', booleanLabel: 'Database required' },
  storageRequired: { label: 'File storage', type: 'boolean', booleanLabel: 'File storage required' },
  redisRequired: { label: 'Cache / queue', type: 'boolean', booleanLabel: 'Redis required' },
};

function getInitialValue(field: EditableReadinessField, application: Application): string | number | boolean {
  switch (field) {
    case 'containerPort':
      return application.containerPort ?? '';
    case 'healthPath':
      return application.healthPath ?? '';
    case 'migrationCommand':
      return application.migrationCommand ?? '';
    case 'databaseRequired':
      return application.databaseRequired;
    case 'storageRequired':
      return application.storageRequired;
    case 'redisRequired':
      return application.redisRequired;
  }
}

function buildUpdateInput(
  field: EditableReadinessField,
  value: string | number | boolean,
): UpdateApplicationInput {
  switch (field) {
    case 'containerPort':
      return { containerPort: value === '' ? null : Number(value) };
    case 'healthPath':
      return { healthPath: String(value).trim() || null };
    case 'migrationCommand':
      return { migrationCommand: String(value).trim() || null };
    case 'databaseRequired':
      return { databaseRequired: Boolean(value) };
    case 'storageRequired':
      return { storageRequired: Boolean(value) };
    case 'redisRequired':
      return { redisRequired: Boolean(value) };
  }
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
