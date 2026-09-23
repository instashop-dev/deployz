'use client';

import { ChevronRight, ExternalLink } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { releaseBuildFailureSummary } from '@deployz/copy-map';

import { CommitPicker, type CommitPickerHandle } from '@/components/commit-picker';
import { useApplicationPage } from '../application-page-context';
import { fetchDeploymentsForApplication, type FleetDeployment } from '@/lib/deployments';
import { formatDateTime } from '@/lib/list-view';
import { relativeTime } from '@/lib/diagnostics';
import {
  RELEASE_FAILURE_NEXT_STEP,
  RELEASE_STATUS_BADGE,
  RELEASE_STATUS_EXPLANATION,
  RELEASE_UNAVAILABLE_COPY,
  releaseStatusLabel,
  fetchReleases,
  createRelease,
  installReleaseState,
  installSummaryLine,
  newestFirst,
  runningOn,
  runningOnLabel,
  shortSha,
  suggestNextVersion,
  type Release,
} from '@/lib/releases';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; releases: Release[]; deployments: FleetDeployment[] };

export default function ReleasesPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const { data } = useApplicationPage();
  const repoFullName = data?.application.repoFullName ?? null;
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
            : { status: 'loaded', releases: newestFirst(releases), deployments },
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
      const deployments = current.status === 'loaded' ? current.deployments : [];
      return { status: 'loaded', releases: newestFirst([release, ...existing]), deployments };
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Releases</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Version history for this application.
          </p>
        </div>
        <Button onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? 'Cancel' : 'Create Release'}
        </Button>
      </div>

      {formOpen ? (
        <CreateReleaseForm
          applicationId={id}
          releases={state.status === 'loaded' ? state.releases : []}
          onCreated={onCreated}
        />
      ) : null}

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
        <ReleaseTable releases={state.releases} deployments={state.deployments} repoFullName={repoFullName} />
      ) : null}
    </div>
  );
}

function CreateReleaseForm({
  applicationId,
  releases,
  onCreated,
}: {
  applicationId: string;
  releases: Release[];
  onCreated: (release: Release) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitReady, setCommitReady] = useState(false);
  const { data } = useApplicationPage();
  const commitPickerRef = useRef<CommitPickerHandle>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const version = String(form.get('version') ?? '').trim();
    const migrationCommand = String(form.get('migrationCommand') ?? '').trim();
    setPending(true);
    setError(null);
    try {
      const gitSha = await commitPickerRef.current?.resolveGitSha();
      if (!gitSha) {
        return;
      }
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
              <Input
                id="version"
                name="version"
                placeholder="v1.3.0"
                defaultValue={suggestNextVersion(releases)}
                required
              />
            </div>
          </div>
          <CommitPicker
            ref={commitPickerRef}
            applicationId={applicationId}
            releases={releases}
            defaultBranch={data?.application.defaultBranch ?? null}
            onReadyChange={setCommitReady}
          />
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
            <Button type="submit" loading={pending} loadingText="Creating release…" disabled={!commitReady}>
              Create Release
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
    <div className="flex flex-col gap-3" data-testid="releases-loading" aria-busy="true">
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

function ReleaseTable({
  releases,
  deployments,
  repoFullName,
}: {
  releases: Release[];
  deployments: FleetDeployment[];
  repoFullName: string | null;
}) {
  const install = installReleaseState(releases);
  const installableId = install.kind === 'ready' ? install.release.id : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Release history</CardTitle>
        <CardDescription data-testid="release-install-summary">
          {installSummaryLine(releases)}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead className="hidden sm:table-cell">Commit</TableHead>
              <TableHead>Build</TableHead>
              <TableHead className="hidden sm:table-cell">Running on</TableHead>
              <TableHead className="hidden sm:table-cell">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((release) => (
              <ReleaseRow
                key={release.id}
                release={release}
                isInstallable={release.id === installableId}
                running={runningOn(deployments, release.id)}
                repoFullName={repoFullName}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReleaseRow({
  release,
  isInstallable,
  running,
  repoFullName,
}: {
  release: Release;
  isInstallable: boolean;
  running: { test: number; customer: number };
  repoFullName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `release-details-${release.id}`;
  const runningLabel = runningOnLabel(running);
  const commitUrl = repoFullName ? `https://github.com/${repoFullName}/commit/${release.gitSha}` : null;

  return (
    <>
      <TableRow data-testid={`release-row-${release.id}`}>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={open ? `Hide details for ${release.version}` : `Show details for ${release.version}`}
              onClick={() => setOpen((current) => !current)}
            >
              <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            </Button>
            <span className="font-mono font-medium">{release.version}</span>
          </div>
        </TableCell>
        <TableCell className="hidden font-mono text-sm text-muted-foreground sm:table-cell">
          {shortSha(release.gitSha)}
        </TableCell>
        <TableCell>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Badge variant={RELEASE_STATUS_BADGE[release.status]}>{releaseStatusLabel(release.status)}</Badge>
              {isInstallable ? <Badge variant="outline">Customer installs</Badge> : null}
            </div>
            {release.status === 'FAILED' ? (
              <p className="text-xs text-muted-foreground" data-testid={`release-failure-${release.id}`}>
                {releaseBuildFailureSummary(release.failureReason)}
              </p>
            ) : null}
            {release.status === 'UNAVAILABLE' ? (
              <p className="text-xs text-muted-foreground">{RELEASE_UNAVAILABLE_COPY}</p>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="hidden text-muted-foreground sm:table-cell">
          {runningLabel ?? '—'}
        </TableCell>
        <TableCell className="hidden text-muted-foreground sm:table-cell">
          {formatDateTime(release.createdAt)}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow id={detailsId} data-testid={`release-details-${release.id}`}>
          <TableCell colSpan={5} className="bg-muted/30">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 py-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Commit</dt>
                <dd className="mt-0.5 font-mono break-all">
                  {commitUrl ? (
                    <a
                      href={commitUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      {release.gitSha}
                      <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                    </a>
                  ) : (
                    release.gitSha
                  )}
                </dd>
              </div>
              <div className="sm:hidden">
                <dt className="text-xs text-muted-foreground">Running on</dt>
                <dd className="mt-0.5">{runningLabel ?? 'Nothing running'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5">
                  {formatDateTime(release.createdAt)}
                  {relativeTime(release.createdAt) ? (
                    <span className="text-muted-foreground"> · {relativeTime(release.createdAt)}</span>
                  ) : null}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Build status</dt>
                <dd className="mt-0.5">
                  {release.status === 'FAILED' ? (
                    <div className="flex flex-col gap-2">
                      <p>{releaseBuildFailureSummary(release.failureReason)}</p>
                      {release.failureReason ? (
                        <code className="block w-fit max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {release.failureReason}
                        </code>
                      ) : null}
                      <p className="text-muted-foreground">{RELEASE_FAILURE_NEXT_STEP}</p>
                    </div>
                  ) : release.status === 'UNAVAILABLE' ? (
                    <p>{RELEASE_UNAVAILABLE_COPY}</p>
                  ) : (
                    <p>{RELEASE_STATUS_EXPLANATION[release.status]}</p>
                  )}
                </dd>
              </div>
            </dl>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
