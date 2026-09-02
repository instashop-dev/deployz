'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/api-client';
import { fetchAdminVendors, type AdminVendorListRow, type VendorListFilter } from '@/lib/admin';
import { VENDOR_CONNECTION_BADGE, VENDOR_CONNECTION_LABEL } from '@/lib/admin-vocabulary';
import { PLAN_LABELS } from '@/lib/organization-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; vendors: AdminVendorListRow[] };

const FILTER_OPTIONS: { value: VendorListFilter | 'all'; label: string }[] = [
  { value: 'all', label: 'All vendors' },
  { value: 'failed', label: 'Has failed deployment' },
  { value: 'disconnected', label: 'Disconnected' },
];

// Cross-tenant vendor list — the entry point into the 360° support view.
// Search/filter are wired straight to the admin API's q/filter params (not
// client-filtered), URL-persisted so a deep link reproduces the same list.
export default function AdminVendorsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const filter = (searchParams.get('filter') as VendorListFilter | null) ?? 'all';

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    async function run(): Promise<void> {
      try {
        const vendors = await fetchAdminVendors({
          q: q || undefined,
          filter: filter === 'all' ? undefined : filter,
        });
        if (cancelled) return;
        setState(vendors.length === 0 ? { status: 'empty' } : { status: 'loaded', vendors });
      } catch (caught) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(caught) });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [q, filter, attempt]);

  function setFilter(key: string, value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all' || value === '') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.replace(query ? `/admin/vendors?${query}` : '/admin/vendors', { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every organization on Deployz.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(event) => setFilter('q', event.target.value)}
            placeholder="Search vendors"
            aria-label="Search vendors"
            data-testid="vendors-search"
            className="w-full pl-8 sm:w-64"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter('filter', value)}>
          <SelectTrigger aria-label="Filter vendors" data-testid="vendors-filter" className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {state.status === 'loading' ? <ListSkeleton /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'empty' ? (
        <p className="px-1 text-sm text-muted-foreground">No vendors match these filters.</p>
      ) : null}
      {state.status === 'loaded' ? <VendorsTable vendors={state.vendors} /> : null}
    </div>
  );
}

function VendorsTable({ vendors }: { vendors: AdminVendorListRow[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="admin-vendors-table">
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Applications</TableHead>
              <TableHead>Deployments</TableHead>
              <TableHead>Connection</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vendors.map((vendor) => (
              <TableRow key={vendor.organizationId} data-testid="admin-vendor-row">
                <TableCell>
                  <Link
                    href={`/admin/vendors/${vendor.organizationId}`}
                    className="font-medium hover:underline"
                  >
                    {vendor.name}
                  </Link>
                  {vendor.hasFailedDeployment ? (
                    <Badge variant="destructive" className="ml-2">
                      Failed deployment
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{vendor.ownerEmail ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {vendor.applicationCount}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {vendor.deploymentCount}
                </TableCell>
                <TableCell>
                  <Badge variant={VENDOR_CONNECTION_BADGE[vendor.connection]}>
                    {VENDOR_CONNECTION_LABEL[vendor.connection]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{PLAN_LABELS[vendor.plan]}</TableCell>
                <TableCell className="text-muted-foreground">
                  {relativeTime(vendor.lastActivityAt) ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section
      aria-labelledby="vendors-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="vendors-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="admin-vendors-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
