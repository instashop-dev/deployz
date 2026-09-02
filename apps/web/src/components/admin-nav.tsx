'use client';

import { Cable, Gauge, ScrollText, Ship, Users, Wrench } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

// Team Admin's own nav — separate from DashboardNav (dashboard-nav.tsx), same
// longest-prefix active-route matching so a detail route (e.g.
// /admin/deployments/:id) lights up its list item, never two at once.
const ITEMS = [
  { href: '/admin', label: 'Overview', icon: Gauge },
  { href: '/admin/vendors', label: 'Vendors', icon: Users },
  { href: '/admin/deployments', label: 'Deployments', icon: Ship },
  { href: '/admin/jobs', label: 'Jobs', icon: Wrench },
  { href: '/admin/connections', label: 'AWS Connections', icon: Cable },
  { href: '/admin/audit-log', label: 'Audit Log', icon: ScrollText },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  const activeHref = ITEMS.reduce<string | null>((best, item) => {
    const matches = item.href === '/admin' ? pathname === item.href : pathname.startsWith(item.href);
    if (!matches) return best;
    if (best === null || item.href.length > best.length) return item.href;
    return best;
  }, null);

  return (
    <nav aria-label="Team Admin" className="flex flex-col gap-2">
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {ITEMS.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={item.href === activeHref}>
                  <Link href={item.href} aria-current={item.href === activeHref ? 'page' : undefined}>
                    <item.icon aria-hidden />
                    {item.label}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </nav>
  );
}
