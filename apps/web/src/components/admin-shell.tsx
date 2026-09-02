'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AdminHeader } from '@/components/admin-header';
import { AdminNav } from '@/components/admin-nav';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';

interface AdminShellProps {
  user: { name: string; email: string };
  children: ReactNode;
}

// Team Admin's own shell — the same SidebarProvider > Sidebar + SidebarInset
// architecture as DashboardShell (dashboard-shell.tsx), branded separately so
// the two areas are never visually confused, with a "Back to dashboard" exit
// in the sidebar footer. Screen padding/base spacing come from this single
// <main>, matching docs/ui-system.md — admin pages never add their own.
export function AdminShell({ user, children }: AdminShellProps) {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex flex-col gap-1 px-2 py-2">
            <Link href="/admin" className="font-heading text-base font-semibold tracking-tight">
              Deployz · Team Admin
            </Link>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <AdminNav />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard">
                  <ArrowLeft aria-hidden />
                  Back to dashboard
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <AdminHeader user={user} />
        <main className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6 md:pb-16 lg:p-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
