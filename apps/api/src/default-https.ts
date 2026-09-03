/**
 * Default-HTTPS state machine — Deployz-owned secure address for every
 * deployment (Phase 11). Reuses the relay's CONFIGURE_DOMAIN / REMOVE_DOMAIN
 * executors and job vocabulary (packages/relay/src/domain.ts) with a
 * Deployz-owned hostname (`<deploymentId>.apps.deployz.dev`) whose DNS lives
 * in a Deployz-controlled Route53 zone: the CONTROL PLANE writes the ACM
 * validation CNAME and the ALB routing CNAME itself (apps/api/src/
 * route53-records.ts), so the customer never owns or configures a domain.
 *
 * State is persisted in `deployments.default_https` — deliberately separate
 * from `custom_domains` (customer DNS). Statuses mirror the custom-domain
 * machine so the same relay outcomes drive it:
 *
 *   PENDING          a CONFIGURE_DOMAIN job is (or will be) requesting the cert
 *   WAITING_FOR_DNS  cert requested; validation + routing records written
 *   CONFIGURING      cert issued + 443 listener wired; HTTPS being probed
 *   ACTIVE           HTTPS verified reachable — the deployment's URL
 *   ERROR            last attempt failed; retried on the next driver pass
 *   REMOVING         destroy/remove in progress
 *
 * Driver cadence: the relay heartbeat (~5 min, the same existing background
 * cadence the custom-domain auto-check rides) plus one immediate kick after a
 * successful INSTALL result. All transitions are idempotent.
 */

import { and, desc, eq, like } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { findActiveDomain } from './domains.js';
import { createOrReuseJob } from './jobs.js';
import type { DnsRecordClient } from './route53-records.js';

// ── State shape ──────────────────────────────────────────────────────────────

export type DefaultHttpsStatus =
  | 'PENDING'
  | 'WAITING_FOR_DNS'
  | 'CONFIGURING'
  | 'ACTIVE'
  | 'ERROR'
  | 'REMOVING';

export interface DefaultHttpsState {
  /** The Deployz-owned hostname this deployment is issued for. */
  hostname: string;
  status: DefaultHttpsStatus;
  certificateArn?: string;
  validationName?: string;
  validationValue?: string;
  /** The ALB's DNS name the routing CNAME points at. */
  routingTarget?: string;
  checkCycle: number;
  lastError: string | null;
}

/** The default HTTPS apex in production — a Deployz-registered domain. */
export const DEFAULT_HTTPS_APEX = 'apps.deployz.dev';

/** The apex used under DNS fixture mode (E2E), mirroring
 *  createFixtureDomainCheckDeps's `.deployz-fixture.test` namespace. */
export const DEFAULT_HTTPS_FIXTURE_APEX = 'apps.deployz-fixture.test';

export function defaultHttpsHostname(deploymentId: string, apex: string): string {
  return `${deploymentId}.${apex}`;
}

const DEFAULT_HTTPS_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);

/** Narrow a persisted `deployments.default_https` jsonb value to the state
 *  shape, or null for anything unrecognisable. Pure — callable from the
 *  read-time status derivation. */
export function parseDefaultHttps(raw: unknown): DefaultHttpsState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['hostname'] !== 'string' || typeof record['status'] !== 'string') return null;
  if (!DEFAULT_HTTPS_STATUSES.has(record['status'])) return null;
  const readString = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const certificateArn = readString('certificateArn');
  const validationName = readString('validationName');
  const validationValue = readString('validationValue');
  const routingTarget = readString('routingTarget');
  const lastError = typeof record['lastError'] === 'string' ? record['lastError'] : null;
  return {
    hostname: record['hostname'],
    status: record['status'] as DefaultHttpsStatus,
    ...(certificateArn ? { certificateArn } : {}),
    ...(validationName ? { validationName } : {}),
    ...(validationValue ? { validationValue } : {}),
    ...(routingTarget ? { routingTarget } : {}),
    checkCycle: typeof record['checkCycle'] === 'number' ? record['checkCycle'] : 0,
    lastError,
  };
}

// ── Job identity ─────────────────────────────────────────────────────────────

/** Job idempotency keys for the default-HTTPS machine are namespaced so a
 *  result can be told apart from a custom-domain job of the SAME relay type
 *  (custom keys embed the custom_domains row's uuid instead). */
