import { describe, expect, it } from 'vitest';

import { toDiagnostics, type DiagnosticEvent } from '../src/lib/diagnostics';

// §14.3 diagnostics plumbing: the API serves the relay's verbatim error as
// `technicalDetail`, and the card's expandable "Technical detail" disclosure
// (DiagnosticCard's EventRows) renders `event.error.message`. The client
// mapping must carry it through — it used to drop it, which left the
// disclosure empty on every failure.

const base = {
  failureCode: 'DATABASE_CREATE_FAILED',
  recoverability: 'USER_ACTION',
  what: 'The database could not be created.',
  why: 'The account rejected the database this application requires.',
  fix: 'Check whether the account limits databases in this region, then run the install link again.',
  events: [{ occurredAt: '2026-09-03T00:00:00.000Z', eventType: 'install.failed', result: 'failed' }],
};

describe('toDiagnostics', () => {
  it('maps an empty (non-failed) response to no cards', () => {
    expect(
      toDiagnostics({
        failureCode: null,
        what: null,
        why: null,
        fix: null,
        events: [],
      }),
    ).toEqual([]);
  });

  it('carries the relay technical detail into the event error message', () => {
    const [diagnostic] = toDiagnostics({
      ...base,
      technicalDetail: 'internal: RDS CreateDBInstance timed out after 900s',
    });
    expect(diagnostic.event.error?.message).toBe('internal: RDS CreateDBInstance timed out after 900s');
  });

  it('leaves the event error absent when no technical detail was served', () => {
    const [diagnostic] = toDiagnostics({ ...base });
    expect((diagnostic.event as DiagnosticEvent).error).toBeUndefined();
  });
});
