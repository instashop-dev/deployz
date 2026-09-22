/**
 * Regional HTTPS certificates — the idempotent control-plane reconciler
 * (docs/https-regional-certificates.md). One persistent wildcard ACM
 * certificate per (customer, aws account, region), requested lazily right
 * after the bootstrap stack enrolls and reused by every deployment in that
 * scope.
 *
 * The `customer_regional_certificates` row IS the concurrency lock: its
 * unique index on (customer_id, aws_account_id, region) means an
 * `ON CONFLICT DO NOTHING` insert from two concurrent first deployments
 * converges on exactly one row, and this module ensures exactly one
 * in-flight ENSURE_CERTIFICATE job chases that row toward ISSUED — across
 * every deployment in the scope, not just the one that happened to insert
 * it. ACM/relay facts (arn, status, validation record) arrive via relay job
 * results, exactly like custom_domains and the legacy default-https
 * machine.
 */

import { and, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { ensureCertificateResultSchema, regionalCertificateDomain } from '@deployz/contracts';

import { CloudflareDnsError, stripTrailingDot, type CloudflareDnsClient } from './cloudflare-records.js';
import { createOrReuseJob } from './jobs.js';
import { recordEvent, type DeploymentEventType, type EventWriter } from './events.js';

// ── Types ────────────────────────────────────────────────────────────────

export type RegionalCertificateRow = typeof schema.customerRegionalCertificates.$inferSelect;
export type RegionalCertificateStatus = RegionalCertificateRow['certificateStatus'];

export interface RegionalCertificateDeps {
  /** The customer-namespace-aware Cloudflare client. */
  dns: CloudflareDnsClient;
  /** The DNS apex the customer namespace is minted under (`deployz.dev`). */
  apex: string;
  now?: () => Date;
}

const IN_FLIGHT_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'RUNNING']);

/** How long an ISSUED certificate is trusted without re-verifying (6h). */
const REVERIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The "taking longer than usual" hint boundary (docs: 30 minutes). */
const SLOW_BOUNDARY_MS = 30 * 60 * 1000;

/** The hard timeout after which a stuck pre-ISSUED row is failed (4 hours). */
const TIMEOUT_MS = 4 * 60 * 60 * 1000;

// ── Customer scope ──────────────────────────────────────────────────────────

/** The customer's DNS namespace label (`customers.dns_scope`). Throws if the
 *  customer row does not exist — callers only ever reach here for a
 *  deployment's own customer, which is a foreign-key guarantee. */
export async function resolveCustomerScope(db: RuntimeDb, customerId: string): Promise<string> {
  const rows = await db
    .select({ dnsScope: schema.customers.dnsScope })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`Customer not found: ${customerId}`);
  }
  return row.dnsScope;
}

// ── Job identity ─────────────────────────────────────────────────────────────

function ensureCertificateKeyMarker(rowId: string): string {
  return `:ENSURE_CERTIFICATE:${rowId}:`;
}

/** The cycle number embedded in an ENSURE_CERTIFICATE idempotency key for
 *  this row, or undefined when the key does not carry a parseable one. */
function parseEnsureCertificateCycle(idempotencyKey: string, rowId: string): number | undefined {
  const marker = ensureCertificateKeyMarker(rowId);
  const index = idempotencyKey.indexOf(marker);
  if (index === -1) return undefined;
  const rest = idempotencyKey.slice(index + marker.length);
  const cycle = Number(rest);
  return Number.isFinite(cycle) ? cycle : undefined;
}

/** The first 32 hex characters of a uuid with its dashes removed — the ACM
 *  IdempotencyToken shape (`[A-Za-z0-9_-]{1,32}`). */
function idempotencyTokenFor(rowId: string): string {
  return rowId.replace(/-/g, '').slice(0, 32);
}

// ── ensureRegionalCertificate ───────────────────────────────────────────────

export interface EnsureRegionalCertificateInput {
  deployment: {
    id: string;
    customerId: string;
    organizationId: string;
    awsAccountId: string;
    region: RegionalCertificateRow['region'];
  };
  dnsScope: string;
}

