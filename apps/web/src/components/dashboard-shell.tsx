'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { DashboardNav } from '@/components/dashboard-nav';
import { OrgSwitcher } from '@/components/org-switcher';
import { UserMenu } from '@/components/user-menu';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { OrganizationSummary } from '@/lib/organization-vocabulary';

interface DashboardShellProps {
  user: { name: string; email: string };
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  children: ReactNode;
}

// App shell: sidebar navigation (static on desktop, slide-over on mobile)
// plus a top bar carrying the user menu. Session data arrives as props from
// the server layout, which re-validates it against the API on every render.
export function DashboardShell({
  user,
  organizations,
  activeOrganizationId,
  children,
}: DashboardShellProps) {
  const [navOpen, setNavOpen] = useState(false);

  const sidebarContent = (
    <div className="flex h-full flex-col gap-3 py-4">
      <div className="px-4">
        <Link
          href="/dashboard"
          className="font-heading text-lg font-semibold tracking-tight"
          onClick={() => setNavOpen(false)}
        >
          Deployz
        </Link>
      </div>
      <OrgSwitcher organizations={organizations} activeOrganizationId={activeOrganizationId} />
      <Separator />
      {/* Close the mobile slide-over after any navigation. */}
      <div onClick={() => setNavOpen(false)}>
        <DashboardNav />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar lg:block">{sidebarContent}</aside>

      {navOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-sidebar shadow-lg">
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setNavOpen(false)}
                aria-label="Close navigation"
              >
                <X aria-hidden />
              </Button>
            </div>
            {sidebarContent}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu aria-hidden />
          </Button>
          <div className="flex-1" />
          <UserMenu name={user.name} email={user.email} />
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
