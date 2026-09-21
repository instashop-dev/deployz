'use client';

import Link from 'next/link';

import { DashboardNav } from '@/components/dashboard-nav';
import { DeployzBrand } from '@/components/deployz-brand';
import { OrgSwitcher } from '@/components/org-switcher';
import { SidebarUserMenu } from '@/components/user-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import type { OrganizationSummary } from '@/lib/organization-vocabulary';

// The application sidebar: brand and sidebar trigger in the header, the
// organization selector and grouped navigation in the content, and the
// account menu in the footer.
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
        <div className="flex items-center px-2 py-2 group-data-[collapsible=icon]:flex-col">
          <Link href="/dashboard" aria-label="Deployz" className="inline-flex">
            <DeployzBrand size="sm" />
          </Link>
          <SidebarTrigger
            aria-label="Toggle sidebar"
            className="ml-auto group-data-[collapsible=icon]:ml-0"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pb-0 group-data-[collapsible=icon]:hidden">
          <OrgSwitcher
            organizations={organizations}
            activeOrganizationId={activeOrganizationId}
          />
        </SidebarGroup>
        <DashboardNav />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUserMenu name={user.name} email={user.email} />
      </SidebarFooter>
    </Sidebar>
  );
}
