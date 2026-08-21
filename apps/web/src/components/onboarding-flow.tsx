import { Check } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ONBOARDING_STEPS } from '@/lib/readiness';
import { cn } from '@/lib/utils';

export interface OnboardingFlowProps {
  /** 1-based current step (1..6). Lower steps render complete; higher muted. */
  currentStep: number;
}

// §42 six-step onboarding — the vendor's first-run flow. Success is readiness,
// not first install (§5). The step labels come VERBATIM from ONBOARDING_STEPS.
// Presentational only: the caller derives `currentStep` from real state.
export function OnboardingFlow({ currentStep }: OnboardingFlowProps) {
  return (
    <ol
      aria-label="Getting your app ready"
      data-testid="onboarding-steps"
      className="flex flex-col gap-2"
    >
      {ONBOARDING_STEPS.map((label, index) => {
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
            {current ? (
              <Badge variant="secondary" className="ml-auto">
                Current
              </Badge>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
