import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/dashboard-shell';
import { fetchMe } from '@/lib/me';

// Real authorization lives here: the middleware is only an optimistic gate,
// so every dashboard render re-validates the session against the API.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const me = await fetchMe();
  if (!me) {
    redirect('/sign-in');
  }
  if (me.organizations.length === 0) {
    redirect('/organizations/new');
  }
  return (
    <DashboardShell
      user={me.user}
      organizations={me.organizations}
      activeOrganizationId={me.organization?.id ?? null}
    >
      {children}
    </DashboardShell>
  );
}