const JOB_KEY_PREFIX = 'default-https';

export function isDefaultHttpsJob(job: { idempotencyKey: string }): boolean {
  return job.idempotencyKey.includes(`:${JOB_KEY_PREFIX}:`);
}

function configureJobPrefix(deploymentId: string): string {
  return `${deploymentId}:CONFIGURE_DOMAIN:${JOB_KEY_PREFIX}:`;
}

function removeJobPrefix(deploymentId: string): string {
  return `${deploymentId}:REMOVE_DOMAIN:${JOB_KEY_PREFIX}:`;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function stateToRecord(state: DefaultHttpsState): Record<string, unknown> {
  return {
    hostname: state.hostname,
    status: state.status,
    ...(state.certificateArn ? { certificateArn: state.certificateArn } : {}),
    ...(state.validationName ? { validationName: state.validationName } : {}),
    ...(state.validationValue ? { validationValue: state.validationValue } : {}),
    ...(state.routingTarget ? { routingTarget: state.routingTarget } : {}),
    checkCycle: state.checkCycle,
    lastError: state.lastError,
  };
}

async function persistState(db: RuntimeDb, deploymentId: string, state: DefaultHttpsState): Promise<void> {
  await db
    .update(schema.deployments)
    .set({ defaultHttps: stateToRecord(state) })
    .where(eq(schema.deployments.id, deploymentId));
}

/** Load the deployment's current default-HTTPS state (always the freshest
 *  row — a caller-held copy can be stale across its own writes). */
async function reloadState(db: RuntimeDb, deploymentId: string): Promise<DefaultHttpsState | null> {
  const rows = await db
    .select({ defaultHttps: schema.deployments.defaultHttps })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  return parseDefaultHttps(rows[0]?.defaultHttps ?? null);
}

/** The newest job of the given type whose key is under this machine's prefix. */
async function newestMachineJob(
  db: RuntimeDb,
  deploymentId: string,
  type: 'CONFIGURE_DOMAIN' | 'REMOVE_DOMAIN',
  prefix: string,
): Promise<typeof schema.deploymentJobs.$inferSelect | undefined> {
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, type),
        like(schema.deploymentJobs.idempotencyKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  return jobs[0];
}

const IN_FLIGHT_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'RUNNING']);

/**
 * Ensures exactly one live CONFIGURE_DOMAIN job chases this deployment's
 * default HTTPS toward its next state — the same cycle bookkeeping as the
 * custom-domain `ensureConfigureJob`. A finished job at the current cycle
 * (or an explicit force) bumps the cycle so the relay sees a fresh
 * idempotency key instead of replaying a stale one.
 */
export async function ensureDefaultHttpsConfigureJob(
  db: RuntimeDb,
  deployment: { id: string },
  state: DefaultHttpsState,
  opts?: { forceNewCycle?: boolean },
): Promise<void> {
  const prefix = configureJobPrefix(deployment.id);
  const newest = await newestMachineJob(db, deployment.id, 'CONFIGURE_DOMAIN', prefix);
  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return;
  }
  const newestCycle = newest ? Number(newest.idempotencyKey.slice(prefix.length)) : undefined;
  const shouldBump = opts?.forceNewCycle === true || (newest !== undefined && newestCycle === state.checkCycle);
  const cycle = shouldBump ? state.checkCycle + 1 : state.checkCycle;
  if (shouldBump) {
    await db
      .update(schema.deployments)
      .set({ defaultHttps: { ...stateToRecord(state), checkCycle: cycle } })
      .where(eq(schema.deployments.id, deployment.id));
    state.checkCycle = cycle;
  }
  await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'CONFIGURE_DOMAIN',
    idempotencyKey: `${prefix}${cycle}`,
    payload: {
      hostname: state.hostname,
      domainId: deployment.id,
      ...(state.certificateArn ? { certificateArn: state.certificateArn } : {}),
    },
    requestedBy: null,
  });
}

/**
 * Marks the default-HTTPS machine REMOVING and ensures one live
 * REMOVE_DOMAIN job (the destroy route's analog of `removeCustomDomain`).
 * A repeat call reuses the in-flight job — never a retry storm.
 */
