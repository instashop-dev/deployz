'use client';

import { Check, ChevronDown, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest, errorMessage } from '@/lib/api-client';
import { ROLE_LABELS, type OrganizationSummary } from '@/lib/organization-vocabulary';
import { cn } from '@/lib/utils';

interface OrgSwitcherProps {
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
}

// Sidebar tenant switcher row: lists every organization the user belongs
// to and switches the active tenant through the API. The trigger's org-name
// span keeps showing the active organization's name at all times — Playwright
// asserts its text content — so the pending state is shown on the icon only.
// The sidebar hides this row when collapsed to icons.
export function OrgSwitcher({ organizations, activeOrganizationId }: OrgSwitcherProps) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeOrganization = organizations.find((org) => org.id === activeOrganizationId) ?? null;

  async function onSwitch(id: string): Promise<void> {
    if (id === activeOrganizationId || pendingId !== null) return;
    setPendingId(id);
    setError(null);
    try {
      await apiRequest(`/api/organizations/${encodeURIComponent(id)}/activate`, {
        method: 'POST',
      });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setPendingId(null);
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              data-testid="org-switcher-trigger"
              disabled={pendingId !== null}
              aria-busy={pendingId !== null || undefined}
              aria-label="Switch organization"
            >
              <span data-testid="org-name" className="truncate">
                {activeOrganization?.name ?? 'Select organization'}
              </span>
              {pendingId !== null ? (
                <Spinner aria-hidden className="ml-auto text-muted-foreground" />
              ) : (
                <ChevronDown className="ml-auto text-muted-foreground" aria-hidden />
              )}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start" className="w-64">
            {organizations.map((org) => (
              <DropdownMenuItem
                key={org.id}
                data-testid="org-switcher-item"
                disabled={pendingId !== null}
                onSelect={() => onSwitch(org.id)}
              >
                <Check
                  className={cn('size-4', org.id === activeOrganizationId ? 'opacity-100' : 'opacity-0')}
                  aria-hidden
                />
                <span className="flex-1 truncate">{org.name}</span>
                <span className="text-xs text-muted-foreground">{ROLE_LABELS[org.role]}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="org-switcher-create" asChild>
              <Link href="/organizations/new">
                <Plus aria-hidden />
                Create organization
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {error ? (
          <p role="alert" className="px-2 pt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
