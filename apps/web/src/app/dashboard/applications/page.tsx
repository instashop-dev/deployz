'use client';

import { GitBranch } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { createApplication, triggerAnalysis } from '@/lib/applications';
import {
  fetchGithubInstallations,
  fetchGithubRepositories,
  type GithubInstallation,
  type GithubRepository,
} from '@/lib/github';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty'; connectUrl: string | null }
  | {
      status: 'loaded';
      installations: GithubInstallation[];
      repositories: Record<string, GithubRepository[]>;
    };

// §42 onboarding step 1: "Connect GitHub". This page lists the org's GitHub
// installations and their repositories so the vendor can pick what to deploy.
// It is honest about GitHub state: no App installed -> the "Connect GitHub"
// empty state (never a fabricated repo list). §65 copy stays jargon-free.
export default function ApplicationsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const { installations, connectUrl } = await fetchGithubInstallations();
        if (cancelled) return;
        if (installations.length === 0) {
          setState({ status: 'empty', connectUrl });
          return;
        }
        const repositories: Record<string, GithubRepository[]> = {};
        await Promise.all(
          installations.map(async (installation) => {
            const { repositories: repos } = await fetchGithubRepositories(installation.id);
            repositories[installation.id] = repos;
          }),
        );
        if (cancelled) return;
        setState({ status: 'loaded', installations, repositories });
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: "We couldn't reach GitHub. Try again in a moment." });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your code, then choose which repositories you deploy.
        </p>
      </div>

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="github-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="github-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'empty' ? <ConnectGitHubEmptyState connectUrl={state.connectUrl} /> : null}
      {state.status === 'loaded' ? (
        <RepoList installations={state.installations} repositories={state.repositories} />
      ) : null}
    </div>
  );
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
}: {
  installations: GithubInstallation[];
  repositories: Record<string, GithubRepository[]>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-base font-semibold">Choose a repository</h2>
      {installations.map((installation) => {
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
                {repos.length} {repos.length === 1 ? 'repository' : 'repositories'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {repos.map((repo) => (
                <RepoRow key={repo.id} installationId={installation.id} repo={repo} />
              ))}
              {repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">No repositories to show.</p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
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
}: {
  installationId: string;
  repo: GithubRepository;
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
    } catch {
      setError("We couldn't set up this application. Try again.");
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
        <Button variant="outline" size="sm" disabled={pending} onClick={onChoose}>
          {pending ? 'Setting up…' : 'Choose'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
