'use client';

import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import { useState } from 'react';

import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  READINESS_STATE_PRESENTATION,
  READINESS_SUPPORT_READY,
  READINESS_SUPPORT_RUNNING,
  readinessBlockedSummary,
  readinessChecksLabel,
  readinessFixCtaSupport,
  readinessStateHeading,
  readinessFailure,
  type ApplicationReadiness,
  type ReadinessFinding,
  type ReadinessState,
} from '@/lib/readiness';
import { cn } from '@/lib/utils';

// §19 readiness result — the DETERMINISTIC semantic verdict rendered as a
// deployment readiness checklist: one state headline, a "passed of total"
// check count with a segmented progress indicator (never a percentage), then
// the checks ordered action-needed → recommended → passed. The top level is
// §65 jargon-free; "How to fix" expands per finding into the action, the
// reason, and the technical evidence. When required checks remain, the
// primary CTA generates ONE consolidated coding-agent prompt — Deployz never
// edits the repository itself.

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

/** Passed checks show inline while the checklist stays short; only a long
 *  list collapses. */
const PASSED_INLINE_LIMIT = 6;

export interface FindingFixSection {
  kind: 'action' | 'why' | 'technical';
  heading: string;
  body: string;
  /** Technical evidence renders as code. */
  code: boolean;
}

/**
 * The "How to fix" content for one finding, in reading order. The finding's
 * plain-English line already answers "what did Deployz find" (it renders
 * above the accordion), so the expansion covers what to do, why, and the
 * raw evidence. Empty fields are omitted — legacy findings carry several.
 */
export function findingFixSections(finding: ReadinessFinding): FindingFixSection[] {
  return (
    [
      {
        kind: 'action',
        heading: 'What you need to do',
        body: finding.suggestedOutcome,
        code: false,
      },
      { kind: 'why', heading: 'Why Deployz needs this', body: finding.whyItMatters, code: false },
      {
        kind: 'technical',
        heading: 'Technical details',
        body: finding.technicalEvidence,
        code: true,
      },
    ] as FindingFixSection[]
  ).filter((section) => section.body.trim().length > 0);
}

/** Changes blocking deployment: blocking findings for NEEDS_CHANGES, the
 *  fixable required findings for ALMOST_READY. */
