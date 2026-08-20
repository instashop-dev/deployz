import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DIAGNOSTIC_EVENT_SOURCES,
  diagnosticEventSchema,
  parseDiagnosticEvent,
} from '../src/analysis/diagnostic-event-schema.js';

// A realistic raw application log line — the thing §16 must never carry.
const RAW_LOG =
  '[2026-08-21T00:00:00Z] ERROR [app] unhandled exception at server.ts:42 — stack=...';

// ==========================================================================
// Valid events parse
// ==========================================================================

describe('diagnosticEventSchema — valid events parse', () => {
  it('parses a minimal event (source only)', () => {
    expect(parseDiagnosticEvent({ source: 'ecs' })).toEqual({ source: 'ecs' });
  });

  it('parses a full structured event (todo 27 shape)', () => {
    const event = parseDiagnosticEvent({
      source: 'health-check',
      action: 'report-health',
      signal: 'port',
      error: { code: 'ValidationError', message: 'port mismatch', statusCode: 400 },
      context: { expectedPort: 3000, actualPort: 8080, healthy: false, region: 'us-east-1' },
    });
    expect(event).toEqual({
      source: 'health-check',
      action: 'report-health',
      signal: 'port',
      error: { code: 'ValidationError', message: 'port mismatch', statusCode: 400 },
      context: { expectedPort: 3000, actualPort: 8080, healthy: false, region: 'us-east-1' },
    });
  });

  it('admits all eight known sources', () => {
    for (const source of DIAGNOSTIC_EVENT_SOURCES) {
      expect(parseDiagnosticEvent({ source }).source).toBe(source);
    }
  });

  it('accepts scalar context values of every allowed type (string/number/boolean)', () => {
    const event = parseDiagnosticEvent({
      source: 'deploy',
      context: { retries: 3, degraded: false, releaseId: 'rel-123' },
    });
    expect(event.context).toEqual({ retries: 3, degraded: false, releaseId: 'rel-123' });
  });

  it('error.message is the one concession (structured AWS error message)', () => {
    const event = parseDiagnosticEvent({
      source: 'ecs',
      error: { message: 'explicit deny in a service control policy' },
    });
    expect(event.error?.message).toBe('explicit deny in a service control policy');
  });
});

// ==========================================================================
// §16 data boundary — raw logs rejected at the INPUT edge
// ==========================================================================

describe('diagnosticEventSchema — §16 data boundary (raw logs rejected at the input edge)', () => {
  it('rejects a top-level `log` field', () => {
    expect(() => parseDiagnosticEvent({ source: 'ecs', log: RAW_LOG })).toThrow(z.ZodError);
  });

  it('rejects a top-level `stdout` field', () => {
    expect(() => parseDiagnosticEvent({ source: 'ecs', stdout: RAW_LOG })).toThrow(z.ZodError);
  });

  it('rejects every raw-log-capable field name (strict mode, no such field)', () => {
    const forbidden = ['log', 'logs', 'rawLog', 'stderr', 'output', 'stack', 'detail', 'message'];
    for (const field of forbidden) {
      expect(() => parseDiagnosticEvent({ source: 'ecs', [field]: RAW_LOG })).toThrow(z.ZodError);
    }
  });

  it('rejects an unknown top-level key (strict mode)', () => {
    expect(() => parseDiagnosticEvent({ source: 'ecs', extraKey: 'x' })).toThrow(z.ZodError);
  });

  it('rejects a raw-log field smuggled into the error object (error.stack)', () => {
    expect(() =>
      parseDiagnosticEvent({ source: 'ecs', error: { code: 'X', stack: RAW_LOG } }),
    ).toThrow(z.ZodError);
  });

  it('rejects context values that are objects (no nested smuggling)', () => {
    expect(() =>
      parseDiagnosticEvent({ source: 'ecs', context: { nested: { log: RAW_LOG } } }),
    ).toThrow(z.ZodError);
  });

  it('rejects context values that are arrays', () => {
    expect(() =>
      parseDiagnosticEvent({ source: 'ecs', context: { lines: [RAW_LOG, RAW_LOG] } }),
    ).toThrow(z.ZodError);
  });

  it('rejects context values that are null', () => {
    expect(() => parseDiagnosticEvent({ source: 'ecs', context: { maybe: null } })).toThrow(
      z.ZodError,
    );
  });

  it('rejects an unknown source value', () => {
    expect(() => parseDiagnosticEvent({ source: 'unknown-source' })).toThrow(z.ZodError);
  });
});

// ==========================================================================
// Shape carries no raw-log field
// ==========================================================================

describe('diagnosticEventSchema — shape carries no raw-log field', () => {
  it('has exactly the five structured fields, none of which hold a raw log', () => {
    const keys = Object.keys(diagnosticEventSchema.shape);
    expect(keys.sort()).toEqual(['action', 'context', 'error', 'signal', 'source'].sort());
    const forbidden = [
      'log',
      'logs',
      'message',
      'rawLog',
      'stdout',
      'stderr',
      'output',
      'stack',
      'detail',
    ];
    for (const field of forbidden) {
      expect(keys).not.toContain(field);
    }
  });

  it('is strict — a stray key is rejected, not silently stripped', () => {
    const result = diagnosticEventSchema.safeParse({ source: 'ecs', stdout: RAW_LOG });
    expect(result.success).toBe(false);
  });
});
