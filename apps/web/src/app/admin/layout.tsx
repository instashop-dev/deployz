import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AdminShell } from '@/components/admin-shell';
import { fetchMe } from '@/lib/me';

// Authoritative Team Admin guard (docs/admin/team-admin.md): middleware.ts is
// only an optimistic session-cookie check, so every /admin render re-checks
// isTeamAdmin against the API here. Navigation visibility is never the
// security boundary — the API's requireTeamAdmin preHandler enforces this
// independently on every /api/admin/* call.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await fetchMe();
  if (!me) {
    redirect('/sign-in');
  }
  if (!me.isTeamAdmin) {
    redirect('/dashboard');
  }
  return <AdminShell user={me.user}>{children}</AdminShell>;
}
