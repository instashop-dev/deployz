'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { Diagnostic, DiagnosticContext, DiagnosticEvent } from '@/lib/diagnostics';
import { cn } from '@/lib/utils';
import {
  AI_CONFIDENCE_COPY,
  AI_EXPLANATION_SOURCE_NOTE,
  EXPLANATION_FALLBACK,
  FAILURE_RECOVERABILITY,
  FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT,
  RECOVERABILITY_COPY,
  failureCodeCopy,
} from '@/lib/diagnostic-vocabulary';

// Diagnostic card — renders one §61 failure in what/why/fix form. The top
// level is §65 jargon-free (label + plain-English explanation); the raw
// failure code, structured event source/action/signal, and error code/message
// live behind an expandable "Technical detail" section (same <details>
// pattern as the security page and activity feed). Code-driven only — this
// IS the diagnostic content; there is no bundle/log export (S3).
export function DiagnosticCard({ diagnostic }: { diagnostic: Diagnostic }) {
  const copy = failureCodeCopy(diagnostic.failureCode);
  const what = diagnostic.explanation?.what ?? copy.description;
  const why = diagnostic.explanation?.why ?? EXPLANATION_FALLBACK.why;
  const fix = diagnostic.explanation?.fix ?? EXPLANATION_FALLBACK.fix;
  const isAi = diagnostic.explanationSource === 'ai';

  return (
    <Card data-testid="diagnostic-card">
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`mt-0.5 size-2 shrink-0 rounded-full ${FAILURE_SEVERITY_DOT[copy.severity]}`}
              aria-hidden
            />
            <h3 className="text-base font-semibold">{copy.label}</h3>
          </div>
          <Badge variant={FAILURE_SEVERITY_BADGE[copy.severity]}>
            {copy.severity === 'critical' ? 'Critical' : 'Warning'}
          </Badge>
        </div>

        {/* Phase 7: an AI reading below high confidence is framed as a lead,
            never a verdict — the hedge precedes the text it qualifies. */}
        {diagnostic.explanationSource === 'ai' && diagnostic.confidence && AI_CONFIDENCE_COPY[diagnostic.confidence] ? (
          <p className="text-sm text-muted-foreground" data-testid="diagnostic-confidence">
            {AI_CONFIDENCE_COPY[diagnostic.confidence]}
          </p>
        ) : null}

        <dl className="flex flex-col gap-2">
          <ExplanationRow title="What happened" text={what} />
          {/* §16 AI copy reads as tentative, never a verdict — "Likely cause"
              and "Suggested fix" name the model's uncertainty; deterministic
              copy keeps the direct What/Why/Fix. */}
          <ExplanationRow title={isAi ? 'Likely cause' : 'Why it happened'} text={why} />
          <ExplanationRow title={isAi ? 'Suggested fix' : 'How to fix it'} text={fix} />
        </dl>
        {diagnostic.explanationSource === 'ai' ? (
          <p className="text-xs text-muted-foreground" data-testid="diagnostic-source">
            {AI_EXPLANATION_SOURCE_NOTE}
          </p>
        ) : null}

        {/* §61 recoverability — sets the retry expectation per failure class
            instead of a one-size-fits-all "try again". */}
        <p className="text-sm text-muted-foreground">
          {RECOVERABILITY_COPY[
            diagnostic.recoverability ?? FAILURE_RECOVERABILITY[diagnostic.failureCode]
          ]}
        </p>

        <StartupEvidence diagnostic={diagnostic} />

        <details className="group rounded-lg border" data-testid="diagnostic-technical">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
            Technical detail
            <ChevronDown
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="flex flex-col gap-2 border-t px-3 py-2.5 text-xs text-muted-foreground">
            <DetailRow label="Failure code" value={diagnostic.failureCode} />
            {diagnostic.context ? <ContextRows context={diagnostic.context} /> : null}
            <EventRows event={diagnostic.event} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function ExplanationRow({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <dt className="text-sm font-medium">{title}</dt>
      <dd className="text-sm text-muted-foreground">{text}</dd>
    </div>
  );
}

/**
 * "Startup evidence" — an expandable block that shows the container stop
 * evidence (Phase 1) and the first failed resource from the normalised
 * context, so a vendor sees what the application actually did before it died.
 * Collapsed by default; text is the redacted + truncated reason, never logs.
 */
function StartupEvidence({ diagnostic }: { diagnostic: Diagnostic }) {
  const container = diagnostic.evidence?.container ?? null;
  const firstResource = diagnostic.context?.relevantEvents?.[0] ?? null;
  const hasContainer =
    container !== null &&
    (container.exitCode !== null ||
      container.stopCode !== null ||
      container.stoppedReason !== null ||
      container.stoppedTaskCount !== null);
  const hasEvidence = hasContainer || firstResource !== null;

  return (
    <details className="group rounded-lg border" id="startup-evidence" data-testid="startup-evidence">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        Startup evidence
        <ChevronDown
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-2.5 text-xs text-muted-foreground">
        {!hasEvidence ? (
          <p>No startup evidence was captured for this failure.</p>
        ) : (
          <>
            {hasContainer ? (
              <div className="flex flex-col gap-1.5" data-testid="startup-evidence-container">
                {container.exitCode !== null ? (
                  <DetailRow label="Exit code" value={String(container.exitCode)} />
                ) : null}
                {container.stopCode !== null ? (
                  <DetailRow label="Stop code" value={container.stopCode} />
                ) : null}
                {container.stoppedTaskCount !== null ? (
                  <DetailRow label="Restart count" value={String(container.stoppedTaskCount)} />
                ) : null}
                {container.stoppedReason !== null ? (
                  <StoppedReason reason={container.stoppedReason} />
                ) : null}
              </div>
            ) : null}
            {firstResource !== null ? (
              <div className="flex flex-col gap-0.5" data-testid="startup-evidence-resource">
                <span className="font-medium text-foreground">Failed resource</span>
                <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">
                  {firstResource.logicalResourceId} · {firstResource.resourceType}
                  {firstResource.reason ? ` — ${firstResource.reason}` : ''}
                </code>
              </div>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

/** The container's free-text stop reason: a muted mono block, line-clamped with an expand toggle. */
function StoppedReason({ reason }: { reason: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">Stopped reason</span>
      <code
        className={cn(
          'break-all rounded bg-muted px-1.5 py-0.5 font-mono',
          !expanded && 'line-clamp-2',
        )}
      >
        {reason}
      </code>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="self-start text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

/** The normalised failure context (Phase 6): the operation, the attempt, the
 *  code the helper reported before refinement, the resource CloudFormation
 *  blamed and the failed events — technical by design, so it lives here. */
function ContextRows({ context }: { context: DiagnosticContext }) {
  return (
    <>
      <DetailRow label="Operation" value={context.attempt !== null ? `${context.phase} (attempt ${context.attempt})` : context.phase} />
      {context.reportedFailureCode !== null ? (
        <DetailRow label="Reported by the helper as" value={context.reportedFailureCode} />
      ) : null}
      {context.applicationVersion !== null ? <DetailRow label="Version" value={context.applicationVersion} /> : null}
      {context.resourceType !== null ? <DetailRow label="Failed resource" value={context.resourceType} /> : null}
      {context.relevantEvents.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-testid="diagnostic-failed-resources">
          <span className="font-medium text-foreground">Failed resources</span>
          <ul className="flex flex-col gap-1">
            {context.relevantEvents.map((event) => (
              <li key={`${event.logicalResourceId}:${event.resourceStatus}`}>
                <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">
                  {event.logicalResourceId} · {event.resourceType} · {event.resourceStatus}
                  {event.reason ? ` — ${event.reason}` : ''}
                </code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function EventRows({ event }: { event: DiagnosticEvent }) {
  return (
    <>
      <DetailRow label="Event source" value={event.source} />
      {event.action !== undefined ? <DetailRow label="Action" value={event.action} /> : null}
      {event.signal !== undefined ? <DetailRow label="Signal" value={event.signal} /> : null}
      {event.error?.code !== undefined ? (
        <DetailRow label="Error code" value={event.error.code} />
      ) : null}
      {event.error?.message !== undefined ? (
        <DetailRow label="Error message" value={event.error.message} />
      ) : null}
      {event.error?.statusCode !== undefined ? (
        <DetailRow label="Status code" value={String(event.error.statusCode)} />
      ) : null}
      {event.context !== undefined ? (
        <DetailRow label="Context" value={JSON.stringify(event.context)} />
      ) : null}
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">{label}</span>
      <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">{value}</code>
    </div>
  );
}
