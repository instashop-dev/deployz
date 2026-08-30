'use client';

import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { OrganizationSummary } from '@/lib/organization-vocabulary';

interface DashboardShellProps {
  user: { name: string; email: string };
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  children: ReactNode;
}

// App shell on the shadcn Sidebar architecture: AppSidebar (brand, org
// switcher, navigation) plus a SiteHeader carrying the sidebar trigger and the
// user menu. Session data arrives as props from the server layout, which
// re-validates it against the API on every render. Pages get their padding
// and base spacing from the single <main> here, not from each page.
export function DashboardShell({
  user,
  organizations,
  activeOrganizationId,
  children,
}: DashboardShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar organizations={organizations} activeOrganizationId={activeOrganizationId} />
      <SidebarInset>
        <SiteHeader user={user} />
        <main className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6 md:pb-16 lg:p-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
