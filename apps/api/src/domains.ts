import { and, desc, eq, isNull, like } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { normalizeHostname, validateHostname } from './domain-validation.js';
import { ApiError } from './errors.js';
import { recordEvent } from './events.js';
import { createOrReuseJob } from './jobs.js';

// Custom-domains MVP — the domain state machine. Rows move
// PENDING -> WAITING_FOR_DNS -> CONFIGURING -> ACTIVE (or -> ERROR at any
// configure step), and REMOVING -> gone (removedAt set) on the way out.
// AWS/ACM facts only ever arrive via applyDomainJobResult, which is the sole
// writer of that machine's transitions outside creation and removal.

export type CustomDomainRow = typeof schema.customDomains.$inferSelect;

export interface DomainRecordView {
  purpose: 'verification' | 'routing';
  type: 'CNAME';
  name: string;
  value: string;
}

export interface CustomDomainView {
  hostname: string;
  status: string;
  records: DomainRecordView[];
  error: string | null;
  url: string | null;
}

const DOMAIN_JOB_TYPES = new Set(['CONFIGURE_DOMAIN', 'REMOVE_DOMAIN']);
export function isDomainJobType(type: string): boolean {
  return DOMAIN_JOB_TYPES.has(type);
}

/**
 * Classifies a Postgres unique-violation (23505) against the two partial
 * unique indexes on custom_domains, so createCustomDomain's insert-race
 * catch can surface the SAME 409 a pre-check would have thrown. Returns
 * null for anything that is not a 23505 — the caller should rethrow those.
 */
export function classifyDomainUniqueViolation(error: unknown): 'DOMAIN_EXISTS' | 'DOMAIN_TAKEN' | null {
  const code = (error as { code?: string } | undefined)?.code;
  if (code !== '23505') {
    return null;
  }
  const constraint = (error as { constraint?: string } | undefined)?.constraint;
  if (constraint === 'custom_domains_active_deployment_idx') {
    return 'DOMAIN_EXISTS';
  }
  // 'custom_domains_active_hostname_idx' or an ambiguous/unknown constraint —
  // prefer DOMAIN_TAKEN, the more conservative of the two 409s.
  return 'DOMAIN_TAKEN';
}

// Jobs in these states are still on their way to a result — a caller must
// not mint a second one on top of them.
const IN_FLIGHT_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'RUNNING']);

export function toDomainView(row: CustomDomainRow): CustomDomainView {
  const records: DomainRecordView[] = [];
  if (row.validationName && row.validationValue) {
    records.push({
      purpose: 'verification',
      type: 'CNAME',
      name: row.validationName,
      value: row.validationValue,
    });
  }
  if (row.routingTarget) {
    records.push({ purpose: 'routing', type: 'CNAME', name: row.hostname, value: row.routingTarget });
  }
  return {
    hostname: row.hostname,
    status: row.status.toLowerCase(),
    records,
    error: row.lastError,
    url: row.status === 'ACTIVE' ? `https://${row.hostname}` : null,
  };
}

