/**
 * Default-HTTPS state machine — Deployz-owned secure address for every
 * deployment (Phase 11). Reuses the relay's CONFIGURE_DOMAIN / REMOVE_DOMAIN
 * executors and job vocabulary (packages/relay/src/domain.ts) with a
 * Deployz-owned hostname (`d-<deploymentId>.deployz.dev`) whose DNS lives in a
 * Deployz-controlled zone: the CONTROL PLANE writes the ACM validation CNAME
 * and the ALB routing CNAME itself through the deployment-keyed Cloudflare
 * DNS client (apps/api/src/cloudflare-records.ts), so the customer never owns
 * or configures a domain.
 *
 * State is persisted in `deployments.default_https` — deliberately separate
 * from `custom_domains` (customer DNS). Statuses mirror the custom-domain
 * machine so the same relay outcomes drive it:
 *
 *   PENDING          a CONFIGURE_DOMAIN job is (or will be) requesting the cert
 *   WAITING_FOR_DNS  cert requested; validation + routing records written
 *   CONFIGURING      cert issued + 443 listener wired; HTTPS being probed
 *   ACTIVE           HTTPS verified reachable — the deployment's URL
 *   ERROR            last attempt failed; terminal — explicit vendor retry required
 *   REMOVING         destroy/remove in progress
 *
 * Driver cadence: the relay heartbeat (~5 min, the same existing background
 * cadence the custom-domain auto-check rides) plus one immediate kick after a
 * successful INSTALL result. All transitions are idempotent.
 */

import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import {
  attachCertificateResultSchema,
  legacyDefaultDeploymentHostname,
  parseLegacyDefaultDeploymentHostname,
  parseScopedDeploymentHostname,
  scopedDeploymentHostname,
} from '@deployz/contracts';

import type { CloudflareDnsClient } from './cloudflare-records.js';
import type { HttpsProbeResult } from './domain-check.js';
import { createOrReuseJob } from './jobs.js';
import { recordDefaultHttpsEvent, type RegionalCertificateRow } from './regional-certificates.js';

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
  /** ISO timestamp of the last DNS-reconciliation attempt (success or failure). */
  lastDnsCheckAt?: string;
  /** Phase 12 watchdog — configure attempts consumed within the current
   *  budget: fresh configure cycles minted plus unavailable DNS-write
   *  failures since the last timeout/ERROR recovery. A rate-limited attempt
   *  NEVER consumes it (Cloudflare said stop; no progress was made). At
   *  MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES the machine times out to ERROR with
   *  DEFAULT_DNS_TIMEOUT. ERROR is terminal (DZ-AUDIT-008); the vendor
   *  retries explicitly via the retry route, which resets the budget.
   *  Absent = 0. */
  configureAttempts?: number;
  /** Regional HTTPS certificates (docs/https-regional-certificates.md).
   *  Missing/'legacy' = the pre-regional per-deployment flow above; absent
   *  entirely for every state written before this field existed. */
  mode?: 'legacy' | 'regional';
  /** The owning customer's DNS namespace label (`dns_scope`, no `c-`
   *  prefix) — regional mode only. */
  dnsScope?: string;
  /** The `customer_regional_certificates` row id this deployment's
   *  certificate lives on — regional mode only. */
  certificateId?: string;
  /** ISO timestamp — the bootstrap relay enrolled and the regional flow
   *  started (set once, at creation). */
  bootstrapReadyAt?: string;
  /** ISO timestamp — the INSTALL job reported the ALB endpoint. */
  albReadyAt?: string;
  /** ISO timestamp — ATTACH_CERTIFICATE reported the 443 listener wired. */
  httpsListenerReadyAt?: string;
  /** ISO timestamp — the scoped deployment CNAME was written (DNS-only). */
  deploymentDnsCreatedAt?: string;
  /** ISO timestamp — the HTTPS probe against the scoped hostname first
   *  resolved DNS successfully (set alongside ACTIVE). */
  deploymentDnsResolvedAt?: string;
  /** ISO timestamp — the HTTPS probe against the scoped hostname first
   *  succeeded end to end. */
  httpsFirstSuccessAt?: string;
  /** ISO timestamp — the machine reached ACTIVE. */
  activatedAt?: string;
}

/**
 * Phase 2 default-hostname model — the deterministic `d-<id>.deployz.dev`
 * helpers. Pure and side-effect free: no DNS/provider I/O here, so these can
 * (and do) back the state machine, the URL resolver and mutation guards alike.
 *
 * A default hostname is `d-<deploymentId>.<zone>` where the deployment id is
 * normalized to lower-case and must be DNS-safe (`[a-z0-9-]+` — never
 * customer-controlled, so anything else is a programming error worth
 * throwing over). Production zone/prefix are the defaults; the optional
 * config override exists for tests and the E2E fixture namespace.
 */

