import type { Metadata } from 'next';

import { SecurityDetailsContent } from '@/components/security-details-content';
import { fetchInstallData } from '@/lib/install-data';

export const metadata: Metadata = {
  title: 'Security details · Deployz',
  robots: { index: false, follow: false },
};

export default async function SecurityDetailsPage({
  params,
}: {
  params: Promise<{ installLinkId: string }>;
}) {
  const { installLinkId } = await params;
  // Resolve the link first: this page used to render the full security story
  // for any id at all, including ones the parent route had already told the
  // reader were invalid.
  const data = await fetchInstallData(installLinkId);

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn&apos;t valid</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This installation link doesn&apos;t match an active deployment. Contact whoever sent you
          this link for a new one.
        </p>
      </div>
    );
  }

  return (
    <SecurityDetailsContent
      plan={data.plan}
      backHref={`/install/${encodeURIComponent(installLinkId)}`}
    />
  );
}
