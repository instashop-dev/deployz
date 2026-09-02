'use client';

import { usePathname } from 'next/navigation';

import { UserMenu } from '@/components/user-menu';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';

// Longest-prefix route table for the header's page context. Detail routes
// (e.g. /dashboard/deployments/:id) fall back to their section's label.
const SECTION_LABELS: readonly (readonly [string, string])[] = [
  ['/dashboard/deployments/new', 'Deploy customer'],
  ['/dashboard/deployments', 'Deployments'],
  ['/dashboard/applications/new', 'Add application'],
  ['/dashboard/applications', 'Applications'],
  ['/dashboard/customers', 'Customers'],
  ['/dashboard/settings/billing', 'Billing'],
  ['/dashboard/settings/members', 'Team'],
  ['/dashboard/settings/profile', 'Profile'],
  ['/dashboard/settings', 'Settings'],
  ['/dashboard', 'Home'],
];

function sectionLabel(pathname: string): string {
  let best: readonly [string, string] | null = null;
  for (const entry of SECTION_LABELS) {
    const href = entry[0];
    const matches = href === '/dashboard' ? pathname === href : pathname.startsWith(href);
    if (matches && (best === null || href.length > best[0].length)) {
      best = entry;
    }
  }
  return best ? best[1] : 'Home';
}

// Compact header: sidebar trigger (also the mobile nav entry point), the
// current section as lightweight context, and the user menu. Page titles stay
// in the page bodies — this never repeats them at the same size.
export function SiteHeader({ user }: { user: { name: string; email: string } }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="mr-1 h-4!" />
      <span className="truncate text-sm font-medium text-muted-foreground">
        {sectionLabel(pathname)}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <UserMenu name={user.name} email={user.email} />
      </div>
    </header>
  );
}
