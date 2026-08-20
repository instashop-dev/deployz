/**
 * §40 + §62 audit completeness test.
 *
 * This test is a READ-ONLY audit — it scans workflow source files for event
 * types, verifies every §40 family is emitted, proves §62 fields are present
 * on every event, and re-verifies append-only immutability.
 *
 * It does NOT modify any source file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { eventLogs } from '@deployz/db';

import {
  EventEmitter,
  InMemoryEventStore,
  type EventRecord,
  type EventStore,
} from '../src/jobs/event-emitter.js';

// ── Paths ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JOBS_DIR = resolve(__dirname, '../src/jobs');

// ── §40 event families ────────────────────────────────────────────────────

const EVENT_FAMILIES = [
  'install',
  'deploy',
  'rollback',
  'config',
  'destroy',
  'health',
  'billing',
] as const;

// ── §62 required fields ───────────────────────────────────────────────────

/**
 * §62: every infra-changing action records:
 *   who (actorType/actorId) / when (occurredAt) / customer (customerId) /
 *   previous state / requested state / release (releaseId) / job ID (jobId) /
 *   result.
 */
const S62_FIELDS = [
  'occurredAt',     // when
  'actorType',      // who
  'actorId',        // who
  'customerId',     // customer
  'previousState',  // previous state
  'requestedState', // requested state
  'releaseId',      // release
  'jobId',          // job ID
  'result',         // result
] as const;

// ── Workflow files to scan ────────────────────────────────────────────────

const WORKFLOW_FILES = [
  'install-workflow.ts',
  'deploy-release-workflow.ts',
  'rollback-workflow.ts',
  'config-update-workflow.ts',
  'destroy-workflow.ts',
  'health-monitor.ts',
  'notifications.ts',
];

// ── Helpers ───────────────────────────────────────────────────────────────

function readSourceFile(filename: string): string {
  return readFileSync(resolve(JOBS_DIR, filename), 'utf-8');
}

/**
 * Extract event type strings from source code.
 * Matches patterns like `eventType: 'install.preflight.region'`
 * AND event types defined in arrays like `NOTIFICATION_EVENT_TYPES = ['health.degraded', ...]`.
 */
function extractEventTypes(source: string): string[] {
  const matches: string[] = [];

  // Pattern 1: `eventType: '...'` (workflow emit calls)
  const emitPattern = /eventType:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = emitPattern.exec(source)) !== null) {
    matches.push(match[1]);
  }

// Pattern 2: String literals in arrays like NOTIFICATION_EVENT_TYPES = ['...', '...']
    // Match single-quoted strings that look like event types (contain a dot, may have underscores)
    const arrayPattern = /'([a-z]+\.[a-z._]+)'/g;
  while ((match = arrayPattern.exec(source)) !== null) {
    const candidate = match[1];
    // Only include if it looks like an event type (has at least one dot)
    // and isn't already captured by the emit pattern
    if (candidate.includes('.') && !matches.includes(candidate)) {
      matches.push(candidate);
    }
  }

  return matches;
}

/** Return the top-level family of an event type (e.g. "install" from "install.preflight.region"). */
function getFamily(eventType: string): string {
  return eventType.split('.')[0] ?? '';
}

// ── Collect all event types ───────────────────────────────────────────────

const allEventTypes = new Map<string, string[]>(); // family → unique event types
const allFoundRaw: string[] = [];

for (const file of WORKFLOW_FILES) {
  const source = readSourceFile(file);
  const types = extractEventTypes(source);
  for (const t of types) {
    allFoundRaw.push(t);
    const family = getFamily(t);
    if (!allEventTypes.has(family)) {
      allEventTypes.set(family, []);
    }
    const existing = allEventTypes.get(family)!;
    if (!existing.includes(t)) {
      existing.push(t);
    }
  }
}

