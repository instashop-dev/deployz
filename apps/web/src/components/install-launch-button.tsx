'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { DeployLinkToken } from '@/lib/deploy-link-flow';
import { launchDeployLink } from '@/lib/deploy-link-flow';
import { launchInstall } from '@/lib/install-data';

// The "Deploy to AWS" handoff. Reports the launch to the control plane
// (best-effort, never blocks) before sending the customer to their own AWS
// console. The console opens in a NEW tab and this page refreshes into its
// WAITING_FOR_RELAY view behind it — the whole point of the launch signal is
// that live progress appears here the moment it exists, which a same-tab
// navigation would hide.
export function InstallLaunchButton({
  installLinkId,
  quickCreateUrl,
  deployLink = null,
}: {
  installLinkId: string;
  quickCreateUrl: string;
  /** Set on the /deploy page: the launch signal resolves through the deploy
   *  link (token header) instead of the install link. */
  deployLink?: DeployLinkToken | null;
}) {
  const router = useRouter();
  return (
    <Button asChild size="lg">
      <a
        href={quickCreateUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          const launched = deployLink
            ? launchDeployLink(deployLink.publicId, deployLink.token)
            : launchInstall(installLinkId);
          void launched.then(() => {
            router.refresh();
          });
        }}
      >
        Deploy to AWS
      </a>
    </Button>
  );
}
