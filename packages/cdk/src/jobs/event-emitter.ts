/**
 * §62 event emission helper — immutable, append-only event records.
 *
 * Every step in the INSTALL workflow emits a §62-complete event:
 *   who (actorType/actorId) / when (occurredAt) / customer / previous state /
 *   requested state / release / job ID / result.
 *
 * The EventStore interface is injectable: InMemoryEventStore for tests,
 * a DB-backed store for production (wired in todo 14+).
 *
 * Immutability: EventRecord fields are readonly; the store only exposes
 * `append` (no update/delete). This matches the event_logs table's
 * append-only trigger (packages/db/src/schema/events.ts).
 */

// ── Types ────────────────────────────────────────────────────────────────

/** Who performed the action. */
export type EventActor =
  | { readonly type: 'user'; readonly id: string }
  | { readonly type: 'relay'; readonly installationId: string }
  | { readonly type: 'system' };

/**
 * §62 "who initiated it" — the shape a workflow's Input type carries on its
 * optional `initiatedBy` field. The API layer already captures
 * `requestedBy`; this is what a caller threads through so the emitted §62
 * events attribute the action to the actual initiator (a user) instead of
 * always defaulting to `system`.
 */
export interface WorkflowInitiator {
  readonly type: 'user' | 'system';
  readonly id?: string | undefined;
}

/**
 * Resolve a workflow's optional `initiatedBy` input into an `EventActor`.
 * Defaults to `{ type: 'system' }` when `initiatedBy` is absent, or when it
 * claims `type: 'user'` without an id (a userless "user" actor is not a
 * meaningful attribution — that's genuinely system-initiated).
 */
export function actorFromInitiator(initiatedBy: WorkflowInitiator | undefined): EventActor {
  if (initiatedBy?.type === 'user' && initiatedBy.id) {
    return { type: 'user', id: initiatedBy.id };
  }
  return { type: 'system' };
}

/** Fields the caller supplies when emitting an event. */
export interface EmitEventInput {
  readonly eventType: string;
  readonly organizationId: string;
  readonly customerId?: string | undefined;
  readonly deploymentId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly releaseId?: string | undefined;
  readonly previousState?: string | undefined;
  readonly requestedState?: string | undefined;
  readonly result?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

/** An immutable event record — matches the event_logs table shape. */
export interface EventRecord {
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly organizationId: string;
  readonly customerId: string | null;
  readonly deploymentId: string | null;
  readonly jobId: string | null;
  readonly releaseId: string | null;
  readonly eventType: string;
  readonly previousState: string | null;
  readonly requestedState: string | null;
  readonly result: string | null;
  readonly payload: Record<string, unknown>;
}

// ── Store interface ──────────────────────────────────────────────────────

/** Append-only event store. No update/delete — events are immutable. */
export interface EventStore {
  append(event: EventRecord): Promise<void>;
}

// ── In-memory store (for tests) ──────────────────────────────────────────

export class InMemoryEventStore implements EventStore {
  private readonly _events: EventRecord[] = [];

  async append(event: EventRecord): Promise<void> {
    // Copy + freeze the payload so callers can't mutate a stored event via
    // the original object reference; freeze the record itself too.
    const payload = { ...event.payload };
    Object.freeze(payload);
    const frozen: EventRecord = Object.freeze({ ...event, payload });
    this._events.push(frozen);
  }

  /** All recorded events (readonly snapshot). */
  get events(): readonly EventRecord[] {
    return this._events;
  }

  /** Number of recorded events. */
  get count(): number {
    return this._events.length;
  }

  /** Clear all events (test isolation only — not on the EventStore interface). */
  clear(): void {
    this._events.length = 0;
  }
}

// ── Emitter ──────────────────────────────────────────────────────────────

/**
 * §62 event emitter.
 *
 * Every call to `emit()` produces an immutable EventRecord with a timestamp
 * and appends it to the store. The clock is injectable for deterministic tests.
 */
export class EventEmitter {
  constructor(
    private readonly store: EventStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async emit(actor: EventActor, input: EmitEventInput): Promise<EventRecord> {
    const [actorType, actorId] = resolveActor(actor);

    const event: EventRecord = {
      occurredAt: this.clock().toISOString(),
      actorType,
      actorId,
      organizationId: input.organizationId,
      customerId: input.customerId ?? null,
      deploymentId: input.deploymentId ?? null,
      jobId: input.jobId ?? null,
      releaseId: input.releaseId ?? null,
      eventType: input.eventType,
      previousState: input.previousState ?? null,
      requestedState: input.requestedState ?? null,
      result: input.result ?? null,
      payload: input.payload ?? {},
    };

    await this.store.append(event);
    return event;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveActor(actor: EventActor): [string, string] {
  switch (actor.type) {
    case 'user':
      return ['user', actor.id];
    case 'relay':
      return ['relay', actor.installationId];
    case 'system':
      return ['system', 'system'];
  }
}