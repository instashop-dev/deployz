'use client';

import { Copy, Eye, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { copyInstallLink } from '@/components/copy-install-link';
import { DeleteCustomerDialog } from '@/components/delete-customer-dialog';
import { EditCustomerDialog } from '@/components/edit-customer-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  customerDeployment,
  deploymentsByCustomer,
  fetchCustomers,
  formatDate,
  installLinkDeployment,
  installLinkUrl,
  matchesCustomerSearch,
  singleDeploymentDestination,
  type Customer,
  type CustomerDeployment,
} from '@/lib/customers';
import { fetchDeployments, type FleetDeployment } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';

// The Customers screen answers three questions per row: who is this customer,
// have they deployed, and what should I do next. Identity lives in one column
// so the answer to the second question gets the room it needs; the deployment
// column is a rollup of the customer's §46 states (lib/customers), never a raw
// AWS status. Search is client-side over the same rows the table already has —
// the fleet a vendor manages is small, and a round trip per keystroke would
// make the screen feel slower, not faster.

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; customers: Customer[]; deployments: FleetDeployment[] };

export default function CustomersPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        // Deployments come from the same fleet endpoint the Deployments list
        // uses, so the status shown here is the server-derived one — the two
        // screens can never disagree about a customer's deployment.
        const [customers, deployments] = await Promise.all([
          fetchCustomers(),
          fetchDeployments({ includeDeleted: true }),
        ]);
        if (!cancelled) setState({ status: 'loaded', customers, deployments });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load your customers. Try again in a moment.",
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const customers = state.status === 'loaded' ? state.customers : [];
  const grouped = useMemo(
    () => deploymentsByCustomer(state.status === 'loaded' ? state.deployments : []),
    [state],
  );

  const rows = useMemo(
    () =>
      customers
        .filter((customer) => matchesCustomerSearch(customer, search))
        .map((customer) => ({
          customer,
          rollup: customerDeployment(grouped.get(customer.id) ?? []),
        })),
    [customers, grouped, search],
  );

  function applySaved(saved: Customer): void {
    setState((current) =>
      current.status === 'loaded'
        ? {
            ...current,
            customers: current.customers.map((customer) =>
              customer.id === saved.id ? saved : customer,
            ),
          }
        : current,
    );
  }

  function applyDeleted(customerId: string): void {
    setState((current) =>
      current.status === 'loaded'
        ? {
            ...current,
            customers: current.customers.filter((customer) => customer.id !== customerId),
          }
        : current,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage customers and their private deployments.
          </p>
        </div>
        {state.status === 'loaded' && customers.length === 0 ? null : (
          <Button asChild size="sm">
            <Link href="/dashboard/deployments/new">Add customer</Link>
          </Button>
        )}
      </div>

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

      {state.status === 'loaded' ? (
        customers.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search customers..."
                  aria-label="Search customers"
                  className="w-full pl-8 sm:w-64"
                />
              </div>
              <p className="text-sm text-muted-foreground" data-testid="customer-count">
                {rows.length} of {customers.length}{' '}
                {customers.length === 1 ? 'customer' : 'customers'}
              </p>
            </div>

            {rows.length === 0 ? (
              <SearchEmptyState />
            ) : (
              <CustomerTable
                rows={rows}
                onEdit={setEditing}
                onDelete={setDeleting}
              />
            )}
          </>
        )
      ) : null}

      {editing ? (
        <EditCustomerDialog
          customer={editing}
          open
          onOpenChange={(open) => (open ? undefined : setEditing(null))}
          onSaved={applySaved}
        />
      ) : null}
      {deleting ? (
        <DeleteCustomerDialog
          customer={deleting}
          open
          onOpenChange={(open) => (open ? undefined : setDeleting(null))}
          onDeleted={applyDeleted}
        />
      ) : null}
    </div>
  );
}

interface CustomerRow {
  customer: Customer;
  rollup: CustomerDeployment;
}

function CustomerTable({
  rows,
  onEdit,
  onDelete,
}: {
  rows: CustomerRow[];
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="customer-list">
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Deployment</TableHead>
              <TableHead>Last activity</TableHead>
              {/* Created is the first thing to go when the screen narrows —
                  it is the least useful column for deciding what to do next. */}
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ customer, rollup }) => (
              <TableRow key={customer.id}>
                <TableCell>
                  <Link
                    href={`/dashboard/customers/${customer.id}`}
                    className="font-medium hover:underline"
                  >
                    {customer.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">{customer.email}</p>
                  {customer.company ? (
                    <p className="text-xs text-muted-foreground">{customer.company}</p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant={rollup.badge}>{rollup.label}</Badge>
                  {rollup.deployment ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {rollup.deployment.applicationName}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {/* data-testid: masked in visual regression — relative time
                      drifts with the clock. */}
                  <span className="text-sm" data-testid="customer-activity">
                    {relativeTime(rollup.lastActivityAt) ?? '—'}
                  </span>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                  {formatDate(customer.createdAt)}
                </TableCell>
                <TableCell className="w-10">
                  <RowActions
                    customer={customer}
                    rollup={rollup}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Only actions this row's data actually supports: no install link without a
// deployment to install, no "View deployment" without one destination, and no
// Delete for a customer the API would refuse anyway.
function RowActions({
  customer,
  rollup,
  onEdit,
  onDelete,
}: {
  customer: Customer;
  rollup: CustomerDeployment;
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => void;
}) {
  const linkDeployment = installLinkDeployment(rollup);
  const destination = singleDeploymentDestination(rollup);
  const deletable = rollup.deployments.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${customer.name}`}
          className="ml-auto"
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {linkDeployment ? (
          <DropdownMenuItem
            onSelect={() => void copyInstallLink(installLinkUrl(linkDeployment, window.location.origin))}
          >
            <Copy aria-hidden />
            Copy install link
          </DropdownMenuItem>
        ) : null}
        {destination ? (
          <DropdownMenuItem asChild>
            <Link href={`/dashboard/deployments/${destination.id}`}>
              <Eye aria-hidden />
              View deployment
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onEdit(customer)}>
          <Pencil aria-hidden />
          Edit customer
        </DropdownMenuItem>
        {deletable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(customer)}>
              <Trash2 aria-hidden />
              Delete customer
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" data-testid="customers-loading">
      <Skeleton className="h-10 w-64 rounded-lg" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section
      aria-labelledby="customers-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="customers-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

function EmptyState() {
  return (
    <section
      aria-labelledby="empty-customers"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="empty-customers" className="text-lg font-semibold">
        Add your first customer
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Create a customer and send them a secure link to deploy your application into their AWS
        account.
      </p>
      <Button asChild>
        <Link href="/dashboard/deployments/new">Add customer</Link>
      </Button>
    </section>
  );
}

function SearchEmptyState() {
  return (
    <section
      aria-labelledby="customers-no-results"
      className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center"
    >
      <h2 id="customers-no-results" className="text-sm font-medium">
        No customers match your search.
      </h2>
    </section>
  );
}
