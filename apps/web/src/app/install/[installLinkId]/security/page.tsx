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
  const lookup = await fetchInstallData(installLinkId);

  if (lookup.status !== 'ok') {
    const heading =
      lookup.status === 'unavailable' && lookup.code === 'INSTALL_LINK_EXPIRED'
        ? 'This installation link has expired'
        : lookup.status === 'unavailable' && lookup.code === 'INSTALL_LINK_REVOKED'
          ? 'This installation link was revoked'
          : "This link isn't valid";
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {lookup.status === 'unavailable'
            ? lookup.message
            : "This installation link doesn't match an active deployment. Contact whoever sent you this link for a new one."}
        </p>
      </div>
    );
  }

  return (
    <SecurityDetailsContent
      plan={lookup.data.plan}
      backHref={`/install/${encodeURIComponent(installLinkId)}`}
    />
  );
}
