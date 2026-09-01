import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProgressStep } from '@/lib/deployment-progress';

// Discrete-state step list shared by the customer install page and the vendor
// deployment views. Deliberately not a progress bar: there are no percentages
// or ETAs anywhere in the product, only states. Icons are decorative — the
// state is always in the text, so color/shape never carries meaning alone.
export function DeploymentProgressSteps({ steps, className }: { steps: ProgressStep[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col gap-2', className)}>
      {steps.map((step) => (
        <li key={step.key} className="flex items-start gap-2.5 text-sm">
          <StepIcon state={step.state} />
          <span className="flex flex-col">
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
            </span>
            {step.detail ? <span className="text-xs text-muted-foreground">{step.detail}</span> : null}
          </span>
          {step.meta ? (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{step.meta}</span>
          ) : null}
        </li>
      ))}
    </ol>
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
