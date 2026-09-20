'use client';

import Link from 'next/link';

import { DashboardNav } from '@/components/dashboard-nav';
import { OrgSwitcher } from '@/components/org-switcher';
import { SidebarUserMenu } from '@/components/user-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import type { OrganizationSummary } from '@/lib/organization-vocabulary';

// The application sidebar: brand and sidebar trigger in the header, the
// grouped navigation in the content, and the account menu in the footer.
// Mobile and collapsible behavior come from the shadcn Sidebar primitives —
// there is no parallel custom nav.
export function AppSidebar({
  user,
  organizations,
  activeOrganizationId,
}: {
  user: { name: string; email: string };
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex flex-col gap-1 px-2 py-2">
          <div className="flex items-center">
            <Link
              href="/dashboard"
              className="font-heading text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden"
            >
              Deployz
            </Link>
            <SidebarTrigger
              aria-label="Toggle sidebar"
              className="ml-auto group-data-[collapsible=icon]:mx-auto"
            />
          </div>
          <OrgSwitcher
            organizations={organizations}
            activeOrganizationId={activeOrganizationId}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <DashboardNav />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUserMenu name={user.name} email={user.email} />
      </SidebarFooter>
    </Sidebar>
  );
}
