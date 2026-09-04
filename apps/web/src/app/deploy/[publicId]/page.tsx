import type { Metadata } from 'next';
import { Loader2 } from 'lucide-react';

import { InstallLaunchButton } from '@/components/install-launch-button';
import { InstallProgress } from '@/components/install-progress';
import { InstallRetryButton } from '@/components/install-retry-button';
import { Button } from '@/components/ui/button';
import { RELAY_STUCK_GUIDANCE } from '@/lib/deployment-vocabulary';
import {
  fetchDeployLinkData,
  fetchDeployLinkStatusServer,
} from '@/lib/deploy-link-flow';

// Rendered per request so the resolve — including the Quick Create link the
// control plane builds for this deployment's region — is always fresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Deploy to AWS · Deployz',
  // Tokenized private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// The hosted customer deploy page: a vendor sends their customer a Deploy
// Link, the customer opens it here, connects their own AWS account through
// the SAME flow as the install page, and watches the deployment come up. The
// token in the URL is the only credential — it authorizes exactly this one
// deployment flow and never becomes a session. Reuse rule: the review, AWS
// connection, progress, domain and retry experiences are the install page's,
// with resolve/launch/retry/status calls re-keyed to the deploy link.

const INVALID_COPY: Record<string, { title: string; body: string }> = {
  invalid: {
    title: "This deployment link isn't valid",
    body: 'It may have been revoked, replaced, or entered incorrectly. Please request a new link from the software provider.',
  },
  revoked: {
    title: 'This deployment link is no longer valid',
    body: 'The software provider revoked this link. Please request a new link to deploy.',
  },
  expired: {
    title: 'This deployment link has expired',
    body: 'Please request a new link from the software provider.',
  },
  unavailable: {
    title: 'We couldn\u2019t load this deployment',
    body: 'Try again in a moment. If it keeps failing, contact the software provider.',
  },
};

function InvalidState({ reason }: { reason: string }) {
  const copy = INVALID_COPY[reason] ?? INVALID_COPY.invalid!;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{copy.body}</p>
      <PoweredBy />
    </div>
  );
}

function PoweredBy() {
  return <p className="text-xs text-muted-foreground">Powered by Deployz</p>;
}

export default async function DeployPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { publicId } = await params;
  const { token } = await searchParams;

  if (!token) {
    return <InvalidState reason="invalid" />;
  }

  // Fetched in parallel: the status projection is a nice-to-have for the
  // first paint (a failed fetch just costs one extra client round trip), so
  // it never blocks or fails the page.
  const [result, initialStatus] = await Promise.all([
    fetchDeployLinkData(publicId, token),
    fetchDeployLinkStatusServer(publicId, token),
  ]);

  if (!result.ok) {
    return <InvalidState reason={result.reason} />;
  }
  const data = result.data;
  const deployLink = { publicId, token };

  // The customer pressed "Deploy to AWS" and the control plane is waiting
  // for the relay to enroll. Never a failure: past the staleness window the
  // page shows guidance and a retry instead.
  if (data.waitingForRelay) {
    const cloudFormationUrl = `https://${data.region}.console.aws.amazon.com/cloudformation/home?region=${data.region}#/stacks`;
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.application.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This application is setting up inside your AWS account
          </p>
        </div>

        <InstallProgress
          installLinkId={publicId}
          deploymentId=""
          initialStatus={initialStatus}
          quickCreateUrl={data.quickCreateUrl}
          initialDomain={data.domain}
          routingTarget={data.routingTarget}
          preinstall
          deployLink={deployLink}
        />

        <section aria-labelledby="deploy-waiting" className="flex flex-col gap-3">
          {data.relayStuck ? (
            <>
              <h2 id="deploy-waiting" className="text-base font-semibold">
                Still connecting
              </h2>
              <div className="flex items-start gap-3">
                <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{RELAY_STUCK_GUIDANCE}</p>
              </div>
            </>
          ) : (
            <h2 id="deploy-waiting" className="sr-only">
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
            {data.relayStuck ? <InstallRetryButton installLinkId={publicId} deployLink={deployLink} /> : null}
            <Button asChild variant="outline">
              <a href={cloudFormationUrl} target="_blank" rel="noreferrer">
                Open AWS CloudFormation
              </a>
            </Button>
          </div>
        </section>

        <PoweredBy />
      </div>
    );
  }

  // Not launched yet: the minimal review. The customer sees what will run
  // and where, then hands off to their own AWS console. Double submits
  // cannot create duplicates — the deployment already exists; this only
  // flips it into its waiting state, and reopening the link resumes it.
  if (data.deploymentState === 'NOT_INSTALLED') {
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.application.name}</h1>
          <p className="mt-2 text-sm font-medium">Deploy privately to your AWS</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            This application will run inside an AWS account you control. You sign in only
            with your own AWS account — Deployz never sees your credentials.
          </p>
        </div>

        <section aria-labelledby="deploy-review" className="flex flex-col gap-3">
          <h2 id="deploy-review" className="text-base font-semibold">
            Deployment review
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">Application</dt>
              <dd>{data.application.name}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">AWS region</dt>
              <dd>{data.region}</dd>
            </div>
          </dl>
          <div>
            <h3 className="text-sm font-medium">Deployz will create</h3>
            <ul className="mt-1.5 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
              {data.resources.map((resource) => (
                <li key={resource}>{resource}</li>
              ))}
            </ul>
          </div>
          <p className="text-sm font-medium text-foreground">Your data stays in your AWS account.</p>
        </section>

        <section aria-label="Deploy actions" className="flex flex-col gap-3">
          {data.quickCreateUrl ? (
            <InstallLaunchButton
              installLinkId={publicId}
              quickCreateUrl={data.quickCreateUrl}
              deployLink={deployLink}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <Button size="lg" disabled>
                Deploy to AWS
              </Button>
              <p className="text-xs text-muted-foreground">
                The setup template isn&apos;t published for this region yet. Please request a
                new link from the software provider.
              </p>
            </div>
          )}
        </section>

        {/* Starts at WAITING_FOR_AWS — small and unobtrusive under the CTA
            above. Polling picks up relay registration on its own. */}
        <InstallProgress
          installLinkId={publicId}
          deploymentId=""
          initialStatus={initialStatus}
          quickCreateUrl={data.quickCreateUrl}
          initialDomain={data.domain}
          routingTarget={data.routingTarget}
          preinstall
          deployLink={deployLink}
        />

        <PoweredBy />
      </div>
    );
  }

  // Launched and past the waiting state: CONNECTING through READY, plus a
  // terminal FAILED, all live in the same progress view the install page
  // uses. The link stays usable to resume — reopening it lands here.
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.application.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This application runs inside your AWS account
        </p>
      </div>

      <InstallProgress
        installLinkId={publicId}
        deploymentId=""
        initialStatus={initialStatus}
        quickCreateUrl={data.quickCreateUrl}
        initialDomain={data.domain}
        routingTarget={data.routingTarget}
        deployLink={deployLink}
      />

      <PoweredBy />
    </div>
  );
}
