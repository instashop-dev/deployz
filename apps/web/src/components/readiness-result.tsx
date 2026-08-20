import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  VERDICT_PRESENTATION,
  type CompatibilityVerdict,
  type ReadinessExplanation,
  type ReadinessVerdict,
} from '@/lib/readiness';
import { cn } from '@/lib/utils';

// §19 readiness result — renders the DETERMINISTIC verdict (todo 23) with §65
// copy. The todo-24 AI explanation renders UNDER the verdict and can never
// change it (§20): the verdict is never sourced from AI text.

const TONE_DOT: Record<CompatibilityVerdict, string> = {
  READY: 'bg-emerald-500',
  NEEDS_ATTENTION: 'bg-amber-500',
  NOT_COMPATIBLE: 'bg-destructive',
};

const TONE_HEADING: Record<CompatibilityVerdict, string> = {
  READY: 'text-emerald-700',
  NEEDS_ATTENTION: 'text-amber-700',
  NOT_COMPATIBLE: 'text-destructive',
};

export function ReadinessResult({
  readiness,
  explanation,
}: {
  readiness: ReadinessVerdict;
  explanation: ReadinessExplanation | null;
}) {
  const presentation = VERDICT_PRESENTATION[readiness.verdict];
  return (
    <div className="flex flex-col gap-6">
      <Card data-testid="readiness-verdict">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[readiness.verdict])}
            />
            <h3 className={cn('font-heading text-base font-medium', TONE_HEADING[readiness.verdict])}>
              {presentation.heading}
            </h3>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {readiness.issues.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="readiness-issues">
              {readiness.issues.map((issue) => (
                <li key={issue.code} className="flex items-start gap-2.5 text-sm">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      TONE_DOT[readiness.verdict],
                    )}
                  />
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{readiness.reason}</p>
          )}
        </CardContent>
      </Card>

      {explanation ? (
        <section aria-labelledby="ai-explanation" className="flex flex-col gap-2">
          <h2 id="ai-explanation" className="text-base font-semibold">
            What this means
          </h2>
          <p className="text-xs text-muted-foreground">
            The result above comes from our automated checks. The explanation below is written by
            an AI assistant and can never change the result.
          </p>
          <p className="text-sm">{explanation.summary}</p>
          <p className="text-sm text-muted-foreground">{explanation.why}</p>
          {explanation.fix ? (
            <p className="text-sm">
              <span className="font-medium">Suggested fix: </span>
              {explanation.fix}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
