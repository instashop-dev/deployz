'use client';

import { ArrowLeft, Copy, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { copyInstallLink } from '@/components/copy-install-link';
import { EditCustomerDialog } from '@/components/edit-customer-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  customerDeployment,
  fetchCustomer,
  formatDate,
  installLinkDeployment,
  installLinkUrl,
  type Customer,
  type CustomerDeployment,
} from '@/lib/customers';
import { fetchDeploymentsForCustomer } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';

// One customer, compact: who they are, whether they have deployed, and the
// link that gets them deployed. Everything a deployment can do stays on the
// deployment page — this is not a CRM profile, and it is not a second place
// to operate infrastructure from.

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; customer: Customer; rollup: CustomerDeployment };

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const [customer, deployments] = await Promise.all([
          fetchCustomer(customerId),
          fetchDeploymentsForCustomer(customerId),
        ]);
        if (!cancelled) {
          setState({ status: 'loaded', customer, rollup: customerDeployment(deployments) });
        }
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load this customer. Try again in a moment.",
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [customerId, attempt]);

  const onSaved = useCallback((saved: Customer) => {
    setState((current) =>
      current.status === 'loaded' ? { ...current, customer: saved } : current,
    );
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-6" data-testid="customer-loading">
        <Skeleton className="h-12 w-64 rounded-lg" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <section
          aria-labelledby="customer-error"
          className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h1 id="customer-error" className="text-lg font-semibold">
            Something went wrong
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">{state.message}</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </section>
      </div>
    );
  }

  const { customer, rollup } = state;
  const linkDeployment = installLinkDeployment(rollup);
  const installUrl =
    linkDeployment && typeof window !== 'undefined'
      ? installLinkUrl(linkDeployment, window.location.origin)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{customer.email}</p>
          {customer.company ? (
            <p className="text-sm text-muted-foreground">{customer.company}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil aria-hidden />
            Edit customer
          </Button>
          {installUrl ? (
            <Button size="sm" onClick={() => void copyInstallLink(installUrl)}>
              <Copy aria-hidden />
              Copy install link
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deployment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={rollup.badge}>{rollup.label}</Badge>
            {rollup.deployments.length > 1 ? (
              <span className="text-xs text-muted-foreground">
                {rollup.deployments.length} deployments
              </span>
            ) : null}
          </div>
          {rollup.deployment ? (
            <>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <MetaRow label="Application" value={rollup.deployment.applicationName} />
                <MetaRow label="Region" value={rollup.deployment.region} />
                <MetaRow
                  label="Last activity"
                  value={relativeTime(rollup.lastActivityAt) ?? '—'}
                />
                <MetaRow label="Added" value={formatDate(customer.createdAt)} />
              </dl>
              <div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/dashboard/deployments/${rollup.deployment.id}`}>
                    View deployment
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                This customer has not deployed yet. Create a deployment to give them an install
                link.
              </p>
              <div>
                <Button asChild size="sm" variant="outline">
                  <Link href="/dashboard/deployments/new">Create deployment</Link>
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {installUrl ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Install link</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Send this to {customer.name} to deploy your application into their AWS account.
              Editing their contact details never changes this link.
            </p>
            <code
              data-testid="customer-install-link"
              className="block truncate rounded-lg border bg-muted px-3 py-2 font-mono text-xs"
            >
              {installUrl}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void copyInstallLink(installUrl)}>
                <Copy aria-hidden />
                Copy install link
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <EditCustomerDialog
        customer={customer}
        open={editing}
        onOpenChange={setEditing}
        onSaved={onSaved}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/dashboard/customers"
      className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Customers
    </Link>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
