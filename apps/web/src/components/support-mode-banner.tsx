'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { endSupportSession } from '@/lib/admin';
import { errorMessage } from '@/lib/api-client';

// Persistent "View as Vendor" indicator (docs/admin/team-admin.md's View as
// Vendor security model) — full-width and token-based (bg-primary), never a
// subtle muted bar, so an admin can never mistake a support session for their
// own dashboard. Exiting hard-navigates to /admin: every server component in
// the tree (organization, role, nav) must re-render against the cleared
// session, which a client-side route change would not guarantee.
export function SupportModeBanner({ organizationName }: { organizationName: string }) {
  const [pending, setPending] = useState(false);

  async function onExit(): Promise<void> {
    setPending(true);
    try {
      await endSupportSession();
      window.location.href = '/admin';
    } catch (caught) {
      toast.error(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <div
      data-testid="support-mode-banner"
      className="flex w-full flex-wrap items-center justify-center gap-3 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
    >
      <span>
        Viewing as {organizationName} — Admin support mode
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => void onExit()}
        data-testid="support-banner-exit"
      >
        {pending ? 'Exiting…' : 'Exit support mode'}
      </Button>
    </div>
  );
}
