'use client';

import { useEffect, useRef } from 'react';

import type { CustomerDeploymentStatus } from '@deployz/contracts';
import { AlertTriangle, ChevronDown, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { DeploymentProgressSteps } from '@/components/deployment-progress-steps';
import { CustomDomainCard } from '@/components/custom-domain-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import type { CustomDomainView } from '@/lib/domains';
import {
  isTerminalStage,
  STAGE_HEADLINE,
  stepDetailLine,
  stepsFromStatus,
} from '@/lib/deployment-progress';
import { fetchInstallStatus } from '@/lib/install-status';
import { useStatusPoll } from '@/lib/use-status-poll';

/**
 * The customer's step list with a compact detail line on the active step
 * only: a slow-step nudge when the install is running long, otherwise the
 * step's typical duration when one exists. Completed and upcoming steps
 * never carry a detail — no percentages, no countdowns, no per-step ETAs.
 */
function activeStepDetail(status: CustomerDeploymentStatus) {
  return stepsFromStatus({ steps: status.steps, step: status.step, stage: status.stage }).map((step) =>
    step.state === 'current'
      ? {
          ...step,
          detail: stepDetailLine({
            takingLongerThanUsual: status.takingLongerThanUsual,
            typicalDurationSeconds: status.typicalDurationSeconds,
            longerMessage: 'Taking longer than usual, but AWS is still working.',
            typicalLabel: (range) => `Usually takes ${range}`,
          }),
        }
      : step,
  );
}

/**
 * §12/§44 the customer's whole install-to-ready experience in one place.
 * Polls the server-derived stage (never infers lifecycle client-side — see
 * deployment-progress.ts) and renders by `status.stage` alone. The same
 * component drives the pre-install page (starting at WAITING_FOR_AWS, small
 * and unobtrusive under the "Deploy to AWS" CTA) and the already-installed
 * page (starting at CONNECTING or later): as the stage advances the card
 * naturally grows into the full progress view, then — for READY/VERIFYING —
 * also surfaces the Access section and the custom-domain card, so a customer
 * who stays on the page never needs to reload it to see their app come up.
 */
export function InstallProgress({
  installLinkId,
  deploymentId,
  initialStatus,
  quickCreateUrl,
  initialDomain,
  routingTarget,
  preinstall = false,
}: {
  installLinkId: string;
  deploymentId: string;
  initialStatus: CustomerDeploymentStatus | null;
  quickCreateUrl: string | null;
  initialDomain: CustomDomainView | null;
  routingTarget: string | null;
  /** True when mounted under the pre-install page layout, whose surrounding
   * server-rendered content (the Deploy to AWS CTA, capability lists) is only
   * correct while nothing has enrolled yet. */
  preinstall?: boolean;
}) {
  const router = useRouter();
  const poll = useStatusPoll({
    fetcher: () => fetchInstallStatus(installLinkId),
    intervalMs: 5000,
    terminalIntervalMs: 60000,
    isTerminal: (status) => isTerminalStage(status.stage),
    initialData: initialStatus,
  });

  const status = poll.data;

  // The pre-install layout is a server component, so this card advancing on
  // its own would leave a spent "Deploy to AWS" CTA above it. One refresh
  // when the stage first moves past WAITING_FOR_AWS re-renders the page from
  // server truth (alreadyInstalled is now set), which swaps the whole layout
  // to the progress view.
  const refreshed = useRef(false);
  const advanced = preinstall && status !== null && status.stage !== 'WAITING_FOR_AWS';
  useEffect(() => {
    if (advanced && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [advanced, router]);
  if (!status) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  const headline = STAGE_HEADLINE[status.stage];
  // A relay outage never regresses the displayed stage (the server already
  // holds the last confirmed one); it only earns this quiet notice. Repeated
  // client-side fetch failures get the same treatment.
  const stale = status.statusUpdatesUnavailable || poll.stale;
  const canAccess = status.stage === 'READY' || status.stage === 'VERIFYING';

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4 py-4">
          <div>
            {/* The only aria-live region in this component — every other
                update (steps, components, access) rides along with it. */}
            <h2 aria-live="polite" className="text-base font-semibold">
              {headline.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{headline.body}</p>
          </div>

          {stale ? (
            <p className="text-xs text-muted-foreground">
              Status updates are temporarily unavailable — showing the last confirmed state.
            </p>
          ) : null}

          {status.stage === 'FAILED' ? (
            <FailureDetails failure={status.failure} />
          ) : (
            <>
              <DeploymentProgressSteps steps={activeStepDetail(status)} />

              {status.stage === 'WAITING_FOR_AWS' && quickCreateUrl ? (
                <Button asChild variant="outline" size="sm" className="self-start">
                  <a href={quickCreateUrl} target="_blank" rel="noopener noreferrer">
                    Open AWS setup
                  </a>
                </Button>
              ) : null}

              {status.stage === 'VERIFYING' && status.needsDomainSetup ? (
                <p className="text-sm text-muted-foreground">
                  Your application is healthy. The last step is a secure address — set up a
                  custom domain below to finish.
                </p>
              ) : null}

              {status.stage === 'READY' && status.url ? (
                <Button asChild size="sm" className="self-start">
                  <a href={status.url} target="_blank" rel="noreferrer">
                    Open application
                    <ExternalLink aria-hidden className="size-3.5" />
                  </a>
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {canAccess ? (
        <>
          <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
            <h2 id="deployment-access" className="text-base font-semibold">
              Access
            </h2>
            {status.url ? (
              <p className="text-sm">
                Your deployment is available at{' '}
                <a className="font-medium underline underline-offset-4" href={status.url}>
                  {status.url}
                </a>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {routingTarget
                  ? 'Set up a custom domain below to give this deployment a permanent address.'
                  : 'This deployment does not have a public address configured yet.'}
              </p>
            )}
            {routingTarget ? (
              <p className="text-xs text-muted-foreground">
                Deployment endpoint:{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {routingTarget}
                </code>
              </p>
            ) : null}
          </section>

          <CustomDomainCard
            deploymentId={deploymentId}
            installLinkId={installLinkId}
            initialDomain={initialDomain}
          />
        </>
      ) : null}
    </div>
  );
}

function FailureDetails({ failure }: { failure: CustomerDeploymentStatus['failure'] }) {
  if (!failure) return null;
  const technical = failure.technical;
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="destructive">
        <AlertTriangle aria-hidden />
        <AlertTitle>What happened</AlertTitle>
        <AlertDescription>{failure.customerMessage}</AlertDescription>
      </Alert>
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
          Technical details
          <ChevronDown
            aria-hidden
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1.5 pt-2 text-sm">
          {technical ? <DetailRow label="Stage" value={technical.stage} /> : null}
          {technical?.component ? <DetailRow label="Component" value={technical.component} /> : null}
          {technical?.awsStatus ? <DetailRow label="AWS status" value={technical.awsStatus} /> : null}
          <DetailRow label="Reference" value={failure.reference} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}