/** The default HTTPS apex in production — a Deployz-registered domain. */
export const DEFAULT_HTTPS_APEX = 'deployz.dev';

/** The apex used under DNS fixture mode (E2E), mirroring
 *  createFixtureDomainCheckDeps's `.deployz-fixture.test` namespace. */
export const DEFAULT_HTTPS_FIXTURE_APEX = 'deployz-fixture.test';

export interface DefaultHostnameConfig {
  /** Hostname label prefix (default `d-`). */
  prefix?: string;
  /** Registrable zone the hostname is minted under (default `deployz.dev`). */
  zone?: string;
}

export const DEFAULT_HOSTNAME_PREFIX = 'd-';

const DNS_SAFE_ID = /^[a-z0-9-]+$/;

/** The deterministic default hostname for a deployment: `d-<id>.deployz.dev`.
 *  Delegates to @deployz/contracts's legacyDefaultDeploymentHostname so this
 *  shape has exactly one implementation. */
export function getDefaultDeploymentHostname(
  deploymentId: string,
  config: DefaultHostnameConfig = {},
): string {
  const prefix = config.prefix ?? DEFAULT_HOSTNAME_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_APEX;
  return legacyDefaultDeploymentHostname(deploymentId, { prefix, zone });
}

/** The default HTTPS URL for a deployment: `https://d-<id>.deployz.dev`. */
export function getDefaultDeploymentUrl(deploymentId: string, config?: DefaultHostnameConfig): string {
  return `https://${getDefaultDeploymentHostname(deploymentId, config)}`;
}

/** Exact-match guard: true iff `hostname` equals the default hostname of some
 *  valid deployment id (case-insensitive; the zone/prefix must match). */
export function isDefaultDeploymentHostname(hostname: string, config: DefaultHostnameConfig = {}): boolean {
  const prefix = config.prefix ?? DEFAULT_HOSTNAME_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_APEX;
  const lower = hostname.toLowerCase();
  if (!lower.startsWith(prefix) || !lower.endsWith(`.${zone}`)) return false;
  const id = lower.slice(prefix.length, -(`.${zone}`.length));
  return DNS_SAFE_ID.test(id) && id.length > 0;
}

/** Hostnames the default-HTTPS mutation guard must never touch: they are the
 *  marketing site, the dashboard, and the control-plane hosts. */
export const RESERVED_DEFAULT_HOSTNAMES = [
  'deployz.dev',
  'app.deployz.dev',
  'www.deployz.dev',
  'api.deployz.dev',
  'admin.deployz.dev',
] as const;

/** Throws unless `hostname` is a mutable default hostname — i.e. it passes
 *  isDefaultDeploymentHostname AND is not a reserved Deployz hostname. Pure;
 *  call before any provider mutation. */
export function assertMutableDefaultHostname(
  hostname: string,
  config: DefaultHostnameConfig = {},
): void {
  if (!isDefaultDeploymentHostname(hostname, config)) {
    throw new Error(`Refusing to mutate ${JSON.stringify(hostname)}: not a default deployment hostname.`);
  }
  if (RESERVED_DEFAULT_HOSTNAMES.includes(hostname.toLowerCase() as (typeof RESERVED_DEFAULT_HOSTNAMES)[number])) {
    throw new Error(`Refusing to mutate ${JSON.stringify(hostname)}: reserved Deployz hostname.`);
  }
}

/** The deployment id embedded in a default hostname (`d-<id>.<zone>`), or
 *  null when the name is not a well-formed `d-<uuid>.<zone>` hostname (wrong
 *  prefix/zone, a reserved or non-uuid id). Pure — the parse gate the purge
 *  orphan reconciliation deletes through: unparseable names are skipped,
 *  never deleted. Delegates to @deployz/contracts's
 *  parseLegacyDefaultDeploymentHostname so this shape has exactly one
 *  implementation. */
export function parseDefaultDeploymentId(
  hostname: string,
  config: DefaultHostnameConfig = {},
): string | null {
  const prefix = config.prefix ?? DEFAULT_HOSTNAME_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_APEX;
  return parseLegacyDefaultDeploymentHostname(hostname, { prefix, zone });
}

/** The candidate URLs a deployment can serve, resolved by the plan's
 *  precedence (Phase 7 wires this into resolveAppUrl's replacement). */
export interface DefaultUrls {
  /** The permanent default-HTTPS URL (`https://d-<id>.deployz.dev`). */
  defaultUrl: string;
  /** The custom-domain URL once one exists (else null/undefined). */
  customUrl?: string | null;
  /** Whether the custom domain is ACTIVE and healthy enough to serve. */
  customHealthy?: boolean;
}

/** The plan's URL model: the custom URL serves ONLY when it is ACTIVE and
 *  healthy; every other state (none, pending, failed, removed) falls back to
 *  the deployment's permanent default URL. */
