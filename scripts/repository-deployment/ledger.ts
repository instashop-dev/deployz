/**
 * The in-flight ledger of a real-AWS attempt — the version canary's
 * `Evidence` (run.json + per-step files) under `runs/evidence/<run id>/`,
 * gitignored, extended with the Stage B fields. Everything cleanup and
 * resume key on is written the moment it is known. The committed result
 * (`results.ts`) is derived from it at the end.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mintRunId, type CanaryConfig } from '../version-canary/config.js';
import { Evidence, type RunRecord } from '../version-canary/evidence.js';

export interface StageBRunRecord extends RunRecord {
  stageB: {
    repoId: string;
    repository: string;
    commit: string;
    deployzCommit: string;
    /** The organization created for this attempt (one application per repo per org). */
    organizationId?: string;
    templateSource?: 'production-default' | 'stage-b-generic' | 'stage-b-pinned';
    templateUrl?: string;
    /** Set once cleanup has fully completed (destroy, purge, leftovers, audit). */
    cleanupCompletedAt?: string;
    /** Set when the attempt is abandoned to cleanup (a failure or an interrupt). */
    cleanupNeeded: boolean;
    keys?: string[];
    generatedKeys?: string[];
  };
}

export function stageBRunId(repoId: string, now = new Date()): string {
  return `stage-b-${repoId}-${mintRunId(now)}`;
}

export function openLedger(evidenceDir: string, config: CanaryConfig, input: StageBRunRecord['stageB'], runId: string): Evidence {
  const run: StageBRunRecord = {
    runId,
    startedAt: new Date().toISOString(),
    apiUrl: config.apiUrl,
    region: config.region,
    accountId: config.expectedAccountId,
    scenario: 'stage-b',
    releases: {},
    markers: [],
    jobs: [],
    steps: [],
    stageB: input,
  };
  return new Evidence(evidenceDir, run);
}

export function stageBRun(evidence: Evidence): StageBRunRecord {
  return evidence.run as StageBRunRecord;
}

/** Ledgers whose cleanup has not completed — what `--resume` must finish first. */
export function listUnfinishedLedgers(evidenceDir: string): { runId: string; repoId: string; path: string }[] {
  if (!existsSync(evidenceDir)) return [];
  const out: { runId: string; repoId: string; path: string }[] = [];
  for (const name of readdirSync(evidenceDir).sort()) {
    const path = join(evidenceDir, name, 'run.json');
    if (!existsSync(path)) continue;
    const run = JSON.parse(readFileSync(path, 'utf8')) as Partial<StageBRunRecord>;
    if (!run.stageB || run.stageB.cleanupCompletedAt) continue;
    if (!run.stageB.cleanupNeeded && run.result === undefined) continue;
    out.push({ runId: run.runId ?? name, repoId: run.stageB.repoId, path });
  }
  return out;
}

/** Series-level state shared by every attempt: the vendor session and the published Stage B templates. */
export interface SeriesState {
  vendor?: { email: string; password: string };
  templates: Record<string, { url: string; keyPrefix: string; bucket: string }>;
}

export function readSeries(evidenceDir: string): SeriesState {
  const path = join(evidenceDir, 'series.json');
  if (!existsSync(path)) return { templates: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as SeriesState;
}

export function writeSeries(evidenceDir: string, state: SeriesState): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'series.json'), `${JSON.stringify(state, null, 2)}\n`);
}
