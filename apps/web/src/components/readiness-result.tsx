'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  READINESS_STATE_PRESENTATION,
  readinessCountsLabel,
  readinessFailure,
  type ApplicationReadiness,
  type ReadinessFinding,
} from '@/lib/readiness';
import { cn } from '@/lib/utils';

// §19 readiness result — the DETERMINISTIC semantic verdict: a state (never a
// percentage), the required/recommended counts, then the findings grouped
// into "Required before deployment" / "Recommended" with passed checks
// collapsed. The top level is §65 jargon-free; technical evidence lives
// behind each finding's expandable details. When findings remain, the primary
// CTA generates ONE consolidated coding-agent prompt — Deployz never edits
// the repository itself.

const TONE_DOT: Record<'ready' | 'attention' | 'incompatible' | 'pending', string> = {
  ready: 'bg-emerald-500',
  attention: 'bg-amber-500',
  incompatible: 'bg-destructive',
  pending: 'bg-muted-foreground',
};

const TONE_HEADING: Record<'ready' | 'attention' | 'incompatible' | 'pending', string> = {
  ready: 'text-emerald-700',
  attention: 'text-amber-700',
  incompatible: 'text-destructive',
  pending: 'text-muted-foreground',
};

export function ReadinessResult({
  readiness,
  applicationId,
  onReanalyse,
}: {
  readiness: ApplicationReadiness;
  applicationId: string;
  /** Triggers a re-analysis (the same action as the Re-analyse button). */
  onReanalyse: () => void;
}) {
  const [instructionsOpen, setInstructionsOpen] = useState(false);

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

  if (readiness.analysisStatus !== 'COMPLETE') {
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

  const presentation = READINESS_STATE_PRESENTATION[readiness.state];
  const required = readiness.findings.filter((f) => f.severity === 'required');
  const recommended = readiness.findings.filter((f) => f.severity === 'recommended');
  const hasFindings = readiness.findings.length > 0;

  return (
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
        <p className="text-sm font-medium" data-testid="readiness-summary">
          {readinessCountsLabel(readiness.requiredCount, readiness.recommendedCount)}
        </p>
        {readiness.summary ? (
          <p className="text-sm text-muted-foreground">{readiness.summary}</p>
        ) : null}
        {readiness.analyzedCommitSha ? (
          <p className="text-xs text-muted-foreground" data-testid="readiness-commit">
            Analysed commit {readiness.analyzedCommitSha.slice(0, 7)}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {hasFindings ? (
          <div className="flex flex-col items-start gap-2">
            <Button
              type="button"
              data-testid="generate-fix-instructions"
              onClick={() => setInstructionsOpen(true)}
            >
              Generate fix instructions
            </Button>
            <p className="text-xs text-muted-foreground">
              Deployz turns these findings into one prompt for your coding agent. Deployz never
              changes your code.
            </p>
          </div>
        ) : null}

        {required.length > 0 ? (
          <section aria-labelledby="readiness-required">
            <h4 id="readiness-required" className="text-sm font-semibold">
              Required before deployment
            </h4>
            <ul className="mt-2 flex flex-col gap-4" data-testid="readiness-required-list">
              {required.map((finding) => (
                <FindingItem key={finding.id} finding={finding} />
              ))}
            </ul>
          </section>
        ) : null}

        {recommended.length > 0 ? (
          <section aria-labelledby="readiness-recommended">
            <h4 id="readiness-recommended" className="text-sm font-semibold">
              Recommended
            </h4>
            <ul className="mt-2 flex flex-col gap-4" data-testid="readiness-recommended-list">
              {recommended.map((finding) => (
                <FindingItem key={finding.id} finding={finding} />
              ))}
            </ul>
          </section>
        ) : null}

        {readiness.passed.length > 0 ? (
          <details className="group rounded-lg border" data-testid="readiness-passed">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              Passed checks ({readiness.passed.length})
              <ChevronDown
                aria-hidden
                className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <ul
              className="flex flex-col gap-1.5 border-t px-3 py-2.5"
              data-testid="readiness-passed-list"
            >
              {readiness.passed.map((check) => (
                <li key={check.id} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className="text-emerald-600">
                    ✓
                  </span>
                  <span>{check.label}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>

      <FixInstructionsDialog
        open={instructionsOpen}
        applicationId={applicationId}
        onClose={() => setInstructionsOpen(false)}
        onReanalyse={onReanalyse}
      />
    </Card>
  );
}

function FindingItem({ finding }: { finding: ReadinessFinding }) {
  return (
    <li className="flex flex-col gap-1.5" data-testid={`readiness-finding-${finding.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{finding.title}</p>
        {finding.confidence === 'needs_confirmation' ? (
          <Badge variant="outline">Needs confirmation</Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{finding.plainEnglishExplanation}</p>
      <details className="group rounded-lg border">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          Why this matters
          <ChevronDown
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-2 border-t px-3 py-2.5 text-sm text-muted-foreground">
          {finding.whyItMatters ? <p>{finding.whyItMatters}</p> : null}
          {finding.suggestedOutcome ? (
            <p>
              <span className="font-medium text-foreground">Suggested outcome: </span>
              {finding.suggestedOutcome}
            </p>
          ) : null}
          {finding.technicalEvidence ? (
            <div className="flex flex-col gap-0.5 text-xs">
              <span className="font-medium text-foreground">Technical detail</span>
              <code className="break-words rounded bg-muted px-1.5 py-0.5 font-mono">
                {finding.technicalEvidence}
              </code>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}
