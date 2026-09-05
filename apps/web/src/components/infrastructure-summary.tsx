'use client';

import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Circle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { InfrastructureSection } from '@/components/infrastructure-section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import {
  INFRASTRUCTURE_COMPONENT_NAME,
  RELAY_STATUS_LABEL,
  infrastructureComponentStatusLabel,
  showInfrastructureRows,
  type DeploymentState,
  type RelayStatus,
} from '@/lib/deployment-vocabulary';
import type {
  FleetDeploymentDetail,
  InfrastructureComponentKind,
  InfrastructureComponentStatus,
  InfrastructureResponse,
  InfrastructureSummaryStatus,
} from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';

// The default Infrastructure view: one line per logical service with a
// plain-English status, the connector's connectivity, and — behind "View N
// resources" — the full resource inventory (InfrastructureSection). Vendors
// see "Database · Ready", never a stack of AWS resource cards, unless they ask.

const SUMMARY_LINE: Record<InfrastructureSummaryStatus, string> = {
  healthy: 'All required services are ready.',
  provisioning: 'Services are being created.',
  updating: 'Services are being updated.',
  degraded: 'Some services need attention.',
  failed: 'A service failed. Diagnostics explains what happened.',
  deleting: 'Services are being removed.',
  retained: 'Retained services remain in the customer AWS account.',
  unknown: 'Service status is not available right now.',
};

const STATUS_ICON: Record<InfrastructureComponentStatus, ReactNode> = {
  ready: <CheckCircle2 aria-hidden className="size-4 shrink-0 text-primary" />,
  retained: <CheckCircle2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
  failed: <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" />,
  provisioning: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  updating: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  deleting: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />,
  pending: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
  removed: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
  unknown: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
};

const RELAY_DOT: Record<RelayStatus, string> = {
  CONNECTED: 'bg-primary',
  DISCONNECTED: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground',
};

/** Services the application does not need, so their absence from the
 *  inventory is "Not required", never a missing row. deploymentStatus
 *  component key → inventory component kind. */
const OPTIONAL_SERVICES: readonly (readonly [key: string, kind: InfrastructureComponentKind])[] = [
  ['database', 'database'],
  ['storage', 'storage'],
  ['redis', 'cache'],
];

export function InfrastructureSummary({
  detail,
  infrastructure,
  infrastructureError,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
  /** The inventory request failed; the rest of the page still renders. */
  infrastructureError: boolean;
}) {
  const state = detail.state as DeploymentState;
  const listable = showInfrastructureRows(state, detail.currentReleaseId) || state === 'DELETED';
  const relay = (
    <RelayRow status={detail.relayStatus} lastContact={relativeTime(detail.lastHealthAt)} />
  );

  if (!listable) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {state === 'NOT_INSTALLED' || state === 'WAITING_FOR_RELAY'
            ? 'This deployment has not been installed yet.'
            : state === 'FAILED'
              ? "This deployment isn't running, so there's nothing to report."
              : 'This deployment has been removed.'}
        </p>
        <ul className="flex flex-col divide-y rounded-lg border text-sm">{relay}</ul>
      </div>
    );
  }

  if (infrastructureError) {
    return (
      <div className="flex flex-col gap-3">
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertTitle>Infrastructure details are unavailable right now</AlertTitle>
          <AlertDescription>
            The deployment itself is unaffected. This section refreshes automatically.
          </AlertDescription>
        </Alert>
        <ul className="flex flex-col divide-y rounded-lg border text-sm">{relay}</ul>
      </div>
    );
  }

  if (infrastructure === null) {
    return (
      <div className="flex flex-col gap-2" data-testid="infrastructure-loading">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  const notRequired = OPTIONAL_SERVICES.filter(
    ([key, kind]) =>
      detail.deploymentStatus.components.some(
        (component) => component.key === key && component.status === 'NOT_REQUIRED',
      ) && !infrastructure.components.some((component) => component.kind === kind),
  );
  const resourceCount = infrastructure.summary.technicalResourceCount;

  return (
    <div className="flex flex-col gap-3">
      {infrastructure.snapshotState === 'none' ? (
        // A failed install that never created a stack's worth of resources
        // has nothing the inventory could add — say so honestly (the hero
        // and activity above carry the failure itself). Live states get the
        // "details appear as they are created" line instead.
        <p className="text-sm text-muted-foreground">
          {state === 'FAILED'
            ? "This deployment isn't running, so there's nothing to report."
            : 'Service details appear as they are created.'}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{SUMMARY_LINE[infrastructure.summary.status]}</p>
      )}
      {infrastructure.connectionState === 'disconnected' ? (
        <p className="text-sm text-muted-foreground">
          Showing the last verified state
          {infrastructure.disconnectWarning
            ? ` (${relativeTime(infrastructure.disconnectWarning.lastVerifiedAt)})`
            : ''}
          .
        </p>
      ) : null}
      <ul className="flex flex-col divide-y rounded-lg border text-sm">
        {infrastructure.components.map((component) => (
          <li key={component.kind} className="flex items-center gap-3 px-3 py-2">
            {STATUS_ICON[component.status]}
            <span className="min-w-0 truncate font-medium">
              {INFRASTRUCTURE_COMPONENT_NAME[component.kind] ?? component.name}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {infrastructureComponentStatusLabel(component)}
            </span>
          </li>
        ))}
        {notRequired.map(([key, kind]) => (
          <li key={key} className="flex items-center gap-3 px-3 py-2">
            <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/30" />
            <span className="min-w-0 truncate font-medium text-muted-foreground">
              {INFRASTRUCTURE_COMPONENT_NAME[kind]}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground">Not required</span>
          </li>
        ))}
        {relay}
      </ul>
      {infrastructure.components.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
            View {resourceCount} resource{resourceCount === 1 ? '' : 's'}
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <InfrastructureSection
              data={infrastructure}
              deploymentId={detail.id}
              deploymentState={detail.state}
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function RelayRow({ status, lastContact }: { status: RelayStatus; lastContact: string | null }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className={`mx-1 size-2 shrink-0 rounded-full ${RELAY_DOT[status]}`} aria-hidden />
      <span className="font-medium">Deployz Relay</span>
      <span className="ml-auto text-right text-muted-foreground" data-testid="status-updated">
        {lastContact ? `${RELAY_STATUS_LABEL[status]} · ${lastContact}` : RELAY_STATUS_LABEL[status]}
      </span>
    </li>
  );
}