export function resolvePreferredPublicUrl(urls: DefaultUrls): string {
  return urls.customUrl && urls.customHealthy ? urls.customUrl : urls.defaultUrl;
}

/** Back-compat seam used by the default-HTTPS state machine (hostname minted
 *  when a PENDING state is first created). Wraps the Phase 2 helper with the
 *  state machine's apex as the zone. */
export function defaultHttpsHostname(deploymentId: string, apex: string): string {
  return getDefaultDeploymentHostname(deploymentId, { zone: apex });
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
  const lastDnsCheckAt = readString('lastDnsCheckAt');
  const lastError = typeof record['lastError'] === 'string' ? record['lastError'] : null;
  const mode = record['mode'] === 'regional' ? 'regional' : record['mode'] === 'legacy' ? 'legacy' : undefined;
  const dnsScope = readString('dnsScope');
  const certificateId = readString('certificateId');
  const bootstrapReadyAt = readString('bootstrapReadyAt');
  const albReadyAt = readString('albReadyAt');
  const httpsListenerReadyAt = readString('httpsListenerReadyAt');
  const deploymentDnsCreatedAt = readString('deploymentDnsCreatedAt');
  const deploymentDnsResolvedAt = readString('deploymentDnsResolvedAt');
  const httpsFirstSuccessAt = readString('httpsFirstSuccessAt');
  const activatedAt = readString('activatedAt');
  return {
    hostname: record['hostname'],
    status: record['status'] as DefaultHttpsStatus,
    ...(certificateArn ? { certificateArn } : {}),
    ...(validationName ? { validationName } : {}),
    ...(validationValue ? { validationValue } : {}),
    ...(routingTarget ? { routingTarget } : {}),
    checkCycle: typeof record['checkCycle'] === 'number' ? record['checkCycle'] : 0,
    lastError,
    configureAttempts: typeof record['configureAttempts'] === 'number' ? record['configureAttempts'] : 0,
    ...(lastDnsCheckAt ? { lastDnsCheckAt } : {}),
    ...(mode ? { mode } : {}),
    ...(dnsScope ? { dnsScope } : {}),
    ...(certificateId ? { certificateId } : {}),
    ...(bootstrapReadyAt ? { bootstrapReadyAt } : {}),
    ...(albReadyAt ? { albReadyAt } : {}),
    ...(httpsListenerReadyAt ? { httpsListenerReadyAt } : {}),
    ...(deploymentDnsCreatedAt ? { deploymentDnsCreatedAt } : {}),
    ...(deploymentDnsResolvedAt ? { deploymentDnsResolvedAt } : {}),
    ...(httpsFirstSuccessAt ? { httpsFirstSuccessAt } : {}),
    ...(activatedAt ? { activatedAt } : {}),
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

/** Whether a job type belongs to the regional HTTPS certificates flow
 *  (docs/https-regional-certificates.md) — ENSURE_CERTIFICATE requests/
 *  adopts the customer-scoped wildcard certificate, ATTACH_CERTIFICATE wires
 *  it into the relay's ALB listener. Both ride outside a deployment's own
 *  lifecycle (deploymentStateAfterFailedJob), exactly like the domain jobs. */
export function isRegionalCertificateJobType(type: string): type is 'ENSURE_CERTIFICATE' | 'ATTACH_CERTIFICATE' {
  return type === 'ENSURE_CERTIFICATE' || type === 'ATTACH_CERTIFICATE';
}

function attachJobKeyPrefix(deploymentId: string): string {
  return `${deploymentId}:ATTACH_CERTIFICATE:`;
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
    configureAttempts: state.configureAttempts ?? 0,
    ...(state.lastDnsCheckAt ? { lastDnsCheckAt: state.lastDnsCheckAt } : {}),
    ...(state.mode ? { mode: state.mode } : {}),
    ...(state.dnsScope ? { dnsScope: state.dnsScope } : {}),
    ...(state.certificateId ? { certificateId: state.certificateId } : {}),
    ...(state.bootstrapReadyAt ? { bootstrapReadyAt: state.bootstrapReadyAt } : {}),
    ...(state.albReadyAt ? { albReadyAt: state.albReadyAt } : {}),
    ...(state.httpsListenerReadyAt ? { httpsListenerReadyAt: state.httpsListenerReadyAt } : {}),
    ...(state.deploymentDnsCreatedAt ? { deploymentDnsCreatedAt: state.deploymentDnsCreatedAt } : {}),
    ...(state.deploymentDnsResolvedAt ? { deploymentDnsResolvedAt: state.deploymentDnsResolvedAt } : {}),
    ...(state.httpsFirstSuccessAt ? { httpsFirstSuccessAt: state.httpsFirstSuccessAt } : {}),
    ...(state.activatedAt ? { activatedAt: state.activatedAt } : {}),
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
 * idempotency key instead of replaying a stale one. Returns whether a new
 * job row was created (the Phase 12 watchdog counts only real attempts — an
 * in-flight or already-finished job that gets reused is not one).
 */
export async function ensureDefaultHttpsConfigureJob(
  db: RuntimeDb,
  deployment: { id: string },
  state: DefaultHttpsState,
  opts?: { forceNewCycle?: boolean },
): Promise<boolean> {
  const prefix = configureJobPrefix(deployment.id);
  const newest = await newestMachineJob(db, deployment.id, 'CONFIGURE_DOMAIN', prefix);
  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return false;
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
  const { created } = await createOrReuseJob(db, {
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
  return created;
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
  if (state.mode === 'regional') {
    // Regional mode never mints a REMOVE_DOMAIN job — there is no
    // per-deployment certificate or listener to tear down (the shared
    // regional certificate rides PURGE, decision 5); only the scoped
    // deployment DNS record needs removing, and that has no relay job of
    // its own either. REMOVING is a terminal marker the customer/vendor
    // views read; a repeat call is a harmless no-op.
    if (state.status === 'REMOVING') return;
    await persistState(db, deployment.id, { ...state, status: 'REMOVING', lastError: null });
    return;
  }
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
  if (state.mode === 'regional') {
    // Regional mode never mints CONFIGURE_DOMAIN/REMOVE_DOMAIN jobs — a
    // result reaching here for one would be a routing bug upstream, not
    // something this machine should ever act on.
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

// ── Regional mode (docs/https-regional-certificates.md) ─────────────────────
//
// The customer-scoped flow: one persistent wildcard certificate per
// customer+account+region (apps/api/src/regional-certificates.ts) reused by
// every deployment. This machine only tracks the per-deployment half — the
// scoped DNS record, the ALB attach, and the HTTPS probe — never a
// per-deployment certificate.

async function loadDeploymentRefs(
  db: RuntimeDb,
  deploymentId: string,
): Promise<{ organizationId: string; customerId: string } | null> {
  const rows = await db
    .select({ organizationId: schema.deployments.organizationId, customerId: schema.deployments.customerId })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Starts the regional default-HTTPS machine for a deployment — called by the
 * route lane right after enrollment selects the regional flow (relay-
 * reported customerScope matches the customer's dns_scope). Persisted only
 * when `default_https` is still null; a repeat call is a no-op that returns
 * the ALREADY-persisted state, never overwrites it.
 */
export async function startRegionalDefaultHttps(
  db: RuntimeDb,
  deployment: { id: string },
  input: { dnsScope: string; certificateId: string; apex: string; now?: () => Date },
): Promise<DefaultHttpsState> {
  const existing = await reloadState(db, deployment.id);
  if (existing) {
    return existing;
  }
  const now = (input.now ?? (() => new Date()))();
  const initial: DefaultHttpsState = {
    hostname: scopedDeploymentHostname(deployment.id, input.dnsScope, { zone: input.apex }),
    status: 'PENDING',
    checkCycle: 0,
    lastError: null,
    mode: 'regional',
    dnsScope: input.dnsScope,
    certificateId: input.certificateId,
    bootstrapReadyAt: now.toISOString(),
  };
  await persistState(db, deployment.id, initial);
  return initial;
}

/** The regional certificate facts an INSTALL result MAY carry (decision 4:
 *  the install executor can attach an already-ISSUED certificate itself,
 *  saving one poll round trip). */
export interface RegionalInstallOutput {
  regionalCertificate?: {
    httpsConfigured?: boolean;
    routingTarget?: string;
  };
}

/**
 * Applies a successful INSTALL result to the regional machine: records the
 * ALB endpoint, writes the scoped deployment CNAME (DNS-only), and — when
 * the install executor already attached an ISSUED certificate itself —
 * advances straight to CONFIGURING. A no-op (returns `needsAttach: false`)
 * when this deployment is not in regional mode (nothing to do here; the
 * legacy CONFIGURE_DOMAIN flow owns it instead).
 */
export async function applyRegionalInstallSuccess(
  db: RuntimeDb,
  deployment: { id: string },
  input: { routingTarget: string; installOutput?: RegionalInstallOutput },
  deps: { dns: CloudflareDnsClient },
): Promise<{ needsAttach: boolean }> {
  const state = await reloadState(db, deployment.id);
  if (!state || state.mode !== 'regional' || !state.dnsScope) {
    return { needsAttach: false };
  }
  if (state.status === 'REMOVING' || state.status === 'ERROR') {
    return { needsAttach: false };
  }

  const nowIso = new Date().toISOString();
  await deps.dns.upsertScopedDeploymentRecord(deployment.id, state.dnsScope, input.routingTarget);

  const httpsConfigured = input.installOutput?.regionalCertificate?.httpsConfigured === true;
  let next: DefaultHttpsState = {
    ...state,
    albReadyAt: state.albReadyAt ?? nowIso,
    routingTarget: input.routingTarget,
    deploymentDnsCreatedAt: state.deploymentDnsCreatedAt ?? nowIso,
  };
  if (httpsConfigured && next.status === 'PENDING') {
    next = { ...next, status: 'CONFIGURING', httpsListenerReadyAt: next.httpsListenerReadyAt ?? nowIso, lastError: null };
  }
  await persistState(db, deployment.id, next);

  const refs = await loadDeploymentRefs(db, deployment.id);
  if (refs) {
    await recordDefaultHttpsEvent(db, {
      organizationId: refs.organizationId,
      deploymentId: deployment.id,
      customerId: refs.customerId,
      eventType: 'dns_created',
      actorType: 'system',
      hostname: next.hostname,
    });
  }

  // The relay already attached the certificate as part of INSTALL — no
  // separate ATTACH_CERTIFICATE round trip needed.
  return { needsAttach: !httpsConfigured };
}

/**
 * Ensures exactly one in-flight ATTACH_CERTIFICATE job for this deployment
 * — the regional analog of ensureDefaultHttpsConfigureJob's cycle
 * bookkeeping, keyed per-deployment (unlike ENSURE_CERTIFICATE, which is
 * keyed per certificate row across the whole scope: only ONE deployment's
 * relay needs to wire its own ALB listener).
 */
export async function ensureAttachCertificateJob(
  db: RuntimeDb,
  deployment: { id: string },
  state: DefaultHttpsState,
  certificateArn: string,
): Promise<boolean> {
  const prefix = attachJobKeyPrefix(deployment.id);
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deployment.id),
        eq(schema.deploymentJobs.type, 'ATTACH_CERTIFICATE'),
        like(schema.deploymentJobs.idempotencyKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  const newest = jobs[0];
  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return false;
  }
  const newestCycle = newest ? Number(newest.idempotencyKey.slice(prefix.length)) : undefined;
  const cycle = newest !== undefined && newestCycle === state.checkCycle ? state.checkCycle + 1 : state.checkCycle;
  if (cycle !== state.checkCycle) {
    await db
      .update(schema.deployments)
      .set({ defaultHttps: { ...stateToRecord(state), checkCycle: cycle } })
      .where(eq(schema.deployments.id, deployment.id));
    state.checkCycle = cycle;
  }
  const { created } = await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'ATTACH_CERTIFICATE',
    idempotencyKey: `${prefix}${cycle}`,
    payload: { certificateArn, hostname: state.hostname },
    requestedBy: null,
  });
  return created;
}

/**
 * Applies one ATTACH_CERTIFICATE relay job result — called from the relay
 * result route in the same transaction that finishes the job row, exactly
 * like applyDefaultHttpsJobResult. A stale/late result never knocks a
 * live (ACTIVE) or already-removing endpoint over.
 */
export async function applyAttachCertificateResult(
  tx: RuntimeDb,
  deploymentId: string,
  job: { type: string },
  body: { success?: boolean; output?: Record<string, unknown>; failureCode?: string },
): Promise<void> {
  void job;
  const state = await reloadState(tx, deploymentId);
  if (!state || state.mode !== 'regional') return;
  if (state.status === 'REMOVING' || state.status === 'ACTIVE') return;

  const isSuccess = body.success !== false;
  if (!isSuccess) {
    const permissionDenied = body.failureCode === 'AWS_PERMISSION_DENIED';
    const attempts = (state.configureAttempts ?? 0) + (permissionDenied ? 0 : 1);
    const timedOut = !permissionDenied && attempts >= MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES;
    const next: DefaultHttpsState =
      permissionDenied || timedOut
        ? { ...state, status: 'ERROR', lastError: permissionDenied ? 'AWS_PERMISSION_DENIED' : 'ATTACH_TIMEOUT', configureAttempts: attempts }
        : { ...state, status: 'PENDING', lastError: 'ATTACH_FAILED', configureAttempts: attempts };
    await persistState(tx, deploymentId, next);
    if (next.status === 'ERROR') {
      const refs = await loadDeploymentRefs(tx, deploymentId);
      if (refs) {
        await recordDefaultHttpsEvent(tx, {
          organizationId: refs.organizationId,
          deploymentId,
          customerId: refs.customerId,
          eventType: 'failed',
          actorType: 'relay',
          hostname: state.hostname,
        });
      }
    }
    return;
  }

  const parsed = attachCertificateResultSchema.safeParse(body.output ?? {});
  if (!parsed.success) {
    await persistState(tx, deploymentId, {
      ...state,
      lastError: 'ATTACH_FAILED',
      configureAttempts: (state.configureAttempts ?? 0) + 1,
    });
    return;
  }
  const result = parsed.data;
  const nowIso = new Date().toISOString();
  const next: DefaultHttpsState = {
    ...state,
    status: 'CONFIGURING',
    routingTarget: result.routingTarget,
    httpsListenerReadyAt: state.httpsListenerReadyAt ?? nowIso,
    lastError: null,
  };
  await persistState(tx, deploymentId, next);
  const refs = await loadDeploymentRefs(tx, deploymentId);
  if (refs) {
    await recordDefaultHttpsEvent(tx, {
      organizationId: refs.organizationId,
      deploymentId,
      customerId: refs.customerId,
      eventType: 'listener_ready',
      actorType: 'relay',
      hostname: state.hostname,
    });
  }
}

/** Injected deps for the regional heartbeat/driver step. */
export interface RegionalDefaultHttpsDeps {
  probeHttps: (hostname: string) => Promise<HttpsProbeResult>;
}

/**
 * Drives the regional machine one step forward — the per-deployment half of
 * the heartbeat pass (the route lane calls ensureRegionalCertificate and
 * reconcileValidationRecord from apps/api/src/regional-certificates.ts
 * alongside this, since those operate on the shared certificate row rather
 * than a deployment's own state). Idempotent, one step per call, mirroring
 * runDefaultHttpsCheck's contract for the legacy flow.
 */
export async function runRegionalDefaultHttpsCheck(
  db: RuntimeDb,
  deployment: { id: string },
  certRow: Pick<RegionalCertificateRow, 'certificateStatus' | 'certificateArn'> | null,
  deps: RegionalDefaultHttpsDeps,
): Promise<void> {
  const state = await reloadState(db, deployment.id);
  if (!state || state.mode !== 'regional') return;
  if (state.status === 'ERROR' || state.status === 'REMOVING') return;

  if (state.status === 'PENDING') {
    if (!state.routingTarget) {
      // INSTALL has not reported the ALB endpoint yet — nothing to attach.
      return;
    }
    if (certRow?.certificateStatus === 'ISSUED' && certRow.certificateArn) {
      const attempts = state.configureAttempts ?? 0;
      if (attempts >= MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES) {
        await persistState(db, deployment.id, { ...state, status: 'ERROR', lastError: 'ATTACH_TIMEOUT' });
        const refs = await loadDeploymentRefs(db, deployment.id);
        if (refs) {
          await recordDefaultHttpsEvent(db, {
            organizationId: refs.organizationId,
            deploymentId: deployment.id,
            customerId: refs.customerId,
            eventType: 'failed',
            actorType: 'system',
            hostname: state.hostname,
          });
        }
        return;
      }
      const created = await ensureAttachCertificateJob(db, deployment, state, certRow.certificateArn);
      if (created) {
        await persistState(db, deployment.id, { ...state, configureAttempts: attempts + 1 });
      }
      return;
    }
    // Waiting for the shared certificate to reach ISSUED — not an error.
    return;
  }

  if (state.status === 'CONFIGURING') {
    const probe = await deps.probeHttps(state.hostname);
    const nowIso = new Date().toISOString();
    if (probe.ok) {
      await persistState(db, deployment.id, {
        ...state,
        status: 'ACTIVE',
        lastError: null,
        httpsFirstSuccessAt: state.httpsFirstSuccessAt ?? nowIso,
        activatedAt: state.activatedAt ?? nowIso,
        deploymentDnsResolvedAt: state.deploymentDnsResolvedAt ?? nowIso,
      });
      const refs = await loadDeploymentRefs(db, deployment.id);
      if (refs) {
        await recordDefaultHttpsEvent(db, {
          organizationId: refs.organizationId,
          deploymentId: deployment.id,
          customerId: refs.customerId,
          eventType: 'active',
          actorType: 'system',
          hostname: state.hostname,
        });
      }
    } else {
      await persistState(db, deployment.id, { ...state, lastError: probe.reason });
    }
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

export interface DefaultHttpsDeps {
  /** Off switch: default HTTPS runs only when the control plane is configured
   *  with the Cloudflare deployz.dev zone, or under DNS fixture mode. */
  enabled: boolean;
  /** The DNS apex the deployz hostname is minted under. */
  apex: string;
  /** Deployment-keyed DNS client (Cloudflare in production; the fixture
   *  provider under E2E; the no-op writer when off). */
  dns: CloudflareDnsClient;
  /** HTTPS reachability probe — the same seam runDomainCheck uses. A failed
   *  probe carries the reason, which the machine persists as lastError so a
   *  stuck CONFIGURING says WHY instead of a single catch-all code. */
  probeHttps: (hostname: string) => Promise<HttpsProbeResult>;
}

const EVER_INSTALLED_STATES = new Set<string>(['HEALTHY', 'UPDATING', 'UPDATE_AVAILABLE']);

/** Deployment states with no ALB/relay to serve HTTPS — same gating the
 *  custom-domain machine applies. */
const NOT_RUNNING_STATES = new Set<string>(['FAILED', 'DELETING', 'DELETED', 'NOT_INSTALLED', 'WAITING_FOR_RELAY']);

/**
 * Phase 12 watchdog — the maximum configure attempts (fresh configure cycles
 * minted or unavailable DNS-write failures) the machine may consume within
 * one budget before it gives up with `DEFAULT_DNS_TIMEOUT`. The machine has
 * no clock seam, so this cycle bound IS the time base (one attempt per relay
 * heartbeat kick, ~5 min). Rate-limited attempts never consume it.
 */
export const MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES = 5;

/** Whether a DNS-write failure is Cloudflare telling us to slow down (429).
 *  Duck-typed on the error code so the real CloudflareDnsError, legacy
 *  writers and test fakes that mirror the taxonomy all classify the same. */
function isCloudflareRateLimited(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'CLOUDFLARE_RATE_LIMITED';
}

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

  if (state?.mode === 'regional') {
    // A regional deployment's own progression is driven by
    // runRegionalDefaultHttpsCheck (needs the shared certificate row, which
    // this legacy entry point has no seam for) — never by this machine.
    return;
  }

  if (!state) {
    // Nothing requested yet. The default URL is permanent (Phase 7): it keeps
    // reconciling even while a custom domain serves — a custom domain can
    // later fail or be removed, and the default is the always-present
    // fallback, so it must never be disabled while a custom domain exists.
    const initial: DefaultHttpsState = {
      hostname: defaultHttpsHostname(deployment.id, deps.apex),
      status: 'PENDING',
      checkCycle: 0,
      lastError: null,
    };
    await persistState(db, deployment.id, initial);
    const created = await ensureDefaultHttpsConfigureJob(db, deployment, initial);
    if (created) {
      // Phase 12 watchdog: the very first configure request is a configure
      // attempt too — count it against the budget (unit parity: a machine
      // that mints its initial job and then stalls owes the same accounting
      // as one that stalls later).
      await persistState(db, deployment.id, { ...initial, configureAttempts: 1 });
    }
    return;
  }

  let working: DefaultHttpsState = state;
  while (working.status !== 'ACTIVE' && working.status !== 'REMOVING' && working.status !== 'ERROR') {
    // Phase 12 watchdog: a pre-ACTIVE machine that has consumed its whole
    // configure budget (MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES attempts) without
    // reaching ACTIVE stops minting and reports DEFAULT_DNS_TIMEOUT. ERROR
    // is terminal (DZ-AUDIT-008); the vendor retries explicitly.
    // CONFIGURING is exempt: it spends no budget (the probe is not a
    // configure attempt).
    if (
      (working.status === 'PENDING' || working.status === 'WAITING_FOR_DNS') &&
      (working.configureAttempts ?? 0) >= MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES
    ) {
      await persistState(db, deployment.id, {
        ...working,
        status: 'ERROR',
        lastError: 'DEFAULT_DNS_TIMEOUT',
      });
      return;
    }
    switch (working.status) {
      case 'PENDING': {
        const created = await ensureDefaultHttpsConfigureJob(db, deployment, working);
        if (created) {
          await persistState(db, deployment.id, {
            ...working,
            configureAttempts: (working.configureAttempts ?? 0) + 1,
          });
        }
        return;
      }
      case 'WAITING_FOR_DNS': {
        if (!working.validationName || !working.validationValue || !working.routingTarget) {
          // The cert was requested but the relay has not yet reported the
          // validation record — nudge it to describe the cert again.
          const created = await ensureDefaultHttpsConfigureJob(db, deployment, working, { forceNewCycle: true });
          if (created) {
            await persistState(db, deployment.id, {
              ...working,
              configureAttempts: (working.configureAttempts ?? 0) + 1,
            });
          }
          return;
        }
        const attemptedAt = new Date().toISOString();
        try {
          // The validation CNAME must stay unproxied for ACM's DNS-01 probe;
          // the routing CNAME is the proxied default record.
          await deps.dns.upsertDefaultValidationRecord(
            deployment.id,
            working.validationName,
            working.validationValue,
          );
          await deps.dns.upsertDefaultDeploymentRecord(deployment.id, working.routingTarget);
        } catch (error) {
          // A DNS failure only touches default-HTTPS state: no AWS job is
          // enqueued and no infrastructure is recreated — the next driver
          // pass retries the reconciliation.
          const rateLimited = isCloudflareRateLimited(error);
          const next: DefaultHttpsState = {
            ...working,
            // Phase 12: a RATE-LIMITED attempt made no progress (Cloudflare
            // said stop) and must NOT consume the watchdog budget — it is
            // stored distinctly and retried on the next pass. Temporary /
            // unavailable failures DO consume the budget: bounded retries
            // instead of infinite heartbeat hammering. The ≥180s heartbeat
            // throttle is the backoff — no sleeper is added.
            lastError: rateLimited ? 'CLOUDFLARE_RATE_LIMITED' : 'DNS_WRITE_FAILED',
            lastDnsCheckAt: attemptedAt,
            ...(rateLimited
              ? {}
              : { configureAttempts: (working.configureAttempts ?? 0) + 1 }),
          };
          if (!rateLimited && (next.configureAttempts ?? 0) >= MAX_DEFAULT_HTTPS_CONFIGURE_CYCLES) {
            next.status = 'ERROR';
            next.lastError = 'DEFAULT_DNS_TIMEOUT';
          }
          await persistState(db, deployment.id, next);
          return;
        }
        working = { ...working, lastError: null, lastDnsCheckAt: attemptedAt };
        await persistState(db, deployment.id, working);
        // DNS is in place — nudge the relay to re-describe the cert and wire
        // the 443 listener once ACM issues it.
        const created = await ensureDefaultHttpsConfigureJob(db, deployment, working, { forceNewCycle: true });
        if (created) {
          await persistState(db, deployment.id, {
            ...working,
            configureAttempts: (working.configureAttempts ?? 0) + 1,
          });
        }
        return;
      }
      case 'CONFIGURING': {
        const probe = await deps.probeHttps(working.hostname);
        if (probe.ok) {
          working = { ...working, status: 'ACTIVE', lastError: null };
          await persistState(db, deployment.id, working);
        } else {
          // Stay CONFIGURING and say why: a distinguishing reason beats the
          // single HTTPS_NOT_REACHABLE the boolean probe could express.
          await persistState(db, deployment.id, { ...working, lastError: probe.reason });
        }
        return;
      }
      default: {
        // ERROR (terminal: DZ-AUDIT-008) or any other unexpected status
        // — nothing to do here. The vendor retries explicitly.
        return;
      }
    }
  }
}

// ── Purge orphan reconciliation (Phase 11) ───────────────────────────────────

export interface OrphanedDefaultRecordReconciliation {
  /** Routing CNAMEs deleted because no live deployment owns them. */
  deleted: number;
  /** Records skipped: names that do not parse to a live deployment's uuid,
   *  or a deployment row that still exists (deletedAt IS NULL). */
  kept: number;
}

/**
 * Purge-time orphan reconciliation (Phase 11). Lists the zone's `d-*` routing
 * CNAMEs and deletes any whose deployment no longer exists — `deletedAt` set,
 * or the row gone entirely. Every name is parsed to a `d-<uuid>.<zone>`
 * deployment id first (parseDefaultDeploymentId); names that fail the parse
 * (reserved hostnames, wrong zone, non-uuid ids — structurally `app.deployz.dev`
 * and friends) are SKIPPED and never reach a delete call. Idempotent: a second
 * pass after a successful one has nothing left to delete; a record that is
 * already missing deletes as a no-op. Failure is state-only — errors propagate
 * so the caller logs and continues on the next purge pass; no DB row is
 * written by this function.
 */
interface OrphanCandidate {
  deploymentId: string;
  /** Present for a regional scoped hostname (`d-<id>.c-<scope>.<zone>`);
   *  absent for a legacy hostname (`d-<id>.<zone>`). */
  dnsScope?: string;
}

export async function reconcileOrphanedDefaultRecords(
  db: RuntimeDb,
  dns: CloudflareDnsClient,
  config: DefaultHostnameConfig = {},
): Promise<OrphanedDefaultRecordReconciliation> {
  // Cloudflare's own `name.startswith=d-` filter (listDefaultRecords) already
  // excludes every validation record (`_<digest>.…`) — legacy or regional —
  // so this sweep never even sees one to accidentally touch.
  const records = await dns.listDefaultRecords();
  let deleted = 0;
  let kept = 0;
  const candidates: OrphanCandidate[] = [];
  for (const record of records) {
    const legacyId = parseDefaultDeploymentId(record.name, config);
    if (legacyId) {
      candidates.push({ deploymentId: legacyId });
      continue;
    }
    const scoped = parseScopedDeploymentHostname(record.name, config);
    if (scoped) {
      candidates.push({ deploymentId: scoped.deploymentId, dnsScope: scoped.dnsScope });
      continue;
    }
    kept += 1;
  }
  if (candidates.length === 0) {
    return { deleted, kept };
  }
  const candidateIds = candidates.map((candidate) => candidate.deploymentId);
  const liveRows = await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(and(inArray(schema.deployments.id, candidateIds), isNull(schema.deployments.deletedAt)));
  const live = new Set(liveRows.map((row) => row.id));
  for (const candidate of candidates) {
    if (live.has(candidate.deploymentId)) {
      kept += 1;
      continue;
    }
    if (candidate.dnsScope) {
      await dns.deleteScopedDeploymentRecord(candidate.deploymentId, candidate.dnsScope);
    } else {
      await dns.deleteDefaultDeploymentRecord(candidate.deploymentId);
    }
    deleted += 1;
  }
  return { deleted, kept };
}
