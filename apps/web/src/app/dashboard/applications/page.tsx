'use client';

import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { RepositoryPicker } from '@/components/repository-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplications, type Application } from '@/lib/applications';
import { READINESS_STATE_PRESENTATION, readinessStateFromVerdict } from '@/lib/readiness';

type AppsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; applications: Application[] };

// The org's applications — one per repository it deploys to customers. An org
// with none yet is mid-onboarding (§42 steps 1-2), so the repository picker
// sits right here: there is nothing to add *to* and no list for it to crowd
// out. Once applications exist the list is the subject of the page and every
// further addition goes through /dashboard/applications/new.
export default function ApplicationsPage() {
  const [appsState, setAppsState] = useState<AppsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setAppsState({ status: 'loading' });
    async function loadApps(): Promise<void> {
      try {
        const applications = await fetchApplications();
        if (cancelled) return;
        setAppsState({ status: 'loaded', applications });
      } catch {
        if (!cancelled) {
          setAppsState({
            status: 'error',
            message: "We couldn't load your applications. Try again in a moment.",
          });
        }
      }
    }
    void loadApps();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const hasApplications = appsState.status === 'loaded' && appsState.applications.length > 0;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          {hasApplications ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Manage the software you deploy to customers.
            </p>
          ) : null}
        </div>
        {hasApplications ? (
          <Button asChild data-testid="add-application-button">
            <Link href="/dashboard/applications/new">
              <Plus aria-hidden />
              Add application
            </Link>
          </Button>
        ) : null}
      </div>

      {appsState.status === 'loading' ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {appsState.status === 'error' ? (
        <section
          aria-labelledby="applications-error"
          className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="applications-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground">{appsState.message}</p>
          <Button
            variant="outline"
            data-testid="applications-retry"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Try again
          </Button>
        </section>
      ) : null}

      {hasApplications ? <ApplicationList applications={appsState.applications} /> : null}

      {appsState.status === 'loaded' && !hasApplications ? (
        <section
          aria-labelledby="add-first-application"
          data-testid="add-application-section"
          className="flex flex-col gap-4"
        >
          <div>
            <h2 id="add-first-application" className="text-base font-semibold">
              Add your first application
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose the GitHub repository containing the application you want to deploy.
            </p>
          </div>
          <RepositoryPicker applications={appsState.applications} />
        </section>
      ) : null}
    </div>
  );
}

function ApplicationList({ applications }: { applications: Application[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((app) => (
              <ApplicationRow key={app.id} application={app} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// The whole row opens the application; the name link is the same
// destination for keyboard and assistive-technology users, so the trailing
// "View" is decoration rather than a second control.
function ApplicationRow({ application }: { application: Application }) {
  const router = useRouter();
  const href = `/dashboard/applications/${application.id}`;
  const label = applicationBadgeLabel(application);
  return (
    <TableRow
      data-testid={`app-card-${application.id}`}
      className="cursor-pointer"
      onClick={() => router.push(href)}
    >
      <TableCell className="font-medium">
        <Link
          href={href}
          data-testid={`app-card-name-${application.id}`}
          className="hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {application.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{application.repoFullName}</TableCell>
      <TableCell>
        <Badge variant="secondary" data-testid={`app-card-badge-${application.id}`}>
          {label}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <span
          aria-hidden
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground"
        >
          View
          <ArrowRight className="size-4" />
        </span>
      </TableCell>
    </TableRow>
  );
}

function applicationBadgeLabel(app: Application): string {
  if (app.compatibilityStatus) {
    return READINESS_STATE_PRESENTATION[readinessStateFromVerdict(app.compatibilityStatus)].label;
  }
  if (app.analysisStatus === 'FAILED') return 'Analysis failed';
  return 'Analysing';
}
