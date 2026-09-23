'use client';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

import { useApplicationPage } from './application-page-context';

// Compact, state-aware header: name, one overall status badge, and a single
// muted metadata line. Everything reads from `presentation` — no interpreting
// `analysisStatus` or a deployment `state` here.
export function ApplicationHeader() {
  const { data, loading, presentation } = useApplicationPage();

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2">
        <h1 id="app-name" className="text-2xl font-semibold tracking-tight">
          Application
        </h1>
        <Badge variant={presentation.badge.variant} data-testid="application-status-badge">
          {presentation.badge.label}
        </Badge>
      </div>
    );
  }

  const { application, readiness } = data;
  const commit = readiness.analyzedCommitSha ? readiness.analyzedCommitSha.slice(0, 7) : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <h1 id="app-name" className="text-2xl font-semibold tracking-tight">
          {application.name}
        </h1>
        <Badge variant={presentation.badge.variant} data-testid="application-status-badge">
          {presentation.badge.label}
        </Badge>
        {presentation.releaseBadge ? (
          <Badge variant={presentation.releaseBadge.variant} data-testid="application-release-badge">
            {presentation.releaseBadge.label}
          </Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {application.repoFullName}
        {commit ? ` · commit ${commit}` : ''}
      </p>
    </div>
  );
}
