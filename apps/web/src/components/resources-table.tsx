'use client';

import type { ComponentProgress, SpecComponent } from '@deployz/contracts';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import {
  COMPONENT_PROGRESS_LABEL,
  COMPONENT_STATUS_TONE,
  specComponentPresentation,
} from '@/lib/deployment-progress';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/lib/status-tone';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// Customer-facing resource-status table (this PR's redesign). One row per
// resource the deployment actually needs, with an honest state label — a
// READY resource never reads "Creating", and a not-yet-started resource
// reads "Waiting" rather than masquerading as in-progress. Rows come from
// either the spec-derived `specComponents` or the legacy `components` list,
// whichever the server sent.

export interface ResourcesTableProps {
  /** Spec-derived rows, when the deployment has a frozen spec. */
  specComponents: SpecComponent[] | undefined;
  /** Legacy rows, when no spec exists. NOT_REQUIRED entries are filtered. */
  components: ComponentProgress[];
  /** Suppress the state column at READY: the headline already says the app
   *  is ready, and a "Ready" column on every row would be redundant. */
  showState: boolean;
}

export function ResourcesTable({ specComponents, components, showState }: ResourcesTableProps) {
  const rows = buildRows(specComponents, components);
  if (rows.length === 0) return null;
  return (
    <section
      aria-labelledby="deployment-resources"
      className="flex flex-col gap-3"
      data-testid="deployment-resources"
    >
      <h2 id="deployment-resources" className="text-base font-semibold">
        Resources
      </h2>
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-full">Resource</TableHead>
              {showState ? <TableHead className="w-[40%] whitespace-nowrap sm:w-[20%]">Status</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} data-testid={`resource-row-${row.key}`}>
                <TableCell className="align-top">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm">{row.label}</span>
                    {row.detail ? (
                      <span className="text-xs text-muted-foreground">{row.detail}</span>
                    ) : null}
                  </div>
                </TableCell>
                {showState ? (
                  <TableCell className="align-top">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ResourceMarker tone={row.tone} state={row.state} />
                      <span className={cn(TONE_TEXT[row.tone])}>{row.stateLabel}</span>
                    </span>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

interface ResourceRow {
  key: string;
  label: string;
  detail: string | undefined;
  state: 'done' | 'progress' | 'waiting' | 'failed';
  stateLabel: string;
  tone: Tone;
}

function buildRows(specComponents: SpecComponent[] | undefined, components: ComponentProgress[]): ResourceRow[] {
  if (specComponents && specComponents.length > 0) {
    return specComponents.map((component) => {
      const view = specComponentPresentation(component);
      return {
        key: component.componentId,
        label: view.label,
        detail: view.detail,
        state: stateFromSpec(component.state),
        stateLabel: view.stateLabel,
        tone: view.tone,
      };
    });
  }
  return components
    .filter((component) => component.status !== 'NOT_REQUIRED')
    .map((component) => {
      const tone = COMPONENT_STATUS_TONE[component.status];
      return {
        key: component.key,
        label: component.label,
        detail: undefined,
        state: stateFromLegacy(component.status),
        stateLabel: COMPONENT_PROGRESS_LABEL[component.status],
        tone,
      };
    });
}

function stateFromSpec(state: SpecComponent['state']): ResourceRow['state'] {
  switch (state) {
    case 'COMPLETE':
      return 'done';
    case 'IN_PROGRESS':
      return 'progress';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return 'waiting';
  }
}

function stateFromLegacy(status: ComponentProgress['status']): ResourceRow['state'] {
  switch (status) {
    case 'READY':
      return 'done';
    case 'IN_PROGRESS':
      return 'progress';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return 'waiting';
    case 'NOT_REQUIRED':
      return 'waiting';
  }
}

function ResourceMarker({ state, tone }: { state: ResourceRow['state']; tone: Tone }) {
  if (state === 'progress') {
    return <Loader2 aria-hidden className={cn('size-3.5 shrink-0 animate-spin', TONE_TEXT[tone])} />;
  }
  if (state === 'done') {
    return <CheckCircle2 aria-hidden className={cn('size-3.5 shrink-0', TONE_TEXT[tone])} />;
  }
  if (state === 'failed') {
    return <AlertCircle aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  }
  return (
    <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
  );
}
