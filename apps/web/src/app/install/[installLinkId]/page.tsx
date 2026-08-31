import type { Metadata } from 'next';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { CustomDomainCard } from '@/components/custom-domain-card';
import { InstallLaunchButton } from '@/components/install-launch-button';
import { InstallRetryButton } from '@/components/install-retry-button';
import { Button } from '@/components/ui/button';
import {
  COMPONENT_STATE_DOT,
  COMPONENT_STATE_LABEL,
  INSTALL_COMPONENT_LABELS,
  RELAY_STUCK_GUIDANCE,
  type ComponentState,
} from '@/lib/deployment-vocabulary';
import { fetchInstallData } from '@/lib/install-data';

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
  const data = await fetchInstallData(installLinkId);

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
    const cloudFormationUrl = `https://${data.region}.console.aws.amazon.com/cloudformation/home?region=${data.region}#/stacks`;
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.publisherName} is setting up inside your AWS account
          </p>
        </div>

        <section aria-labelledby="install-waiting" className="flex flex-col gap-3">
          <h2 id="install-waiting" className="text-base font-semibold">
            {data.relayStuck ? 'Still connecting' : 'Connecting to your AWS account'}
          </h2>
          <div className="flex items-start gap-3">
            <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {data.relayStuck ? RELAY_STUCK_GUIDANCE : 'Deployz is connecting to your AWS account…'}
            </p>
          </div>
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
    const primaryUrl = data.domain?.status === 'active' ? data.domain.url : null;
    const failed = data.deploymentState === 'FAILED';
    const removed = data.deploymentState === 'DELETING' || data.deploymentState === 'DELETED';
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {failed
              ? 'Installation failed'
              : removed
                ? 'This deployment was removed'
                : `Running in your cloud account · deployed by ${data.publisherName}`}
          </p>
        </div>

        {failed ? (
          <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
            <h2 id="deployment-access" className="text-base font-semibold">
              Installation failed
            </h2>
            <p className="text-sm text-muted-foreground">
              The installation did not finish. {data.publisherName} has been notified. Contact{' '}
              {data.publisherName} for help.
            </p>
          </section>
        ) : removed ? (
          <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
            <h2 id="deployment-access" className="text-base font-semibold">
              Deployment removed
            </h2>
            <p className="text-sm text-muted-foreground">
              This deployment no longer exists. Contact {data.publisherName} if you did not expect
              this.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
              <h2 id="deployment-access" className="text-base font-semibold">
                Access
              </h2>
              {primaryUrl ? (
                <p className="text-sm">
                  Your deployment is available at{' '}
                  <a className="font-medium underline underline-offset-4" href={primaryUrl}>
                    {primaryUrl}
                  </a>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {data.routingTarget
                    ? 'Set up a custom domain below to give this deployment a permanent address.'
                    : 'This deployment does not have a public address configured yet.'}
                </p>
              )}
              {data.routingTarget ? (
                <p className="text-xs text-muted-foreground">
                  Deployment endpoint:{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {data.routingTarget}
                  </code>
                </p>
              ) : null}
            </section>

            {data.components ? (
              <section aria-labelledby="component-status" className="flex flex-col gap-3">
                <h2 id="component-status" className="text-base font-semibold">
                  Status
                </h2>
                <ul className="flex flex-col gap-2">
                  {INSTALL_COMPONENT_LABELS.filter(
                    ([key]) => data.components?.[key] !== undefined,
                  ).map(([key, label]) => {
                    const status = data.components![key]!;
                    return (
                      <li
                        key={key}
                        className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                      >
                        <span
                          aria-hidden
                          className={`size-2 shrink-0 rounded-full ${COMPONENT_STATE_DOT[status as ComponentState]}`}
                        />
                        <span className="text-sm font-medium">{label}</span>
                        <span className="ml-auto text-sm text-muted-foreground">
                          {COMPONENT_STATE_LABEL[status as ComponentState] ?? status}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <CustomDomainCard
              deploymentId={data.deploymentId}
              installLinkId={installLinkId}
              initialDomain={data.domain}
            />
          </>
        )}

        <p className="text-xs text-muted-foreground">
          {failed
            ? `This setup link has been used. To try again, ask ${data.publisherName} for a new link.`
            : removed
              ? `This setup link has been used. To install again, ask ${data.publisherName} for a new link.`
              : `This setup link has been used — ${data.applicationName} is already installed. To install again, ask ${data.publisherName} for a new link.`}
        </p>
      </div>
    );
  }

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
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {data.resourcesCreated.map((resource) => (
            <li key={resource}>{resource}</li>
          ))}
        </ul>
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
              anchor, not a Next Link. Disabled rather than broken when the
              publisher has not published a bootstrap template yet: a link to
              a template AWS cannot fetch fails inside the customer's console
              with nothing to act on. */}
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
    </div>
  );
}
