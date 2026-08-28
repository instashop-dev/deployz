'use client';

import { GitBranch, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createApplication,
  fetchApplications,
  triggerAnalysis,
  type Application,
} from '@/lib/applications';
import {
  fetchGithubInstallations,
  fetchGithubRepositories,
  type GithubInstallation,
  type GithubRepository,
} from '@/lib/github';
import { loadGithubState, type GithubState } from '@/lib/github-state';
import { errorMessage } from '@/lib/api-client';
import { VERDICT_PRESENTATION } from '@/lib/readiness';

type AppsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; applications: Application[] };

// §42 onboarding step 1: "Connect GitHub". This page shows the org's existing
// applications above the GitHub installations and their repositories so the
// vendor can pick what to deploy. It is honest about GitHub state: no App
// installed -> the "Connect GitHub" empty state (never a fabricated repo
// list). §65 copy stays jargon-free.
export default function ApplicationsPage() {
  const [appsState, setAppsState] = useState<AppsState>({ status: 'loading' });
  const [githubState, setGithubState] = useState<GithubState>({ status: 'loading' });
  const [addOpen, setAddOpen] = useState(false);
  // Bumped by "Try again" so the GitHub load re-runs. A GitHub outage is the
  // kind of thing that clears on its own, and a full page reload would throw
  // away the application list with it.
  const [githubAttempt, setGithubAttempt] = useState(0);
  const addSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    setGithubState({ status: 'loading' });
    void loadGithubState({
      fetchInstallations: fetchGithubInstallations,
      fetchRepositories: fetchGithubRepositories,
    }).then((state) => {
      if (!cancelled) setGithubState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [githubAttempt]);

  // An org with no applications yet is mid-onboarding (§42 steps 1-2), so the
  // repo picker stays expanded inline — there is nothing to add *to* and no
  // list for it to crowd out. Once applications exist the list becomes the
  // subject of the page and the picker hides behind "Add application", which
  // is also what makes it obvious you can connect more than one repository.
  const hasApplications = appsState.status === 'loaded' && appsState.applications.length > 0;
  const addSectionVisible = !hasApplications || addOpen;

  // The picker renders below the application list, which can sit off-screen on
  // a long list — scroll it into view so the reveal is never invisible.
  useEffect(() => {
    if (addOpen) {
      addSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [addOpen]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasApplications
              ? 'Each application is one repository you deploy to your customers. Add as many as you need.'
              : 'Connect your code, then choose which repositories you deploy.'}
          </p>
        </div>
        {hasApplications ? (
          <Button data-testid="add-application-button" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add application
          </Button>
        ) : null}
      </div>

      {appsState.status === 'loaded' && appsState.applications.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold">Your applications</h2>
          <ApplicationList applications={appsState.applications} />
        </section>
      ) : null}
      {appsState.status === 'loading' ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : null}
      {appsState.status === 'error' ? (
        <section
          aria-labelledby="applications-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="applications-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{appsState.message}</p>
        </section>
      ) : null}

      {addSectionVisible ? (
        <section
          ref={addSectionRef}
          data-testid="add-application-section"
          className="flex flex-col gap-6"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">
              {hasApplications ? 'Add another application' : 'Add application'}
            </h2>
            {hasApplications ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="add-application-cancel"
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
          {githubState.status === 'loading' ? <LoadingState /> : null}
          {githubState.status === 'error' ? (
            <section
              aria-labelledby="github-error"
              data-testid="github-error"
              className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
            >
              <h2 id="github-error" className="text-lg font-semibold">
                Something went wrong
              </h2>
              <p className="text-sm text-muted-foreground">{githubState.message}</p>
              <Button
                variant="outline"
                data-testid="github-retry"
                onClick={() => setGithubAttempt((attempt) => attempt + 1)}
              >
                Try again
              </Button>
            </section>
          ) : null}
          {githubState.status === 'empty' ? (
            <ConnectGitHubEmptyState connectUrl={githubState.connectUrl} />
          ) : null}
          {githubState.status === 'loaded' ? (
            <RepoList
              installations={githubState.installations}
              repositories={githubState.repositories}
              unreachable={new Set(githubState.unreachable)}
              connectUrl={githubState.connectUrl}
              connectedRepos={
                new Map(
                  appsState.status === 'loaded'
                    ? appsState.applications.map((app) => [app.repoFullName, app.id])
                    : [],
                )
              }
            />
          ) : null}
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

function ApplicationRow({ application }: { application: Application }) {
  const label = applicationBadgeLabel(application);
  return (
    <TableRow data-testid={`app-card-${application.id}`}>
      <TableCell className="font-medium">
        <Link
          href={`/dashboard/applications/${application.id}`}
          data-testid={`app-card-name-${application.id}`}
          className="hover:underline"
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
    </TableRow>
  );
}

function applicationBadgeLabel(app: Application): string {
  if (app.compatibilityStatus) {
    return VERDICT_PRESENTATION[app.compatibilityStatus].label;
  }
  if (app.analysisStatus === 'FAILED') return 'Analysis failed';
  return 'Analysing';
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" data-testid="applications-loading">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function ConnectGitHubEmptyState({ connectUrl }: { connectUrl: string | null }) {
  return (
    <section
      aria-labelledby="connect-github"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="connect-github" className="text-lg font-semibold">
        Connect your code
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Link your GitHub account to choose the repositories you want to deploy. We only ask for
        read-only access to your code.
      </p>
      {connectUrl ? (
        <Button asChild>
          <a href={connectUrl}>Connect GitHub</a>
        </Button>
      ) : (
        <Button disabled>Connect GitHub</Button>
      )}
      {!connectUrl ? (
        <p className="text-xs text-muted-foreground">
          GitHub isn&apos;t set up for this workspace yet.
        </p>
      ) : null}
    </section>
  );
}

function RepoList({
  installations,
  repositories,
  unreachable,
  connectUrl,
  connectedRepos,
}: {
  installations: GithubInstallation[];
  repositories: Record<string, GithubRepository[]>;
  /** Installation ids GitHub would not list repositories for — said out loud
   *  rather than shown as an account with no repositories. */
  unreachable: Set<string>;
  connectUrl: string | null;
  /** repoFullName -> the application already connected to it. */
  connectedRepos: Map<string, string>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-base font-semibold">Choose a repository</h2>
      {installations.map((installation) => {
        const failed = unreachable.has(installation.id);
        const repos = repositories[installation.id] ?? [];
        return (
          <Card key={installation.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-muted-foreground" aria-hidden />
                <CardTitle>{installation.accountLogin}</CardTitle>
                <Badge variant="secondary">{installation.accountType}</Badge>
              </div>
              <CardDescription>
                {failed
                  ? "We couldn't reach GitHub for this account"
                  : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {repos.map((repo) => (
                <RepoRow
                  key={repo.id}
                  installationId={installation.id}
                  repo={repo}
                  connectedApplicationId={connectedRepos.get(repo.fullName) ?? null}
                />
              ))}
              {failed ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid={`repos-unavailable-${installation.id}`}
                >
                  We couldn&apos;t load the repositories for {installation.accountLogin}. Try again
                  in a moment, or check that Deployz is still installed on GitHub.
                </p>
              ) : null}
              {!failed && repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">No repositories to show.</p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
      {/* Always reachable, even when every listing above failed: it is both
          how you add another account and how you repair a broken one. */}
      {connectUrl ? (
        <div>
          <Button variant="outline" asChild data-testid="github-manage">
            <a href={connectUrl}>Manage GitHub access</a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// §42 step 2 "Choose repository". Previously this only navigated to a
// fixture-id route without ever creating an Application row, so the
// readiness page had nothing real to show. Now it creates the Application
// (POST /api/applications), kicks off analysis (POST .../analyse), and only
// then navigates to the real (UUID) application id.
function RepoRow({
  installationId,
  repo,
  connectedApplicationId,
}: {
  installationId: string;
  repo: GithubRepository;
  /** Set when this repository is already an application in this organization. */
  connectedApplicationId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChoose(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const application = await createApplication({
        name: repo.name,
        githubInstallationId: installationId,
        repoFullName: repo.fullName,
        repoUrl: `https://github.com/${repo.fullName}`,
        defaultBranch: repo.defaultBranch,
      });
      await triggerAnalysis(application.id);
      router.push(`/dashboard/applications/${application.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{repo.name}</p>
          {repo.description ? (
            <p className="truncate text-xs text-muted-foreground">{repo.description}</p>
          ) : null}
        </div>
        {/*
          A repository that is already an application links to it instead of
          offering Choose again. Choosing twice used to create a second
          application for the same repo, with its own releases and
          deployments.
        */}
        {connectedApplicationId ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/dashboard/applications/${connectedApplicationId}`}>Connected</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={pending} onClick={onChoose}>
            {pending ? 'Setting up…' : 'Choose'}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
