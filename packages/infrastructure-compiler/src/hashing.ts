import { createHash } from 'node:crypto';

// Deterministic content hashing for the compiler's immutable artifacts.
// Identical JSON values hash identically regardless of key insertion order,
// and never depend on wall-clock time, random ids, or AWS lookups.

function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return val;
  });
}

/** SHA-256 hex over a key-order-stable JSON serialization. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(sortedJsonStringify(value)).digest('hex');
}
