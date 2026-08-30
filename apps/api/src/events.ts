import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

// §40/§62 event log — the append-only audit stream.
//
// Every deployment-lifecycle transition writes one row here. Before this, the
// only writers were application deletion and the organization routes, and
// neither set deployment_id — which is the column
// GET /api/deployments/:id/events filters on, so that endpoint could never
// return anything and "Recent activity" was permanently empty.
//
// Rows are immutable: drizzle/0001_event_logs_immutable.sql installs a
// trigger that raises on UPDATE, DELETE and TRUNCATE. An event has to be
// correct when it is written; there is no patching it afterwards.
//
// Write inside the same transaction as the state change it describes, so an
// event can never disagree with the row it is about.

/** §40 event vocabulary. Families are install/deploy/rollback/destroy/config/health/relay. */
export type DeploymentEventType =
  | 'install.requested'
  | 'install.completed'
  | 'install.failed'
  | 'install.retry.requested'
  | 'install.enrollment.rejected'
  | 'deploy.requested'
  | 'deploy.completed'
  | 'deploy.failed'
  | 'rollback.requested'
  | 'rollback.completed'
  | 'rollback.failed'
  | 'restart.requested'
  | 'restart.completed'
  | 'restart.failed'
  | 'destroy.requested'
  | 'destroy.completed'
  | 'destroy.failed'
  // Runtime observation corrected the release pointer (never a deploy claim).
  | 'deployment.reconciled'
  // A healthy heartbeat cleared a stale FAILED on an installed deployment.
  | 'deployment.state_recovered'
  // The watchdog failed a stuck mutating job (Phase 7).
  | 'operation.timeout'
  | 'config.updated'
  | 'config.failed'
  | 'health.reported'
  | 'health.degraded'
  | 'health.unhealthy'
  | 'health.recovered'
  | 'ecs.rollout_failed'
  | 'relay.reenrollment.requested'
  // domain family — custom-domains MVP.
  | 'domain.added'
  | 'domain.activated'
  | 'domain.failed'
  | 'domain.removed';

export interface DeploymentEvent {
  readonly organizationId: string;
  readonly eventType: DeploymentEventType;
  /** 'user' for a vendor action, 'relay' for anything the relay reports. */
  readonly actorType: 'user' | 'relay' | 'system';
  /** Better Auth user id, or the deployment id for a relay actor. */
  readonly actorId: string;
  readonly deploymentId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly releaseId?: string | undefined;
  readonly previousState?: string | null | undefined;
  readonly requestedState?: string | null | undefined;
  readonly result?: 'success' | 'failure' | 'pending' | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

/**
 * The db or an open transaction. Typed off RuntimeDb's own insert so a
 * transaction handle — which carries the identical signature — satisfies it
 * without the row type being widened to something drizzle cannot check.
 */
export type EventWriter = Pick<RuntimeDb, 'insert'>;

/**
 * Append one event. Takes the db or an open transaction so callers can keep
 * the event and the state change atomic.
 */
export async function recordEvent(tx: EventWriter, event: DeploymentEvent): Promise<void> {
  await tx.insert(schema.eventLogs).values({
    actorType: event.actorType,
    actorId: event.actorId,
    organizationId: event.organizationId,
    customerId: event.customerId ?? null,
    deploymentId: event.deploymentId ?? null,
    jobId: event.jobId ?? null,
    releaseId: event.releaseId ?? null,
    eventType: event.eventType,
    previousState: event.previousState ?? null,
    requestedState: event.requestedState ?? null,
    result: event.result ?? 'success',
    payload: event.payload ?? {},
  });
}
