import type { Metadata } from 'next';

import { DeployLinkInvalidState } from '@/components/deploy-link-invalid-state';
import { SecurityDetailsContent } from '@/components/security-details-content';
import { fetchDeployLinkData } from '@/lib/deploy-link-flow';

// Rendered per request so the resolve is always fresh — same rule as the
// /deploy page this hangs off.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Security details · Deployz',
  // Tokenized private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// The Security Details sub-page of the tokenized deploy link: the same trust
// story the install link serves, resolved through the same
// x-deployz-token-header flow and failing closed exactly like /deploy. The
// token is never rendered in page content — it only travels back to the
// customer through the back link's query string, the convention the /deploy
// page itself already uses.
export default async function DeploySecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { publicId } = await params;
  const { token } = await searchParams;

  if (!token) {
    return <DeployLinkInvalidState reason="invalid" />;
  }

  const result = await fetchDeployLinkData(publicId, token);

  if (!result.ok) {
    return <DeployLinkInvalidState reason={result.reason} />;
  }

  return (
    <SecurityDetailsContent
      plan={result.data.plan}
      backHref={`/deploy/${encodeURIComponent(publicId)}?token=${encodeURIComponent(token)}`}
      backLabel="Back to deployment"
    />
  );
}
