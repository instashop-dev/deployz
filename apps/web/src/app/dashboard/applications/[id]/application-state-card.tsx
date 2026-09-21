'use client';

import { ArrowUpRight, Check, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { InstallLinkControls } from '@/components/public-install-link-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import type {
  ApplicationAction,
  ApplicationActionId,
  ApplicationPresentation,
  SetupLifecycleItem,
} from '@/lib/application-state';
import { cn } from '@/lib/utils';

/** The test ids the old readiness page shipped, kept so existing tests and
 *  muscle memory still find the same controls under their old names. */
const ACTION_TEST_IDS: Partial<Record<ApplicationActionId, string>> = {
  analyse: 'readiness-analyze',
  'retry-analysis': 'readiness-retry',
  'restart-analysis': 'readiness-restart',
  'start-test': 'readiness-create-test',
  'view-progress': 'readiness-view-deployment',
  'continue-test': 'readiness-view-deployment',
  'view-test-deployment': 'readiness-view-deployment',
  'review-configuration': 'readiness-review-blocker',
};

const REANALYSE_LOADING_TEXT: Partial<Record<ApplicationActionId, string>> = {
  analyse: 'Analysing application…',
  'retry-analysis': 'Retrying analysis…',
  'restart-analysis': 'Restarting analysis…',
};

interface ApplicationStateCardProps {
  applicationId: string;
  presentation: ApplicationPresentation;
  refresh: () => Promise<void>;
  reanalyse: () => Promise<void>;
  reanalysing: boolean;
}

/**
 * The one state-aware card on the Overview tab. Every word and every action
 * comes from `presentation` — nothing here re-derives readiness or
 * deployment state on its own.
 */
export function ApplicationStateCard({
  applicationId,
  presentation,
  refresh,
  reanalyse,
  reanalysing,
}: ApplicationStateCardProps) {
  const [retryingLoad, setRetryingLoad] = useState(false);

  async function handleRetryLoad(): Promise<void> {
    setRetryingLoad(true);
    try {
      await refresh();
    } finally {
      setRetryingLoad(false);
    }
  }

  function renderAction(item: ApplicationAction, variant: 'default' | 'outline'): ReactNode {
    const testId = ACTION_TEST_IDS[item.id];

    if (item.id === 'retry-load') {
      return (
        <Button
          key={item.id}
          variant={variant}
          onClick={() => void handleRetryLoad()}
          loading={retryingLoad}
          loadingText="Trying again…"
          data-testid={testId}
        >
          {item.label}
        </Button>
      );
    }

    if (item.id === 'analyse' || item.id === 'retry-analysis' || item.id === 'restart-analysis') {
      return (
        <Button
          key={item.id}
          variant={variant}
          onClick={() => void reanalyse()}
          loading={reanalysing}
          loadingText={REANALYSE_LOADING_TEXT[item.id]}
          data-testid={testId}
        >
          {item.label}
        </Button>
      );
    }

    // The install-link controls (rendered separately below) already offer
    // create/copy/preview for the link — never render a second control for
    // the same action here.
    if (item.id === 'copy-install-link' || item.id === 'create-install-link' || item.id === 'preview-install-link') {
      return null;
    }

    if (!item.href) return null;

    if (item.external) {
      return (
        <Button key={item.id} variant={variant} asChild data-testid={testId}>
          <a href={item.href} target="_blank" rel="noreferrer">
            {item.label}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
        </Button>
      );
    }

    return (
      <Button key={item.id} variant={variant} asChild data-testid={testId}>
        <Link href={item.href}>{item.label}</Link>
      </Button>
    );
  }

  const showReadinessSummary =
    (presentation.state === 'ready-to-share' || presentation.state === 'customers-active') &&
    presentation.readinessSummary !== null;

  const hasFooterContent =
    presentation.installLinkPlacement === 'primary' ||
    presentation.primaryAction !== null ||
    presentation.secondaryActions.length > 0;

  return (
    <Card aria-busy={presentation.busy || undefined}>
      <CardHeader>
        <h2
          id="application-state-heading"
          data-testid="application-state-heading"
          aria-live="polite"
          className="flex items-center gap-2 font-heading text-base leading-snug font-medium"
        >
          {presentation.busy ? <Spinner aria-hidden className="size-4 text-primary" /> : null}
          {presentation.heading}
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{presentation.message}</p>

        {presentation.notices.map((notice, index) => (
          <Alert key={index} variant={notice.tone === 'error' ? 'destructive' : 'default'}>
            <TriangleAlert aria-hidden />
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ))}

        {presentation.state === 'configuration-required' && presentation.blockers.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {presentation.blockers.slice(0, 5).map((blocker) => (
              <li key={blocker.id}>{blocker.title}</li>
            ))}
            {presentation.blockers.length > 5 ? <li>and {presentation.blockers.length - 5} more</li> : null}
          </ul>
        ) : null}

        {showReadinessSummary ? (
          <p className="text-xs text-muted-foreground">
            {presentation.readinessSummary}
            {presentation.recommendationCount > 0 ? (
              <>
                {' · '}
                <Link
                  href={`/dashboard/applications/${applicationId}/config`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {presentation.recommendationCount}{' '}
                  {presentation.recommendationCount === 1 ? 'recommendation' : 'recommendations'}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        {presentation.lifecycle ? <SetupLifecycle items={presentation.lifecycle} /> : null}
      </CardContent>
      {hasFooterContent ? (
        <CardFooter className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {presentation.installLinkPlacement === 'primary' ? (
            <InstallLinkControls
              applicationId={applicationId}
              installLink={presentation.installLink}
              onChanged={refresh}
              primary
            />
          ) : presentation.primaryAction ? (
            renderAction(presentation.primaryAction, 'default')
          ) : null}
          {presentation.secondaryActions.map((secondaryAction) => renderAction(secondaryAction, 'outline'))}
        </CardFooter>
      ) : null}
    </Card>
  );
}

function SetupLifecycle({ items }: { items: SetupLifecycleItem[] }) {
  return (
    <ol
      aria-label="Setup progress"
      data-testid="lifecycle-steps"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
    >
      {items.map((item, index) => {
        const isDone = item.state === 'done';
        const isCurrent = item.state === 'current';
        const isFailed = item.state === 'failed';
        return (
          <li key={item.step} aria-current={isCurrent ? 'step' : undefined} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.65rem] font-medium',
                isDone
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : isFailed
                    ? 'border-destructive text-destructive'
                    : isCurrent
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground',
              )}
            >
              {isDone ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={isCurrent ? 'font-medium' : 'text-muted-foreground'}>
              {item.step}
              <span className="sr-only">
                {' '}
                {isDone ? '(done)' : isFailed ? '(failed)' : isCurrent ? '(current)' : '(pending)'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
