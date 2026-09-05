'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { releaseBuildFailureSummary } from '@deployz/copy-map';

import { fetchDeploymentsForApplication } from '@/lib/deployments';
import {
  RELEASE_STATUS_BADGE,
  RELEASE_UNAVAILABLE_COPY,
  releaseStatusLabel,
  fetchReleases,
  createRelease,
  runningReleaseIds,
  type Release,
} from '@/lib/releases';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; releases: Release[]; running: Set<string> };

export default function ReleasesPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [releases, deployments] = await Promise.all([
          fetchReleases(id),
          fetchDeploymentsForApplication(id),
        ]);
        if (cancelled) return;
        setState(
          releases.length === 0
            ? { status: 'empty' }
            : { status: 'loaded', releases, running: runningReleaseIds(deployments) },
        );
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load releases. Try again in a moment.",
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function onCreated(release: Release): void {
    setFormOpen(false);
    setState((current) => {
      const existing = current.status === 'loaded' ? current.releases : [];
      const running = current.status === 'loaded' ? current.running : new Set<string>();
      return { status: 'loaded', releases: [release, ...existing], running };
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/dashboard/applications/${id}`}>
            <ArrowLeft aria-hidden className="size-4" />
            Application
          </Link>
        </Button>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Releases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Version history for this application.
          </p>
        </div>
        <Button onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? 'Cancel' : 'Create Release'}
        </Button>
      </div>

      {formOpen ? <CreateReleaseForm applicationId={id} onCreated={onCreated} /> : null}

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="releases-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="releases-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'empty' ? <EmptyState /> : null}
      {state.status === 'loaded' ? (
        <ReleaseTable releases={state.releases} running={state.running} />
      ) : null}
    </div>
  );
}

function CreateReleaseForm({
  applicationId,
  onCreated,
}: {
  applicationId: string;
  onCreated: (release: Release) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const version = String(form.get('version') ?? '').trim();
    const gitSha = String(form.get('gitSha') ?? '').trim();
    const migrationCommand = String(form.get('migrationCommand') ?? '').trim();
    setPending(true);
    setError(null);
    try {
      const release = await createRelease(applicationId, {
        version,
        gitSha,
        migrationCommand: migrationCommand.length > 0 ? migrationCommand : null,
      });
      onCreated(release);
    } catch {
      setError("We couldn't create this release. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="create-release-form">
      <CardHeader>
        <CardTitle>New release</CardTitle>
        <CardDescription>
          Records an immutable version. This does not update any customer — deploy it from a
          deployment&apos;s page, or to several customers at once from the fleet dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="version">Version</Label>
              <Input id="version" name="version" placeholder="v1.3.0" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gitSha">Git commit</Label>
              <Input id="gitSha" name="gitSha" placeholder="a1b2c3d" required />
            </div>
          </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="migrationCommand">Migration command (optional)</Label>
              <Input id="migrationCommand" name="migrationCommand" placeholder="npm run migrate" />
              <p className="text-xs text-muted-foreground">
                Runs inside the customer&apos;s account before this release starts, as a
                one-off task. Leave empty to use the command Deployz detected for this
                application.
              </p>
            </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create Release'}
            </Button>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" data-testid="releases-loading">
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <section
      aria-labelledby="empty-releases"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="empty-releases" className="text-lg font-semibold">
        No releases yet
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        When you create a release, it appears here with its version, status, and creation date.
      </p>
    </section>
  );
}

function ReleaseTable({ releases, running }: { releases: Release[]; running: Set<string> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Release history</CardTitle>
        <CardDescription>{releases.length} {releases.length === 1 ? 'release' : 'releases'}</CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="pb-2 font-medium">Version</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Runtime</th>
              <th className="pb-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id} className="border-b last:border-0">
                <td className="py-2.5 font-mono font-medium">{release.version}</td>
                <td className="py-2.5">
                  <Badge variant={RELEASE_STATUS_BADGE[release.status]}>
                    {releaseStatusLabel(release.status)}
                  </Badge>
                  {release.status === 'FAILED' ? (
                    <div className="mt-1 max-w-xs text-xs text-muted-foreground" data-testid={`release-failure-${release.id}`}>
                      <p>{releaseBuildFailureSummary(release.failureReason)}</p>
                      {release.failureReason ? (
                        <details className="mt-0.5">
                          <summary className="cursor-pointer">Technical detail</summary>
                          <code className="mt-0.5 block break-all rounded bg-muted px-1.5 py-0.5 font-mono">{release.failureReason}</code>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                  {release.status === 'UNAVAILABLE' ? (
                    <p
                      className="mt-1 max-w-xs text-xs text-muted-foreground"
                      data-testid={`release-unavailable-${release.id}`}
                    >
                      {RELEASE_UNAVAILABLE_COPY}
                    </p>
                  ) : null}
                </td>
                <td className="py-2.5">
                  {running.has(release.id) ? <Badge variant="outline">Running</Badge> : null}
                </td>
                <td className="py-2.5 text-muted-foreground">
                  {new Date(release.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
