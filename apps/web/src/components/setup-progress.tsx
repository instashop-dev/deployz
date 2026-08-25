import { Check } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface SetupProgressProps {
  steps: readonly string[];
  /** 1-based current step. Lower steps render complete; higher ones pending. */
  currentStep: number;
}

// The homepage's short first-run track. Presentational only: the caller
// derives `currentStep` from real organization state. Every step carries a
// worded status, so the progress never depends on colour alone.
export function SetupProgress({ steps, currentStep }: SetupProgressProps) {
  return (
    <ol aria-label="Setup progress" data-testid="setup-progress" className="flex flex-col gap-2">
      {steps.map((label, index) => {
        const step = index + 1;
        const complete = step < currentStep;
        const current = step === currentStep;
        return (
          <li
            key={label}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm',
              current ? 'border-foreground/20 bg-accent' : 'border-transparent',
              complete || current ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                complete && 'border-transparent bg-primary text-primary-foreground',
                current && 'border-primary text-primary',
                !complete && !current && 'border-border text-muted-foreground',
              )}
            >
              {complete ? <Check className="size-3.5" /> : step}
            </span>
            <span className="font-medium">{label}</span>
            <Badge variant={current ? 'secondary' : 'ghost'} className="ml-auto shrink-0">
              {complete ? 'Done' : current ? 'Current' : 'Pending'}
            </Badge>
          </li>
        );
      })}
    </ol>
  );
}