/**
 * Ensures the customer+account+region certificate row exists and, unless it
 * is already ISSUED-and-fresh or terminally ERROR, ensures exactly one
 * in-flight ENSURE_CERTIFICATE job chases it — across every deployment in
 * the scope, never one job per deployment. Safe to call on every heartbeat
 * and right after enrollment; the row insert is itself the concurrency lock,
 * so two callers racing the very first insert converge on one row.
 */
export async function ensureRegionalCertificate(
  db: RuntimeDb,
  input: EnsureRegionalCertificateInput,
  deps: RegionalCertificateDeps,
): Promise<{ row: RegionalCertificateRow; jobCreated: boolean }> {
  const now = deps.now ?? (() => new Date());
  const { deployment, dnsScope } = input;
  const certificateDomain = regionalCertificateDomain(dnsScope, deps.apex);
  const scopeMatch = and(
    eq(schema.customerRegionalCertificates.customerId, deployment.customerId),
    eq(schema.customerRegionalCertificates.awsAccountId, deployment.awsAccountId),
    eq(schema.customerRegionalCertificates.region, deployment.region),
  );

  // The lock: an ON CONFLICT DO NOTHING insert on the scope unique index.
  // Two concurrent first deployments for this customer+account+region both
  // attempt this insert; only one row ever exists afterwards.
  await db
    .insert(schema.customerRegionalCertificates)
    .values({
      organizationId: deployment.organizationId,
      customerId: deployment.customerId,
      awsAccountId: deployment.awsAccountId,
      region: deployment.region,
      certificateDomain,
      certificateStatus: 'REQUESTING',
    })
    .onConflictDoNothing({
      target: [
        schema.customerRegionalCertificates.customerId,
        schema.customerRegionalCertificates.awsAccountId,
        schema.customerRegionalCertificates.region,
      ],
    });

  const rows = await db.select().from(schema.customerRegionalCertificates).where(scopeMatch).limit(1);
  let row = rows[0];
  if (!row) {
    // Impossible under normal operation (the insert above either created it
    // or a conflicting row already existed) — defensive only.
    throw new Error('customer_regional_certificates row missing after ensure-insert');
  }

  if (row.certificateStatus === 'ISSUED') {
    const freshEnough = row.lastVerifiedAt !== null && now().getTime() - row.lastVerifiedAt.getTime() < REVERIFY_INTERVAL_MS;
    if (freshEnough) {
      return { row, jobCreated: false };
    }
  }
  if (row.certificateStatus === 'ERROR') {
    // Terminal — the retry route (retryRegionalCertificate) resets it.
    return { row, jobCreated: false };
  }

  // One in-flight ENSURE_CERTIFICATE job for this row, across ALL
  // deployments in the scope.
  const marker = ensureCertificateKeyMarker(row.id);
  const candidateJobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.type, 'ENSURE_CERTIFICATE'),
        like(schema.deploymentJobs.idempotencyKey, `%${marker}%`),
      ),
    )
    .orderBy(desc(schema.deploymentJobs.createdAt));

  const inFlight = candidateJobs.find((job) => IN_FLIGHT_JOB_STATES.has(job.state));
  if (inFlight) {
    return { row, jobCreated: false };
  }

  const newest = candidateJobs[0];
  const newestCycle = newest ? parseEnsureCertificateCycle(newest.idempotencyKey, row.id) : undefined;
  const cycle = newest !== undefined && newestCycle === row.checkCycle ? row.checkCycle + 1 : row.checkCycle;

  const { created } = await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'ENSURE_CERTIFICATE',
    idempotencyKey: `${deployment.id}:ENSURE_CERTIFICATE:${row.id}:${cycle}`,
    payload: {
      certificateDomain: row.certificateDomain,
      customerScope: dnsScope,
      ...(row.certificateArn ? { certificateArn: row.certificateArn } : {}),
      idempotencyToken: idempotencyTokenFor(row.id),
    },
    requestedBy: null,
  });

  const updates: Partial<typeof schema.customerRegionalCertificates.$inferInsert> = {};
  if (cycle !== row.checkCycle) {
    updates.checkCycle = cycle;
  }
  if (created) {
    if (row.certificateStatus !== 'ISSUED') {
      updates.attempts = row.attempts + 1;
    }
    if (row.requestedAt === null) {
      updates.requestedAt = now();
    }
  }
  if (Object.keys(updates).length > 0) {
    const [updated] = await db
      .update(schema.customerRegionalCertificates)
      .set(updates)
      .where(eq(schema.customerRegionalCertificates.id, row.id))
      .returning();
    row = updated ?? row;
  }
  if (created && updates.requestedAt) {
    await recordDefaultHttpsEvent(db, {
      organizationId: deployment.organizationId,
      deploymentId: deployment.id,
      customerId: deployment.customerId,
      eventType: 'certificate_requested',
      actorType: 'system',
      awsAccountId: deployment.awsAccountId,
      region: deployment.region,
      certificateDomain: row.certificateDomain,
    });
  }

  return { row, jobCreated: created };
}