export async function findActiveDomain(
  db: RuntimeDb,
  deploymentId: string,
): Promise<CustomDomainRow | null> {
  const rows = await db
    .select()
    .from(schema.customDomains)
    .where(
      and(eq(schema.customDomains.deploymentId, deploymentId), isNull(schema.customDomains.removedAt)),
    )
    .orderBy(desc(schema.customDomains.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ensures exactly one live CONFIGURE_DOMAIN job is chasing this domain
 * toward its next state. A fresh domain (cycle 0, no jobs yet) gets its
 * cycle-0 job without bumping checkCycle; a finished job at the current
 * cycle (or an explicit forceNewCycle) mints the next cycle so relay sees a
 * fresh idempotency key instead of replaying a stale one.
 */
export async function ensureConfigureJob(
  db: RuntimeDb,
  deployment: { id: string },
  domain: CustomDomainRow,
  opts?: { forceNewCycle?: boolean },
): Promise<void> {
  const prefix = `${deployment.id}:CONFIGURE_DOMAIN:${domain.id}:`;
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deployment.id),
        eq(schema.deploymentJobs.type, 'CONFIGURE_DOMAIN'),
        like(schema.deploymentJobs.idempotencyKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  const newest = jobs[0];

  if (newest && IN_FLIGHT_JOB_STATES.has(newest.state)) {
    return;
  }

  const newestCycle = newest ? Number(newest.idempotencyKey.slice(prefix.length)) : undefined;
  const shouldBump = opts?.forceNewCycle === true || (newest !== undefined && newestCycle === domain.checkCycle);
  const cycle = shouldBump ? domain.checkCycle + 1 : domain.checkCycle;

  if (shouldBump) {
    await db
      .update(schema.customDomains)
      .set({ checkCycle: cycle })
      .where(eq(schema.customDomains.id, domain.id));
  }

  await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'CONFIGURE_DOMAIN',
    idempotencyKey: `${prefix}${cycle}`,
    payload: {
      hostname: domain.hostname,
      domainId: domain.id,
      ...(domain.certificateArn ? { certificateArn: domain.certificateArn } : {}),
    },
    requestedBy: null,
  });
}

export async function createCustomDomain(
  db: RuntimeDb,
  deployment: { id: string; organizationId: string },
  rawHostname: string,
  actorId: string,
): Promise<CustomDomainRow> {
  const hostname = normalizeHostname(rawHostname);
  const validation = validateHostname(hostname);
  if (!validation.ok) {
    throw new ApiError(400, validation.code, validation.message);
  }

  const existingForDeployment = await findActiveDomain(db, deployment.id);
  if (existingForDeployment) {
    throw new ApiError(409, 'DOMAIN_EXISTS', 'This deployment already has a custom domain.');
  }

  const takenElsewhere = await db
    .select({ id: schema.customDomains.id })
    .from(schema.customDomains)
    .where(and(eq(schema.customDomains.hostname, hostname), isNull(schema.customDomains.removedAt)))
    .limit(1);
  if (takenElsewhere.length > 0) {
    // Never name the other org — the requester has no right to know it.
    throw new ApiError(409, 'DOMAIN_TAKEN', 'This domain is already connected to a deployment.');
  }

  let row: CustomDomainRow;
  try {
    const inserted = await db
      .insert(schema.customDomains)
      .values({
        deploymentId: deployment.id,
        organizationId: deployment.organizationId,
        hostname,
        status: 'PENDING',
        createdBy: actorId,
      })
      .returning();
    row = inserted[0]!;
  } catch (error) {
    // A concurrent request can win the race between our pre-checks above and
    // the insert; the partial unique indexes are the real source of truth,
    // so surface the SAME 409s rather than a raw constraint violation.
    const classification = classifyDomainUniqueViolation(error);
    if (classification === 'DOMAIN_EXISTS') {
      throw new ApiError(409, 'DOMAIN_EXISTS', 'This deployment already has a custom domain.');
    }
    if (classification === 'DOMAIN_TAKEN') {
      throw new ApiError(409, 'DOMAIN_TAKEN', 'This domain is already connected to a deployment.');
    }
    throw error;
  }

  await ensureConfigureJob(db, deployment, row);

  await recordEvent(db, {
    organizationId: deployment.organizationId,
    eventType: 'domain.added',
    actorType: 'user',
    actorId,
    deploymentId: deployment.id,
    result: 'success',
    payload: { hostname },
  });

  return row;
}

export async function removeCustomDomain(
  db: RuntimeDb,
  deployment: { id: string },
  domain: CustomDomainRow,
): Promise<CustomDomainRow> {
  const alreadyRemoving = domain.status === 'REMOVING';
  const prefix = `${deployment.id}:REMOVE_DOMAIN:${domain.id}:`;
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deployment.id),
        eq(schema.deploymentJobs.type, 'REMOVE_DOMAIN'),
        like(schema.deploymentJobs.idempotencyKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  const newest = jobs[0];

  // First call always mints a fresh cycle; a repeat call on an already-
  // REMOVING row only mints a new one if the previous remove job died —
  // otherwise it re-ensures (and idempotently reuses) the same job.
  const shouldBump = !alreadyRemoving || newest?.state === 'FAILED';
  const cycle = shouldBump ? domain.checkCycle + 1 : domain.checkCycle;

  const [updated] = await db
    .update(schema.customDomains)
    .set({ status: 'REMOVING', checkCycle: cycle })
    .where(eq(schema.customDomains.id, domain.id))
    .returning();

  await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'REMOVE_DOMAIN',
    idempotencyKey: `${prefix}${cycle}`,
    payload: {
      hostname: domain.hostname,
      domainId: domain.id,
      ...(domain.certificateArn ? { certificateArn: domain.certificateArn } : {}),
    },
    requestedBy: null,
  });

  return updated!;
}

