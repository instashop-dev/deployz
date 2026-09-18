'use client';

import { ChevronDown, RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  type AnalysisStatus,
  type Application,
  type UpdateApplicationInput,
  updateApplication,
} from '@/lib/applications';
import {
  requirementSummaryKeyFor,
  type ApplicationReadiness,
  type DeploymentRequirementDriftSummary,
  type EditableReadinessField,
  type ReadinessRequirementStatus,
  type ReadinessRow,
  type ReadinessTableFinding,
  type ReadinessTablePassed,
  type ReadinessTableSetting,
} from '@/lib/readiness';
import { requirementDriftLine } from '@/lib/install-plan';

export function ReadinessTable({
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
  const analyzing = application.analysisStatus === 'ANALYZING';
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
          <TableBody aria-busy={analyzing || undefined}>
            {rows.map((row) => (
              <ReadinessTableRow
                key={row.id}
                row={row}
                application={application}
                onEdit={onEdit}
                onShowFix={onShowFix}
              />
            ))}
            {rows.length === 0 ? (
              <ReadinessTablePlaceholder analysisStatus={application.analysisStatus} />
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// The rows only exist once an analysis has completed. While one runs, the
// table keeps its geometry with skeleton rows; before the first analysis it
// says what the vendor has to do to fill it.
function ReadinessTablePlaceholder({ analysisStatus }: { analysisStatus: AnalysisStatus }) {
  if (analysisStatus === 'ANALYZING') {
    return (
      <>
        <TableRow>
          <TableCell colSpan={4} className="sr-only" role="status">
            Checking deployment readiness…
          </TableCell>
        </TableRow>
        {[0, 1, 2].map((index) => (
          <TableRow key={index} aria-hidden data-testid="readiness-row-skeleton">
            <TableCell>
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-20 rounded-full" />
            </TableCell>
            <TableCell />
          </TableRow>
        ))}
      </>
    );
  }

  const message =
    analysisStatus === 'FAILED'
      ? 'The checks will show here after a successful analysis.'
      : 'Analyze the application to see its deployment checks.';
  return (
    <TableRow>
      <TableCell colSpan={4} className="text-muted-foreground" data-testid="readiness-empty">
        {message}
      </TableCell>
    </TableRow>
  );
}

export function ReadinessTableRow({
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
        {setting.status ? (
          <ReadinessStatusBadge status={setting.status} />
        ) : (
          <Badge variant="default">Passed</Badge>
        )}
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

function ReadinessStatusBadge({ status }: { status: ReadinessRequirementStatus }) {
  switch (status) {
    case 'required':
      return <Badge variant="default">Required</Badge>;
    case 'not-required':
      return <Badge variant="secondary">Not required</Badge>;
    case 'vendor-override':
      return <Badge variant="outline">Vendor override</Badge>;
    case 'needs-review':
      return <Badge variant="outline">Needs review</Badge>;
  }
}

export function RequirementDriftNotice({
  drifts,
}: {
  drifts: DeploymentRequirementDriftSummary[];
}) {
  if (drifts.length === 0) return null;
  return (
    <section aria-labelledby="drift-heading" className="flex flex-col gap-3" data-testid="requirement-drift-notice">
      <Alert>
        <TriangleAlert className="size-4" aria-hidden />
        <AlertTitle>Existing deployments are not changed</AlertTitle>
        <AlertDescription>
          Deployz reports these differences only. Deployz does not change these deployments
          automatically. Each deployment below keeps the settings it was created with.
        </AlertDescription>
      </Alert>
      <ul className="flex flex-col gap-3">
        {drifts.map((entry) => (
          <li key={entry.deploymentId}>
            <Card data-testid={`requirement-drift-entry-${entry.deploymentId}`}>
              <CardContent className="flex flex-col gap-2 py-4">
                <div className="flex items-center justify-between gap-4">
                  <Link
                    href={`/dashboard/deployments/${entry.deploymentId}`}
                    className="text-sm font-medium hover:underline"
                    data-testid={`requirement-drift-link-${entry.deploymentId}`}
                  >
                    {entry.customerName}
                  </Link>
                  <DeploymentStatusBadge state={entry.state} />
                </div>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {entry.drift.map((item) => (
                    <li key={item.kind}>{requirementDriftLine(item)}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EditDialog({
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
  onSaved: () => Promise<void> | void;
}) {
  const [pendingAction, setPendingAction] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | number | boolean>(false);

  useEffect(() => {
    if (!field) return;
    setValue(getInitialValue(field, application, readiness));
    setError(null);
  }, [field, application, readiness]);

  if (!field) return null;
  const currentField = field;

  const config = FIELD_CONFIG[currentField];

  async function handleSave(): Promise<void> {
    setPendingAction('save');
    setError(null);
    try {
      const input = buildUpdateInput(currentField, value);
      await updateApplication(application.id, input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not save the change. Try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReset(): Promise<void> {
    setPendingAction('reset');
    setError(null);
    try {
      const input: UpdateApplicationInput = { [currentField]: null };
      await updateApplication(application.id, input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not reset the value. Try again.');
    } finally {
      setPendingAction(null);
    }
  }

  const requirementKey = requirementSummaryKeyFor(currentField);
  const requirement = requirementKey ? readiness.requirements?.[requirementKey] : undefined;
  const needsReview = requirementKey !== null && requirement === undefined;
  const isOverridden = requirement ? requirement.overridden : false;
  const detectedValue = requirement
    ? requirement.detected
      ? 'Required'
      : 'Not required'
    : 'Needs review';

  return (
    <Dialog open={currentField !== null} onOpenChange={(open) => !open && onClose()}>
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
                  disabled={needsReview}
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
            {needsReview ? detectedValue : `Detected: ${detectedValue || '—'}`}
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
              disabled={pendingAction !== null}
              loading={pendingAction === 'reset'}
              loadingText="Resetting to detected…"
              data-testid={`edit-reset-${field}`}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to detected
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={pendingAction !== null || needsReview}
            loading={pendingAction === 'save'}
            loadingText="Saving value…"
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

function getInitialValue(
  field: EditableReadinessField,
  application: Application,
  readiness: ApplicationReadiness,
): string | number | boolean {
  switch (field) {
    case 'containerPort':
      return application.containerPort ?? '';
    case 'healthPath':
      return application.healthPath ?? '';
    case 'migrationCommand':
      return application.migrationCommand ?? '';
    case 'databaseRequired':
      return readiness.requirements?.database?.effective ?? application.databaseRequired;
    case 'storageRequired':
      return readiness.requirements?.storage?.effective ?? application.storageRequired;
    case 'redisRequired':
      return readiness.requirements?.redis?.effective ?? application.redisRequired;
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
