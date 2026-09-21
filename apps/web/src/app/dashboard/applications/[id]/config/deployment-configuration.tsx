'use client';

import { ChevronDown, Info, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';

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
  isSettingRowId,
  type AnalysisDetail,
  type ConfigurationRow,
} from '@/lib/application-configuration';
import type { EditableReadinessField } from '@/lib/readiness';

import { useApplicationPage } from '../application-page-context';
import { EditDialog, RequirementDriftNotice } from '../readiness-components';

// The Configuration tab's readiness surface — everything that used to live on
// the overview page's "Deployment readiness" table, now framed around what a
// vendor configures rather than what the analyser checked. Re-analysis lives
// here too: the table is what a fresh analysis actually changes.
export function DeploymentConfiguration() {
  const { data, loading, presentation, refresh, reanalyse, reanalysing } = useApplicationPage();
  const [editingField, setEditingField] = useState<EditableReadinessField | null>(null);
  const [fixOpen, setFixOpen] = useState(false);

  if (loading) return <DeploymentConfigurationSkeleton />;
  if (!data) return null;

  const { application, readiness } = data;
  const rows = deriveConfigurationRows(application, readiness);
  const details = deriveAnalysisDetails(readiness);
  const analyzing = application.analysisStatus === 'ANALYZING';

  return (
    <section aria-labelledby="deployment-configuration" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="deployment-configuration" className="scroll-mt-20 text-base font-semibold">
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
                  onEdit={setEditingField}
                  onShowFix={() => setFixOpen(true)}
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
        onClose={() => setFixOpen(false)}
        onReanalyse={() => {
          void reanalyse();
          setFixOpen(false);
        }}
      />

      <EditDialog
        field={editingField}
        application={application}
        readiness={readiness}
        onClose={() => setEditingField(null)}
        onSaved={refresh}
      />
    </section>
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
        <div className="flex flex-col">
          <span>{row.value}</span>
          {row.detail ? <span className="text-xs text-muted-foreground">{row.detail}</span> : null}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={row.result.variant}>{row.result.label}</Badge>
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
