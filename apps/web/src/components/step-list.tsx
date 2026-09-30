'use client';

import { AlertCircle, CheckCircle2, ChevronDown, Circle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  checkedLabel,
  elapsedLabel,
  liveDurationLine,
  type ProgressStep,
} from '@/lib/deployment-progress';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

// The one step list for install, update and removal (ux-guidelines §9, §11):
// replaces deployment-progress-steps, deployment-stepper and
// live-step-detail. Completed steps collapse into "N steps done" once a
// current step exists; the current step carries its live detail (elapsed
// time, typical duration, "Checked just now"); the next step is named, not
// itemized. Deliberately not a progress bar — states only, never a percentage.

export interface StepListItem extends ProgressStep {
  /** Compact sub-rows under this step — only rendered while it is current
   *  (the customer stepper's data/cache/migration rows under "Starting
   *  application"). */
  substeps?: ProgressStep[];
}

/** Live detail for the current step only — elapsed time, typical duration or
 *  the slow-step nudge, and freshness. Omit for a step list that already
 *  carries its own static `detail`/`meta` per step (the vendor card). */
export interface StepListLiveDetail {
  currentActivity: string;
  takingLongerThanUsual: boolean;
  typicalDurationSeconds: { min: number; max: number } | null;
  stepStartedAt: string | null;
  checkedAt: number | null;
  /** Stops the ticking clock once the stage is terminal. */
  active: boolean;
}

export function StepList({
  steps,
  liveDetail,
  className,
}: {
  steps: StepListItem[];
  liveDetail?: StepListLiveDetail | undefined;
  className?: string;
}) {
  const currentIndex = steps.findIndex((step) => step.state === 'current' || step.state === 'attention');
  const current = currentIndex >= 0 ? steps[currentIndex]! : null;
  const doneSteps = currentIndex >= 0 ? steps.slice(0, currentIndex) : steps.filter((step) => step.state === 'done');
  // A failed step has no "next": the operation stopped there.
  const next =
    current?.state === 'current' ? steps.slice(currentIndex + 1).find((step) => step.state === 'waiting') : undefined;
  // Nothing current (e.g. every step finished, or the list hasn't started):
  // render the plain list rather than a collapse with nothing to expand into.
  const flatList = current === null;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
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
            <ol className="flex flex-col gap-2 pt-2">
              {doneSteps.map((step) => (
                <StepRow key={step.key} step={step} />
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {flatList ? (
        <ol className="flex flex-col gap-2">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ol>
      ) : (
        <>
          <StepRow step={current} live={liveDetail} />
          {next ? (
            <p className="pl-[26px] text-xs text-muted-foreground" data-testid="step-list-next">
              Next: {next.label}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function StepRow({ step, live }: { step: StepListItem; live?: StepListLiveDetail | undefined }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <StepIcon state={step.state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            step.state === 'waiting' && 'text-muted-foreground',
            step.state === 'current' && 'font-medium',
            step.state === 'attention' && 'font-medium text-destructive',
          )}
        >
          {step.label}
          {step.state === 'current' ? <span className="sr-only"> (in progress)</span> : null}
          {step.state === 'done' ? <span className="sr-only"> (complete)</span> : null}
          {step.state === 'attention' ? <span className="sr-only"> (failed)</span> : null}
        </span>
        {live ? (
          <LiveStepLine {...live} />
        ) : step.detail ? (
          <span className="text-xs text-muted-foreground">{step.detail}</span>
        ) : null}
        {step.substeps && step.substeps.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1.5">
            {step.substeps.map((substep) => (
              <li key={substep.key} className="flex items-start gap-2 text-xs">
                <SubstepIcon state={substep.state} />
                <span
                  className={cn(
                    substep.state === 'waiting' && 'text-muted-foreground',
                    substep.state === 'attention' && 'text-destructive',
                  )}
                >
                  {substep.label}
                  {substep.state === 'current' ? <span className="sr-only"> (in progress)</span> : null}
                  {substep.state === 'done' ? <span className="sr-only"> (complete)</span> : null}
                  {substep.state === 'attention' ? <span className="sr-only"> (failed)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </span>
      {step.meta ? <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{step.meta}</span> : null}
    </li>
  );
}

/** The current step's ticking detail: what is happening right now, the
 *  typical-duration/slow-step line with a live elapsed counter, and when
 *  Deployz last checked (ux-guidelines §9). Replaces live-step-detail.tsx. */
function LiveStepLine({
  currentActivity,
  takingLongerThanUsual,
  typicalDurationSeconds,
  stepStartedAt,
  checkedAt,
  active,
}: StepListLiveDetail) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const elapsed = elapsedLabel(stepStartedAt, now);
  const durationLine = liveDurationLine({ takingLongerThanUsual, typicalDurationSeconds, elapsed });
  const checked = checkedLabel(checkedAt, now);

  return (
    <span className="flex flex-col text-xs text-muted-foreground">
      <span>{currentActivity}</span>
      {durationLine ? (
        // The slow-step sentence is a warning: it gets the attention tone so
        // it reads as amber, not as another muted timing line.
        <span className={cn(takingLongerThanUsual && TONE_TEXT.attention)}>{durationLine}</span>
      ) : null}
      {checked ? <span>{checked}</span> : null}
    </span>
  );
}

function StepIcon({ state }: { state: ProgressStep['state'] }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 aria-hidden className="size-4 shrink-0 text-primary" />;
    case 'current':
      return <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />;
    case 'attention':
      return <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" />;
    case 'waiting':
      return <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />;
  }
}

function SubstepIcon({ state }: { state: ProgressStep['state'] }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />;
    case 'current':
      return <Loader2 aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />;
    case 'attention':
      return <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
    case 'waiting':
      return <Circle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" />;
  }
}
