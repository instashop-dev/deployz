'use client';

import { ChevronDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { Diagnostic, DiagnosticContext, DiagnosticEvent } from '@/lib/diagnostics';
import {
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

        <dl className="flex flex-col gap-2">
          <ExplanationRow title="What happened" text={what} />
          <ExplanationRow title="Why it happened" text={why} />
          <ExplanationRow title="How to fix it" text={fix} />
        </dl>

        {/* §61 recoverability — sets the retry expectation per failure class
            instead of a one-size-fits-all "try again". */}
        <p className="text-sm text-muted-foreground">
          {RECOVERABILITY_COPY[
            diagnostic.recoverability ?? FAILURE_RECOVERABILITY[diagnostic.failureCode]
          ]}
        </p>

        <details className="group rounded-lg border">
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
