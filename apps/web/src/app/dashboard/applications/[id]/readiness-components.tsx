'use client';

import { ChevronDown, RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { INFRASTRUCTURE_COMPONENT_DISPLAY, type DeploymentPlan } from '@deployz/contracts';

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type Application, type UpdateApplicationInput, updateApplication } from '@/lib/applications';
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

export function InstallPlanSection({ plan }: { plan: DeploymentPlan | null }) {
  if (!plan) return null;
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3" data-testid="install-plan-section">
      <div>
        <h2 id="plan-heading" className="text-base font-semibold">
          What a new deployment will create
        </h2>
        <p className="text-sm text-muted-foreground">
          Deployz will provision these components for the next deployment.
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Lifecycle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.components.map((component) => (
                <TableRow key={component.kind} data-testid={`install-plan-component-${component.kind}`}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">
                        {INFRASTRUCTURE_COMPONENT_DISPLAY[component.kind].name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {INFRASTRUCTURE_COMPONENT_DISPLAY[component.kind].purpose}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{component.action}</Badge>
                  </TableCell>
                  <TableCell className="capitalize">{component.lifecycle}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    setError(null);
    try {
      const input = buildUpdateInput(currentField, value);
      await updateApplication(application.id, input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not save the change. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const input: UpdateApplicationInput = { [currentField]: null };
      await updateApplication(application.id, input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not reset the value. Try again.');
    } finally {
      setSaving(false);
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
              disabled={saving}
              data-testid={`edit-reset-${field}`}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to detected
            </Button>
          ) : null}
          <Button type="button" onClick={() => void handleSave()} disabled={saving || needsReview}>
            {saving ? 'Saving…' : 'Save'}
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
