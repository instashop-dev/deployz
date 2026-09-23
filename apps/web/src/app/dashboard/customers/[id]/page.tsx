'use client';

import { ArrowLeft, Copy, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { copyInstallLink } from '@/components/copy-install-link';
import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { EditCustomerDialog } from '@/components/edit-customer-dialog';
import { InvitationDialog } from '@/components/invitation-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  customerDeployment,
  fetchCustomer,
  fetchCustomerInvitations,
  formatDate,
  installLinkUrl,
  type Customer,
  type CustomerDeployment,
  type CustomerInvitation,
} from '@/lib/customers';
import { fetchDeploymentsForCustomer } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';
import { regionOptionLabel } from '@/lib/regions';

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
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creatingInstallation, setCreatingInstallation] = useState(false);
  const [invitations, setInvitations] = useState<CustomerInvitation[] | null>(null);
  const [invitationAttempt, setInvitationAttempt] = useState(0);

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
      } finally {
        if (!cancelled) setRetrying(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [customerId, attempt]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const loaded = await fetchCustomerInvitations(customerId);
        if (!cancelled) setInvitations(loaded);
      } catch {
        if (!cancelled) setInvitations([]);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [customerId, invitationAttempt]);

  const onSaved = useCallback((saved: Customer) => {
    setState((current) =>
      current.status === 'loaded' ? { ...current, customer: saved } : current,
    );
  }, []);

  const onInvitationCreated = useCallback(() => {
    setInvitationAttempt((n) => n + 1);
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-6" data-testid="customer-loading" aria-busy="true">
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
          <Button
            variant="outline"
            loading={retrying}
            loadingText="Trying again…"
            onClick={() => {
              setRetrying(true);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </section>
      </div>
    );
  }

  const { customer, rollup } = state;

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
          <Button size="sm" onClick={() => setCreatingInstallation(true)}>
            <Plus aria-hidden />
            Create installation
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deployments</CardTitle>
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
          {rollup.deployments.length > 1 ? (
            <ul className="flex flex-col gap-2">
              {rollup.deployments.map((deployment) => (
                <li
                  key={deployment.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{deployment.applicationName}</span>
                    <span className="text-xs text-muted-foreground">{deployment.region}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <DeploymentStatusBadge state={deployment.state} />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void copyInstallLink(installLinkUrl(deployment, window.location.origin))
                      }
                    >
                      <Copy aria-hidden />
                      Copy customer link
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/dashboard/deployments/${deployment.id}`}>View deployment</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : rollup.deployment ? (
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void copyInstallLink(installLinkUrl(rollup.deployment!, window.location.origin))
                  }
                >
                  <Copy aria-hidden />
                  Copy customer link
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/dashboard/deployments/${rollup.deployment.id}`}>
                    View deployment
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">No installations yet</p>
              <Button size="sm" onClick={() => setCreatingInstallation(true)}>
                <Plus aria-hidden />
                Create installation
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <PendingInstallationsCard
        invitations={invitations}
        onCreate={() => setCreatingInstallation(true)}
      />

      <EditCustomerDialog
        customer={customer}
        open={editing}
        onOpenChange={setEditing}
        onSaved={onSaved}
      />
      <InvitationDialog
        customerId={customerId}
        open={creatingInstallation}
        onOpenChange={setCreatingInstallation}
        onCreated={onInvitationCreated}
      />
    </div>
  );
}

function PendingInstallationsCard({
  invitations,
  onCreate,
}: {
  invitations: CustomerInvitation[] | null;
  onCreate: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending installations</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {invitations === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : invitations.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">No pending installations</p>
            <Button size="sm" onClick={onCreate}>
              <Plus aria-hidden />
              Create installation
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{invitation.applicationName}</span>
                  <span className="text-xs text-muted-foreground">
                    {invitation.recommendedRegion ? regionOptionLabel(invitation.recommendedRegion) : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <InvitationStatusBadge status={invitation.status} />
                  <span className="text-xs text-muted-foreground">
                    Expires {invitation.expiresAt ? formatDate(invitation.expiresAt) : '—'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function InvitationStatusBadge({ status }: { status: CustomerInvitation['status'] }) {
  const variant =
    status === 'used' ? 'success' : status === 'active' ? 'default' : 'secondary';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge variant={variant}>{label}</Badge>;
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
