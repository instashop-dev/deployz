import type { ComponentProgressStatus, VendorDeploymentStatus } from '@deployz/contracts';
import { AlertTriangle } from 'lucide-react';

import { DeploymentProgressSteps } from '@/components/deployment-progress-steps';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { relativeTime } from '@/lib/diagnostics';
import { COMPONENT_PROGRESS_LABEL, customerSteps, STAGE_LABEL } from '@/lib/deployment-progress';
import { JOB_STATE_LABEL, JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';

/** Dot color per component-progress status — semantic tokens only (opacity
 *  modifiers, not a raw palette), paired with COMPONENT_PROGRESS_LABEL text
 *  so color never carries meaning alone. */
const PROGRESS_DOT: Record<ComponentProgressStatus, string> = {
  PENDING: 'bg-muted-foreground/50',
  IN_PROGRESS: 'bg-primary/60',
  READY: 'bg-primary',
  FAILED: 'bg-destructive',
  NOT_REQUIRED: 'bg-muted-foreground/30',
};

/**
 * The vendor-side "where is this deployment right now" card, driven entirely
 * by the server-derived `deploymentStatus` — the same stage/step model the
 * customer install page renders, so the two surfaces can never disagree.
 *
 * This is deliberately NOT a duplicate of the page's existing Infrastructure
 * section: that section only appears once a deployment has completed an
 * install (`showInfrastructureRows`), so it renders nothing for the entire
 * WAITING_FOR_AWS / CONNECTING / PROVISIONING run. This card fills that gap
 * with the relay/job/component detail a vendor needs while an install is in
 * flight, and keeps showing it afterwards for continuity.
 */
export function DeploymentProgressCard({ status }: { status: VendorDeploymentStatus }) {
  const lastSeen = relativeTime(status.relay.lastSeenAt);
  const lastUpdate = relativeTime(status.updatedAt);
  const failure = status.stage === 'FAILED' ? status.failure : null;
  const failureComponentLabel = failure?.component
    ? (status.components.find((component) => component.key === failure.component)?.label ??
      failure.component)
    : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-4">
        <div>
          {/* The one aria-live region on this card: the stage text itself,
              so assistive tech announces a transition without re-reading
              the whole card on every poll tick. */}
          <p aria-live="polite" className="text-sm font-semibold">
            {STAGE_LABEL[status.stage]}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{status.currentActivity}</p>
        </div>

        {status.statusUpdatesUnavailable ? (
          <p className="text-sm text-muted-foreground">
            Status updates temporarily unavailable — showing last confirmed state.
          </p>
        ) : null}

        {failure ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>{failure.message}</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              {failureComponentLabel ? <span>Component: {failureComponentLabel}</span> : null}
              {failure.awsStatus ? (
                <span>
                  AWS status:{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    {failure.awsStatus}
                  </code>
                </span>
              ) : null}
              <span>
                Reference:{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  {failure.reference}
                </code>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        <DeploymentProgressSteps steps={customerSteps(status.stage)} />

        <ul className="flex flex-col gap-2">
          {status.components.map((component) => (
            <li
              key={component.key}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${PROGRESS_DOT[component.status]}`}
                aria-hidden
              />
              <span className="text-sm font-medium">{component.label}</span>
              <span className="ml-auto text-sm text-muted-foreground">
                {COMPONENT_PROGRESS_LABEL[component.status]}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <span
              className={`size-2 shrink-0 rounded-full ${status.relay.connected ? 'bg-primary' : 'bg-destructive'}`}
              aria-hidden
            />
            <span className="text-sm font-medium">Deployz Relay</span>
            {/* data-testid: masked in visual regression — relative time
                drifts with the clock. */}
            <span className="ml-auto text-sm text-muted-foreground" data-testid="status-updated">
              {status.relay.connected ? 'Connected' : 'Offline'}
              {lastSeen ? ` · ${lastSeen}` : ''}
            </span>
          </li>
          {status.job ? (
            <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm font-medium">Latest job</span>
              <span className="ml-auto text-sm text-muted-foreground">
                {JOB_TYPE_LABEL[status.job.type]} · {JOB_STATE_LABEL[status.job.status]}
              </span>
            </li>
          ) : null}
          {status.aws.stackStatus ? (
            <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm font-medium">AWS stack</span>
              <code className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {status.aws.stackStatus}
              </code>
            </li>
          ) : null}
          <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <span className="text-sm font-medium">Last update</span>
            <span className="ml-auto text-sm text-muted-foreground" data-testid="status-updated">
              {lastUpdate ?? '—'}
            </span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
