'use client';

import { ArrowLeft, Eye } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import { fetchAdminVendor, startSupportSession, type AdminVendorDetail } from '@/lib/admin';
import {
  adminEventTypeLabel,
  analysisStatusLabel,
  compatibilityStatusLabel,
} from '@/lib/admin-vocabulary';
import { eventTypeLabel, RELAY_STATUS_LABEL } from '@/lib/deployment-vocabulary';
import { RELEASE_STATUS_BADGE, RELEASE_STATUS_LABEL } from '@/lib/releases';
import { PLAN_LABELS } from '@/lib/organization-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'loaded'; detail: AdminVendorDetail };

/** admin.* events use their own vocabulary (audit actions); every other
 *  event type reuses the shared §65 fleet vocabulary. */
function activityLabel(eventType: string): string {
  return eventType.startsWith('admin.') ? adminEventTypeLabel(eventType) : eventTypeLabel(eventType);
}

// The 360° support view: identity, owner, applications, deployments,
// connections, and recent activity for one vendor — the jumping-off point
// for "View as Vendor" and every deployment/job/connection deep link.
export default function AdminVendorDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const detail = await fetchAdminVendor(id);
      setState({ status: 'loaded', detail });
    } catch (caught) {
      const notFound = caught instanceof ApiRequestError && caught.code === 'NOT_FOUND';
      setState({
        status: 'error',
        notFound,
        message: notFound
          ? "This vendor doesn't exist."
          : errorMessage(caught),
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
        <Link href="/admin/vendors">
          <ArrowLeft aria-hidden className="size-4" />
          Vendors
        </Link>
      </Button>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="vendor-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="vendor-error" className="text-lg font-semibold">
            {state.notFound ? 'Vendor not found' : 'Something went wrong'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          {!state.notFound ? (
            <Button variant="outline" className="mt-4" onClick={() => void load()}>
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
      {state.status === 'loaded' ? <VendorDetailBody detail={state.detail} /> : null}
    </div>
  );
}

function VendorDetailBody({ detail }: { detail: AdminVendorDetail }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const owner = detail.members.find((member) => member.role === 'owner') ?? null;

  async function onViewAsVendor(): Promise<void> {
    setPending(true);
    try {
      await startSupportSession(detail.organization.id);
      toast.success(`Viewing as ${detail.organization.name}`);
      router.push('/dashboard');
    } catch (caught) {
      toast.error(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.organization.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{detail.organization.slug}</p>
        </div>
        <Button
          data-testid="view-as-vendor"
          disabled={pending}
          onClick={() => void onViewAsVendor()}
        >
          <Eye aria-hidden />
          {pending ? 'Starting…' : 'View as Vendor'}
        </Button>
      </div>

      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="text-base font-semibold">
          Account
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <MetaRow label="Organization ID" value={detail.organization.id} />
            <MetaRow label="Owner" value={owner ? `${owner.name} (${owner.email})` : 'No owner found'} />
            <MetaRow label="Plan" value={PLAN_LABELS[detail.organization.plan]} />
            <MetaRow
              label="Created"
              value={new Date(detail.organization.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            />
            <MetaRow label="Members" value={String(detail.members.length)} />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="applications" className="flex flex-col gap-3">
        <h2 id="applications" className="text-base font-semibold">
          Applications
        </h2>
        {detail.applications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No applications yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="vendor-applications-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Application</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Analysis</TableHead>
                    <TableHead>Latest release</TableHead>
                    <TableHead>Deployments</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.applications.map((app) => (
                    <TableRow key={app.id}>
                      <TableCell className="font-medium">{app.name}</TableCell>
                      <TableCell className="text-muted-foreground">{app.repoFullName}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {analysisStatusLabel(app.analysisStatus)}
                        {app.compatibilityStatus ? ` · ${compatibilityStatusLabel(app.compatibilityStatus)}` : ''}
                      </TableCell>
                      <TableCell>
                        {app.latestRelease ? (
                          <Badge variant={RELEASE_STATUS_BADGE[app.latestRelease.releaseStatus]}>
                            v{app.latestRelease.version} ·{' '}
                            {RELEASE_STATUS_LABEL[app.latestRelease.releaseStatus]}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">No releases</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {app.deploymentCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="deployments" className="flex flex-col gap-3">
        <h2 id="deployments" className="text-base font-semibold">
          Deployments
        </h2>
        {detail.deployments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deployments yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="vendor-deployments-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Application</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.deployments.map((deployment) => (
                    <TableRow key={deployment.id}>
                      <TableCell>
                        <Link
                          href={`/admin/deployments/${deployment.id}`}
                          className="font-medium hover:underline"
                        >
                          {deployment.customerName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{deployment.applicationName}</TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {deployment.version ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{deployment.region}</TableCell>
                      <TableCell>
                        <DeploymentStatusBadge state={deployment.state} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(deployment.updatedAt) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="connections" className="flex flex-col gap-3">
        <h2 id="connections" className="text-base font-semibold">
          AWS Connections
        </h2>
        {detail.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AWS connections yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="vendor-connections-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>AWS account</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Relay</TableHead>
                    <TableHead>Last check-in</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.connections.map((connection) => (
                    <TableRow key={connection.deploymentId}>
                      <TableCell>
                        <Link
                          href={`/admin/connections/${connection.deploymentId}`}
                          className="font-medium hover:underline"
                        >
                          {connection.customerName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {connection.awsAccountId ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{connection.region}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {RELAY_STATUS_LABEL[connection.relayStatus]}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(connection.lastHealthAt) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Recent activity
        </h2>
        {detail.recentEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-2 py-4">
              {detail.recentEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm last:border-b-0 last:pb-0"
                >
                  <span>{activityLabel(event.eventType)}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="vendor-detail-loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