export async function beginDefaultHttpsRemoval(
  db: RuntimeDb,
  deployment: { id: string },
  state: DefaultHttpsState,
): Promise<void> {
  const prefix = removeJobPrefix(deployment.id);
  const newest = await newestMachineJob(db, deployment.id, 'REMOVE_DOMAIN', prefix);
  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return;
  }
  const shouldBump = state.status !== 'REMOVING' || newest?.state === 'FAILED';
  const cycle = shouldBump ? state.checkCycle + 1 : state.checkCycle;
  if (state.status !== 'REMOVING' || shouldBump) {
    const updated: DefaultHttpsState = { ...state, status: 'REMOVING', checkCycle: cycle, lastError: null };
    await db
      .update(schema.deployments)
      .set({ defaultHttps: stateToRecord(updated) })
      .where(eq(schema.deployments.id, deployment.id));
    state.status = 'REMOVING';
    state.checkCycle = cycle;
  }
  await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'REMOVE_DOMAIN',
    idempotencyKey: `${prefix}${cycle}`,
    payload: {
      hostname: state.hostname,
      domainId: deployment.id,
      ...(state.certificateArn ? { certificateArn: state.certificateArn } : {}),
    },
    requestedBy: null,
  });
}

// ── Result application ───────────────────────────────────────────────────────

/**
 * Applies one relay job result to the deployment's default-HTTPS state.
 * Called from the relay result route ONLY for jobs whose idempotency key
 * is this machine's (`isDefaultHttpsJob`), in the same transaction that
 * finishes the job row.
 */
