import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  VERDICT_PRESENTATION,
  readinessFailure,
  readinessSummaryLabel,
  type ApplicationReadiness,
} from '@/lib/readiness';
import { cn } from '@/lib/utils';

// §19 readiness result — the DETERMINISTIC verdict, rendered in the exact
// §19 shape: percentage + "N changes required", then three separately-headed
// groups (Ready / Needs attention / Unsupported). When analysis hasn't
// completed yet, this renders the pending state — never a fabricated score.

const TONE_DOT: Record<'ready' | 'attention' | 'incompatible', string> = {
  ready: 'bg-emerald-500',
  attention: 'bg-amber-500',
  incompatible: 'bg-destructive',
};

const TONE_HEADING: Record<'ready' | 'attention' | 'incompatible', string> = {
  ready: 'text-emerald-700',
  attention: 'text-amber-700',
  incompatible: 'text-destructive',
};

export function ReadinessResult({ readiness }: { readiness: ApplicationReadiness }) {
  // FAILED first: it is NOT a slower kind of pending. Falling through to the
  // pending card left the vendor watching "this usually takes a minute" for
  // ever, with polling already stopped and no hint that Re-analyse had run
  // and failed.
  const failure = readinessFailure(readiness);
  if (failure) {
    return (
      <Card data-testid="readiness-verdict">
        <CardContent className="py-6 text-center">
          <h3 className="font-heading text-base font-medium text-destructive">{failure.heading}</h3>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="readiness-failure">
            {failure.detail}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Press Re-analyse above to try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (readiness.analysisStatus !== 'COMPLETE' || readiness.verdict === null) {
    return (
      <Card data-testid="readiness-verdict">
        <CardContent className="py-6 text-center">
          <h3 className="font-heading text-base font-medium">Analysing your app</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            We&apos;re checking your app against the Deployz application contract. This usually
            takes a minute.
          </p>
        </CardContent>
      </Card>
    );
  }

  const presentation = VERDICT_PRESENTATION[readiness.verdict];
  const score = readiness.score ?? 0;
  const changesRequired = readiness.changesRequired ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <Card data-testid="readiness-verdict">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[presentation.tone])}
            />
            <h3 className={cn('font-heading text-base font-medium', TONE_HEADING[presentation.tone])}>
              {presentation.heading}
            </h3>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="readiness-summary">
            {readinessSummaryLabel(score, changesRequired)}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {readiness.ready.length > 0 ? (
            <section aria-labelledby="readiness-ready">
              <h4 id="readiness-ready" className="text-sm font-semibold">
                Ready
              </h4>
              <ul className="mt-2 flex flex-col gap-1.5" data-testid="readiness-ready-list">
                {readiness.ready.map((check) => (
                  <li key={check.label} className="flex items-start gap-2 text-sm">
                    <span aria-hidden className="text-emerald-600">
                      ✓
                    </span>
                    <span>{check.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {readiness.needsAttention.length > 0 ? (
            <section aria-labelledby="readiness-attention">
              <h4 id="readiness-attention" className="text-sm font-semibold">
                Needs attention
              </h4>
              <ul className="mt-2 flex flex-col gap-4" data-testid="readiness-attention-list">
                {readiness.needsAttention.map((issue) => (
                  <li key={issue.title} className="flex flex-col gap-1 text-sm">
                    <p className="font-medium">{issue.title}</p>
                    <p className="text-muted-foreground">{issue.detail}</p>
                    {issue.suggestedFix ? (
                      <p>
                        <span className="font-medium">Suggested fix: </span>
                        {issue.suggestedFix}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {readiness.unsupported.length > 0 ? (
            <section aria-labelledby="readiness-unsupported">
              <h4 id="readiness-unsupported" className="text-sm font-semibold">
                Unsupported
              </h4>
              {/* §19 verbatim framing for a fundamental incompatibility. */}
              <p className="mt-1 text-sm text-muted-foreground">
                This application isn&apos;t currently compatible with Deployz.
              </p>
              <ul className="mt-2 flex flex-col gap-3" data-testid="readiness-unsupported-list">
                {readiness.unsupported.map((issue) => (
                  <li key={issue.title} className="flex flex-col gap-1 text-sm">
                    <p className="font-medium">{issue.title}</p>
                    <p className="text-muted-foreground">{issue.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
