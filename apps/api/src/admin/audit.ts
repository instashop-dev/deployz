import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Actor } from '../organizations.js';

/** Append-only `admin.*` audit row (docs/admin/team-admin.md's Audit requirements). */
export async function recordAdminAuditEvent(
  db: RuntimeDb,
  entry: {
    actor: Actor;
    eventType: string;
    organizationId: string;
    targetType: string;
    targetId: string;
    reason?: string;
    result?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(schema.eventLogs).values({
    actorType: 'user',
    actorId: entry.actor.id,
    organizationId: entry.organizationId,
    eventType: entry.eventType,
    result: entry.result ?? 'success',
    payload: {
      adminEmail: entry.actor.email,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...entry.payload,
    },
  });
}
