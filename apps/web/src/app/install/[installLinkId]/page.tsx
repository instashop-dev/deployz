import type { Metadata } from 'next';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { InstallLaunchButton } from '@/components/install-launch-button';
import { InstallProgress } from '@/components/install-progress';
import { InstallRetryButton } from '@/components/install-retry-button';
import { PublicInstallFlow } from '@/components/public-install-flow';
import { TablePanel } from '@/components/table-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RELAY_STUCK_GUIDANCE } from '@/lib/deployment-vocabulary';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import { fetchInstallData } from '@/lib/install-data';
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

const CAN_DO = [
  'Deploy application releases',
  'Check deployment status',
  'Perform health checks',
  'Update the application',
  'Roll back the application version',
  'Manage the resources Deployz created',
] as const;

const CANNOT_DO = [
  "Access AWS resources outside what it created",
  'Access your AWS account credentials',
  'Administer applications unrelated to Deployz',
  'Access your application data directly',
  'Modify infrastructure outside the Deployz stack',
] as const;

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
  const [data, initialStatus] = await Promise.all([
    fetchInstallData(installLinkId),
    fetchInstallStatusServer(installLinkId),
  ]);

  if (!data) {
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

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.publisherName} wants to deploy inside your AWS account
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;ve been given a private setup link. Three steps, about five minutes — and you
          sign in only with your own cloud provider.
        </p>
      </div>

      <section aria-labelledby="app-details" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <h2 id="app-details" className="text-xs font-medium uppercase text-muted-foreground">
            Application
          </h2>
          <p className="mt-1 text-sm font-medium">{data.applicationName}</p>
        </div>
        <div>
          <h2 className="text-xs font-medium uppercase text-muted-foreground">Publisher</h2>
          <p className="mt-1 text-sm font-medium">{data.publisherName}</p>
        </div>
      </section>

      <section aria-labelledby="will-create" className="flex flex-col gap-3">
        <h2 id="will-create" className="text-base font-semibold">
          Deployz will create
        </h2>
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
        <AwsInfrastructureDetails plan={data.plan} region={data.region} />
        {regionLabel ? (
          <p className="text-sm text-muted-foreground">Region: {regionLabel}</p>
        ) : null}
        {retentionNote ? <p className="text-sm text-muted-foreground">{retentionNote}</p> : null}
        <p className="text-sm font-medium text-foreground">
          Your data stays in your AWS account.
        </p>
      </section>

      <section aria-labelledby="can-do" className="flex flex-col gap-3">
        <h2 id="can-do" className="text-base font-semibold">
          What Deployz can do
        </h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {CAN_DO.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="cannot-do" className="flex flex-col gap-3">
        <h2 id="cannot-do" className="text-base font-semibold">
          What Deployz cannot do
        </h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {CANNOT_DO.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="what-happens" className="flex flex-col gap-3">
        <h2 id="what-happens" className="text-base font-semibold">
          What will happen
        </h2>
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-muted-foreground">
          <li>
            Select <strong className="font-medium text-foreground">Deploy to AWS</strong> below.
            You&apos;ll leave this page and land on a setup screen inside your own AWS account.
          </li>
          <li>
            <strong className="font-medium text-foreground">AWS auth happens at AWS.</strong> You
            sign in to your own AWS account — Deployz never sees, asks for, or stores your AWS
            credentials.
          </li>
          <li>
            Review what will be created, then confirm. AWS shows you the full list before anything
            happens, and you can cancel at any point.
          </li>
        </ol>
      </section>

      <section aria-labelledby="what-is-relay" className="flex flex-col gap-3">
        <h2 id="what-is-relay" className="text-base font-semibold">
          What is the &ldquo;relay&rdquo;?
        </h2>
        <p className="text-sm text-muted-foreground">
          A relay is a small helper that runs in your cloud account and keeps us in sync. It calls
          out to Deployz on a schedule to ask for work — Deployz never calls in. That&apos;s how
          your app gets installed and kept up to date without you handing anyone your account
          keys.
        </p>
      </section>

      <section aria-label="Install actions" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* External handoff to the customer's own AWS console — a plain
              anchor, not a Next Link. Opens in a new tab so this page stays
              open behind it: it's what starts showing live deployment
              progress once AWS hands off to the relay. Disabled rather than
              broken when the publisher has not published a bootstrap
              template yet: a link to a template AWS cannot fetch fails
              inside the customer's console with nothing to act on. */}
          {data.quickCreateUrl ? (
            <InstallLaunchButton
              installLinkId={installLinkId}
              quickCreateUrl={data.quickCreateUrl}
            />
          ) : (
            <Button size="lg" disabled>
              Deploy to AWS
            </Button>
          )}
          <Button asChild variant="ghost" size="lg">
            <Link href={`/install/${encodeURIComponent(installLinkId)}/security`}>
              Security details
            </Link>
          </Button>
        </div>
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

      {/* Starts at WAITING_FOR_AWS — small and unobtrusive under the CTA
          above. Polling picks up relay registration on its own, so if the
          customer stays on this page through the whole install, the same
          card grows into the full progress view without a reload. */}
      <InstallProgress
        installLinkId={installLinkId}
        deploymentId={data.deploymentId}
        initialStatus={initialStatus}
        quickCreateUrl={data.quickCreateUrl}
        initialDomain={data.domain}
        routingTarget={data.routingTarget}
        preinstall
        awaitingLaunch
      />
    </div>
  );
}
