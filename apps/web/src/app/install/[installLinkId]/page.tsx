import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronDown, Loader2 } from 'lucide-react';

import { FootprintCost } from '@/components/footprint-cost';
import { InstallLaunchButton } from '@/components/install-launch-button';
import { InstallPlanTable } from '@/components/install-plan-table';
import { InstallProgress } from '@/components/install-progress';
import { InstallRetryButton } from '@/components/install-retry-button';
import { PublicInstallFlow } from '@/components/public-install-flow';
import { TablePanel } from '@/components/table-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RELAY_STUCK_GUIDANCE } from '@/lib/deployment-vocabulary';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import { fetchInstallData } from '@/lib/install-data';
import { formatMonthlyRange } from '@/lib/footprint';
import { installPlanRegionLabel, installPlanRetentionNote, installPlanRows } from '@/lib/install-plan';
import { fetchPublicInstallData } from '@/lib/public-install-data';
import { publicInstallErrorMessage } from '@/lib/public-install-types';
import { fetchInstallStatusServer } from '@/lib/install-status';

// Rendered per request so the install data — including the Quick Create link
// the control plane builds for this deployment's region — is always fresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Install your app · Deployz',
  // Unique private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// §44 install page: a vendor hands their customer this unique link. The
// customer needs NO Deployz account — they sign in to their OWN cloud account
// ("AWS auth happens at AWS"), and Deployz never sees or stores their
// credentials. Fetches the real §12/§44 data (application, publisher,
// customer, resources created); an unknown/invalid link gets an honest
// not-found state rather than fabricated content. Copy is §65 jargon-free
// at the top level; the Security Details page carries the technical truth.
export default async function InstallPage({
  params,
}: {
  params: Promise<{ installLinkId: string }>;
}) {
  const { installLinkId } = await params;

  // Public install links expose an app-level review/confirm flow. Try that
  // surface first; a 404 means this id is a per-deployment install link, so
  // fall through to the existing flow. A 410 means the public link is known
  // but unavailable and must show its own error copy.
  const publicLookup = await fetchPublicInstallData(installLinkId);
  if (publicLookup?.status === 'ok') {
    return <PublicInstallFlow linkId={installLinkId} resolve={publicLookup.data} />;
  }
  if (publicLookup?.status === 'gone') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          This application cannot be installed
        </h1>
        <Alert variant="destructive">
          <AlertTitle>Installation unavailable</AlertTitle>
          <AlertDescription>{publicInstallErrorMessage(publicLookup.code)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Fetched in parallel: the status projection is a nice-to-have for the
  // first paint (a failed fetch just costs one extra client round trip —
  // see fetchInstallStatusServer), so it never blocks or fails the page.
  const [lookup, initialStatus] = await Promise.all([
    fetchInstallData(installLinkId),
    fetchInstallStatusServer(installLinkId),
  ]);

  // Invitation lifecycle: an expired or revoked link gets its own honest
  // customer state instead of the generic invalid-link copy.
  if (lookup.status === 'unavailable') {
    const revoked = lookup.code === 'INSTALL_LINK_REVOKED';
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {revoked ? 'This installation link was revoked' : 'This installation link has expired'}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">{lookup.message}</p>
      </div>
    );
  }

  if (lookup.status === 'not_found') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn&apos;t valid</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This installation link doesn&apos;t match an active deployment. It may have been
          removed, or the link may be incorrect. Contact whoever sent you this link for a new
          one.
        </p>
      </div>
    );
  }

  const data = lookup.data;

  // The customer pressed "Deploy to AWS" and the control plane is waiting
  // for the relay to enroll. Never a failure: past the staleness window the
  // page shows guidance and a retry instead. The enrollment code is spent
  // only when a relay actually connects, so this state needs no "already
  // used" warning.
  if (data.waitingForRelay) {
    const cloudFormationUrl = cloudFormationStacksUrl(data.region);
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.publisherName} is setting up inside your AWS account
          </p>
        </div>

        {/* Live six-stage progress; `preinstall` refreshes this server-
            rendered layout the moment the relay enrolls and the stage moves
            past WAITING_FOR_AWS. */}
        <InstallProgress
          installLinkId={installLinkId}
          deploymentId={data.deploymentId}
          initialStatus={initialStatus}
          quickCreateUrl={data.quickCreateUrl}
          initialDomain={data.domain}
          routingTarget={data.routingTarget}
          preinstall
        />

        <section aria-labelledby="install-waiting" className="flex flex-col gap-3">
          {data.relayStuck ? (
            <>
              <h2 id="install-waiting" className="text-base font-semibold">
                Still connecting
              </h2>
              <div className="flex items-start gap-3">
                <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{RELAY_STUCK_GUIDANCE}</p>
              </div>
            </>
          ) : (
            <h2 id="install-waiting" className="sr-only">
              AWS setup details
            </h2>
          )}
          <p className="text-xs text-muted-foreground">
            Expected stack name:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {data.bootstrapStackName}
            </code>
          </p>
          <div className="flex flex-wrap items-start gap-2">
            {data.relayStuck ? <InstallRetryButton installLinkId={installLinkId} /> : null}
            <Button asChild variant="outline">
              <a href={cloudFormationUrl} target="_blank" rel="noreferrer">
                Open AWS CloudFormation
              </a>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <Link href={`/install/${encodeURIComponent(installLinkId)}/security`}>
                Security details
              </Link>
            </Button>
          </div>
        </section>

        <p className="text-xs text-muted-foreground">
          Installation reference:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{installLinkId}</code>
        </p>
      </div>
    );
  }

  // The enrollment code is single use. Once a relay has traded it, running the
  // setup again would fail at the point of no return — after the customer has
  // approved a stack in their own account — so say so before they start.
  if (data.alreadyInstalled) {
    const removed = data.deploymentState === 'DELETING' || data.deploymentState === 'DELETED';
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {removed ? 'This deployment was removed' : `Deployed by ${data.publisherName}`}
          </p>
        </div>

        {removed ? (
          <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
            <h2 id="deployment-access" className="text-base font-semibold">
              Deployment removed
            </h2>
            <p className="text-sm text-muted-foreground">
              This deployment no longer exists. Contact {data.publisherName} if you did not expect
              this.
            </p>
            {data.deploymentState === 'DELETED' && data.bootstrapStackName ? (
              // The connector stack was created by the customer's own Quick
              // Create, so Deployz cannot delete it for them (CANARY-014).
              <>
                <p className="text-sm text-muted-foreground">
                  One item remains: the Deployz connector stack{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {data.bootstrapStackName}
                  </code>{' '}
                  that you created in your AWS account. Delete that stack in CloudFormation to
                  finish. If you already deleted it, there is nothing else to do.
                </p>
                <div>
                  <Button asChild variant="outline">
                    <a
                      href={cloudFormationStacksUrl(data.region, data.bootstrapStackName ?? undefined)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open AWS CloudFormation
                    </a>
                  </Button>
                </div>
              </>
            ) : null}
          </section>
        ) : (
          // CONNECTING through READY, plus a terminal FAILED, all live here:
          // InstallProgress polls the server-derived stage and — once the
          // stage reaches VERIFYING/READY — also renders the Access section
          // and the custom-domain card itself, so this branch doesn't need
          // its own stage logic.
          <>
            <section aria-labelledby="install-summary" className="flex flex-col gap-3">
              <h2 id="install-summary" className="text-base font-semibold">
                Summary
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {data.releaseVersion ? (
                  <div>
                    <h3 className="text-xs font-medium uppercase text-muted-foreground">Release</h3>
                    <p className="mt-1 text-sm font-medium">Release {data.releaseVersion}</p>
                  </div>
                ) : null}
                {(() => {
                  const label = installPlanRegionLabel(data.region);
                  return label ? (
                    <div>
                      <h3 className="text-xs font-medium uppercase text-muted-foreground">Region</h3>
                      <p className="mt-1 text-sm font-medium">{label}</p>
                    </div>
                  ) : null;
                })()}
              </div>
              <TablePanel>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Component</TableHead>
                      <TableHead>What happens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {installPlanRows(data.plan).map((row) => (
                      <TableRow key={row.kind}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="text-muted-foreground">{row.whatHappens}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
              {(() => {
                const note = installPlanRetentionNote(data.plan);
                return note ? <p className="text-sm text-muted-foreground">{note}</p> : null;
              })()}
              <p className="text-sm font-medium text-foreground">
                PostgreSQL and stored files are retained when the application is disconnected. They
                can continue to generate AWS charges until they are permanently purged.
              </p>
            </section>

            <InstallProgress
              installLinkId={installLinkId}
              deploymentId={data.deploymentId}
              initialStatus={initialStatus}
              quickCreateUrl={data.quickCreateUrl}
              initialDomain={data.domain}
              routingTarget={data.routingTarget}
            />
          </>
        )}

        {/* Security Details stays reachable in every post-launch state —
            installing, ready, failed, and removed alike. */}
        <Button asChild variant="ghost" size="lg">
          <Link href={`/install/${encodeURIComponent(installLinkId)}/security`}>
            Security details
          </Link>
        </Button>

        <p className="text-xs text-muted-foreground">
          {/* The link is consumed as soon as the connector trades its
              enrollment code — long before the install finishes — so this
              says the link is spent without claiming the app is running. */}
          {`This setup link has been used. To install again, ask ${data.publisherName} for a new link.`}
        </p>
      </div>
    );
  }

  const retentionNote = installPlanRetentionNote(data.plan);
  const regionLabel = installPlanRegionLabel(data.region);
  const costRange = formatMonthlyRange(
    data.plan?.costEstimate?.monthlyMin ?? null,
    data.plan?.costEstimate?.monthlyMax ?? null,
  );
  const expiryLabel = data.installLinkExpiresAt
    ? new Date(data.installLinkExpiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Deploy {data.applicationName} to your AWS account
          </h1>
          <p className="text-sm text-muted-foreground">
            Requested by {data.publisherName} · Unlisted deployment link
          </p>
        </div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase text-muted-foreground">Application</dt>
            <dd className="mt-1 text-sm font-medium">{data.applicationName}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-muted-foreground">Publisher</dt>
            <dd className="mt-1 text-sm font-medium">{data.publisherName}</dd>
          </div>
          {regionLabel ? (
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">Region</dt>
              <dd className="mt-1 text-sm font-medium">{regionLabel}</dd>
            </div>
          ) : null}
          {data.releaseVersion ? (
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">Release</dt>
              <dd className="mt-1 text-sm font-medium">{data.releaseVersion}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs font-medium uppercase text-muted-foreground">
              Estimated monthly AWS cost
            </dt>
            <dd className="mt-1 text-sm font-medium">
              {costRange ?? 'Estimate unavailable'}
            </dd>
          </div>
          {expiryLabel ? (
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                Invitation expires
              </dt>
              <dd className="mt-1 text-sm font-medium">{expiryLabel}</dd>
            </div>
          ) : null}
        </dl>
        {retentionNote ? (
          <p className="text-sm text-muted-foreground" data-testid="install-retention-warning">
            {retentionNote} Retained resources keep accruing AWS charges until the publisher
            permanently purges them or you delete them.
          </p>
        ) : null}
      </header>

      <section aria-labelledby="infrastructure" className="flex flex-col gap-3">
        <h2 id="infrastructure" className="text-base font-semibold">
          What Deployz will create
        </h2>
        <InstallPlanTable plan={data.plan} regionLabel={regionLabel} />
        <p className="text-sm text-muted-foreground">
          Retained resources stay in your AWS account when the application is disconnected. Delete
          them from the AWS console, or ask {data.publisherName} to purge them, to stop their
          charges.
        </p>
        <FootprintCost estimate={data.plan?.costEstimate} />
      </section>

      <section aria-labelledby="what-happens-next" className="flex flex-col gap-3">
        <h2 id="what-happens-next" className="text-base font-semibold">
          What happens next
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
          <li>Review the setup in AWS.</li>
          <li>Approve creation of the Deployz connector.</li>
          <li>Deployz prepares the infrastructure, starts the application and verifies HTTPS.</li>
        </ol>
      </section>

      <section aria-labelledby="security-facts" className="flex flex-col gap-3">
        <h2 id="security-facts" className="text-base font-semibold">
          Your security and access
        </h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>Your AWS credentials stay in your AWS account — Deployz never sees or stores them.</li>
          <li>
            Your application data stays in your AWS account. Retained data survives a disconnect
            until the publisher purges it or you delete it.
          </li>
          <li>
            The Deployz connector only calls out to Deployz on a schedule. No inbound access to
            your account is required.
          </li>
        </ul>
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className="w-fit">
              Security and access details
              <ChevronDown aria-hidden className="ml-2 size-4" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-5 pt-4">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Access granted to Deployz</h3>
              <p className="text-sm text-muted-foreground">
                The Deployz connector can deploy application releases, check deployment status, run
                health checks, update the application, roll back the application version, and manage
                the resources Deployz created for this deployment.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Access boundaries</h3>
              <p className="text-sm text-muted-foreground">
                Deployz cannot read your AWS account credentials, cannot access AWS resources it did
                not create, cannot administer applications unrelated to Deployz, and cannot read your
                application data directly. Its permissions are scoped to the resources this
                deployment creates.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">How the Deployz connector works</h3>
              <p className="text-sm text-muted-foreground">
                The connector runs as an AWS Lambda function in your account and calls out to Deployz
                on a schedule to ask for work — Deployz never connects in. Its credential is stored in
                a Secrets Manager secret in your account. It performs install, update, rollback,
                restart, configuration and teardown work through your own AWS APIs. Only deployment
                status and metadata leave your account; application data and logs stay in your
                CloudWatch. The connector belongs to this deployment only and is created once during
                setup — a new deployment gets its own connector. It is removed when you delete its
                CloudFormation stack. If Deployz is temporarily offline, your application keeps running
                — the connector simply waits for the next check-in.
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href={`/install/${encodeURIComponent(installLinkId)}/security`}>
                Inspect the template and permissions
              </Link>
            </Button>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section aria-label="Install actions" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {data.quickCreateUrl ? (
            <InstallLaunchButton
              installLinkId={installLinkId}
              quickCreateUrl={data.quickCreateUrl}
            />
          ) : (
            <Button size="lg" disabled>
              Review setup in AWS
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          You&apos;ll review the CloudFormation setup in AWS before anything is created. No Deployz
          account is required.
        </p>
        <p className="text-xs text-muted-foreground">
          Requires an AWS identity that can create CloudFormation stacks and the resources listed
          above.
        </p>
        {!data.quickCreateUrl && (
          <p className="text-xs text-muted-foreground">
            {data.publisherName} hasn&apos;t published a setup template yet. Contact them for a
            working link.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Installation reference:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{installLinkId}</code>
        </p>
      </section>
    </div>
  );
}
