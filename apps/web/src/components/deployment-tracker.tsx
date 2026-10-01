'use client';

import { useEffect, useState } from 'react';

import type { CustomerDeploymentStatus } from '@deployz/contracts';
import { AlertCircle, CheckCircle2, ChevronDown, Circle, Loader2 } from 'lucide-react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  AWAITING_DOMAIN_STEP_DETAIL,
  elapsedLabel,
  formatDurationRange,
  liveDurationLine,
  STAGE_HEADLINE,
  stepperProgressCount,
  stepperRungDescription,
  type ProgressStep,
  type StepperStep,
} from '@/lib/deployment-progress';
import { TONE_TEXT } from '@/lib/status-tone';

// The customer's deployment tracker (ux-guidelines §9 + this PR's redesign).
// One authoritative X-of-Y stepper replacing the prior top status card; the
// active rung carries its live detail (what's happening right now, elapsed
// time, typical range or slow-step nudge, last-checked freshness). The tracker
// speaks in deployment language, not CloudFormation language, and shows the
// reassuring sentence only when the server's `takingLongerThanUsual` flag is
// true — never as a guess.

export interface DeploymentTrackerLiveDetail {
  currentActivity: string;
  takingLongerThanUsual: boolean;
  typicalDurationSeconds: { min: number; max: number } | null;
  stepStartedAt: string | null;
  checkedAt: number | null;
  /** Stops the ticking clock once the stage is terminal. */
  active: boolean;
}

export interface DeploymentTrackerProps {
  /** The deployment stage — drives the headline title. */
  stage: CustomerDeploymentStatus['stage'];
  /** The stepper rungs to render. Order is wire order; state is per-rung. */
  steps: StepperStep[];
  /** Live detail for the current step (omitted at terminal stages). */
  liveDetail?: DeploymentTrackerLiveDetail | undefined;
  /**
   * The wire steps the server reported as applicable to this deployment, in
   * wire order, with per-step state. Renders below the redesigned stepper
   * as the legacy done-toggle + active-step detail so the existing wire-step
   * labels (Network created, Database & storage created, Application
   * started, Health checks passed, HTTPS set up) stay reachable from the
   * primary flow.
   */
  wireSteps?: ProgressStep[] | undefined;
}

export function DeploymentTracker({ stage, steps, liveDetail, wireSteps }: DeploymentTrackerProps) {
  const { completed, total } = stepperProgressCount(steps);
  const current = steps.find((step) => step.state === 'current' || step.state === 'attention') ?? null;
  // The primary headline mirrors the server-derived stage (the legacy
  // `STAGE_HEADLINE` map): one line, no jargon, no current-step duplication.
  // The X-of-Y secondary line carries the granular progress.
  const headline = STAGE_HEADLINE[stage];
  const headlineBody = stage === 'READY'
    ? 'Your application passed its health checks.'
    : stage === 'FAILED'
      ? 'Deployz stopped the deployment before it finished.'
      : `${completed} of ${total} ${total === 1 ? 'step' : 'steps'} complete`;

  return (
    <section
      aria-labelledby="deployment-tracker"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4"
      data-testid="deployment-tracker"
    >
      <header className="flex flex-col gap-1">
        <h2 id="deployment-tracker" aria-live="polite" className="text-base font-semibold">
          {headline.title}
        </h2>
        <p className="text-sm text-muted-foreground">{headlineBody}</p>
      </header>

      <ol className="flex flex-col" data-testid="deployment-tracker-steps">
        {steps.map((step, index) => (
          <TrackerStepRow
            key={step.key}
            step={step}
            liveDetail={
              liveDetail && (step.state === 'current' || step.state === 'attention')
                ? liveDetail
                : undefined
            }
            isLast={index === steps.length - 1}
          />
        ))}
      </ol>

      {current && liveDetail ? (
        <CurrentStepDetail
          current={current}
          liveDetail={liveDetail}
          takingLongerThanUsual={liveDetail.takingLongerThanUsual}
        />
      ) : null}

      {wireSteps && wireSteps.length > 0 ? (
        <WireStepList wireSteps={wireSteps} stage={stage} />
      ) : null}
    </section>
  );
}

