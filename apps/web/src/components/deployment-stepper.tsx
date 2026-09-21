import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProgressStep, StepperStep } from '@/lib/deployment-progress';
import { TONE_TEXT } from '@/lib/status-tone';

// The customer pages' vertical stepper: a connector rail between fixed-size
// markers, grouped steps from customerStepperSteps, and the data/cache/
// migration wire steps as compact sub-rows under "Starting application".
// Deliberately not a progress bar: no percentages, only states. Markers are
// decorative — the state is always in the text, so color/shape never carries
// meaning alone. Only the genuinely active step animates (the spinner).
export function DeploymentStepper({ steps, className }: { steps: StepperStep[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li key={step.key} className="flex gap-3">
            <div aria-hidden className="flex flex-col items-center">
              <span className="flex size-6 shrink-0 items-center justify-center">
                <StepMarker state={step.state} />
              </span>
              {last ? null : <span className="w-px grow bg-border" />}
            </div>
            <div className={cn('flex min-w-0 flex-col gap-1', !last && 'pb-5')}>
              <span
                className={cn(
                  'text-sm font-medium leading-6',
                  step.state === 'waiting' && 'font-normal text-muted-foreground',
                  step.state === 'attention' && 'text-destructive',
                )}
              >
                {step.label}
                {step.state === 'current' ? <span className="sr-only"> (in progress)</span> : null}
                {step.state === 'done' ? <span className="sr-only"> (complete)</span> : null}
                {step.state === 'attention' ? <span className="sr-only"> (failed)</span> : null}
              </span>
              {step.detail ? (
                <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">{step.detail}</div>
              ) : null}
              {step.substeps && step.substeps.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1.5">
                  {step.substeps.map((substep) => (
                    <li key={substep.key} className="flex items-start gap-2 text-xs">
                      <SubstepMarker state={substep.state} />
                      <span
                        className={cn(
                          'leading-5',
                          substep.state === 'waiting' && 'text-muted-foreground',
                          substep.state === 'attention' && 'text-destructive',
                        )}
                      >
                        {substep.label}
                        {substep.state === 'current' ? (
                          <span className="sr-only"> (in progress)</span>
                        ) : null}
                        {substep.state === 'done' ? <span className="sr-only"> (complete)</span> : null}
                        {substep.state === 'attention' ? (
                          <span className="sr-only"> (failed)</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepMarker({ state }: { state: ProgressStep['state'] }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 aria-hidden className={cn('size-5', TONE_TEXT.positive)} />;
    case 'current':
      return <Loader2 aria-hidden className={cn('size-5 animate-spin', TONE_TEXT.progress)} />;
    case 'attention':
      return <AlertCircle aria-hidden className="size-5 text-destructive" />;
    case 'waiting':
      return <Circle aria-hidden className="size-5 text-muted-foreground/40" />;
  }
}

function SubstepMarker({ state }: { state: ProgressStep['state'] }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', TONE_TEXT.positive)} />;
    case 'current':
      return <Loader2 aria-hidden className={cn('mt-0.5 size-3.5 shrink-0 animate-spin', TONE_TEXT.progress)} />;
    case 'attention':
      return <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
    case 'waiting':
      return <Circle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" />;
  }
}