export async function applyDefaultHttpsJobResult(
  tx: RuntimeDb,
  deploymentId: string,
  job: { type: string },
  body: { success?: boolean; error?: string; output?: Record<string, unknown>; failureCode?: string },
): Promise<void> {
  const state = await reloadState(tx, deploymentId);
  if (!state) {
    return;
  }
  const isSuccess = body.success !== false;

  if (job.type === 'REMOVE_DOMAIN') {
    if (isSuccess) {
      await tx.update(schema.deployments).set({ defaultHttps: null }).where(eq(schema.deployments.id, deploymentId));
    } else if (state.status === 'REMOVING') {
      await persistState(tx, deploymentId, { ...state, lastError: 'REMOVE_FAILED' });
    }
    return;
  }

  // CONFIGURE_DOMAIN
  if (state.status === 'REMOVING') {
    // A stale configure outcome no longer applies once removal has started.
    return;
  }
  if (!isSuccess) {
    if (state.status === 'ACTIVE') {
      // A late/stale configure failure must never knock a live endpoint
      // offline — it is already serving traffic.
      return;
    }
    const lastError = body.failureCode === 'AWS_PERMISSION_DENIED' ? 'AWS_PERMISSION_DENIED' : 'CONFIGURE_FAILED';
    await persistState(tx, deploymentId, { ...state, status: 'ERROR', lastError });
    return;
  }

  const output = body.output ?? {};
  const update: DefaultHttpsState = { ...state };
  let changed = false;
  for (const field of ['certificateArn', 'validationName', 'validationValue', 'routingTarget'] as const) {
    const value = output[field];
    if (typeof value === 'string' && value.length > 0 && value !== update[field]) {
      update[field] = value;
      changed = true;
    }
  }
  const validationKnown = Boolean(update.validationName && update.validationValue);

  let nextStatus: DefaultHttpsStatus | undefined;
  if (state.status === 'PENDING' && validationKnown) {
    nextStatus = 'WAITING_FOR_DNS';
  }
  const statusForHttpsCheck = nextStatus ?? state.status;
  if (
    output.certificateStatus === 'ISSUED' &&
    output.httpsConfigured === true &&
    (statusForHttpsCheck === 'PENDING' || statusForHttpsCheck === 'WAITING_FOR_DNS')
  ) {
    nextStatus = 'CONFIGURING';
  }
  if (nextStatus) {
    update.status = nextStatus;
    update.lastError = null;
    changed = true;
  }
  if (changed) {
    await persistState(tx, deploymentId, update);
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

export interface DefaultHttpsDeps {
  /** Off switch: default HTTPS runs only when the control plane is configured
   *  with a Route53 zone (or under DNS fixture mode). */
  enabled: boolean;
  /** The DNS apex the deployz hostname is minted under. */
  apex: string;
  /** Route53 record writer (real client in production, no-op in fixture mode). */
  dns: DnsRecordClient;
  /** HTTPS reachability probe — the same seam runDomainCheck uses. */
  probeHttps: (hostname: string) => Promise<boolean>;
}

const EVER_INSTALLED_STATES = new Set<string>(['HEALTHY', 'UPDATING', 'UPDATE_AVAILABLE']);

/** Deployment states with no ALB/relay to serve HTTPS — same gating the
 *  custom-domain machine applies. */
const NOT_RUNNING_STATES = new Set<string>(['FAILED', 'DELETING', 'DELETED', 'NOT_INSTALLED', 'WAITING_FOR_RELAY']);

/**
 * Drives the deployment's default HTTPS one step forward. Idempotent and
 * safe to call on every relay heartbeat (plus once after a successful
 * INSTALL result): any in-flight job blocks a duplicate, every write is an
 * upsert, and the state machine's own statuses gate the transitions.
 */
export async function runDefaultHttpsCheck(
  db: RuntimeDb,
  deployment: {
    id: string;
    state: (typeof schema.deployments.$inferSelect)['state'];
    currentReleaseId?: string | null;
  },
  deps: DefaultHttpsDeps,
): Promise<void> {
  if (!deps.enabled) {
    return;
  }
  // A failed day-2 operation with a current release keeps serving behind its
  // ALB, so HTTPS keeps being driven exactly like the custom-domain check.
  const notRunning =
    NOT_RUNNING_STATES.has(deployment.state) &&
    !(deployment.state === 'FAILED' && (deployment.currentReleaseId ?? null) !== null);
  if (notRunning || !EVER_INSTALLED_STATES.has(deployment.state)) {
    return;
  }

  const state = await reloadState(db, deployment.id);
  const custom = await findActiveDomain(db, deployment.id);
  const customServing = custom?.status === 'ACTIVE' || custom?.status === 'CONFIGURING';

  if (!state) {
    // Nothing requested yet. Skip while a custom domain is the serving URL —
    // a per-deployment cert that will never be the primary URL is pure waste.
    if (customServing) {
      return;
    }
    const initial: DefaultHttpsState = {
      hostname: defaultHttpsHostname(deployment.id, deps.apex),
      status: 'PENDING',
      checkCycle: 0,
      lastError: null,
    };
    await persistState(db, deployment.id, initial);
    await ensureDefaultHttpsConfigureJob(db, deployment, initial);
    return;
  }

  let working: DefaultHttpsState = state;
  while (working.status !== 'ACTIVE' && working.status !== 'REMOVING') {
    switch (working.status) {
      case 'PENDING':
        await ensureDefaultHttpsConfigureJob(db, deployment, working);
        return;
      case 'WAITING_FOR_DNS': {
        if (!working.validationName || !working.validationValue || !working.routingTarget) {
          // The cert was requested but the relay has not yet reported the
          // validation record — nudge it to describe the cert again.
          await ensureDefaultHttpsConfigureJob(db, deployment, working, { forceNewCycle: true });
          return;
        }
        try {
          await deps.dns.upsertCname(working.validationName, working.validationValue);
          await deps.dns.upsertCname(working.hostname, working.routingTarget);
        } catch {
          await persistState(db, deployment.id, { ...working, lastError: 'DNS_WRITE_FAILED' });
          return;
        }
        working = { ...working, lastError: null };
        await persistState(db, deployment.id, working);
        // DNS is in place — nudge the relay to re-describe the cert and wire
        // the 443 listener once ACM issues it.
        await ensureDefaultHttpsConfigureJob(db, deployment, working, { forceNewCycle: true });
        return;
      }
      case 'CONFIGURING':
        if (await deps.probeHttps(working.hostname)) {
          working = { ...working, status: 'ACTIVE', lastError: null };
          await persistState(db, deployment.id, working);
        } else {
          await persistState(db, deployment.id, { ...working, lastError: 'HTTPS_NOT_REACHABLE' });
        }
        return;
      case 'ERROR': {
        // Automatic retry: fall back to the earliest still-plausible stage
        // and re-run, mirroring the custom-domain Retry path.
        working = {
          ...working,
          status: working.validationName ? 'WAITING_FOR_DNS' : 'PENDING',
          lastError: null,
        };
        await persistState(db, deployment.id, working);
        continue;
      }
    }
  }
}
