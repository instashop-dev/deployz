'use client';

import { AppWindow, Settings, Ship, Tag, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const items = [
  { href: '/dashboard', label: 'Deployments', icon: Ship },
  { href: '/dashboard/applications', label: 'Applications', icon: AppWindow },
  { href: '/dashboard/applications', label: 'Releases', icon: Tag },
  { href: '/dashboard/customers', label: 'Customers', icon: Users },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-1 px-3">
      {items.map((item) => {
        const active =
          item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              active && 'bg-accent text-foreground',
            )}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
