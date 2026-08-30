'use client';

import Link from 'next/link';

import { DashboardNav } from '@/components/dashboard-nav';
import { OrgSwitcher } from '@/components/org-switcher';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '@/components/ui/sidebar';
import type { OrganizationSummary } from '@/lib/organization-vocabulary';

// The application sidebar: brand + organization switcher in the header, the
// grouped navigation in the content. Mobile and collapsible behavior come
// from the shadcn Sidebar primitives — there is no parallel custom nav.
export function AppSidebar({
  organizations,
  activeOrganizationId,
}: {
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
}) {
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex flex-col gap-1 px-2 py-2">
          <Link
            href="/dashboard"
            className="font-heading text-base font-semibold tracking-tight"
          >
            Deployz
          </Link>
          <OrgSwitcher
            organizations={organizations}
            activeOrganizationId={activeOrganizationId}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <DashboardNav />
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}
