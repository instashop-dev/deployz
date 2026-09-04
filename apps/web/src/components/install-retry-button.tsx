'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { DeployLinkToken } from '@/lib/deploy-link-flow';
import { retryDeployLinkAttempt } from '@/lib/deploy-link-flow';
import { InstallRetryError, retryInstallAttempt } from '@/lib/install-data';

// Customer-facing retry for an install that never connected: starts a fresh
// attempt (new enrollment code, new stack name) and refreshes the page so it
// re-renders the pre-install state with the new Quick Create link.
export function InstallRetryButton({
  installLinkId,
  deployLink = null,
}: {
  installLinkId: string;
  /** Set on the /deploy page: the retry resolves through the deploy link
   *  (token header) instead of the install link. */
  deployLink?: DeployLinkToken | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRetry(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      if (deployLink) {
        await retryDeployLinkAttempt(deployLink.publicId, deployLink.token);
      } else {
        await retryInstallAttempt(installLinkId);
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof InstallRetryError && caught.status === 409
          ? 'This deployment was already installed. Contact the vendor for help.'
          : "We couldn't start the retry. Try again in a moment.",
      );
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" disabled={pending} onClick={() => void onRetry()}>
        {pending ? 'Retrying…' : 'Retry deployment'}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
