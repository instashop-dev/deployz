'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api-client';
import { adminSearchIsEmpty, fetchAdminSearch, type AdminSearchResults } from '@/lib/admin';
import { JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; results: AdminSearchResults };

// Global search results — resolves common identifiers (org/app/customer
// names, AWS account id, installation id, bootstrap stack name, custom
// domain hostname, or a raw uuid) to their admin detail page.
export default function AdminSearchPage() {
  const searchParams = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const [state, setState] = useState<LoadState>({ status: 'idle' });

  useEffect(() => {
    if (q.trim().length < 2) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    async function run(): Promise<void> {
      try {
        const results = await fetchAdminSearch(q);
        if (!cancelled) setState({ status: 'loaded', results });
      } catch (caught) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(caught) });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [q]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {q ? (
            <>
              Results for <span className="font-medium text-foreground">&ldquo;{q}&rdquo;</span>
            </>
          ) : (
            'Search vendors, applications, customers, deployments, and jobs.'
          )}
        </p>
      </div>

      {state.status === 'idle' ? (
        <p className="px-1 text-sm text-muted-foreground">
          Type at least 2 characters in the search box above.
        </p>
      ) : null}
      {state.status === 'loading' ? <SearchSkeleton /> : null}
      {state.status === 'error' ? (
        <p className="px-1 text-sm text-destructive">{state.message}</p>
      ) : null}
      {state.status === 'loaded' ? <SearchResults results={state.results} /> : null}
    </div>
  );
}

function SearchResults({ results }: { results: AdminSearchResults }) {
  if (adminSearchIsEmpty(results)) {
    return (
      <section
        aria-labelledby="search-empty"
        className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <h2 id="search-empty" className="text-lg font-semibold">
          No results
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Try a vendor name, customer name or email, AWS account ID, or a deployment/job ID.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="admin-search-results">
      {results.vendors.length > 0 ? (
        <ResultSection title="Vendors">
          {results.vendors.map((vendor) => (
            <ResultRow key={vendor.id} href={`/admin/vendors/${vendor.id}`} primary={vendor.name} secondary={vendor.slug} />
          ))}
        </ResultSection>
      ) : null}
      {results.applications.length > 0 ? (
        <ResultSection title="Applications">
          {results.applications.map((app) => (
            <ResultRow
              key={app.id}
              href={`/admin/vendors/${app.organizationId}`}
              primary={app.name}
              secondary={`${app.repoFullName} · ${app.organizationName}`}
            />
          ))}
        </ResultSection>
      ) : null}
      {results.customers.length > 0 ? (
        <ResultSection title="Customers">
          {results.customers.map((customer) => (
            <ResultRow
              key={customer.id}
              href={`/admin/vendors/${customer.organizationId}`}
              primary={customer.name}
              secondary={`${customer.email} · ${customer.organizationName}`}
            />
          ))}
        </ResultSection>
      ) : null}
      {results.deployments.length > 0 ? (
        <ResultSection title="Deployments">
          {results.deployments.map((deployment) => (
            <div
              key={deployment.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-b-0"
            >
              <div>
                <Link href={`/admin/deployments/${deployment.id}`} className="font-medium hover:underline">
                  {deployment.customerName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {deployment.applicationName} · {deployment.organizationName}
                </p>
              </div>
              <DeploymentStatusBadge state={deployment.state} />
            </div>
          ))}
        </ResultSection>
      ) : null}
      {results.jobs.length > 0 ? (
        <ResultSection title="Jobs">
          {results.jobs.map((job) => (
            <ResultRow
              key={job.id}
              href={`/admin/jobs/${job.id}`}
              primary={JOB_TYPE_LABEL[job.type]}
              secondary={job.organizationName}
            />
          ))}
        </ResultSection>
      ) : null}
    </div>
  );
}

function ResultSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <Card>
        <CardHeader className="sr-only">
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col py-2">{children}</CardContent>
      </Card>
    </section>
  );
}

function ResultRow({ href, primary, secondary }: { href: string; primary: string; secondary: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0">
      <Link href={href} className="font-medium hover:underline">
        {primary}
      </Link>
      <span className="text-xs text-muted-foreground">{secondary}</span>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="admin-search-loading">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
