import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { TechnicalDetails } from '@/components/technical-details';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

// The one failure and recovery pattern (ux-guidelines §6), top to bottom:
// what happened → impact → who acts → recovery action → technical details.
// The caller supplies role-specific words; this component never decides who
// must act or what the failure means.
export function FailurePanel({
  title,
  description,
  impact,
  explanation,
  whoActs,
  action,
  technical,
  className,
  testId = 'failure-panel',
}: {
  /** What happened — one sentence, product words. */
  title: ReactNode;
  description?: ReactNode;
  /** What still works ("Release v3 is still live"). */
  impact?: ReactNode;
  /** The classified cause and fix, when the failure has one. */
  explanation?: ReactNode;
  /** Only when authoritative data says who acts. */
  whoActs?: ReactNode;
  /** One primary recovery action, plus outline alternatives. */
  action?: ReactNode;
  /** Raw error, events, identifiers — collapsed. */
  technical?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Alert variant="destructive" className={className} data-testid={testId}>
      <AlertCircle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        {description ? <div>{description}</div> : null}
        {impact ? <p className="font-medium text-foreground">{impact}</p> : null}
        {explanation}
        {whoActs ? <p className="text-muted-foreground">{whoActs}</p> : null}
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
        {technical ? (
          <TechnicalDetails className="text-foreground">{technical}</TechnicalDetails>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
