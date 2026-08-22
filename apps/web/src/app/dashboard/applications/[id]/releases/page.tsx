'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RELEASE_STATUS_BADGE,
  releaseStatusLabel,
  fetchReleases,
  type Release,
} from '@/lib/releases';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; releases: Release[] };

export default function ReleasesPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const releases = await fetchReleases(id);
        if (cancelled) return;
        setState(
          releases.length === 0
            ? { status: 'empty' }
            : { status: 'loaded', releases },
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

  return (
    <div className="flex flex-col gap-8">
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
        <Button>Create Release</Button>
      </div>

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
      {state.status === 'loaded' ? <ReleaseTable releases={state.releases} /> : null}
    </div>
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

function ReleaseTable({ releases }: { releases: Release[] }) {
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
