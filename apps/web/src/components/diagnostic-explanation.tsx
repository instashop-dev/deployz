'use client';

import { useState } from 'react';

import type { Diagnostic, DiagnosticContext, DiagnosticEvent } from '@/lib/diagnostics';
import {
  AI_CONFIDENCE_COPY,
  AI_EXPLANATION_SOURCE_NOTE,
  EXPLANATION_FALLBACK,
} from '@/lib/diagnostic-vocabulary';
import { cn } from '@/lib/utils';

// The classified explanation of one deployment failure, shown inside the
// deployment page's recovery panel (ux-guidelines §6). AI copy reads as
// tentative ("Likely cause", "Suggested fix"); deterministic copy stays direct.
export function DiagnosticExplanation({ diagnostic }: { diagnostic: Diagnostic }) {
  const why = diagnostic.explanation?.why ?? EXPLANATION_FALLBACK.why;
  const fix = diagnostic.explanation?.fix ?? EXPLANATION_FALLBACK.fix;
  const isAi = diagnostic.explanationSource === 'ai';
  const confidence = isAi && diagnostic.confidence ? AI_CONFIDENCE_COPY[diagnostic.confidence] : null;

  return (
    <div className="flex flex-col gap-2 text-foreground" data-testid="diagnostic-explanation">
      {diagnostic.context?.componentLabel ? (
        <p className="text-muted-foreground">Affects: {diagnostic.context.componentLabel}</p>
      ) : null}
      {confidence ? <p className="text-muted-foreground">{confidence}</p> : null}
      <dl className="flex flex-col gap-2">
        <div>
          <dt className="font-medium">{isAi ? 'Likely cause' : 'Why it happened'}</dt>
          <dd className="text-muted-foreground">{why}</dd>
        </div>
        <div>
          <dt className="font-medium">{isAi ? 'Suggested fix' : 'How to fix it'}</dt>
          <dd className="text-muted-foreground">{fix}</dd>
        </div>
      </dl>
      {isAi ? <p className="text-xs text-muted-foreground">{AI_EXPLANATION_SOURCE_NOTE}</p> : null}
    </div>
  );
}

/** The raw failure record for the panel's Technical details: failure code,
 *  normalised context, startup evidence and the structured event. */
export function DiagnosticTechnical({ diagnostic }: { diagnostic: Diagnostic }) {
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground" data-testid="diagnostic-technical">
      <DetailRow label="Failure code" value={diagnostic.failureCode} />
      {diagnostic.context ? <ContextRows context={diagnostic.context} /> : null}
      <StartupEvidence diagnostic={diagnostic} />
      <EventRows event={diagnostic.event} />
    </div>
  );
}

function StartupEvidence({ diagnostic }: { diagnostic: Diagnostic }) {
  const container = diagnostic.evidence?.container ?? null;
  if (
    container === null ||
    (container.exitCode === null &&
      container.stopCode === null &&
      container.stoppedReason === null &&
      container.stoppedTaskCount === null)
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="startup-evidence">
      {container.exitCode !== null ? <DetailRow label="Exit code" value={String(container.exitCode)} /> : null}
      {container.stopCode !== null ? <DetailRow label="Stop code" value={container.stopCode} /> : null}
      {container.stoppedTaskCount !== null ? (
        <DetailRow label="Restart count" value={String(container.stoppedTaskCount)} />
      ) : null}
      {container.stoppedReason !== null ? <StoppedReason reason={container.stoppedReason} /> : null}
      <p>Raw container logs are not collected.</p>
    </div>
  );
}

function StoppedReason({ reason }: { reason: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">Stopped reason</span>
      <code className={cn('break-all rounded bg-muted px-1.5 py-0.5 font-mono', !expanded && 'line-clamp-2')}>
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

function ContextRows({ context }: { context: DiagnosticContext }) {
  return (
    <>
      <DetailRow
        label="Operation"
        value={context.attempt !== null ? `${context.phase} (attempt ${context.attempt})` : context.phase}
      />
      {context.reportedFailureCode !== null ? (
        <DetailRow label="Reported by the helper as" value={context.reportedFailureCode} />
      ) : null}
      {context.componentId ? <DetailRow label="Component ID" value={context.componentId} /> : null}
      {context.applicationVersion !== null ? <DetailRow label="Version" value={context.applicationVersion} /> : null}
      {context.resourceType !== null ? <DetailRow label="Failed resource" value={context.resourceType} /> : null}
      {context.relevantEvents.length > 0 ? (
        <div className="flex flex-col gap-0.5">
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
      {event.error?.code !== undefined ? <DetailRow label="Error code" value={event.error.code} /> : null}
      {event.error?.message !== undefined ? <DetailRow label="Error message" value={event.error.message} /> : null}
      {event.error?.statusCode !== undefined ? (
        <DetailRow label="Status code" value={String(event.error.statusCode)} />
      ) : null}
      {event.context !== undefined ? <DetailRow label="Context" value={JSON.stringify(event.context)} /> : null}
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
