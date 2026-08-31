'use client';

import { Button } from '@/components/ui/button';
import { launchInstall } from '@/lib/install-data';

// The "Deploy to AWS" handoff. Reports the launch to the control plane
// (best-effort, never blocks) before sending the customer to their own AWS
// console, so the deployment can show an explicit waiting state.
export function InstallLaunchButton({
  installLinkId,
  quickCreateUrl,
}: {
  installLinkId: string;
  quickCreateUrl: string;
}) {
  return (
    <Button asChild size="lg">
      <a
        href={quickCreateUrl}
        onClick={(event) => {
          event.preventDefault();
          void launchInstall(installLinkId).then(() => {
            window.location.assign(quickCreateUrl);
          });
        }}
      >
        Deploy to AWS
      </a>
    </Button>
  );
}
