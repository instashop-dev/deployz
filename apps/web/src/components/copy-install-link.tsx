'use client';

import { toast } from 'sonner';

// Copying an install link is a pure read of the link a deployment already
// has: nothing is minted, rotated or revoked by copying it. Shared because
// the Customers list, the customer page and the create-deployment result all
// offer the same action and must give the same feedback.
export async function copyInstallLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Install link copied.');
  } catch {
    toast.error("We couldn't copy the link. Select it and copy it by hand.");
  }
}
