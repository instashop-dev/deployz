'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { UserMenu } from '@/components/user-menu';

// Team Admin's header: sidebar trigger, the prominent global search (submits
// to /admin/search?q=…), and the reused UserMenu. Mirrors SiteHeader's
// layout, but the search bar replaces the section label — global search is
// the primary cross-tenant lookup tool, not a secondary affordance.
export function AdminHeader({ user }: { user: { name: string; email: string } }) {
  const router = useRouter();
  const [query, setQuery] = useState('');

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    router.push(`/admin/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="mr-1 h-4!" />
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search vendors, deployments, jobs…"
            aria-label="Search Team Admin"
            data-testid="admin-search-input"
            className="pl-8"
          />
        </div>
      </form>
      <div className="ml-auto flex items-center gap-2">
        <UserMenu name={user.name} email={user.email} />
      </div>
    </header>
  );
}
