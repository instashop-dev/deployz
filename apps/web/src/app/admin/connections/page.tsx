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
import { fetchAdminConnections, type AdminConnectionListRow, type ConnectionState } from '@/lib/admin';
import { CONNECTION_STATE_BADGE, CONNECTION_STATE_LABEL } from '@/lib/admin-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; connections: AdminConnectionListRow[] };

const FILTER_OPTIONS: { value: ConnectionState | 'all'; label: string }[] = [
  { value: 'all', label: 'All connections' },
  { value: 'CONNECTED', label: CONNECTION_STATE_LABEL.CONNECTED },
  { value: 'DEGRADED', label: CONNECTION_STATE_LABEL.DEGRADED },
  { value: 'DISCONNECTED', label: CONNECTION_STATE_LABEL.DISCONNECTED },
  { value: 'BOOTSTRAP_INCOMPLETE', label: CONNECTION_STATE_LABEL.BOOTSTRAP_INCOMPLETE },
  { value: 'UNKNOWN', label: CONNECTION_STATE_LABEL.UNKNOWN },
];

// Relay/bootstrap connectivity per installed deployment, cross-tenant.
export default function AdminConnectionsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const filter = (searchParams.get('filter') as ConnectionState | null) ?? 'all';

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    async function run(): Promise<void> {
      try {
        const connections = await fetchAdminConnections({
          q: q || undefined,
          filter: filter === 'all' ? undefined : filter,
        });
        if (cancelled) return;
        setState(connections.length === 0 ? { status: 'empty' } : { status: 'loaded', connections });
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
    router.replace(query ? `/admin/connections?${query}` : '/admin/connections', { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AWS Connections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Relay and bootstrap connectivity for every installed deployment.
        </p>
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
            placeholder="Search customer, AWS account, region"
            aria-label="Search connections"
            data-testid="admin-connections-search"
            className="w-full pl-8 sm:w-72"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter('filter', value)}>
          <SelectTrigger
            aria-label="Filter connections"
            data-testid="admin-connections-filter"
            className="w-full sm:w-48"
          >
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
        <p className="px-1 text-sm text-muted-foreground">No connections match these filters.</p>
      ) : null}
      {state.status === 'loaded' ? <ConnectionsTable connections={state.connections} /> : null}
    </div>
  );
}

function ConnectionsTable({ connections }: { connections: AdminConnectionListRow[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="admin-connections-table">
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>AWS account</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Connection</TableHead>
              <TableHead>Relay version</TableHead>
              <TableHead>Last heartbeat</TableHead>
              <TableHead>Deployments on account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow key={connection.deploymentId} data-testid="admin-connection-row">
                <TableCell className="text-muted-foreground">{connection.organizationName}</TableCell>
                <TableCell>
                  <Link
                    href={`/admin/connections/${connection.deploymentId}`}
                    className="font-medium hover:underline"
                  >
                    {connection.customerName}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{connection.awsAccountId ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{connection.region}</TableCell>
                <TableCell>
                  <Badge variant={CONNECTION_STATE_BADGE[connection.connectionState]}>
                    {CONNECTION_STATE_LABEL[connection.connectionState]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{connection.relayVersion ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">
                  {relativeTime(connection.lastHealthAt) ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {connection.accountDeploymentCount}
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
      aria-labelledby="connections-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="connections-error" className="text-lg font-semibold">
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
    <div className="flex flex-col gap-3" data-testid="admin-connections-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
