'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  type Application,
  type UpdateApplicationInput,
  updateApplication,
} from '@/lib/applications';
import {
  requirementSummaryKeyFor,
  type ApplicationReadiness,
  type DeploymentRequirementDriftSummary,
  type EditableReadinessField,
} from '@/lib/readiness';
import { requirementDriftLine } from '@/lib/install-plan';

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