// ── applyEnsureCertificateResult ─────────────────────────────────────────────

export interface RegionalCertificateTransition {
  arnReplaced: boolean;
  previousArn?: string;
  statusChanged: boolean;
  fromStatus?: RegionalCertificateStatus;
  toStatus?: RegionalCertificateStatus;
}

/**
 * Applies one ENSURE_CERTIFICATE relay job result to the certificate row.
 * Called from the relay result route, in the same transaction that finishes
 * the job row — mirrors applyDefaultHttpsJobResult's contract. `rowId` is
 * the certificate row id (embedded in the job's own idempotency key).
 */
export async function applyEnsureCertificateResult(
  tx: RuntimeDb,
  rowId: string,
  job: { type: string },
  body: { success?: boolean; output?: Record<string, unknown>; failureCode?: string },
): Promise<{ row: RegionalCertificateRow; transition: RegionalCertificateTransition | null } | null> {
  void job;
  const rows = await tx
    .select()
    .from(schema.customerRegionalCertificates)
    .where(eq(schema.customerRegionalCertificates.id, rowId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const isSuccess = body.success !== false;

  if (!isSuccess) {
    const permissionDenied = body.failureCode === 'AWS_PERMISSION_DENIED';
    const lastError = permissionDenied ? 'AWS_PERMISSION_DENIED' : 'ENSURE_FAILED';
    const nextStatus: RegionalCertificateStatus = permissionDenied ? 'ERROR' : row.certificateStatus;
    const statusChanged = nextStatus !== row.certificateStatus;
    const [updated] = await tx
      .update(schema.customerRegionalCertificates)
      .set({ lastError, ...(statusChanged ? { certificateStatus: nextStatus } : {}) })
      .where(eq(schema.customerRegionalCertificates.id, rowId))
      .returning();
    if (statusChanged) {
      await recordDefaultHttpsEvent(tx, {
        organizationId: row.organizationId,
        customerId: row.customerId,
        eventType: 'certificate_failed',
        actorType: 'relay',
        awsAccountId: row.awsAccountId,
        region: row.region,
        certificateDomain: row.certificateDomain,
        certificateArn: row.certificateArn,
      });
    }
    return {
      row: updated ?? row,
      transition: statusChanged
        ? { arnReplaced: false, statusChanged: true, fromStatus: row.certificateStatus, toStatus: nextStatus }
        : null,
    };
  }

  const parsed = ensureCertificateResultSchema.safeParse(body.output ?? {});
  if (!parsed.success) {
    const [updated] = await tx
      .update(schema.customerRegionalCertificates)
      .set({ lastError: 'ENSURE_FAILED' })
      .where(eq(schema.customerRegionalCertificates.id, rowId))
      .returning();
    return { row: updated ?? row, transition: null };
  }
  const result = parsed.data;
  const now = new Date();

  const updates: Partial<typeof schema.customerRegionalCertificates.$inferInsert> = {};
  const arnReplaced = Boolean(row.certificateArn) && row.certificateArn !== result.certificateArn;
  if (row.certificateArn !== result.certificateArn) {
    updates.certificateArn = result.certificateArn;
  }
  if (result.validationRecordName) {
    const strippedName = stripTrailingDot(result.validationRecordName);
    if (strippedName !== row.validationRecordName) updates.validationRecordName = strippedName;
  }
  if (result.validationRecordValue && result.validationRecordValue !== row.validationRecordValue) {
    updates.validationRecordValue = result.validationRecordValue;
  }
  if (result.validationRecordType && result.validationRecordType !== row.validationRecordType) {
    updates.validationRecordType = result.validationRecordType;
  }

  let nextStatus: RegionalCertificateStatus = row.certificateStatus;
  let lastError: string | null = row.lastError;
  switch (result.certificateStatus) {
    case 'PENDING_VALIDATION':
      nextStatus = 'DNS_VALIDATION_PENDING';
      lastError = null;
      break;
    case 'ISSUED':
      nextStatus = 'ISSUED';
      lastError = null;
      if (!row.issuedAt) updates.issuedAt = now;
      updates.lastVerifiedAt = now;
      break;
    case 'FAILED':
    case 'VALIDATION_TIMED_OUT':
    case 'REVOKED':
    case 'EXPIRED':
    case 'INACTIVE': {
      nextStatus = 'ERROR';
      const reason = `CERTIFICATE_${result.certificateStatus}`;
      lastError = result.failureReason ? `${reason}: ${result.failureReason}` : reason;
      break;
    }
    default:
      break;
  }

  const statusChanged = nextStatus !== row.certificateStatus;
  if (statusChanged) updates.certificateStatus = nextStatus;
  if (lastError !== row.lastError) updates.lastError = lastError;

  let updatedRow = row;
  if (Object.keys(updates).length > 0) {
    const [updated] = await tx
      .update(schema.customerRegionalCertificates)
      .set(updates)
      .where(eq(schema.customerRegionalCertificates.id, rowId))
      .returning();
    updatedRow = updated ?? row;
  }

  if (statusChanged && nextStatus === 'ISSUED') {
    await recordDefaultHttpsEvent(tx, {
      organizationId: row.organizationId,
      customerId: row.customerId,
      eventType: 'certificate_issued',
      actorType: 'relay',
      awsAccountId: row.awsAccountId,
      region: row.region,
      certificateDomain: row.certificateDomain,
      certificateArn: updatedRow.certificateArn,
    });
  } else if (statusChanged && nextStatus === 'ERROR') {
    await recordDefaultHttpsEvent(tx, {
      organizationId: row.organizationId,
      customerId: row.customerId,
      eventType: 'certificate_failed',
      actorType: 'relay',
      awsAccountId: row.awsAccountId,
      region: row.region,
      certificateDomain: row.certificateDomain,
      certificateArn: updatedRow.certificateArn,
    });
  }

  const transition: RegionalCertificateTransition | null =
    arnReplaced || statusChanged
      ? {
          arnReplaced,
          ...(arnReplaced && row.certificateArn ? { previousArn: row.certificateArn } : {}),
          statusChanged,
          ...(statusChanged ? { fromStatus: row.certificateStatus, toStatus: nextStatus } : {}),
        }
      : null;

  return { row: updatedRow, transition };
}

// ── reconcileValidationRecord ───────────────────────────────────────────────

/**
 * Reconciles the regional wildcard certificate's ACM validation CNAME.
 * Called OUTSIDE the relay-result transaction — by the route right after
 * applyEnsureCertificateResult, and by the heartbeat driver on every pass
 * while the row is not ISSUED (and once right after ISSUED, to make sure
 * the record still exists). Never consumes the certificate row's `attempts`
 * budget: a DNS write failure here is retried on the next cycle regardless.
 */
export async function reconcileValidationRecord(
  db: RuntimeDb,
  row: RegionalCertificateRow,
  deps: RegionalCertificateDeps,
): Promise<RegionalCertificateRow> {
  if (!row.validationRecordName || !row.validationRecordValue) {
    return row;
  }
  // dnsScope is embedded in the certificate domain (`*.c-<scope>.<zone>`),
  // not stored on the row directly — derive it from the validation name's
  // own namespace suffix instead of re-deriving it from certificateDomain,
  // since the validation name is what the DNS client actually guards on.
  const dnsScope = dnsScopeFromValidationName(row.validationRecordName, deps.apex);
  if (!dnsScope) {
    // Should never happen for a row this module wrote itself — defensive.
    return row;
  }

  const attemptedAt = new Date();
  try {
    const upsert = await deps.dns.upsertScopeValidationRecord(
      dnsScope,
      row.validationRecordName,
      row.validationRecordValue,
    );
    const updates: Partial<typeof schema.customerRegionalCertificates.$inferInsert> = {};
    if (row.lastError === 'DNS_WRITE_FAILED' || row.lastError === 'CLOUDFLARE_RATE_LIMITED') {
      updates.lastError = null;
    }
    if (!row.validationDnsReadyAt) {
      updates.validationDnsReadyAt = attemptedAt;
    }
    const recordId = upsert.record?.id;
    if (recordId && recordId !== row.cloudflareRecordId) {
      updates.cloudflareRecordId = recordId;
    }
    if (Object.keys(updates).length === 0) {
      return row;
    }
    const [updated] = await db
      .update(schema.customerRegionalCertificates)
      .set(updates)
      .where(eq(schema.customerRegionalCertificates.id, row.id))
      .returning();
    if (updates.validationDnsReadyAt) {
      await recordDefaultHttpsEvent(db, {
        organizationId: row.organizationId,
        customerId: row.customerId,
        eventType: 'validation_dns_ready',
        actorType: 'system',
        awsAccountId: row.awsAccountId,
        region: row.region,
        certificateDomain: row.certificateDomain,
      });
    }
    return updated ?? row;
  } catch (error) {
    if (error instanceof CloudflareDnsError && error.code === 'CLOUDFLARE_DNS_CONFLICT') {
      // Never overwrite a conflicting value — terminal until an operator
      // clears the offending record.
      const [updated] = await db
        .update(schema.customerRegionalCertificates)
        .set({ certificateStatus: 'ERROR', lastError: 'DNS_VALIDATION_CONFLICT' })
        .where(eq(schema.customerRegionalCertificates.id, row.id))
        .returning();
      return updated ?? row;
    }
    if (error instanceof CloudflareDnsError && error.code === 'CLOUDFLARE_RATE_LIMITED') {
      const [updated] = await db
        .update(schema.customerRegionalCertificates)
        .set({ lastError: 'CLOUDFLARE_RATE_LIMITED' })
        .where(eq(schema.customerRegionalCertificates.id, row.id))
        .returning();
      return updated ?? row;
    }
    const [updated] = await db
      .update(schema.customerRegionalCertificates)
      .set({ lastError: 'DNS_WRITE_FAILED' })
      .where(eq(schema.customerRegionalCertificates.id, row.id))
      .returning();
    return updated ?? row;
  }
}

/** Recovers the `c-<scope>` namespace from a validation record name shaped
 *  `_<digest>.c-<scope>.<zone>` (or its FQDN form with a trailing dot). */
function dnsScopeFromValidationName(validationName: string, apex: string): string | null {
  const stripped = stripTrailingDot(validationName);
  const suffix = `.${apex}`;
  if (!stripped.toLowerCase().endsWith(suffix)) return null;
  const withoutZone = stripped.slice(0, -suffix.length);
  const parts = withoutZone.split('.');
  const scopeLabel = parts[parts.length - 1];
  if (!scopeLabel || !scopeLabel.startsWith('c-')) return null;
  return scopeLabel.slice(2);
}

// ── slow / timeout helpers ───────────────────────────────────────────────────

/** The slice of a certificate row the slow/timeout predicates need — a Pick
 *  rather than the full row so callers projecting a narrower shape (e.g. the
 *  deployment-status httpsProgress derivation) never need an unsafe cast. */
export interface RegionalCertificateTiming {
  certificateStatus: RegionalCertificateStatus;
  requestedAt: Date | string | null | undefined;
}

/** True once a not-yet-ISSUED row has been in progress for over 30 minutes —
 *  the "taking longer than usual" hint boundary. */
export function isRegionalCertificateSlow(row: RegionalCertificateTiming, now: Date = new Date()): boolean {
  if (row.certificateStatus === 'ISSUED') return false;
  if (!row.requestedAt) return false;
  return now.getTime() - new Date(row.requestedAt).getTime() > SLOW_BOUNDARY_MS;
}

/** True once a not-yet-ISSUED row has been in progress for over 4 hours —
 *  the hard timeout the heartbeat driver fails on (VALIDATION_TIMEOUT). */
export function hasRegionalCertificateTimedOut(row: RegionalCertificateTiming, now: Date = new Date()): boolean {
  if (row.certificateStatus === 'ISSUED') return false;
  if (!row.requestedAt) return false;
  return now.getTime() - new Date(row.requestedAt).getTime() > TIMEOUT_MS;
}

// ── retry ────────────────────────────────────────────────────────────────────

/** The vendor's explicit retry: ERROR → REQUESTING, budget reset. Mirrors
 *  the legacy default-HTTPS retry route's contract. */
export async function retryRegionalCertificate(db: RuntimeDb, rowId: string): Promise<RegionalCertificateRow> {
  const [updated] = await db
    .update(schema.customerRegionalCertificates)
    .set({
      certificateStatus: 'REQUESTING',
      lastError: null,
      checkCycle: sql`${schema.customerRegionalCertificates.checkCycle} + 1`,
      attempts: 0,
    })
    .where(eq(schema.customerRegionalCertificates.id, rowId))
    .returning();
  if (!updated) {
    throw new Error(`Regional certificate row not found: ${rowId}`);
  }
  return updated;
}

// ── purge / scope bookkeeping ────────────────────────────────────────────────

const LIVE_DEPLOYMENT_STATE = ne(schema.deployments.state, 'DELETED');

/** How many non-DELETED deployments remain in a customer+account+region
 *  scope, optionally excluding one deployment (the one currently being
 *  purged). */
export async function remainingScopeDeployments(
  db: RuntimeDb,
  scope: { customerId: string; awsAccountId: string; region: RegionalCertificateRow['region']; excludeDeploymentId?: string },
): Promise<number> {
  const rows = await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.customerId, scope.customerId),
        eq(schema.deployments.awsAccountId, scope.awsAccountId),
        eq(schema.deployments.region, scope.region),
        LIVE_DEPLOYMENT_STATE,
        ...(scope.excludeDeploymentId ? [ne(schema.deployments.id, scope.excludeDeploymentId)] : []),
      ),
    );
  return rows.length;
}

