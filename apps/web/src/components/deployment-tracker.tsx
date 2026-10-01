'use client';

import { useEffect, useState } from 'react';

import type { CustomerDeploymentStatus } from '@deployz/contracts';
import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  elapsedLabel,
  formatDurationRange,
  liveDurationLine,
  stepperProgressCount,
  stepperRungDescription,
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
}

export function DeploymentTracker({ stage, steps, liveDetail }: DeploymentTrackerProps) {
  const { completed, total } = stepperProgressCount(steps);
  const current = steps.find((step) => step.state === 'current' || step.state === 'attention') ?? null;
  const headline =
    stage === 'READY'
      ? 'Application ready'
      : stage === 'FAILED'
        ? 'Deployment failed'
        : 'Deploying application';
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
          {headline}
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