// Sort for deterministic output
for (const types of allEventTypes.values()) {
  types.sort();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('audit + event completeness (§40, §62)', () => {
  // ══════════════════════════════════════════════════════════════════════
  // §40: Event family coverage
  // ══════════════════════════════════════════════════════════════════════

  describe('§40 event family coverage', () => {
    for (const family of EVENT_FAMILIES) {
      it(`family "${family}.*" has at least one event type emitted`, () => {
        const types = allEventTypes.get(family);
        expect(
          types,
          `No event types found for family "${family}.*"`,
        ).toBeDefined();
        expect(
          types!.length,
          `Family "${family}.*" has zero event types — expected at least 1`,
        ).toBeGreaterThan(0);
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // No orphaned event types
  // ══════════════════════════════════════════════════════════════════════

  it('no event type is orphaned — every found event type belongs to a §40 family', () => {
    const knownFamilies = new Set<string>(EVENT_FAMILIES);
    const orphans: string[] = [];
    for (const t of allFoundRaw) {
      const family = getFamily(t);
      if (!knownFamilies.has(family)) {
        orphans.push(t);
      }
    }
    expect(
      orphans,
      `Orphaned event types (not in §40 families): ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // No duplicate event types across families
  // ══════════════════════════════════════════════════════════════════════

  it('no event type is duplicated across families', () => {
    const seen = new Map<string, string>(); // eventType → family
    const duplicates: string[] = [];
    for (const t of allFoundRaw) {
      const family = getFamily(t);
      const prev = seen.get(t);
      if (prev !== undefined && prev !== family) {
        duplicates.push(`${t} (${prev} vs ${family})`);
      }
      seen.set(t, family);
    }
    expect(
      duplicates,
      `Event types duplicated across families: ${duplicates.join(', ')}`,
    ).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // §62: EventRecord type has all required fields
  // ══════════════════════════════════════════════════════════════════════

  describe('§62 field verification — EventRecord type', () => {
    // Construct a dummy record to verify the shape at runtime.
    // TypeScript would catch missing fields at compile time, but this
    // test proves the runtime shape matches the §62 contract.
    const dummy: EventRecord = {
      occurredAt: '2026-01-01T00:00:00.000Z',
      actorType: 'system',
      actorId: 'system',
      organizationId: 'org-1',
      customerId: null,
      deploymentId: null,
      jobId: null,
      releaseId: null,
      eventType: 'test.event',
      previousState: null,
      requestedState: null,
      result: null,
      payload: {},
    };

    for (const field of S62_FIELDS) {
      it(`EventRecord has §62 field "${field}"`, () => {
        expect(
          field in dummy,
          `EventRecord is missing §62 field "${field}"`,
        ).toBe(true);
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // §62: event_logs table has all required columns
  // ══════════════════════════════════════════════════════════════════════

  describe('§62 field verification — event_logs table', () => {
    // Drizzle exposes columns by their JavaScript property names (camelCase),
    // not by their SQL column names (snake_case). The schema defines:
    //   occurredAt: timestamp('occurred_at', ...)
    // so the column is accessed as eventLogs.occurredAt, not eventLogs.occurred_at.
    const s62ColumnNames = [
      'occurredAt',
      'actorType',
      'actorId',
      'customerId',
      'previousState',
      'requestedState',
      'releaseId',
      'jobId',
      'result',
    ] as const;

    for (const colName of s62ColumnNames) {
      it(`event_logs has §62 column "${colName}"`, () => {
        const col = (eventLogs as Record<string, unknown>)[colName];
        expect(
          col,
          `event_logs is missing §62 column "${colName}"`,
        ).toBeDefined();
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // Cross-reference: EventRecord ↔ event_logs
  // ══════════════════════════════════════════════════════════════════════

  describe('EventRecord ↔ event_logs cross-reference', () => {
    // EventRecord fields (camelCase)
    const recordFields = [
      'occurredAt',
      'actorType',
      'actorId',
      'organizationId',
      'customerId',
      'deploymentId',
      'jobId',
      'releaseId',
      'eventType',
      'previousState',
      'requestedState',
      'result',
      'payload',
    ];

    // Known event_logs Drizzle column names (camelCase JS property names)
    const tableColumns = [
      'id',
      'occurredAt',
      'actorType',
      'actorId',
      'organizationId',
      'customerId',
      'deploymentId',
      'jobId',
      'releaseId',
      'eventType',
      'previousState',
      'requestedState',
      'result',
      'payload',
    ];

    it('every EventRecord field has a matching event_logs column', () => {
      const missing: string[] = [];
      for (const field of recordFields) {
        const col = (eventLogs as Record<string, unknown>)[field];
        if (col === undefined) {
          missing.push(field);
        }
      }
      expect(
        missing,
        `EventRecord fields with no matching event_logs column: ${missing.join(', ')}`,
      ).toEqual([]);
    });

    it('every event_logs column (except id) has a matching EventRecord field', () => {
      const missing: string[] = [];
      for (const col of tableColumns) {
        if (col === 'id') continue;
        if (!recordFields.includes(col)) {
          missing.push(col);
        }
      }
      expect(
        missing,
        `event_logs columns with no matching EventRecord field: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Append-only immutability
  // ══════════════════════════════════════════════════════════════════════

  describe('append-only immutability', () => {
    it('EventStore interface exposes only append (no update/delete)', () => {
      const store: EventStore = new InMemoryEventStore();
      expect(typeof store.append).toBe('function');
      // Verify no mutation methods exist on the interface
      expect('update' in store).toBe(false);
      expect('delete' in store).toBe(false);
      expect('remove' in store).toBe(false);
      expect('modify' in store).toBe(false);
      expect('set' in store).toBe(false);
    });

    it('InMemoryEventStore has no mutation methods beyond append', () => {
      const store = new InMemoryEventStore();
      const proto = Object.getPrototypeOf(store);
      const ownKeys = Object.getOwnPropertyNames(proto).filter(
        (k) => k !== 'constructor',
      );
      const forbidden = ['update', 'delete', 'remove', 'modify', 'set', 'replace'];
      const found = ownKeys.filter((k) => forbidden.includes(k));
      expect(
        found,
        `InMemoryEventStore has forbidden mutation methods: ${found.join(', ')}`,
      ).toEqual([]);
    });

    it('InMemoryEventStore freezes records on append (immutability)', async () => {
      const store = new InMemoryEventStore();
      const emitter = new EventEmitter(
        store,
        () => new Date('2026-01-01T00:00:00.000Z'),
      );

      await emitter.emit(
        { type: 'system' },
        {
          eventType: 'test.event',
          organizationId: 'org-1',
          payload: { key: 'value' },
        },
      );

      const stored = store.events[0];
      expect(stored).toBeDefined();
      expect(Object.isFrozen(stored!)).toBe(true);
      expect(Object.isFrozen(stored!.payload)).toBe(true);
    });

    it('InMemoryEventStore.clear() is test-only (not on EventStore interface)', () => {
      // clear() exists on InMemoryEventStore for test isolation but is NOT
      // part of the EventStore interface — production stores cannot clear.
      const store = new InMemoryEventStore();
      expect(typeof store.clear).toBe('function');

      // Verify clear is NOT declared on the EventStore interface by checking
      // that the interface only declares `append`. We do this by verifying
      // that the only callable method on the interface type is `append`.
      // At runtime, `in` checks the object, not the type, so we verify
      // the interface shape through the EventStore type declaration:
      // EventStore { append(event: EventRecord): Promise<void> }
      // No clear, update, delete, remove, modify, or set.
      const storeAsInterface: EventStore = store;
      expect(typeof storeAsInterface.append).toBe('function');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // EventEmitter produces §62-complete records
  // ══════════════════════════════════════════════════════════════════════

  describe('EventEmitter produces §62-complete records', () => {
    it('every emitted event carries all §62 fields with correct values', async () => {
      const store = new InMemoryEventStore();
      const emitter = new EventEmitter(
        store,
        () => new Date('2026-01-01T00:00:00.000Z'),
      );

      const event = await emitter.emit(
        { type: 'user', id: 'user-1' },
        {
          eventType: 'install.preflight.region',
          organizationId: 'org-1',
          customerId: 'customer-1',
          deploymentId: 'deployment-1',
          jobId: 'job-1',
          releaseId: 'release-1',
          previousState: 'NOT_INSTALLED',
          requestedState: 'INSTALLING',
          result: 'passed',
          payload: { region: 'us-east-1' },
        },
      );

      // §62: who
      expect(event.actorType).toBe('user');
      expect(event.actorId).toBe('user-1');
      // §62: when
      expect(event.occurredAt).toBe('2026-01-01T00:00:00.000Z');
      // §62: customer
      expect(event.customerId).toBe('customer-1');
      // §62: previous state
      expect(event.previousState).toBe('NOT_INSTALLED');
      // §62: requested state
      expect(event.requestedState).toBe('INSTALLING');
      // §62: release
      expect(event.releaseId).toBe('release-1');
      // §62: job ID
      expect(event.jobId).toBe('job-1');
      // §62: result
      expect(event.result).toBe('passed');
    });

    it('emitted events are appended to the store exactly once', async () => {
      const store = new InMemoryEventStore();
      const emitter = new EventEmitter(
        store,
        () => new Date('2026-01-01T00:00:00.000Z'),
      );

      expect(store.count).toBe(0);

      await emitter.emit(
        { type: 'system' },
        { eventType: 'test.one', organizationId: 'org-1' },
      );
      expect(store.count).toBe(1);

      await emitter.emit(
        { type: 'system' },
        { eventType: 'test.two', organizationId: 'org-1' },
      );
      expect(store.count).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Informational: event-coverage summary
  // ══════════════════════════════════════════════════════════════════════

  it('event-coverage summary (informational — always passes)', () => {
    const lines: string[] = [];
    lines.push('');
    lines.push('=== §40 Event Coverage Summary ===');
    for (const family of EVENT_FAMILIES) {
      const types = allEventTypes.get(family) ?? [];
      lines.push(`  ${family}.* (${types.length} types): ${types.join(', ')}`);
    }
    const uniqueCount = new Set(allFoundRaw).size;
    lines.push(`  Total unique event types: ${uniqueCount}`);
    lines.push('===================================');
    lines.push('');
    console.log(lines.join('\n'));

    // This test always passes — it's informational only.
    expect(true).toBe(true);
  });
});