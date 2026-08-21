import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { buildBootstrapQuickCreateUrl, getInstallLinkConfig } from '@/lib/install-link';

// Rendered per request so DEPLOYZ_BOOTSTRAP_TEMPLATE_URL / DEPLOYZ_CONTROL_PLANE_URL
// overrides take effect without a rebuild (the todo-14 harness points the CTA
// at the real published template). No backend is required — fixture defaults
// keep the page fully self-contained.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Install your app · Deployz',
  // Unique private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// §44 install page: a vendor hands their customer this unique link. The
// customer needs NO Deployz account — they sign in to their OWN cloud account
// ("AWS auth happens at AWS"), and Deployz never sees or stores their
// credentials. Copy is §65 jargon-free: no raw service names at the top
// level; the Security Details page carries the technical truth.
export default async function InstallPage({
  params,
}: {
  params: Promise<{ installationId: string }>;
}) {
  const { installationId } = await params;
  const deployUrl = buildBootstrapQuickCreateUrl(getInstallLinkConfig());

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Install your app</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;ve been given a private setup link. Three steps, about five minutes — and you
          sign in only with your own cloud provider.
        </p>
      </div>

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
              anchor, not a Next Link. */}
          <Button asChild size="lg">
            <a href={deployUrl}>Deploy to AWS</a>
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link href={`/install/${encodeURIComponent(installationId)}/security`}>
              Security details
            </Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Installation reference:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{installationId}</code>
        </p>
      </section>
    </div>
  );
}
