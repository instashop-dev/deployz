'use client';

import { Check, ChevronDown, Circle, CircleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

// §19 readiness result — the DETERMINISTIC semantic verdict rendered as
// focused cards: a state headline with a "passed of total" check count and a
// segmented progress indicator (never a percentage); a "What Deployz found"
// card listing the automatic positives; a "Needs your input" card for the
// required values the vendor provides on the Configuration screen; a
// blocking-incompatibility card when code changes are needed; and, only for
// the states that can need code adaptation, a secondary "Generate fix
// instructions" CTA. Copy stays §65 jargon-free; each finding's "How to fix"
// expands into the action, the reason, and the technical evidence. Deployz
// never edits the repository itself.

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

/** Automatic positives show inline while the list stays short; only a long
 *  list collapses. */
const FOUND_INLINE_LIMIT = 6;

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

/**
 * The automatic positives Deployz derived beyond the passed checks: a
 * database requirement is provisioned with the deployment, and an app that
 * needs no Redis has nothing to configure. A rejected background worker is
 * NOT a positive — it surfaces as a finding instead.
 */
export function automaticHighlights(application?: {
  databaseRequired: boolean;
  redisRequired: boolean;
}): string[] {
  if (!application) return [];
  const highlights: string[] = [];
  if (application.databaseRequired) highlights.push('PostgreSQL connection provisioned');
  if (!application.redisRequired) highlights.push('Redis not required');
  return highlights;
}

export function ReadinessResult({
  readiness,
  applicationId,
  onReanalyse,
  application,
}: {
  readiness: ApplicationReadiness;
  applicationId: string;
  /** Triggers a re-analysis (the same action as the Re-analyse button). */
  onReanalyse: () => void;
  /** The application row — feeds the derived "what Deployz found" positives. */
  application?: { databaseRequired: boolean; redisRequired: boolean };
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
  const needsInput = required.filter((f) => !f.blocking);
  const blocking = required.filter((f) => f.blocking);
  const recommended = readiness.findings.filter((f) => f.severity === 'recommended');
  const blocked = changesCount(readiness);
  const passedCount = readiness.passed.length;
  const totalCount = passedCount + readiness.findings.length;
  const checksLabel = readinessChecksLabel(passedCount, totalCount);

  // Configuration-resolvable cases (required findings the vendor can address
  // on the Configuration screen) take the "Review configuration" links as
  // their primary action; fix instructions are code adaptation, so they stay
  // secondary below the cards and only for the states that can need them.
  const showFixCta =
    required.length > 0 &&
    (readiness.state === 'ALMOST_READY' || readiness.state === 'NEEDS_CHANGES');

  const readyForDeploy =
    readiness.state === 'READY' || readiness.state === 'ALMOST_READY';
  // Nothing left to resolve — the found/needs-input cards collapse into one
  // compact "Ready to deploy" confirmation.
  const showReadyCard = readyForDeploy && readiness.requiredCount === 0;

  const highlights = automaticHighlights(application);
  const foundShown = !showReadyCard && (highlights.length > 0 || readiness.passed.length > 0);
  const needsShown = !showReadyCard && needsInput.length > 0;
  const incompatibleShown = !showReadyCard && blocking.length > 0;
  const showRecommendedHere = {
    // The Recommended group nests inside whichever of the found/needs-input/
    // ready cards is in play; it is never a standalone card.
    inReady: showReadyCard && recommended.length > 0,
    inFound: foundShown && !needsShown && recommended.length > 0,
    inNeeds: needsShown && recommended.length > 0,
  };

  return (
    <div className="flex flex-col gap-4">
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
      </Card>

      {showReadyCard ? (
        <ReadyCard>
          {showRecommendedHere.inReady ? <RecommendedGroup findings={recommended} /> : null}
        </ReadyCard>
      ) : null}

      {foundShown ? (
        <Card data-testid="readiness-found">
          <CardHeader>
            <CardTitle>What Deployz found</CardTitle>
          </CardHeader>
          <CardContent>
            <AutomaticRows highlights={highlights} passed={readiness.passed} />
            {showRecommendedHere.inFound ? <RecommendedGroup findings={recommended} /> : null}
          </CardContent>
        </Card>
      ) : null}

      {needsShown ? (
        <Card data-testid="needs-input">
          <CardHeader>
            <CardTitle>Needs your input</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-4" data-testid="needs-input-list">
              {needsInput.map((finding) => (
                <NeedsInputItem key={finding.id} finding={finding} applicationId={applicationId} />
              ))}
            </ul>
            {showRecommendedHere.inNeeds ? <RecommendedGroup findings={recommended} /> : null}
            <p className="text-xs text-muted-foreground" data-testid="needs-input-summary">
              {needsInputCountLabel(needsInput.length)}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {incompatibleShown ? (
        <Card data-testid="readiness-incompatible">
          <CardHeader>
            <CardTitle>{READINESS_STATE_PRESENTATION['NEEDS_CHANGES'].label}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-4" data-testid="readiness-required-list">
              {blocking.map((finding) => (
                <BlockingItem key={finding.id} finding={finding} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {showFixCta ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="secondary"
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

      {readiness.analyzedCommitSha ? (
        <p className="text-xs text-muted-foreground" data-testid="readiness-commit">
          Analysed commit {readiness.analyzedCommitSha.slice(0, 7)}
        </p>
      ) : null}

      <FixInstructionsDialog
        open={instructionsOpen}
        applicationId={applicationId}
        onClose={() => setInstructionsOpen(false)}
        onReanalyse={onReanalyse}
      />
    </div>
  );
}

/** "Ready after 1 required value is provided." / "…2 required values…" */
function needsInputCountLabel(count: number): string {
  return `Ready after ${count} required ${count === 1 ? 'value is' : 'values are'} provided.`;
}

/** The compact "nothing left to resolve" confirmation card. */
function ReadyCard({ children }: { children?: ReactNode }) {
  return (
    <Card size="sm" data-testid="readiness-ready">
      <CardContent className={cn('flex items-center gap-2', children ? 'flex-col items-start gap-2' : '')}>
        <div className="flex items-center gap-2">
          <Check aria-hidden className="size-4 shrink-0 text-emerald-600" />
          <p className="text-sm font-medium">{readinessStateHeading('READY', 0)}</p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** The automatic/positive rows of the "What Deployz found" card — derived
 *  highlights first, then the passed checks. Long lists collapse behind a
 *  count, matching the old passed-checks disclosure. */
function AutomaticRows({
  highlights,
  passed,
}: {
  highlights: readonly string[];
  passed: ApplicationReadiness['passed'];
}) {
  const rows = (
    <ul className="flex flex-col gap-1.5" data-testid="readiness-found-list">
      {highlights.map((label, index) => (
        <li key={`highlight-${index}`} className="flex items-center gap-2 text-sm">
          <Check aria-hidden className="size-4 shrink-0 text-emerald-600" />
          <span className="flex-1">{label}</span>
        </li>
      ))}
      {passed.map((check) => (
        <li key={check.id} className="flex items-center gap-2 text-sm">
          <Check aria-hidden className="size-4 shrink-0 text-emerald-600" />
          <span className="flex-1">{check.label}</span>
          <span className="text-xs text-muted-foreground">Passed</span>
        </li>
      ))}
    </ul>
  );

  const count = highlights.length + passed.length;
  if (count <= FOUND_INLINE_LIMIT) {
    return rows;
  }

  return (
    <details className="group rounded-lg border" data-testid="readiness-found-collapse">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        What Deployz found ({count})
        <ChevronDown
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t px-3 py-2.5">{rows}</div>
    </details>
  );
}

/** A "Needs your input" row — one required value the vendor provides on the
 *  Configuration screen. */
function NeedsInputItem({
  finding,
  applicationId,
}: {
  finding: ReadinessFinding;
  applicationId: string;
}) {
  return (
    <li className="flex flex-col gap-1.5" data-testid={`readiness-finding-${finding.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Circle aria-hidden className="size-4 shrink-0 text-amber-500" />
          <p className="text-sm font-medium">{finding.title}</p>
          {finding.confidence === 'needs_confirmation' ? (
            <Badge variant="outline">Needs confirmation</Badge>
          ) : null}
        </div>
        <Button
          asChild
          variant="secondary"
          size="sm"
          data-testid={`readiness-config-link-${finding.id}`}
        >
          <Link href={`/dashboard/applications/${applicationId}/config`}>Review configuration</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{finding.plainEnglishExplanation}</p>
      <FindingDetails finding={finding} />
    </li>
  );
}

/** A blocking incompatibility row — code adaptation, not configuration. */
function BlockingItem({ finding }: { finding: ReadinessFinding }) {
  return (
    <li className="flex flex-col gap-1.5" data-testid={`readiness-finding-${finding.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <CircleAlert aria-hidden className="size-4 shrink-0 text-amber-600" />
        <p className="text-sm font-medium">{finding.title}</p>
        <span className="text-xs font-medium text-amber-700">Action needed</span>
        {finding.confidence === 'needs_confirmation' ? (
          <Badge variant="outline">Needs confirmation</Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{finding.plainEnglishExplanation}</p>
      <FindingDetails finding={finding} />
    </li>
  );
}

/** Non-blocking findings, visually quieter and never mixed into the rows the
 *  vendor must act on. */
function RecommendedGroup({ findings }: { findings: ReadinessFinding[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">Recommended</p>
      <ul className="flex flex-col gap-4" data-testid="readiness-recommended-list">
        {findings.map((finding) => (
          <li
            key={finding.id}
            className="flex flex-col gap-1.5"
            data-testid={`readiness-finding-${finding.id}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <CircleAlert aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <p className="text-sm font-medium">{finding.title}</p>
              {finding.confidence === 'needs_confirmation' ? (
                <Badge variant="outline">Needs confirmation</Badge>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{finding.plainEnglishExplanation}</p>
            <FindingDetails finding={finding} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The per-finding "How to fix" disclosure: action, reason, raw evidence. */
function FindingDetails({ finding }: { finding: ReadinessFinding }) {
  const sections = findingFixSections(finding);
  if (sections.length === 0) return null;
  return (
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
  );
}
