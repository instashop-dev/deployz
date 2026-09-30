'use client';

import { MoreHorizontal, RefreshCw } from 'lucide-react';

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';

import { useApplicationPage } from './application-page-context';

// Compact, state-aware header: name, one overall status badge, a single
// muted metadata line, and the "More actions" overflow menu. Everything
// reads from `presentation` — no interpreting `analysisStatus` or a
// deployment `state` here.
export function ApplicationHeader() {
  const { data, loading, presentation, reanalyse, reanalysing } = useApplicationPage();

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  const analysing = presentation.state === 'analysing';

  if (!data) {
    return (
      <div className="flex items-center gap-2">
        <h1 id="app-name" className="text-2xl font-semibold tracking-tight">
          Application
        </h1>
        <Badge variant={presentation.badge.variant} data-testid="application-status-badge">
          {presentation.badge.label}
        </Badge>
        <HeaderActionsMenu reanalyse={reanalyse} reanalysing={reanalysing} analysing={analysing} />
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
        <HeaderActionsMenu reanalyse={reanalyse} reanalysing={reanalysing} analysing={analysing} />
      </div>
      <p className="text-sm text-muted-foreground">
        {application.repoFullName}
        {commit ? ` · commit ${commit}` : ''}
      </p>
      {readiness.analysisOutdated && !analysing ? (
        <Alert className="mt-2 pr-28" data-testid="application-analysis-outdated">
          <RefreshCw aria-hidden />
          <AlertTitle>Checks have been updated</AlertTitle>
          <AlertDescription>
            Deployz has improved its checks since this application was last analysed. Re-analyse to apply them.
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={reanalysing}
              onClick={() => void reanalyse()}
              data-testid="application-analysis-outdated-reanalyse"
            >
              Re-analyse
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </div>
  );
}

// Re-analyse's home in normal states (ux-guidelines §3). Disabled while an
// analysis is already running.
function HeaderActionsMenu({
  reanalyse,
  reanalysing,
  analysing,
}: {
  reanalyse: () => Promise<void>;
  reanalysing: boolean;
  analysing: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="outline" aria-label="More actions" className="ml-auto">
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={analysing || reanalysing}
          onSelect={() => void reanalyse()}
          data-testid="application-header-reanalyse"
        >
          Re-analyse application
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
