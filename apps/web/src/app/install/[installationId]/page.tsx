import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { buildBootstrapQuickCreateUrl, getInstallLinkConfig } from '@/lib/install-link';
import { fetchInstallData } from '@/lib/install-data';

// Rendered per request so DEPLOYZ_BOOTSTRAP_TEMPLATE_URL / DEPLOYZ_CONTROL_PLANE_URL
// overrides take effect without a rebuild, and so the install data is always
// fresh for this specific installation.
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
  params: Promise<{ installationId: string }>;
}) {
  const { installationId } = await params;
  const data = await fetchInstallData(installationId);

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

  const deployUrl = buildBootstrapQuickCreateUrl(getInstallLinkConfig());

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
