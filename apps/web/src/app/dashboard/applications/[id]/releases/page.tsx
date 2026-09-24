'use client';

import { ChevronRight, ExternalLink } from 'lucide-react';
import Link from 'next/link';
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
import { ReleaseFailureDetails } from '@/components/release-failure-details';
import { useApplicationPage } from '../application-page-context';
import { fetchDeploymentsForApplication, type FleetDeployment } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';
import {
  RELEASE_STATUS_BADGE,
  RELEASE_STATUS_EXPLANATION,
  RELEASE_UNAVAILABLE_COPY,
  releaseStatusLabel,
  fetchReleases,
  createRelease,
  formatReleaseCreatedAt,
  installReleaseState,
  installSummaryLine,
  newestFirst,
  runningOn,
  runningOnLabel,
  shortSha,
  suggestNextVersion,
  BuildConfigurationMissingError,
  type RunningOn,
  type Release,
} from '@/lib/releases';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  /** `deployments` is null when they could not be loaded: "Running on" then
   *  reads "Not determined" instead of the page failing. */
  | { status: 'loaded'; releases: Release[]; deployments: FleetDeployment[] | null };

export default function ReleasesPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const { data, refresh } = useApplicationPage();
  const repoFullName = data?.application.repoFullName ?? null;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [formOpen, setFormOpen] = useState(false);

  function openCreateForm(): void {
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [releases, deployments] = await Promise.all([
          fetchReleases(id),
          fetchDeploymentsForApplication(id).catch(() => null),
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
    // The header's release badge reads the same releases.
    void refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground" data-testid="release-install-summary">
          {state.status === 'loaded'
            ? installSummaryLine(state.releases)
            : 'Each release is an image built from one commit.'}
        </p>
        <Button className="shrink-0" onClick={() => setFormOpen((open) => !open)}>
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
        <ReleaseTable
          applicationId={id}
          releases={state.releases}
          deployments={state.deployments}
          repoFullName={repoFullName}
          onCreateRelease={openCreateForm}
        />
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
  const [missingBuildKeys, setMissingBuildKeys] = useState<string[] | null>(null);
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
    setMissingBuildKeys(null);
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
    } catch (err) {
      if (err instanceof BuildConfigurationMissingError) {
        setError(`Set these build values before you build a release: ${err.keys.join(', ')}.`);
        setMissingBuildKeys(err.keys);
      } else {
        setError("We couldn't create this release. Try again in a moment.");
      }
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
                {missingBuildKeys ? (
                  <>
                    {' '}
                    <Link
                      href={`/dashboard/applications/${applicationId}/config#environment-variables`}
                      className="underline underline-offset-4"
                    >
                      Review configuration
                    </Link>
                  </>
                ) : null}
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
  applicationId,
  releases,
  deployments,
  repoFullName,
  onCreateRelease,
}: {
  applicationId: string;
  releases: Release[];
  deployments: FleetDeployment[] | null;
  repoFullName: string | null;
  onCreateRelease: () => void;
}) {
  const install = installReleaseState(releases);
  const installableId = install.kind === 'ready' ? install.release.id : null;

  return (
    <Card className="py-0">
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
                applicationId={applicationId}
                release={release}
                isInstallable={release.id === installableId}
                running={deployments === null ? null : runningOn(deployments, release.id)}
                repoFullName={repoFullName}
                onCreateRelease={onCreateRelease}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** "Not determined" when the deployments could not be loaded. */
function runningText(running: RunningOn | null): string {
  if (running === null) return 'Not determined';
  return runningOnLabel(running) ?? 'Not running';
}

function ReleaseRow({
  applicationId,
  release,
  isInstallable,
  running,
  repoFullName,
  onCreateRelease,
}: {
  applicationId: string;
  release: Release;
  isInstallable: boolean;
  running: RunningOn | null;
  repoFullName: string | null;
  onCreateRelease: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `release-details-${release.id}`;
  const commitUrl = repoFullName ? `https://github.com/${repoFullName}/commit/${release.gitSha}` : null;
  const failed = release.status === 'FAILED';

  return (
    <>
      <TableRow data-testid={`release-row-${release.id}`} className={cn(open && 'border-b-0')}>
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
          <div className="flex flex-col items-start gap-1">
            <div className="flex items-center gap-1.5">
              <Badge variant={RELEASE_STATUS_BADGE[release.status]}>{releaseStatusLabel(release.status)}</Badge>
              {isInstallable ? <Badge variant="outline">Customer installs</Badge> : null}
            </div>
            {failed ? (
              <p className="text-xs text-muted-foreground" data-testid={`release-failure-${release.id}`}>
                {releaseBuildFailureSummary(release.failureReason)}
              </p>
            ) : null}
            {failed ? (
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => setOpen((current) => !current)}
                data-testid={`release-review-failure-${release.id}`}
              >
                {open ? 'Hide failure details' : 'Review failure details'}
              </Button>
            ) : null}
            {release.status === 'UNAVAILABLE' ? (
              <p className="text-xs text-muted-foreground">{RELEASE_UNAVAILABLE_COPY}</p>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="hidden text-muted-foreground sm:table-cell">{runningText(running)}</TableCell>
        <TableCell className="hidden text-muted-foreground sm:table-cell">
          <time dateTime={release.createdAt}>{formatReleaseCreatedAt(release.createdAt)}</time>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow id={detailsId} data-testid={`release-details-${release.id}`} className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/30 p-0 whitespace-normal">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 pt-3 text-sm sm:grid-cols-2">
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
                <dd className="mt-0.5">{runningText(running)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5">
                  {formatReleaseCreatedAt(release.createdAt)}
                  {relativeTime(release.createdAt) ? (
                    <span className="text-muted-foreground"> · {relativeTime(release.createdAt)}</span>
                  ) : null}
                </dd>
              </div>
              {release.status === 'FAILED' ? null : (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Build status</dt>
                  <dd className="mt-0.5">
                    {release.status === 'UNAVAILABLE' ? RELEASE_UNAVAILABLE_COPY : RELEASE_STATUS_EXPLANATION[release.status]}
                  </dd>
                </div>
              )}
            </dl>
            {failed ? (
              <ReleaseFailureDetails applicationId={applicationId} release={release} onCreateRelease={onCreateRelease} />
            ) : (
              <div className="pb-3" />
            )}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