/**
 * The certificate row(s) to delete when purging `deployment` — only
 * non-empty when it is the LAST non-DELETED deployment in its scope (ACM
 * certificates are account+region scoped and shared by every deployment
 * there; deleting one out from under a sibling deployment would break it).
 */
export async function regionalCertificatesForPurge(
  db: RuntimeDb,
  deployment: { id: string; customerId: string; awsAccountId: string | null; region: RegionalCertificateRow['region'] },
): Promise<RegionalCertificateRow[]> {
  if (!deployment.awsAccountId) return [];
  const remaining = await remainingScopeDeployments(db, {
    customerId: deployment.customerId,
    awsAccountId: deployment.awsAccountId,
    region: deployment.region,
    excludeDeploymentId: deployment.id,
  });
  if (remaining > 0) return [];
  return db
    .select()
    .from(schema.customerRegionalCertificates)
    .where(
      and(
        eq(schema.customerRegionalCertificates.customerId, deployment.customerId),
        eq(schema.customerRegionalCertificates.awsAccountId, deployment.awsAccountId),
        eq(schema.customerRegionalCertificates.region, deployment.region),
      ),
    );
}

/**
 * Deletes the purged certificate row(s) and their validation CNAME — unless
 * another row for the same (customerId, awsAccountId) still carries the
 * SAME validationRecordName (ACM shares one validation record across every
 * region in an account, since the record lives one level under the
 * customer's namespace, not under a region). Tolerates an already-missing
 * DNS record.
 */
