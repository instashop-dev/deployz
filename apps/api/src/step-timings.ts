import { DEPLOYMENT_STEP_ORDER, type DeploymentStep } from '@deployz/contracts';

import type { DerivedDeploymentStatus } from './deployment-status.js';

// Persisted, write-once step telemetry (deployments.step_timings) — NOT a
// lifecycle. `deriveDeploymentStatus` already knows, at read time, which
// step is active and (via its resolution ladder) when it started; this
// module's only job is to turn that read-time answer into the smallest
// durable record that lets a later screen show "took 3m 12s" instead of
// re-deriving elapsed time from scratch. Pure, like deployment-status.ts:
// given the same (previous, derived, now) it always returns the same
// result, so it is unit-testable with plain object literals.

/** One step's persisted timestamps. `completedAt` absent means still active (or never reached). */
export interface StepTimingRecord {
  startedAt: string;
  completedAt?: string;
}

/** The shape of deployments.step_timings — keyed by DeploymentStep, sparse (only reached steps appear). */
export type StepTimings = Record<string, StepTimingRecord>;

/** One step newly completed by this call — the shape recordEvent's 'deployment.step_completed' payload carries. */
export interface CompletedStepTiming {
  step: DeploymentStep;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
}

export interface AdvanceStepTimingsResult {
  /** The updated map to persist — identical to `previous` (same reference-safe shape) when `changed` is false. */
  next: StepTimings;
  /** Whether `next` differs from `previous` — callers should skip the write/events when false. */
  changed: boolean;
  /** Steps that gained a completedAt during THIS call, in canonical order — the ones worth an event. */
  completedSteps: CompletedStepTiming[];
}

/**
 * Advances a deployment's persisted step timings against its freshly-derived
 * status. Two rules, applied in order:
 *
 *   1. The active step (`derived.step`) gets a `startedAt` if it does not
 *      already have one — preferring the derivation's own `stepStartedAt`
 *      (which already prefers authoritative timestamps over "now") and
 *      falling back to `now` only when nothing authoritative is known.
 *   2. Every step in `derived.steps` ordered BEFORE the active one that has
 *      a `startedAt` but no `completedAt` gets one — preferring the relay
 *      provisioning snapshot's own completion time
 *      (`derived.stepSnapshotCompletedAt`), else the active step's
 *      `startedAt` (the step ended when the next one began).
 *
 * An existing value is NEVER rewritten — once a step has a timestamp, this
 * function only ever fills in what is still missing. Rule 2 is skipped
 * entirely on a FAILED stage or a removed deployment: an interruption is not
 * a completion, and backfilling one would misrepresent what actually
 * happened to whatever later reads this data for a duration average.
 */
export function advanceStepTimings(
  previous: StepTimings | null | undefined,
  derived: DerivedDeploymentStatus,
  now: Date,
): AdvanceStepTimingsResult {
  const next: StepTimings = { ...(previous ?? {}) };
  let changed = false;
  const completedSteps: CompletedStepTiming[] = [];

  const activeStep = derived.step;
  const activeStartedAt = next[activeStep]?.startedAt ?? derived.stepStartedAt ?? now.toISOString();
  if (!next[activeStep]?.startedAt) {
    next[activeStep] = { ...next[activeStep], startedAt: activeStartedAt };
    changed = true;
  }

  const skipCompletion = derived.stage === 'FAILED' || derived.removed !== undefined;
  if (!skipCompletion) {
    const activeIndex = DEPLOYMENT_STEP_ORDER.indexOf(activeStep);
    for (const step of derived.steps) {
      if (DEPLOYMENT_STEP_ORDER.indexOf(step) >= activeIndex) continue;
      const entry = next[step];
      if (!entry?.startedAt || entry.completedAt) continue;

      const completedAt = derived.stepSnapshotCompletedAt[step] ?? activeStartedAt;
      next[step] = { ...entry, completedAt };
      changed = true;
      completedSteps.push({
        step,
        startedAt: entry.startedAt,
        completedAt,
        durationSeconds: Math.round((new Date(completedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000),
      });
    }
  }

  return { next, changed, completedSteps };
}
