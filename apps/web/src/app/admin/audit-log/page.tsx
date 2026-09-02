'use client';

import { ChevronDown } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { fetchAdminAuditLog, type AdminEventLogRow } from '@/lib/admin';
import { AUDIT_ACTION_OPTIONS, adminEventTypeLabel, auditOutcomeLabel } from '@/lib/admin-vocabulary';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; events: AdminEventLogRow[]; nextBefore: number | null; loadingMore: boolean };

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Read-only append-only audit trail of every admin.* action
// (docs/admin/team-admin.md's Audit requirements) — this UI never edits or
// resolves an entry, matching the immutable `event_logs` table underneath.
export default function AdminAuditLogPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  const actor = searchParams.get('actor') ?? '';
  const action = searchParams.get('action') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    async function run(): Promise<void> {
      try {
        const result = await fetchAdminAuditLog({
          actor: actor || undefined,
          action: action || undefined,
          from: from || undefined,
          to: to || undefined,
        });
        if (!cancelled) {
          setState({ status: 'loaded', events: result.events, nextBefore: result.nextBefore, loadingMore: false });
        }
      } catch (caught) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(caught) });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [actor, action, from, to, attempt]);

  async function loadMore(): Promise<void> {
    if (state.status !== 'loaded' || state.nextBefore === null) return;
    setState({ ...state, loadingMore: true });
    try {
      const result = await fetchAdminAuditLog({
        actor: actor || undefined,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        before: state.nextBefore,
      });
      setState((current) =>
        current.status === 'loaded'
          ? {
              status: 'loaded',
              events: [...current.events, ...result.events],
              nextBefore: result.nextBefore,
              loadingMore: false,
            }
          : current,
      );
    } catch {
      setState((current) => (current.status === 'loaded' ? { ...current, loadingMore: false } : current));
    }
  }

  function setFilter(key: string, value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === '' || value === 'all') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.replace(query ? `/admin/audit-log?${query}` : '/admin/audit-log', { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every privileged admin action, append-only.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-actor">Admin</Label>
          <Input
            id="audit-actor"
            value={actor}
            onChange={(event) => setFilter('actor', event.target.value)}
            placeholder="Email"
            data-testid="audit-actor-filter"
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-action">Action</Label>
          <Select value={action || 'all'} onValueChange={(value) => setFilter('action', value)}>
            <SelectTrigger id="audit-action" data-testid="audit-action-filter" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {AUDIT_ACTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(event) => setFilter('from', event.target.value)}
            data-testid="audit-from-filter"
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-to">To</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(event) => setFilter('to', event.target.value)}
            data-testid="audit-to-filter"
            className="w-40"
          />
        </div>
      </div>

      {state.status === 'loading' ? <ListSkeleton /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.status === 'loaded' && state.events.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No audit events match these filters.</p>
      ) : null}
      {state.status === 'loaded' && state.events.length > 0 ? (
        <>
          <AuditTable events={state.events} />
          {state.nextBefore !== null ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              disabled={state.loadingMore}
              onClick={() => void loadMore()}
              data-testid="audit-load-older"
            >
              {state.loadingMore ? 'Loading…' : 'Load older'}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function AuditTable({ events }: { events: AdminEventLogRow[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="admin-audit-log-table">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <AuditRow key={event.id} event={event} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AuditRow({ event }: { event: AdminEventLogRow }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const adminEmail = payloadString(event.payload, 'adminEmail') ?? event.actorId;
  const targetType = payloadString(event.payload, 'targetType');
  const targetId = payloadString(event.payload, 'targetId');
  const reason = payloadString(event.payload, 'reason');

  return (
    <>
      <TableRow>
        <TableCell className="text-muted-foreground">
          {new Date(event.occurredAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </TableCell>
        <TableCell className="text-muted-foreground">{adminEmail}</TableCell>
        <TableCell className="font-medium">{adminEventTypeLabel(event.eventType)}</TableCell>
        <TableCell className="text-muted-foreground">
          {targetType && targetId ? `${targetType} · ${targetId.slice(0, 8)}` : '—'}
        </TableCell>
        <TableCell className="text-muted-foreground">{reason ?? '—'}</TableCell>
        <TableCell className="text-muted-foreground">{auditOutcomeLabel(event.result)}</TableCell>
        <TableCell>
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={open}
              aria-controls={panelId}
            >
              Details
              <ChevronDown
                aria-hidden
                className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </CollapsibleTrigger>
          </Collapsible>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={7} id={panelId} className="bg-muted/50 text-xs text-muted-foreground">
            <code className="block whitespace-pre-wrap break-all">
              {JSON.stringify(event.payload, null, 2)}
            </code>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section
      aria-labelledby="audit-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="audit-error" className="text-lg font-semibold">
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
    <div className="flex flex-col gap-3" data-testid="admin-audit-log-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