function TrackerStepRow({
  step,
  isLast,
}: {
  step: StepperStep;
  liveDetail?: DeploymentTrackerLiveDetail | undefined;
  isLast: boolean;
}) {
  return (
    <li className="flex items-start gap-3 py-2" data-testid={`tracker-step-${step.key}`}>
      <div className="flex flex-col items-center self-stretch pt-0.5">
        <StepMarker state={step.state} />
        {!isLast ? (
          <span
            aria-hidden
            className={cn(
              'mt-1 w-px flex-1',
              step.state === 'done' ? 'bg-primary/40' : 'bg-border',
            )}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pb-1">
        <span
          className={cn(
            'text-sm',
            step.state === 'waiting' && 'text-muted-foreground',
            step.state === 'current' && 'font-medium',
            step.state === 'attention' && 'font-medium text-destructive',
          )}
        >
          {step.label}
          <span className="sr-only">
            {step.state === 'done'
              ? ' (complete)'
              : step.state === 'current'
                ? ' (in progress)'
                : step.state === 'attention'
                  ? ' (failed)'
                  : ''}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">{stepperRungDescription(step.key)}</span>
      </div>
    </li>
  );
}

function StepMarker({ state }: { state: StepperStep['state'] }) {
  switch (state) {
    case 'done':
      return (
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-primary" data-testid="step-marker-done" />
      );
    case 'current':
      return (
        <Loader2
          aria-hidden
          className="size-4 shrink-0 animate-spin text-primary"
          data-testid="step-marker-current"
        />
      );
    case 'attention':
      return (
        <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" data-testid="step-marker-attention" />
      );
    case 'waiting':
      return (
        <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/40" data-testid="step-marker-waiting" />
      );
  }
}

/**
 * The legacy wire-step list, kept reachable inside the redesigned tracker so
 * the per-step labels the server emits (Network created, Database & storage
 * created, Application started, Health checks passed, HTTPS set up, …) stay
 * visible alongside the new rung markers. Completed steps collapse into an
 * "N steps done" disclosure (ux-guidelines §9); the active step carries its
 * live detail, including the awaiting-domain line when the deployment is
 * paused on TLS waiting for a custom domain.
 */
function WireStepList({
  wireSteps,
  stage,
}: {
  wireSteps: ProgressStep[];
  stage: CustomerDeploymentStatus['stage'];
}) {
  const currentIndex = wireSteps.findIndex(
    (step) => step.state === 'current' || step.state === 'attention',
  );
  const current = currentIndex >= 0 ? wireSteps[currentIndex]! : null;
  const doneSteps = wireSteps.filter((step) => step.state === 'done');
  const failed = stage === 'FAILED';
  const isReady = stage === 'READY';
  const flatList = current === null;
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      {!flatList && doneSteps.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger
            className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="step-list-done-toggle"
          >
            {doneSteps.length} step{doneSteps.length === 1 ? '' : 's'} done
            <ChevronDown aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="flex flex-col gap-2 pt-2" data-testid="step-list-done-list">
              {doneSteps.map((step) => (
                <li key={step.key} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>{step.label}</span>
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {flatList ? (
        <ol className="flex flex-col gap-2" data-testid="step-list-all">
          {wireSteps.map((step) => (
            <li key={step.key} className="flex items-start gap-2 text-sm">
              {step.state === 'done' ? (
                <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : step.state === 'current' ? (
                <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
              ) : step.state === 'attention' ? (
                <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : (
                <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" />
              )}
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      ) : current ? (
        <div className="flex flex-col gap-1 text-sm" data-testid="step-list-current">
          <span className="flex items-start gap-2">
            {current.state === 'attention' ? (
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
            )}
            <span className={cn(current.state === 'attention' && 'font-medium text-destructive')}>
              {current.label}
            </span>
          </span>
          {/* The TLS step's customer-DNS-dependent pause carries a static
              line instead of an elapsed counter (the only step where
              Deployz never makes progress by itself). */}
          {current.key === 'TLS' && current.state === 'current' ? (
            <p className="pl-6 text-xs text-muted-foreground">{AWAITING_DOMAIN_STEP_DETAIL}</p>
          ) : null}
          {/* A failed step has no "next": the operation stopped there. */}
          {failed && current.state === 'attention' ? null : (
            <NextStepHint steps={wireSteps} currentIndex={currentIndex} />
          )}
        </div>
      ) : null}
      {isReady && doneSteps.length > 0 ? (
        <p className="text-xs text-muted-foreground">All {doneSteps.length} steps complete.</p>
      ) : null}
    </div>
  );
}

function NextStepHint({ steps, currentIndex }: { steps: ProgressStep[]; currentIndex: number }) {
  const next = steps.slice(currentIndex + 1).find((step) => step.state === 'waiting');
  if (!next) return null;
  return (
    <p className="pl-6 text-xs text-muted-foreground" data-testid="step-list-next">
      Next: {next.label}
    </p>
  );
}

/** The current rung's live detail line — what AWS is doing right now, the
 *  elapsed time and typical range, and the freshness stamp. Reassurance
 *  ("No action needed") is a thin amber band reserved for the slow-step
 *  state — never displayed when the server says progress is normal. */
function CurrentStepDetail({
  current,
  liveDetail,
  takingLongerThanUsual,
}: {
  current: StepperStep;
  liveDetail: DeploymentTrackerLiveDetail;
  takingLongerThanUsual: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveDetail.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveDetail.active]);

  const elapsed = elapsedLabel(liveDetail.stepStartedAt, now);
  const durationLine = liveDurationLine({
    takingLongerThanUsual,
    typicalDurationSeconds: liveDetail.typicalDurationSeconds,
    elapsed,
  });

  return (
    <div
      className="flex flex-col gap-1 border-t pt-3"
      data-testid="tracker-current-detail"
    >
      <p className="text-sm font-medium">{current.label}</p>
      <p className="text-sm text-muted-foreground">{liveDetail.currentActivity}</p>
      {durationLine ? <p className="text-xs text-muted-foreground">{durationLine}</p> : null}
      {takingLongerThanUsual ? (
        <p
          className={cn('mt-1 rounded-md border bg-muted px-3 py-2 text-xs', TONE_TEXT.attention)}
          data-testid="tracker-no-action-needed"
        >
          <span className="font-medium">No action needed.</span>{' '}
          AWS is still processing the deployment. Deployz is continuing to check.
        </p>
      ) : null}
    </div>
  );
}

/** "Usually 5–15 min" — the standalone typical-range label, exported for the
 *  page-level elapsed/timing line when the tracker is not active (terminal
 *  stages). Mirrors the format the live-detail line uses so a customer's
 *  reading of "usually X" is identical wherever it appears. */
export function typicalRangeLabel(range: { min: number; max: number }): string {
  return `Usually ${formatDurationRange(range)}`;
}
