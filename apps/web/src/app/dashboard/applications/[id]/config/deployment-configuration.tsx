'use client';

import { ChevronDown, Info, TriangleAlert } from 'lucide-react';
import { Fragment, forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';

import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { TechnicalDetails } from '@/components/technical-details';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import type { Application, AnalysisStatus } from '@/lib/applications';
import { deriveAnalysisDetails, deriveRequiredChanges, type AnalysisDetail, type RequiredChange } from '@/lib/application-configuration';
import {
  deriveServiceInventory,
  formatRowCost,
  type InventoryAction,
  type InventoryGroup,
  type InventoryRow,
  type RowCost,
} from '@/lib/configuration-inventory';
import type {
  ApplicationArchitecture,
  ApplicationReadiness,
  DeploymentRequirementDriftSummary,
  EditableReadinessField,
} from '@/lib/readiness';

import { useApplicationPage } from '../application-page-context';
import { EditDialog, RequirementDriftNotice } from '../readiness-components';
import { DeploymentSize } from './deployment-size';

const COLUMN_COUNT = 6;

const NODE_STATE_COPY: Record<'detected' | 'confirmed', string> = {
  detected: 'Detected automatically',
  confirmed: 'Confirmed',
};

/** The one edit/fix dialog pair every row and the attention summary route into. */
export function ConfigurationDialogs({
  applicationId,
  application,
  readiness,
  editingField,
  fixOpen,
  onCloseFix,
  onCloseEdit,
  onReanalyse,
  onSaved,
}: {
  applicationId: string;
  application: Application;
  readiness: ApplicationReadiness;
  editingField: EditableReadinessField | null;
  fixOpen: boolean;
  onCloseFix: () => void;
  onCloseEdit: () => void;
  onReanalyse: () => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <>
      <FixInstructionsDialog
        open={fixOpen}
        applicationId={applicationId}
        onClose={onCloseFix}
        onReanalyse={onReanalyse}
      />
      <EditDialog
        field={editingField}
        application={application}
        readiness={readiness}
        onClose={onCloseEdit}
        onSaved={onSaved}
      />
    </>
  );
}

// The Configuration tab's analysis-driven part: the attention summary, the
// deployment size and estimate, then the one "Services & resources" table.
// `children` (the environment variables table) follows the services table.
export function DeploymentConfiguration({ children }: { children?: ReactNode }) {
  const { data, loading, presentation, refresh, reanalyse } = useApplicationPage();
  const [editingField, setEditingField] = useState<EditableReadinessField | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // The dialogs open from state, not from a Radix trigger, so Radix has no
  // element to return focus to on close — keep the opener and restore it.
  const openerRef = useRef<HTMLElement | null>(null);

  const inventory = data ? deriveServiceInventory(data) : null;
  const requiredChanges = data ? deriveRequiredChanges(data.readiness) : [];
  const attentionItems = data && inventory ? deriveAttentionItems(data.readiness, inventory.groups) : [];
  const hasAttention = requiredChanges.length > 0 || attentionItems.length > 0;

  // A link into this page (from the Overview tab, or a bookmarked URL) can
  // carry `#required-changes` — on load, and whenever the hash changes again
  // without a full navigation, scroll to and focus the summary. With nothing
  // to fix, focus the services heading instead of a summary that is gone.
  useEffect(() => {
    if (!data) return;
    function focusRequiredChanges(): void {
      if (window.location.hash !== '#required-changes') return;
      const target = hasAttention ? panelRef.current : headingRef.current;
      // jsdom (unit tests) has no `scrollIntoView` implementation.
      target?.scrollIntoView?.({ block: 'start' });
      target?.focus();
    }
    focusRequiredChanges();
    window.addEventListener('hashchange', focusRequiredChanges);
    return () => window.removeEventListener('hashchange', focusRequiredChanges);
  }, [data, hasAttention]);

  if (loading) {
    return (
      <>
        <DeploymentConfigurationSkeleton />
        {children}
      </>
    );
  }
  if (!data || !inventory) return <>{children}</>;

  const { application, readiness } = data;
  const analyzing = application.analysisStatus === 'ANALYZING';

  function rememberOpener(): void {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  function restoreFocus(): void {
    const opener = openerRef.current;
    requestAnimationFrame(() => opener?.focus());
  }
  function runAction(action: InventoryAction | RequiredChange['fix']): void {
    rememberOpener();
    if (action.kind === 'edit') setEditingField(action.field);
    else setFixOpen(true);
  }

  return (
    <>
      <AttentionSummary ref={panelRef} changes={requiredChanges} items={attentionItems} onAction={runAction} />

      {application.analysisStatus === 'COMPLETE' ? (
        <DeploymentSize
          plan={data.plan}
          externalServices={inventory.externalServices}
          unestimatedWorkload={inventory.unestimatedWorkload}
        />
      ) : null}

      <ServicesSection
        ref={headingRef}
        groups={inventory.groups}
        analyzing={analyzing}
        analysisStatus={application.analysisStatus}
        readinessSummary={presentation.readinessSummary}
        analyzedCommitSha={readiness.analyzedCommitSha}
        details={deriveAnalysisDetails(readiness)}
        architecture={readiness.architecture ?? null}
        drifts={readiness.deploymentRequirementDrift}
        onAction={runAction}
      />

      {children}

      <ConfigurationDialogs
        applicationId={application.id}
        application={application}
        readiness={readiness}
        editingField={editingField}
        fixOpen={fixOpen}
        onCloseFix={() => {
          setFixOpen(false);
          restoreFocus();
        }}
        onCloseEdit={() => {
          setEditingField(null);
          restoreFocus();
        }}
        onReanalyse={() => {
          void reanalyse();
          setFixOpen(false);
        }}
        onSaved={refresh}
      />
    </>
  );
}

/** One line of the attention summary that is not a required change: a link to the affected row. */
interface AttentionItem {
  id: string;
  text: string;
  href: string;
}

function rowAnchor(row: InventoryRow): string {
  return `#config-row-${row.id}`;
}

/**
 * Everything that needs the vendor, once each: the architecture questions
 * and the environment variables that still need a decision or a value.
 * Recommended findings and external services stay on their own rows.
 * Required findings render separately above these, with their Fix action.
 */
function deriveAttentionItems(readiness: ApplicationReadiness, groups: InventoryGroup[]): AttentionItem[] {
  const rows = groups.flatMap((group) => group.rows);
  const items: AttentionItem[] = [];
  const unresolved = readiness.architecture?.unresolved ?? [];

  unresolved.forEach((item, index) => {
    const row = rows.find((candidate) => candidate.questionIndexes.includes(index));
    items.push({ id: `question-${index}`, text: item.question, href: row ? rowAnchor(row) : '#services' });
  });
  const setup = readiness.environmentSetup ?? null;
  if (setup && setup.needsDecision > 0) {
    items.push({
      id: 'env-decisions',
      text: `${setup.needsDecision} environment ${setup.needsDecision === 1 ? 'variable needs' : 'variables need'} a decision`,
      href: '#environment-variables',
    });
  }
  if (setup && setup.missingValue > 0) {
    items.push({
      id: 'env-values',
      text: `${setup.missingValue} environment ${setup.missingValue === 1 ? 'variable needs' : 'variables need'} a value`,
      href: '#environment-variables',
    });
  }
  return items;
}

const AttentionSummary = forwardRef<
  HTMLDivElement,
  {
    changes: RequiredChange[];
    items: AttentionItem[];
    onAction: (fix: RequiredChange['fix']) => void;
  }
>(function AttentionSummary({ changes, items, onAction }, ref) {
  if (changes.length === 0 && items.length === 0) return null;
  return (
    <div
      ref={ref}
      id="required-changes"
      tabIndex={-1}
      className="scroll-mt-20 rounded-xl border border-destructive/40 bg-card outline-none"
      aria-labelledby="required-changes-heading"
      data-testid="attention-summary"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          <h2 id="required-changes-heading" className="text-base font-semibold">
            Needs attention
          </h2>
        </div>
        {changes.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {changes.length} {changes.length === 1 ? 'change' : 'changes'} needed before deploy.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {changes.map((change) => (
            <li
              key={change.finding.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
              data-testid={`required-change-${change.finding.id}`}
            >
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">{change.label}</p>
                <p className="text-sm text-muted-foreground">{change.explanation}</p>
                {change.fix.kind === 'instructions' ? (
                  <p className="text-xs text-muted-foreground">Change your repository, then re-analyse.</p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => onAction(change.fix)}
                data-testid={`required-change-fix-${change.finding.id}`}
              >
                {change.fix.kind === 'edit' ? 'Fix' : 'Get fix instructions'}
              </Button>
            </li>
          ))}
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
              data-testid={`attention-item-${item.id}`}
            >
              <p className="min-w-0 text-sm">{item.text}</p>
              <Button asChild variant="ghost" size="sm" className="shrink-0">
                <a href={item.href}>Go to row</a>
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});

const ServicesSection = forwardRef<
  HTMLHeadingElement,
  {
    groups: InventoryGroup[];
    analyzing: boolean;
    analysisStatus: AnalysisStatus;
    readinessSummary: string | null;
    analyzedCommitSha: string | null;
    details: AnalysisDetail[];
    architecture: ApplicationArchitecture | null;
    drifts: DeploymentRequirementDriftSummary[];
    onAction: (action: InventoryAction) => void;
  }
>(function ServicesSection(
  { groups, analyzing, analysisStatus, readinessSummary, analyzedCommitSha, details, architecture, drifts, onAction },
  ref,
) {
  const hasKept = groups.some((group) =>
    group.rows.some((row) => row.afterRemoval === 'Kept' || row.afterRemoval === 'Mixed'),
  );
  const detectedGroups = architecture?.groups ?? [];

  return (
    <section id="services" aria-labelledby="services-heading" className="flex scroll-mt-20 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="services-heading" ref={ref} tabIndex={-1} className="text-base font-semibold outline-none">
            Services & resources
          </h2>
          {readinessSummary ? <p className="text-sm text-muted-foreground">{readinessSummary}</p> : null}
        </div>
        {analyzedCommitSha ? (
          <span className="shrink-0 text-sm text-muted-foreground" data-testid="readiness-commit">
            Analysed commit {analyzedCommitSha.slice(0, 7)}
          </span>
        ) : null}
      </div>

      <Card className="py-0">
        <CardContent className="p-0">
          <Table data-testid="services-table" className="min-w-[56rem] max-md:block max-md:min-w-0">
            <TableHeader className="max-md:hidden">
              <TableRow>
                <TableHead className="w-48">Item</TableHead>
                <TableHead>Configuration / resources</TableHead>
                <TableHead className="w-32">Est. AWS/month</TableHead>
                <TableHead className="w-28">After removal</TableHead>
                <TableHead className="w-56">Issues</TableHead>
                <TableHead className="w-44">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={analyzing || undefined} className="max-md:block">
              {groups.map((group) => (
                <Fragment key={group.id}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50 max-md:block" data-testid={`services-group-${group.id}`}>
                    <TableHead colSpan={COLUMN_COUNT} scope="colgroup" className="text-foreground max-md:block">
                      {group.label}
                    </TableHead>
                  </TableRow>
                  {group.rows.map((row) => (
                    <ServiceRow key={row.id} row={row} onAction={onAction} />
                  ))}
                </Fragment>
              ))}
              {groups.length === 0 ? <ServicesTablePlaceholder analysisStatus={analysisStatus} /> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {hasKept ? (
        <p className="text-xs text-muted-foreground">
          Kept resources stay in the customer&apos;s AWS account after removal and keep costing money until their data
          is deleted.
        </p>
      ) : null}

      {details.length > 0 || detectedGroups.length > 0 ? (
        <TechnicalDetails>
          <div className="flex flex-col gap-4">
            {detectedGroups.length > 0 ? (
              <div data-testid="detected-components">
                <h3 className="text-sm font-medium">Detected components</h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                  {detectedGroups.flatMap((group) =>
                    group.nodes.map((node) => (
                      <li key={`${group.group}-${node.label}`}>
                        {node.label} · {NODE_STATE_COPY[node.state]}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            ) : null}
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
        </TechnicalDetails>
      ) : null}
      <RequirementDriftNotice drifts={drifts} />
    </section>
  );
});

function costText(cost: RowCost): string | null {
  if (cost === null) return null;
  if (cost === 'billed-separately') return 'Billed separately';
  if (cost === 'not-estimated') return 'Not estimated';
  return formatRowCost(cost);
}

function ServiceRow({ row, onAction }: { row: InventoryRow; onAction: (action: InventoryAction) => void }) {
  const cost = costText(row.cost);
  const action = row.action;
  const mixed = row.afterRemoval === 'Mixed';

  return (
    <TableRow
      id={`config-row-${row.id}`}
      className="scroll-mt-20 max-md:flex max-md:flex-col max-md:gap-1.5 max-md:py-2"
      data-testid={row.testId}
    >
      <TableCell
        className={
          row.indent
            ? 'pl-8 align-top text-muted-foreground max-md:py-0 max-md:pl-6'
            : 'align-top font-medium max-md:py-0'
        }
      >
        <div className="flex items-center gap-1.5">
          <span>{row.label}</span>
          {row.help ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Details for ${row.label}`} className="text-muted-foreground">
                  <Info aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72">
                <p className="text-sm text-muted-foreground">{row.help}</p>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="align-top max-md:py-0">
        <div className="flex min-w-0 flex-col gap-1">
          {row.configuration ? (
            row.command ? (
              <code className="font-mono text-xs break-all whitespace-pre-wrap">{row.configuration}</code>
            ) : (
              <span>{row.configuration}</span>
            )
          ) : null}
          {row.detail ? <span className="text-xs text-muted-foreground">{row.detail}</span> : null}
          {row.resources.length > 0 ? (
            // AWS resource names stay one click away, so the page's top-level
            // copy stays free of AWS terms (ux-guidelines §65).
            <Collapsible data-testid={`${row.testId}-resources`}>
              <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                Planned AWS resources ({row.resources.length})
                <ChevronDown aria-hidden className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {row.resources.map((resource) => (
                    <li key={resource.id} data-testid={`inventory-resource-${resource.id}`}>
                      <span className="text-foreground">{resource.name}</span> · {resource.purpose}
                      {mixed ? ` · ${resource.afterRemoval}` : ''}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </TableCell>
      <TableCell
        data-label="Est. AWS/month: "
        className="align-top tabular-nums max-md:py-0 max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)] max-md:empty:hidden"
      >
        {cost}
      </TableCell>
      <TableCell
        data-label="After removal: "
        className="align-top max-md:py-0 max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)] max-md:empty:hidden"
      >
        {row.afterRemoval === 'Kept' ? (
          <Badge variant="secondary">Kept</Badge>
        ) : row.afterRemoval === 'Removed' || mixed ? (
          <Badge variant="outline">{row.afterRemoval}</Badge>
        ) : row.afterRemoval === 'Not determined' ? (
          <span className="text-muted-foreground">Not determined</span>
        ) : null}
      </TableCell>
      <TableCell className="align-top max-md:py-0 max-md:empty:hidden">
        {row.issues.length > 0 ? (
          <div className="flex flex-col gap-1">
            {row.issues.map((issue, index) => (
              <div key={index} className="flex flex-col items-start gap-0.5">
                <Badge variant={issue.variant}>{issue.label}</Badge>
                {issue.text ? <span className="text-xs text-muted-foreground">{issue.text}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="align-top max-md:py-0 max-md:empty:hidden">
        {action?.kind === 'link' ? (
          <Button asChild variant="outline" size="sm" data-testid={action.testId}>
            <a href={action.href}>{action.label}</a>
          </Button>
        ) : action ? (
          <Button variant="outline" size="sm" onClick={() => onAction(action)} data-testid={action.testId}>
            {action.label}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

// The rows only exist once an analysis has completed. While one runs, the
// table keeps its geometry with skeleton rows; before the first analysis it
// says what the vendor has to do to fill it.
function ServicesTablePlaceholder({ analysisStatus }: { analysisStatus: AnalysisStatus }) {
  if (analysisStatus === 'ANALYZING') {
    return (
      <>
        <TableRow>
          <TableCell colSpan={COLUMN_COUNT} className="sr-only" role="status">
            Checking deployment configuration…
          </TableCell>
        </TableRow>
        {[0, 1, 2].map((index) => (
          <TableRow key={index} aria-hidden data-testid="readiness-row-skeleton">
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-48" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-16 rounded-full" />
            </TableCell>
            <TableCell />
            <TableCell />
          </TableRow>
        ))}
      </>
    );
  }

  const message =
    analysisStatus === 'FAILED'
      ? 'Shown after a successful analysis.'
      : 'Analyse the application to see its configuration.';
  return (
    <TableRow>
      <TableCell colSpan={COLUMN_COUNT} className="text-muted-foreground" data-testid="readiness-empty">
        {message}
      </TableCell>
    </TableRow>
  );
}

export function DeploymentConfigurationSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" data-testid="deployment-configuration-loading">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
