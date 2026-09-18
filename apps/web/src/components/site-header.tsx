'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';

// Longest-prefix route table for the header's page context. Detail routes
// (e.g. /dashboard/deployments/:id) fall back to their section's label.
const SECTION_LABELS: readonly (readonly [string, string])[] = [
  ['/dashboard/deployments/new', 'Create deployment'],
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

// Index routes where the section label only repeats the page's own title —
// the label adds nothing there, so it is suppressed. Nested routes keep the
// parent section's label for hierarchy.
const INDEX_ROUTES = new Set([
  '/dashboard',
  '/dashboard/applications',
  '/dashboard/customers',
  '/dashboard/deployments',
  '/dashboard/settings',
]);

export function sectionLabel(pathname: string): string | null {
  let best: readonly [string, string] | null = null;
  for (const entry of SECTION_LABELS) {
    const href = entry[0];
    const matches = href === '/dashboard' ? pathname === href : pathname.startsWith(href);
    if (matches && (best === null || href.length > best[0].length)) {
      best = entry;
    }
  }
  if (best === null || INDEX_ROUTES.has(pathname)) return null;
  return best[1];
}

// Slim top bar: the sidebar trigger (also the mobile nav entry point, with
// the wordmark beside it below md) and section context on nested routes only.
// Page titles stay in page bodies and the account menu lives in the sidebar
// footer — nothing user-specific renders here.
export function SiteHeader() {
  const pathname = usePathname();
  const label = sectionLabel(pathname);

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Link
        href="/dashboard"
        className="font-heading text-base font-semibold tracking-tight md:hidden"
      >
        Deployz
      </Link>
      {label ? (
        <>
          <Separator orientation="vertical" className="mr-1 h-4!" />
          <span className="truncate text-sm font-medium text-muted-foreground">{label}</span>
        </>
      ) : null}
    </header>
  );
}
