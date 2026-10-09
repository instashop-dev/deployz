'use client';

import { Check, ChevronDown, CircleAlert, CircleX } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { preflightPresentation, type PreflightCheck, type PreflightResult } from '@/lib/preflight';
import { TONE_TEXT, type Tone } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

// Preflight summary (AI MVP Phase 5) — the deterministic pre-deployment gate
// rendered as one status line. Blocked and recommended checks always show
// under it; passed checks stay behind "View details". The API enforces the
// same gate; this only shows it earlier.

// Routes the preflight tones through the shared tone system: ready is
// green, warnings amber, blocked red — always paired with the label text.
const PREFLIGHT_TONE: Record<'ready' | 'attention' | 'blocked', Tone> = {
  ready: 'positive',
  attention: 'attention',
  blocked: 'negative',
};

const STATUS_ORDER: Record<PreflightCheck['status'], number> = { blocked: 0, warning: 1, passed: 2 };

const STATUS_TONE: Record<PreflightCheck['status'], Tone> = {
  blocked: 'negative',
  warning: 'attention',
  passed: 'positive',
};

const STATUS_LABEL: Record<PreflightCheck['status'], string> = {
  blocked: 'Fix before deploying',
  warning: 'Recommended',
  passed: 'Passed',
};

function StatusIcon({ status }: { status: PreflightCheck['status'] }) {
  const className = cn('size-4 shrink-0', TONE_TEXT[STATUS_TONE[status]]);
  if (status === 'blocked') return <CircleX aria-hidden className={className} />;
  if (status === 'warning') return <CircleAlert aria-hidden className={className} />;
  return <Check aria-hidden className={className} />;
}

export function PreflightSummary({ result }: { result: PreflightResult }) {
  const [open, setOpen] = useState(false);
  const checks = [...result.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const attention = checks.filter((check) => check.status !== 'passed');
  const passed = checks.filter((check) => check.status === 'passed');
  const presentation = preflightPresentation(result, passed.length);
  const tone = PREFLIGHT_TONE[presentation.tone];
  const headingStatus: PreflightCheck['status'] =
    presentation.tone === 'blocked' ? 'blocked' : presentation.tone === 'attention' ? 'warning' : 'passed';

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col gap-2"
      data-testid="preflight-summary"
      data-state={result.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <StatusIcon status={headingStatus} />
          <span className={TONE_TEXT[tone]} data-testid="preflight-heading">
            {presentation.heading}
          </span>
        </p>
        {passed.length > 0 ? (
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              {open ? 'Hide details' : 'View details'}
              <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      {attention.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="preflight-attention">
          {attention.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      ) : null}
      <CollapsibleContent>
        <ul className="flex flex-col gap-2" data-testid="preflight-passed">
          {passed.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CheckRow({ check }: { check: PreflightCheck }) {
  return (
    <li className="flex items-start gap-2 text-sm" data-testid={`preflight-check-${check.id}`}>
      <StatusIcon status={check.status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {check.label}
          <span className="sr-only"> — {STATUS_LABEL[check.status]}</span>
        </span>
        {check.detail ? <span className="break-words text-xs text-muted-foreground">{check.detail}</span> : null}
      </div>
    </li>
  );
}
