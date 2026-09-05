'use client';

import { Check, ChevronDown, CircleAlert, CircleX } from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { preflightPresentation, type PreflightCheck, type PreflightResult } from '@/lib/preflight';
import { cn } from '@/lib/utils';

// Preflight summary (AI MVP Phase 5) — the deterministic pre-deployment gate
// rendered as one headline and the list of checks: passed, recommended,
// blocked. Shown before a deployment is created and beside the install
// link. The API enforces the same gate; this only shows it earlier.

const TONE_DOT = {
  ready: 'bg-primary',
  attention: 'bg-muted-foreground',
  blocked: 'bg-destructive',
} as const;

const TONE_HEADING = {
  ready: 'text-primary',
  attention: 'text-foreground',
  blocked: 'text-destructive',
} as const;

const STATUS_ORDER: Record<PreflightCheck['status'], number> = { blocked: 0, warning: 1, passed: 2 };

function StatusIcon({ status }: { status: PreflightCheck['status'] }) {
  if (status === 'blocked') return <CircleX aria-hidden className="size-4 shrink-0 text-destructive" />;
  if (status === 'warning') return <CircleAlert aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  return <Check aria-hidden className="size-4 shrink-0 text-primary" />;
}

const STATUS_LABEL: Record<PreflightCheck['status'], string> = {
  blocked: 'Fix before deploying',
  warning: 'Recommended',
  passed: 'Passed',
};

export function PreflightSummary({ result, title = 'Deployment preflight' }: { result: PreflightResult; title?: string }) {
  const presentation = preflightPresentation(result);
  const checks = [...result.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const attention = checks.filter((check) => check.status !== 'passed');
  const passed = checks.filter((check) => check.status === 'passed');

  return (
    <Card data-testid="preflight-summary" data-state={result.state}>
      <CardHeader>
        <p className="text-sm font-semibold">{title}</p>
        <div className="flex items-center gap-2.5">
          <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', TONE_DOT[presentation.tone])} />
          <h3 className={cn('font-heading text-base font-medium', TONE_HEADING[presentation.tone])} data-testid="preflight-heading">
            {presentation.heading}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground" data-testid="preflight-support">
          {presentation.summary}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {attention.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="preflight-attention">
            {attention.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </ul>
        ) : null}
        {passed.length > 0 ? (
          <details className="group rounded-lg border" data-testid="preflight-passed" open={attention.length === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              Passed checks ({passed.length})
              <ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <ul className="flex flex-col gap-2 border-t px-3 py-2.5">
              {passed.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CheckRow({ check }: { check: PreflightCheck }) {
  return (
    <li className="flex items-start gap-2 text-sm" data-testid={`preflight-check-${check.id}`}>
      <StatusIcon status={check.status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{check.label}</span>
          <span className={cn('text-xs', check.status === 'blocked' ? 'text-destructive' : 'text-muted-foreground')}>
            {STATUS_LABEL[check.status]}
          </span>
        </span>
        {check.detail ? <span className="break-words text-xs text-muted-foreground">{check.detail}</span> : null}
      </div>
    </li>
  );
}
