import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/dashboard-shell';
import { SupportModeBanner } from '@/components/support-mode-banner';
import { fetchMe } from '@/lib/me';

// Real authorization lives here: the middleware is only an optimistic gate,
// so every dashboard render re-validates the session against the API.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const me = await fetchMe();
  if (!me) {
    redirect('/sign-in');
  }
  // `me.organizations` is the ADMIN's own memberships, which is unrelated to
  // whether they have somewhere to look at right now: in a support session
  // `me.organization` is already the vendor's (docs/admin/team-admin.md), so
  // an admin with zero organizations of their own must still reach the
  // vendor's dashboard rather than being bounced to /organizations/new.
  if (me.organizations.length === 0 && me.supportMode === null) {
    redirect('/organizations/new');
  }
  return (
    <>
      {me.supportMode ? (
        <SupportModeBanner organizationName={me.supportMode.organizationName} />
      ) : null}
      <DashboardShell
        user={me.user}
        organizations={me.organizations}
        activeOrganizationId={me.organization?.id ?? null}
      >
        {children}
      </DashboardShell>
    </>
  );
}
