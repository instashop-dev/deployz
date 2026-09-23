'use client';

import { ChevronDown, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AnalysisStatus } from '@/lib/applications';
import {
  deriveAnalysisDetails,
  deriveConfigurationRows,
  deriveRequiredChanges,
  isSettingRowId,
  type AnalysisDetail,
  type ConfigurationRow,
  type RequiredChange,
} from '@/lib/application-configuration';
import type { EditableReadinessField } from '@/lib/readiness';

import { useApplicationPage } from '../application-page-context';
import { EditDialog, RequirementDriftNotice } from '../readiness-components';

// Commands can be long (a chained shell script, a full drizzle-kit
// invocation) — these rows get the abbreviated + "Show full command"
// treatment instead of wrapping or overflowing the table.
const COMMAND_ROW_IDS = new Set(['build', 'start', 'migrations', 'worker']);
const LONG_VALUE_THRESHOLD = 32;

// The Configuration tab's readiness surface — everything that used to live on
// the overview page's "Deployment readiness" table, now framed around what a
// vendor configures rather than what the analyser checked. Re-analysis lives
// here too: the table is what a fresh analysis actually changes.
export function DeploymentConfiguration() {
  const { data, loading, presentation, refresh, reanalyse, reanalysing } = useApplicationPage();
  const [editingField, setEditingField] = useState<EditableReadinessField | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // The dialogs open from state, not from a Radix trigger, so Radix has no
  // element to return focus to on close — keep the opener and restore it.
  const openerRef = useRef<HTMLElement | null>(null);

  const rows = data ? deriveConfigurationRows(data.application, data.readiness) : [];
  const requiredChanges = data ? deriveRequiredChanges(data.readiness) : [];

  // A link into this page (from the Overview tab, or a bookmarked URL) can
  // carry `#required-changes` — on load, and whenever the hash changes again
  // without a full navigation, scroll to and focus the panel. When there is
  // nothing required (the vendor already fixed everything, or arrived here
  // straight after a re-analysis), focus the section heading instead of a
  // panel that no longer exists.
  useEffect(() => {
    if (!data) return;
    function focusRequiredChanges(): void {
      if (window.location.hash !== '#required-changes') return;
      const target = requiredChanges.length > 0 ? panelRef.current : headingRef.current;
      // jsdom (unit tests) has no `scrollIntoView` implementation — guard it
      // rather than skip the real browser behaviour.
      target?.scrollIntoView?.({ block: 'start' });
      target?.focus();
    }
    focusRequiredChanges();
    window.addEventListener('hashchange', focusRequiredChanges);
    return () => window.removeEventListener('hashchange', focusRequiredChanges);
  }, [data, requiredChanges.length]);

  if (loading) return <DeploymentConfigurationSkeleton />;
  if (!data) return null;

  const { application, readiness } = data;
  const details = deriveAnalysisDetails(readiness);
  const analyzing = application.analysisStatus === 'ANALYZING';

  function rememberOpener(): void {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function restoreFocus(): void {
    const opener = openerRef.current;
    requestAnimationFrame(() => opener?.focus());
  }

  function openFix(): void {
    rememberOpener();
    setFixOpen(true);
  }

  function openEdit(field: EditableReadinessField): void {
    rememberOpener();
    setEditingField(field);
  }

  return (
    <section aria-labelledby="deployment-configuration" className="flex flex-col gap-3">
      <RequiredChangesPanel
        ref={panelRef}
        changes={requiredChanges}
        onEdit={openEdit}
        onShowFix={openFix}
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="deployment-configuration" ref={headingRef} tabIndex={-1} className="scroll-mt-20 text-base font-semibold">
            Deployment configuration
          </h2>
          {presentation.readinessSummary ? (
            <p className="text-sm text-muted-foreground">{presentation.readinessSummary}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {readiness.analyzedCommitSha ? (
            <span data-testid="readiness-commit">Analysed commit {readiness.analyzedCommitSha.slice(0, 7)}</span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reanalyse()}
            loading={reanalysing}
            loadingText="Analysing application…"
            disabled={presentation.state === 'analysing'}
            data-testid="app-details-reanalyse"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Re-analyse
          </Button>
        </div>
      </div>

      <Card className="py-0">
        <CardContent className="overflow-x-auto p-0">
          <Table data-testid="readiness-table">
            <TableHeader>
              <TableRow>
                <TableHead>Configuration</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={analyzing || undefined}>
              {rows.map((row) => (
                <ConfigurationTableRow
                  key={row.id}
                  row={row}
                  onEdit={openEdit}
                  onShowFix={openFix}
                />
              ))}
              {rows.length === 0 ? <ConfigurationTablePlaceholder analysisStatus={application.analysisStatus} /> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AnalysisDetailsSection details={details} />

      <RequirementDriftNotice drifts={readiness.deploymentRequirementDrift} />

      <FixInstructionsDialog
        open={fixOpen}
        applicationId={application.id}
        onClose={() => {
          setFixOpen(false);
          restoreFocus();
        }}
        onReanalyse={() => {
          void reanalyse();
          setFixOpen(false);
        }}
      />

      <EditDialog
        field={editingField}
        application={application}
        readiness={readiness}
        onClose={() => {
          setEditingField(null);
          restoreFocus();
        }}
        onSaved={refresh}
      />
    </section>
  );
}

// The panel a vendor lands on from the Overview tab's "N changes required"
// link (`#required-changes`) or scrolls to on their own — every blocking
// finding in one place, each routed to the same fix (edit dialog or
// instructions) the table row below uses.
function RequiredChangesPanel({
  ref,
  changes,
  onEdit,
  onShowFix,
}: {
  ref: React.Ref<HTMLDivElement>;
  changes: RequiredChange[];
  onEdit: (field: EditableReadinessField) => void;
  onShowFix: () => void;
}) {
  if (changes.length === 0) return null;
  return (
    <div
      ref={ref}
      id="required-changes"
      tabIndex={-1}
      className="scroll-mt-20 rounded-xl border border-destructive/40 bg-card outline-none"
      aria-labelledby="required-changes-heading"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          <h2 id="required-changes-heading" className="text-base font-semibold">
            Required changes
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          {changes.length} {changes.length === 1 ? 'change' : 'changes'} needed before this application is ready to
          deploy.
        </p>
        <ul className="flex flex-col gap-2">
          {changes.map((change) => {
            const fix = change.fix;
            return (
              <li
                key={change.finding.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
                data-testid={`required-change-${change.finding.id}`}
              >
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">{change.label}</p>
                  <p className="text-sm text-muted-foreground">{change.explanation}</p>
                  {fix.kind === 'instructions' ? (
                    <p className="text-xs text-muted-foreground">Change your repository, then re-analyse.</p>
                  ) : null}
                </div>
                {fix.kind === 'edit' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => onEdit(fix.field)}
                    data-testid={`required-change-fix-${change.finding.id}`}
                  >
                    Fix
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={onShowFix}
                    data-testid={`required-change-fix-${change.finding.id}`}
                  >
                    Get fix instructions
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ConfigurationTableRow({
  row,
  onEdit,
  onShowFix,
}: {
  row: ConfigurationRow;
  onEdit: (field: EditableReadinessField) => void;
  onShowFix: () => void;
}) {
  const firstFindingId = row.findingIds[0];
  const isSetting = isSettingRowId(row.id);
  const testId = isSetting ? `readiness-setting-${row.id}` : `readiness-finding-${firstFindingId}`;
  const action = row.action;

  return (
    <TableRow id={firstFindingId ? `readiness-row-${firstFindingId}` : undefined} data-testid={testId}>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{row.label}</span>
          {row.help ? (
            <InfoPopover label={`Details for ${row.label}`}>
              <p className="text-sm text-muted-foreground">{row.help}</p>
            </InfoPopover>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-0.5">
          {COMMAND_ROW_IDS.has(row.id) && row.value.length > LONG_VALUE_THRESHOLD ? (
            <CommandValue value={row.value} />
          ) : (
            <span>{row.value}</span>
          )}
          {row.detail ? <span className="text-xs text-muted-foreground">{row.detail}</span> : null}
        </div>
      </TableCell>
      <TableCell>
        {/* Ready and Not used are already spelled out by the value cell next
            to them — a pill repeating the same word adds noise, not
            information. Change required / Recommended / Needs review keep
            their badge because the value cell alone does not say that. */}
        {row.result.label === 'Ready' || row.result.label === 'Not used' ? null : (
          <Badge variant={row.result.variant}>{row.result.label}</Badge>
        )}
      </TableCell>
      <TableCell>
        {action?.kind === 'edit' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(action.field)}
            data-testid={`readiness-setting-edit-${row.id}`}
          >
            {action.label}
          </Button>
        ) : action?.kind === 'fix' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onShowFix}
            data-testid={`readiness-finding-fix-${firstFindingId}`}
          >
            Fix
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

// A long build/start/migration/worker command: one abbreviated monospace
// line (CSS truncation, not JS measurement) plus a popover with the exact
// text and a copy button — keyboard-accessible without widening the table or
// wrapping every other row.
function CommandValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="block max-w-56 truncate font-mono text-sm" title={value}>
        {value}
      </code>
      <Popover onOpenChange={(open) => !open && setCopied(false)}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground">
            Show full command
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-2">
          <code className="block max-h-40 overflow-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap">
            {value}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(value).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// A single-line info affordance for a row's secondary text — same pattern as
// the old readiness table's InfoPopover.
function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} className="text-muted-foreground">
          <Info aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

// The rows only exist once an analysis has completed. While one runs, the
// table keeps its geometry with skeleton rows; before the first analysis it
// says what the vendor has to do to fill it.
function ConfigurationTablePlaceholder({ analysisStatus }: { analysisStatus: AnalysisStatus }) {
  if (analysisStatus === 'ANALYZING') {
    return (
      <>
        <TableRow>
          <TableCell colSpan={4} className="sr-only" role="status">
            Checking deployment configuration…
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
      ? 'The configuration will show here after a successful analysis.'
      : 'Analyse the application to see its deployment configuration.';
  return (
    <TableRow>
      <TableCell colSpan={4} className="text-muted-foreground" data-testid="readiness-empty">
        {message}
      </TableCell>
    </TableRow>
  );
}

function AnalysisDetailsSection({ details }: { details: AnalysisDetail[] }) {
  if (details.length === 0) return null;
  return (
    <Collapsible className="rounded-md border" data-testid="analysis-details">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm">
        <span className="font-medium">Analysis details</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 border-t px-4 py-4">
          {details.map((detail) => (
            <div key={detail.id}>
              <h3 className="text-sm font-medium">{detail.label}</h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                {detail.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DeploymentConfigurationSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" data-testid="deployment-configuration-loading">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