function changesCount(readiness: ApplicationReadiness): number {
  if (readiness.state === 'NEEDS_CHANGES') {
    return readiness.findings.filter((f) => f.blocking).length;
  }
  return readiness.requiredCount;
}

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
        <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
          <h3 className="font-heading text-base font-medium text-destructive">{failure.heading}</h3>
          <p className="text-sm text-muted-foreground" data-testid="readiness-failure">
            {failure.detail}
          </p>
          <Button type="button" size="sm" data-testid="readiness-retry" onClick={onReanalyse}>
            Try analysis again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (readiness.analysisStatus !== 'COMPLETE') {
    return (
      <Card data-testid="readiness-verdict">
        <CardContent className="py-6 text-center">
          <h3 className="font-heading text-base font-medium">
            Checking deployment readiness…
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{READINESS_SUPPORT_RUNNING}</p>
        </CardContent>
      </Card>
    );
  }

  const presentation = READINESS_STATE_PRESENTATION[readiness.state];
  const required = readiness.findings.filter((f) => f.severity === 'required');
  const recommended = readiness.findings.filter((f) => f.severity === 'recommended');
  const blocked = changesCount(readiness);
  const passedCount = readiness.passed.length;
  const totalCount = passedCount + readiness.findings.length;
  const checksLabel = readinessChecksLabel(passedCount, totalCount);
  const hasRequired = required.length > 0;

  return (
    <Card data-testid="readiness-verdict">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[presentation.tone])}
          />
          <h3 className={cn('font-heading text-base font-medium', TONE_HEADING[presentation.tone])}>
            {readinessStateHeading(readiness.state as ReadinessState, blocked)}
          </h3>
        </div>
        <p className="text-sm font-medium" data-testid="readiness-summary">
          {readiness.state === 'READY'
            ? READINESS_SUPPORT_READY
            : readinessBlockedSummary(passedCount, totalCount, blocked)}
        </p>
        {totalCount > 0 ? (
          <div className="mt-1 flex items-center gap-3" data-testid="readiness-progress">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={totalCount}
              aria-valuenow={passedCount}
              aria-label={checksLabel}
              className="flex flex-1 gap-0.5"
            >
              {Array.from({ length: totalCount }, (_, index) => (
                <span
                  key={index}
                  aria-hidden
                  className={cn(
                    'h-1.5 flex-1 rounded-full',
                    index < passedCount ? 'bg-emerald-500' : 'bg-muted',
                  )}
                />
              ))}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{checksLabel}</span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {totalCount > 0 ? (
          <section aria-labelledby="readiness-checks">
            <h4 id="readiness-checks" className="text-sm font-semibold">
              Deployment checks
            </h4>
            {required.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-4" data-testid="readiness-required-list">
                {required.map((finding) => (
                  <FindingItem key={finding.id} finding={finding} />
                ))}
              </ul>
            ) : null}
            {recommended.length > 0 ? (
              <ul className="mt-4 flex flex-col gap-4" data-testid="readiness-recommended-list">
                {recommended.map((finding) => (
                  <FindingItem key={finding.id} finding={finding} />
                ))}
              </ul>
            ) : null}
            {hasRequired ? (
              <div className="mt-6 flex flex-col items-start gap-2">
                <Button
                  type="button"
                  data-testid="generate-fix-instructions"
                  onClick={() => setInstructionsOpen(true)}
                >
                  Generate fix instructions
                </Button>
                <p className="text-xs text-muted-foreground">
                  {readinessFixCtaSupport(required.length)} Deployz never changes your repository.
                </p>
              </div>
            ) : null}
            {passedCount > 0 ? (
              <div className="mt-6">
                <PassedChecks passed={readiness.passed} />
              </div>
            ) : null}
          </section>
        ) : null}

        {readiness.analyzedCommitSha ? (
          <p className="text-xs text-muted-foreground" data-testid="readiness-commit">
            Analysed commit {readiness.analyzedCommitSha.slice(0, 7)}
          </p>
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

/** The passed checks — visible for trust, but visually quieter than the
 *  findings. Short lists render inline; long ones collapse behind a count. */
function PassedChecks({ passed }: { passed: ApplicationReadiness['passed'] }) {
  const rows = (
    <ul className="flex flex-col gap-1.5" data-testid="readiness-passed-list">
      {passed.map((check) => (
        <li key={check.id} className="flex items-center gap-2 text-sm">
          <Check aria-hidden className="size-4 shrink-0 text-emerald-600" />
          <span className="flex-1">{check.label}</span>
          <span className="text-xs text-muted-foreground">Passed</span>
        </li>
      ))}
    </ul>
  );

  if (passed.length <= PASSED_INLINE_LIMIT) {
    return (
      <div data-testid="readiness-passed">
        {rows}
      </div>
    );
  }

  return (
    <details className="group rounded-lg border" data-testid="readiness-passed">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        Passed checks ({passed.length})
        <ChevronDown
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t px-3 py-2.5">{rows}</div>
    </details>
  );
}

function FindingItem({ finding }: { finding: ReadinessFinding }) {
  const sections = findingFixSections(finding);
  const required = finding.severity === 'required';
  return (
    <li className="flex flex-col gap-1.5" data-testid={`readiness-finding-${finding.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <CircleAlert
          aria-hidden
          className={cn('size-4 shrink-0', required ? 'text-amber-600' : 'text-muted-foreground')}
        />
        <p className="text-sm font-medium">{finding.title}</p>
        <span
          className={cn(
            'text-xs font-medium',
            required ? 'text-amber-700' : 'text-muted-foreground',
          )}
        >
          {required ? 'Action needed' : 'Recommended'}
        </span>
        {finding.confidence === 'needs_confirmation' ? (
          <Badge variant="outline">Needs confirmation</Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{finding.plainEnglishExplanation}</p>
      <details className="group rounded-lg border">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
          How to fix
          <ChevronDown
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-3 border-t px-3 py-2.5">
          {sections.map((section) => (
            <div key={section.kind} className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold">{section.heading}</span>
              {section.code ? (
                <code className="break-words rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {section.body}
                </code>
              ) : (
                <p className="text-sm text-muted-foreground">{section.body}</p>
              )}
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}
