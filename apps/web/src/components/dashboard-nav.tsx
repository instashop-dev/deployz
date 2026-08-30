'use client';

import { AppWindow, CreditCard, Home, Settings, Ship, Users, Users2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

// Deployments is the primary operational object, so it leads the main group
// right after Home; Team/Billing/Settings are management concerns and sit in
// their own labeled group.
const MAIN_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/deployments', label: 'Deployments', icon: Ship },
  { href: '/dashboard/applications', label: 'Applications', icon: AppWindow },
  { href: '/dashboard/customers', label: 'Customers', icon: Users },
] as const;

const MANAGEMENT_ITEMS = [
  { href: '/dashboard/settings/members', label: 'Team', icon: Users2 },
  { href: '/dashboard/settings/billing', label: 'Billing', icon: CreditCard },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
] as const;

const ITEMS = [...MAIN_ITEMS, ...MANAGEMENT_ITEMS];

export function DashboardNav() {
  const pathname = usePathname();
  // Pick the single longest matching href so nested routes (e.g. Team
  // under /dashboard/settings/members) never light up their parent (Settings)
  // at the same time.
  const activeHref = ITEMS.reduce<string | null>((best, item) => {
    const matches =
      item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href);
    if (!matches) return best;
    if (best === null || item.href.length > best.length) return item.href;
    return best;
  }, null);

  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-2">
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {MAIN_ITEMS.map((item) => (
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
      <SidebarGroup>
        <SidebarGroupLabel>Management</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {MANAGEMENT_ITEMS.map((item) => (
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