/**
 * Applies one relay job result to the domain state machine. `tx` is
 * expected to be the same transaction (or db) the caller already used to
 * finish the job row, so the domain transition and the job's own bookkeeping
 * land together.
 */
export async function applyDomainJobResult(
  tx: RuntimeDb,
  deployment: { id: string; organizationId: string },
  job: typeof schema.deploymentJobs.$inferSelect,
  body: { success?: boolean; error?: string; output?: Record<string, unknown>; failureCode?: string },
): Promise<void> {
  const domain = await findActiveDomain(tx, deployment.id);
  if (!domain) {
    return;
  }

  const isSuccess = body.success !== false;

  if (job.type === 'REMOVE_DOMAIN') {
    if (isSuccess) {
      await tx
        .update(schema.customDomains)
        .set({ removedAt: new Date() })
        .where(eq(schema.customDomains.id, domain.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'domain.removed',
        actorType: 'relay',
        actorId: deployment.id,
        deploymentId: deployment.id,
        result: 'success',
        payload: { hostname: domain.hostname },
      });
    } else {
      await tx
        .update(schema.customDomains)
        .set({ lastError: 'REMOVE_FAILED' })
        .where(eq(schema.customDomains.id, domain.id));
    }
    return;
  }

  // job.type === 'CONFIGURE_DOMAIN'
  if (domain.status === 'REMOVING') {
    // Stale result: removal has already started, so a configure outcome no
    // longer applies to this domain's future.
    return;
  }

  if (!isSuccess) {
    if (domain.status === 'ACTIVE') {
      // A late/stale configure failure must never knock an active domain
      // offline — the domain is already serving traffic successfully.
      return;
    }
    const lastError = body.failureCode === 'AWS_PERMISSION_DENIED' ? 'AWS_PERMISSION_DENIED' : 'CONFIGURE_FAILED';
    await tx
      .update(schema.customDomains)
      .set({ status: 'ERROR', lastError })
      .where(eq(schema.customDomains.id, domain.id));
    await recordEvent(tx, {
      organizationId: deployment.organizationId,
      eventType: 'domain.failed',
      actorType: 'relay',
      actorId: deployment.id,
      deploymentId: deployment.id,
      result: 'failure',
      payload: { hostname: domain.hostname, error: body.error },
    });
    return;
  }

  const output = body.output ?? {};
  const update: Partial<typeof schema.customDomains.$inferInsert> = {};
  for (const field of ['certificateArn', 'validationName', 'validationValue', 'routingTarget'] as const) {
    const value = output[field];
    if (typeof value === 'string') {
      update[field] = value;
    }
  }

  const validationName = update.validationName ?? domain.validationName;
  const validationValue = update.validationValue ?? domain.validationValue;

  let nextStatus: CustomDomainRow['status'] | undefined;
  if (domain.status === 'PENDING' && validationName && validationValue) {
    nextStatus = 'WAITING_FOR_DNS';
  }
  const statusForHttpsCheck = nextStatus ?? domain.status;
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
  }

  if (Object.keys(update).length > 0) {
    await tx.update(schema.customDomains).set(update).where(eq(schema.customDomains.id, domain.id));
  }
}