export async function completeRegionalCertificateRemoval(
  db: RuntimeDb,
  deps: RegionalCertificateDeps,
  rows: RegionalCertificateRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);

  for (const row of rows) {
    if (row.validationRecordName) {
      const siblings = await db
        .select({ id: schema.customerRegionalCertificates.id })
        .from(schema.customerRegionalCertificates)
        .where(
          and(
            eq(schema.customerRegionalCertificates.customerId, row.customerId),
            eq(schema.customerRegionalCertificates.awsAccountId, row.awsAccountId),
            eq(schema.customerRegionalCertificates.validationRecordName, row.validationRecordName),
            ne(schema.customerRegionalCertificates.id, row.id),
          ),
        );
      if (siblings.length === 0) {
        const dnsScope = dnsScopeFromValidationName(row.validationRecordName, deps.apex);
        if (dnsScope) {
          try {
            await deps.dns.deleteScopeValidationRecord(dnsScope, row.validationRecordName);
          } catch (error) {
            if (!(error instanceof CloudflareDnsError)) throw error;
            // Tolerate a missing/unreachable record — the row is being
            // deleted regardless; nothing left to reconcile it later.
          }
        }
      }
    }
    await recordDefaultHttpsEvent(db, {
      organizationId: row.organizationId,
      customerId: row.customerId,
      eventType: 'certificate_removed',
      actorType: 'system',
      awsAccountId: row.awsAccountId,
      region: row.region,
      certificateDomain: row.certificateDomain,
      certificateArn: row.certificateArn,
    });
  }

  await db.delete(schema.customerRegionalCertificates).where(inArray(schema.customerRegionalCertificates.id, ids));
}

