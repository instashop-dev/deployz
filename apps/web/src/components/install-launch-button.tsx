'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
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
}: {
  installLinkId: string;
  quickCreateUrl: string;
}) {
  const router = useRouter();
  return (
    <Button asChild size="lg">
      <a
        href={quickCreateUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          void launchInstall(installLinkId).then(() => {
            router.refresh();
          });
        }}
      >
        Deploy to AWS
      </a>
    </Button>
  );
}
