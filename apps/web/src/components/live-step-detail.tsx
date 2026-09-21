'use client';

import { useEffect, useState } from 'react';

import { checkedLabel, elapsedLabel, liveDurationLine } from '@/lib/deployment-progress';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

/**
 * The customer install page's ticking detail under the active step: what
 * Deployz is doing right now, the typical-duration or slow-step line with a
 * live elapsed counter, and when Deployz last checked. Shared by every
 * long-running step (AWS setup, relay connect, preparing, network,
 * database/storage, cache, migration, starting application, health check,
 * HTTPS) — only the active step ever renders it, so there is never more than
 * one 1-second ticker running at a time. `active` stops the ticker once the
 * stage is terminal, since nothing is left to count.
 */
export function LiveStepDetail({
  currentActivity,
  takingLongerThanUsual,
  typicalDurationSeconds,
  stepStartedAt,
  checkedAt,
  active,
}: {
  currentActivity: string;
  takingLongerThanUsual: boolean;
  typicalDurationSeconds: { min: number; max: number } | null;
  stepStartedAt: string | null;
  checkedAt: number | null;
  active: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const elapsed = elapsedLabel(stepStartedAt, now);
  const durationLine = liveDurationLine({ takingLongerThanUsual, typicalDurationSeconds, elapsed });
  const checked = checkedLabel(checkedAt, now);

  return (
    <>
      <span className="block">{currentActivity}</span>
      {durationLine ? (
        // The slow-step sentence is a warning: it gets the attention tone so
        // it reads as amber, not as another muted timing line.
        <span className={cn('block', takingLongerThanUsual && TONE_TEXT.attention)}>{durationLine}</span>
      ) : null}
      {checked ? <span className="block">{checked}</span> : null}
    </>
  );
}