// ── events ───────────────────────────────────────────────────────────────────

export type DefaultHttpsEventKind =
  | 'certificate_requested'
  | 'validation_dns_ready'
  | 'certificate_issued'
  | 'certificate_failed'
  | 'listener_ready'
  | 'dns_created'
  | 'active'
  | 'failed'
  | 'certificate_removed';

/** Fills organizationId/customerId/deploymentId and the no-secrets payload
 *  ({ awsAccountId, region, certificateArn, certificateDomain, hostname })
 *  for one `default_https.*` event row. Shared by this module and
 *  apps/api/src/default-https.ts's regional driver. */
export async function recordDefaultHttpsEvent(
  tx: EventWriter,
  input: {
    organizationId: string;
    deploymentId?: string;
    customerId?: string;
    eventType: DefaultHttpsEventKind;
    actorType?: 'user' | 'relay' | 'system';
    awsAccountId?: string | null;
    region?: string | null;
    certificateArn?: string | null;
    certificateDomain?: string | null;
    hostname?: string | null;
  },
): Promise<void> {
  await recordEvent(tx, {
    organizationId: input.organizationId,
    eventType: `default_https.${input.eventType}` as DeploymentEventType,
    actorType: input.actorType ?? 'system',
    actorId: input.deploymentId ?? input.customerId ?? input.organizationId,
    deploymentId: input.deploymentId,
    customerId: input.customerId,
    payload: {
      ...(input.awsAccountId ? { awsAccountId: input.awsAccountId } : {}),
      ...(input.region ? { region: input.region } : {}),
      ...(input.certificateArn ? { certificateArn: input.certificateArn } : {}),
      ...(input.certificateDomain ? { certificateDomain: input.certificateDomain } : {}),
      ...(input.hostname ? { hostname: input.hostname } : {}),
    },
  });
}
