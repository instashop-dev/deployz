'use client';

import { useEffect, useRef } from 'react';

import type {
  CustomerActivityItem,
  CustomerDeploymentStatus,
  CustomerTechnicalDetails,
  DeploymentPlan,
} from '@deployz/contracts';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { DeploymentStepper } from '@/components/deployment-stepper';
import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { CustomDomainCard } from '@/components/custom-domain-card';
import { LiveStepDetail } from '@/components/live-step-detail';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import type { CustomDomainView } from '@/lib/domains';
import {
  COMPONENT_PROGRESS_LABEL,
  COMPONENT_STATUS_TONE,
  isTerminalStage,
  PRE_LAUNCH_HEADLINE,
  recentActivityTimeLabel,
  STAGE_HEADLINE,
  stepWaitingOnInput,
  stepsBeforeLaunch,
  AWAITING_DOMAIN_STEP_DETAIL,
  customerStepperSteps,
  stepsFromStatus,
} from '@/lib/deployment-progress';
import { fetchDeployLinkStatus, type DeployLinkToken } from '@/lib/deploy-link-flow';
import { fetchInstallStatus } from '@/lib/install-status';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import {
  STARTUP_FAILURE_CUSTOMER_NOTE,
  STARTUP_FAILURE_TITLE,
} from '@/lib/diagnostic-vocabulary';
import { OWNERSHIP_NOTE } from '@/lib/security-details';
import { TONE_DOT, TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';
import { useStatusPoll } from '@/lib/use-status-poll';

/**
 * The customer's grouped stepper with a live, ticking detail on the active
 * step only (LiveStepDetail — current activity, duration/slow-step line with
 * elapsed time, last-checked time). Completed and upcoming steps never carry
 * a detail — no percentages, no countdowns, no per-step ETAs.
 */
function activeStepDetail({
  status,
  checkedAt,
  active,
}: {
  status: CustomerDeploymentStatus;
  checkedAt: number | null;
  active: boolean;
}) {
  // HTTPS waits for a domain, not for AWS: LiveStepDetail's "still working"
  // nudge and elapsed counter would otherwise promise work nothing is doing.
  const waitingOnInput = stepWaitingOnInput({
    step: status.step,
    needsDomainSetup: status.needsDomainSetup,
  });
  return customerStepperSteps(
    stepsFromStatus({ steps: status.steps, step: status.step, stage: status.stage }).map((step) => {
      if (step.state !== 'current') return step;
      if (waitingOnInput) return { ...step, detail: AWAITING_DOMAIN_STEP_DETAIL };
      return {
        ...step,
        detail: (
          <LiveStepDetail
            currentActivity={status.currentActivity}
            takingLongerThanUsual={status.takingLongerThanUsual}
            typicalDurationSeconds={status.typicalDurationSeconds}
            stepStartedAt={status.stepStartedAt ?? null}
            checkedAt={checkedAt}
            active={active}
          />
        ),
      };
    }),
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
 *
 * Layout, top to bottom: the dominant progress card (headline + grouped
 * vertical stepper), then the always-visible "Live AWS activity" feed with
 * the raw AWS events behind their own collapsed disclosure, then the compact
 * per-component "Resources" summary with the plan's full AWS inventory
 * behind "View all AWS resources (N)", and finally the collapsed "Technical
 * details". Everything technical is closed by default — the page stays
 * jargon-free until the reader asks for more.
 */
export function InstallProgress({
  installLinkId,
  deploymentId,
  initialStatus,
  quickCreateUrl,
  initialDomain,
  routingTarget,
  plan = null,
  preinstall = false,
  awaitingLaunch = false,
  deployLink = null,
}: {
  installLinkId: string;
  deploymentId: string;
  initialStatus: CustomerDeploymentStatus | null;
  quickCreateUrl: string | null;
  initialDomain: CustomDomainView | null;
  routingTarget: string | null;
  /** The deployment's plan — supplies the "View all AWS resources (N)"
   *  inventory on the deploy page; the install page renders its own review
   *  table above and passes nothing. */
  plan?: DeploymentPlan | null;
  /** True when mounted under the pre-install page layout, whose surrounding
   *  server-rendered content (the Deploy to AWS CTA, capability lists) is only
   *  correct while nothing has enrolled yet. */
  preinstall?: boolean;
  /** True while the customer has not pressed Deploy to AWS yet (the
   *  deployment is still NOT_INSTALLED): nothing is being created, so the
   *  card must not claim AWS is at work. */
  awaitingLaunch?: boolean;
  /** Set on the /deploy page: status and domain calls resolve through the
   *  deploy link (token header) instead of the install link. */
  deployLink?: DeployLinkToken | null;
}) {
  const router = useRouter();
  const poll = useStatusPoll({
    fetcher: () =>
      deployLink
        ? fetchDeployLinkStatus(deployLink.publicId, deployLink.token)
        : fetchInstallStatus(installLinkId),
    intervalMs: 5000,
    // Stop polling once the stage is terminal — the visibility-
    // change refresh still fires and resumes the loop if it ever returns a
    // non-terminal value (a retried install after FAILED, health lost after
    // READY).
    terminalIntervalMs: null,
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
      <Card aria-busy="true">
        <CardContent className="flex flex-col gap-3 py-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  const beforeLaunch = awaitingLaunch && status.stage === 'WAITING_FOR_AWS';
  const headline = beforeLaunch ? PRE_LAUNCH_HEADLINE : STAGE_HEADLINE[status.stage];
  // A relay outage never regresses the displayed stage (the server already
  // holds the last confirmed one); it only earns this quiet notice. Repeated
  // client-side fetch failures get the same treatment.
  const stale = status.statusUpdatesUnavailable || poll.stale;
  const canAccess = status.stage === 'READY' || status.stage === 'VERIFYING';
  const active = !isTerminalStage(status.stage);
  const failed = status.stage === 'FAILED';

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

          {failed ? (
            <>
              <FailureDetails
                failure={status.failure}
                technicalDetails={status.technicalDetails}
                cleanup={status.cleanup ?? null}
              />
              {/* The attempt's own stepper stays visible after the failure:
                  completed steps remain done, the interrupted step is the
                  failed one, later steps stay not started — the failure must
                  never read as "still deploying". */}
              <DeploymentStepper steps={activeStepDetail({ status, checkedAt: poll.checkedAt, active })} />
            </>
          ) : (
            <>
              {/* AWS can report a resource failure well before the job
                  itself lands on FAILED (a rollback can take many minutes) —
                  this says so immediately instead of leaving the page silent. */}
              {status.provisioningIssue ? (
                <Alert variant="destructive">
                  <AlertTriangle aria-hidden />
                  <AlertTitle>AWS reported a problem</AlertTitle>
                  <AlertDescription>{status.provisioningIssue.message}</AlertDescription>
                </Alert>
              ) : null}

              <DeploymentStepper
                steps={
                  beforeLaunch
                    ? customerStepperSteps(stepsBeforeLaunch(status.steps))
                    : activeStepDetail({ status, checkedAt: poll.checkedAt, active })
                }
              />

              {status.stage === 'WAITING_FOR_AWS' && !beforeLaunch && quickCreateUrl ? (
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

      {active && !beforeLaunch ? (
        <LiveAwsActivity
          items={status.recentActivity ?? []}
          technicalDetails={status.technicalDetails}
          stale={stale}
          showSetupHint={status.stage === 'WAITING_FOR_AWS' || status.stage === 'CONNECTING'}
        />
      ) : null}

      {!failed ? <ResourcesSummary components={status.components} plan={plan} /> : null}

      {!failed && status.technicalDetails ? (
        <ActiveTechnicalDetails technicalDetails={status.technicalDetails} />
      ) : null}

      {canAccess ? (
        <>
          <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
            <h2 id="deployment-access" className="text-base font-semibold">
              Access
            </h2>
            {status.url ? (
              status.url.startsWith('https://') ? (
                <p className="text-sm">
                  Your deployment is available securely at{' '}
                  <a className="font-medium underline underline-offset-4" href={status.url}>
                    {status.url}
                  </a>
                </p>
              ) : (
                // A bare ALB endpoint serves over plain HTTP — reachable, but
                // temporary and explicitly not secure. Never label it otherwise.
                <p className="text-sm">
                  Your deployment is temporarily available at{' '}
                  <a className="font-medium underline underline-offset-4" href={status.url}>
                    {status.url}
                  </a>
                  {' '}
                  — not secure, and this address may change.
                </p>
              )
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
            deployLink={deployLink}
          />
        </>
      ) : null}

      {status.stage === 'READY' && status.awsSummary ? (
        <AwsDeploymentDetails summary={status.awsSummary} url={status.url} updatedAt={status.updatedAt} />
      ) : null}
    </div>
  );
}

/**
 * The always-visible activity feed while the deployment runs: the latest few
 * human-readable AWS events (already translated to customer copy and
 * deduplicated by the API), a subtle live/freshness cue, and the raw
 * CloudFormation events tucked behind their own collapsed disclosure so the
 * feed itself stays jargon-free. Hidden once the stage is terminal or before
 * the first launch — nothing is live then.
 */
function LiveAwsActivity({
  items,
  technicalDetails,
  stale,
  showSetupHint,
}: {
  items: CustomerActivityItem[];
  technicalDetails: CustomerTechnicalDetails | null | undefined;
  stale: boolean;
  showSetupHint: boolean;
}) {
  const now = Date.now();
  const events = technicalDetails?.events ?? [];
  return (
    <section aria-labelledby="deployment-activity" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            stale ? TONE_DOT.attention : TONE_DOT.progress,
            !stale && 'animate-pulse',
          )}
        />
        <h2 id="deployment-activity" className="text-base font-semibold">
          Live AWS activity
        </h2>
        <span className="text-xs text-muted-foreground">{stale ? 'Last confirmed update' : 'Live'}</span>
      </div>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {items.slice(0, 5).map((item) => (
            <li key={item.key} className="flex items-start gap-2 text-xs text-muted-foreground">
              <ActivityIcon state={item.state} />
              <span className="flex-1">{item.message}</span>
              <span className="shrink-0 tabular-nums">{recentActivityTimeLabel(item.at, now)}</span>
            </li>
          ))}
        </ul>
      ) : showSetupHint ? (
        <p className="text-sm text-muted-foreground">
          Live AWS activity appears here when Deployz starts to create your infrastructure.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No AWS activity reported yet.</p>
      )}
      {events.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
            View raw AWS events
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <TechnicalEvents events={events} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

/**
 * The compact per-component summary below the progress card: one clean row
 * per component this deployment actually requires — the backend's component
 * labels are the only AWS naming shown, never a client-side guess — with the
 * plan's full AWS inventory behind "View all AWS resources (N)". Components
 * the deployment does not need are never listed (the API already omits
 * them; NOT_REQUIRED rows are dropped defensively too).
 */
function ResourcesSummary({
  components,
  plan,
}: {
  components: CustomerDeploymentStatus['components'];
  plan: DeploymentPlan | null;
}) {
  const rows = components.filter((component) => component.status !== 'NOT_REQUIRED');
  const resourceCount = plan?.awsResources.length ?? 0;
  if (rows.length === 0 && resourceCount === 0) return null;
  return (
    <section aria-labelledby="deployment-resources" className="flex flex-col gap-3">
      <h2 id="deployment-resources" className="text-base font-semibold">
        Resources
      </h2>
      {rows.length > 0 ? (
        <ul>
          {rows.map((component, index) => (
            <li
              key={component.key}
              className={cn(
                'flex items-center justify-between gap-3 py-2',
                index < rows.length - 1 && 'border-b',
              )}
            >
              <span className="min-w-0 text-sm">{component.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className={cn('size-1.5 rounded-full', TONE_DOT[COMPONENT_STATUS_TONE[component.status]])}
                />
                {COMPONENT_PROGRESS_LABEL[component.status]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {resourceCount > 0 ? (
        <AwsInfrastructureDetails plan={plan} triggerLabel={`View all AWS resources (${resourceCount})`} />
      ) : null}
    </section>
  );
}

/**
 * The READY-only summary of the deployment's AWS footprint: a quiet,
 * collapsed disclosure of the few server-verifiable, non-secret facts the
 * status carries (stored data only — no raw CloudFormation state). The
 * ownership note below it states who owns what.
 */
function AwsDeploymentDetails({
  summary,
  url,
  updatedAt,
}: {
  summary: NonNullable<CustomerDeploymentStatus['awsSummary']>;
  url: string | null;
  updatedAt: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="aws-deployment-details">
      <Collapsible className="rounded-md border">
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm">
          <span className="font-medium">AWS deployment details</span>
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 border-t px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Application stack name</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {summary.applicationStackName}
              </code>
            </div>
            <DetailRow label="AWS region" value={summary.region} />
            {summary.releaseVersion !== null ? (
              <DetailRow label="Installed release" value={summary.releaseVersion} />
            ) : null}
            {url ? (
              <div className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground">Application endpoint</span>
                <a
                  className="min-w-0 break-words text-right font-mono text-xs underline underline-offset-4"
                  href={url}
                >
                  {url}
                </a>
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Last checked</span>
              <span className="text-right font-mono text-xs">{formatEventTime(updatedAt)}</span>
            </div>
            <a
              className="self-start font-medium underline underline-offset-4"
              href={cloudFormationStacksUrl(summary.region, summary.applicationStackName)}
              target="_blank"
              rel="noreferrer"
            >
              View in AWS CloudFormation
            </a>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <p className="text-xs text-muted-foreground">{OWNERSHIP_NOTE}</p>
    </div>
  );
}

/**
 * The customer failure projection, plus the derived startup flag the API
 * computes from the §61 code behind the message. The raw code itself never
 * reaches this unauthenticated surface (§65). The flag is optional here so
 * an older cached response that predates it still renders today's exact
 * behavior.
 */
type CustomerFailure = NonNullable<CustomerDeploymentStatus['failure']> & {
  ownedByApplication?: boolean;
  customerActionRequired?: boolean;
};

/** Cleanup copy for a failed install — which of the three states applies is
 *  derived server-side from the live stack status and cleanupState; the
 *  page never guesses. */
const CLEANUP_COPY: Record<NonNullable<CustomerDeploymentStatus['cleanup']>, string> = {
  IN_PROGRESS: 'Deployz has stopped the deployment and is cleaning up resources created during this attempt.',
  COMPLETE: 'The failed deployment has been cleaned up.',
  RETAINED: 'Some data or resources may remain in your AWS account. The technical details below have more information.',
};

/** The default customer next step after a failed install: the vendor owns
 *  the retry, and the customer is explicitly told no action is needed. */
const DEFAULT_NEXT_STEPS =
  'No action is required right now. Your software provider has been notified and can retry the deployment after reviewing the issue.';

function FailureDetails({
  failure,
  technicalDetails,
  cleanup,
}: {
  failure: CustomerFailure | null;
  technicalDetails: CustomerDeploymentStatus['technicalDetails'];
  cleanup: CustomerDeploymentStatus['cleanup'];
}) {
  if (!failure) return null;
  const technical = failure.technical;
  // The app-owned startup failures are the vendor's to fix — the customer is
  // told it is not their fault. Gated strictly on the derived flag; "What
  // happened" stays for every other failure.
  const startup = failure.ownedByApplication === true;
  // A USER_ACTION failure that is not the application's own needs a change
  // on the customer side before a retry can succeed — the default
  // "no action required" copy would then be wrong.
  const actionRequired = failure.customerActionRequired === true;
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="destructive">
        <AlertTriangle aria-hidden />
        <AlertTitle>{startup ? STARTUP_FAILURE_TITLE : 'What happened'}</AlertTitle>
        <AlertDescription>
          {failure.customerMessage}
          {startup ? <span className="mt-1 block">{STARTUP_FAILURE_CUSTOMER_NOTE}</span> : null}
        </AlertDescription>
      </Alert>
      {cleanup ? <p className="text-sm text-muted-foreground">{CLEANUP_COPY[cleanup]}</p> : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">What happens next</h3>
        <p className="text-sm text-muted-foreground">
          {actionRequired
            ? 'Your software provider can retry the deployment once the change described above has been made.'
            : DEFAULT_NEXT_STEPS}
        </p>
      </div>
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
          {/* The API maps the raw CloudFormation status to a jargon-free
              phrase before it reaches this projection (§65). */}
          {technical?.awsStatus ? <DetailRow label="Infrastructure" value={technical.awsStatus} /> : null}
          <DetailRow label="Reference" value={failure.reference} />
          {technicalDetails ? (
            <>
              {technicalDetails.facts.map((fact) => (
                <DetailRow key={fact.label} label={fact.label} value={fact.value} />
              ))}
              <TechnicalEvents events={technicalDetails.events} />
            </>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * The active-stage (non-FAILED) counterpart to FailureDetails' collapsible —
 * the same closed-by-default "Technical details" disclosure, holding the
 * deployment reference and the raw facts the API attaches once it has them.
 * The raw CloudFormation events live one section up, behind "View raw AWS
 * events", so no fact is ever listed twice. Renders nothing until
 * `technicalDetails` arrives, so a deployment stays jargon-free by default.
 */
function ActiveTechnicalDetails({ technicalDetails }: { technicalDetails: CustomerTechnicalDetails }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        Technical details
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 pt-2 text-sm">
        <DetailRow label="Reference" value={technicalDetails.reference} />
        {technicalDetails.facts.map((fact) => (
          <DetailRow key={fact.label} label={fact.label} value={fact.value} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Raw CloudFormation events, compact monospace rows — customer-owned AWS
 *  account detail, shown only inside a collapsed disclosure. */
function TechnicalEvents({ events }: { events: CustomerTechnicalDetails['events'] }) {
  if (events.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pt-1">
      {events.map((event) => (
        <p
          key={`${event.at}-${event.logicalResourceId}-${event.resourceStatus}`}
          className="font-mono text-xs text-muted-foreground"
        >
          {formatEventTime(event.at)} · {event.logicalResourceId} · {event.resourceType} ·{' '}
          {event.resourceStatus}
          {event.resourceStatusReason ? ` · ${event.resourceStatusReason}` : ''}
        </p>
      ))}
    </div>
  );
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ActivityIcon({ state }: { state: CustomerActivityItem['state'] }) {
  switch (state) {
    case 'COMPLETE':
      return <CheckCircle2 aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', TONE_TEXT.positive)} />;
    case 'FAILED':
      return <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
    case 'IN_PROGRESS':
      return <Loader2 aria-hidden className={cn('mt-0.5 size-3.5 shrink-0 animate-spin', TONE_TEXT.progress)} />;
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs">{value}</span>
    </div>
  );
}
