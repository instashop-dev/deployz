// Search and sort helpers shared by the Customers and Deployments lists. Pure
// functions: the pages own the URL, these own the arithmetic.

export type SortDirection = 'asc' | 'desc';

export interface SortState<Key extends string> {
  key: Key;
  dir: SortDirection;
}

/** Every whitespace-separated word must appear somewhere in the fields, so
 *  "acme docs" finds a customer "Acme" running "Docs" in either order. */
export function matchesSearch(fields: readonly (string | null | undefined)[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** "Sep 12, 2025, 11:30 AM" — the exact moment behind a relative time. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

/** Oldest first. A missing or unparseable timestamp counts as oldest, so it
 *  never ranks as recent activity. */
export function compareTime(a: string | null, b: string | null): number {
  const left = a === null ? Number.NaN : Date.parse(a);
  const right = b === null ? Number.NaN : Date.parse(b);
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return -1;
  if (Number.isNaN(right)) return 1;
  return left - right;
}

export function withDirection(comparison: number, dir: SortDirection): number {
  return dir === 'asc' ? comparison : -comparison;
}

/** The sort a header click asks for: the active column flips direction, any
 *  other column starts in its own natural direction. */
export function nextSort<Key extends string>(
  current: SortState<Key>,
  key: Key,
  naturalDirection: Record<Key, SortDirection>,
): SortState<Key> {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: naturalDirection[key] };
}

/** Reads `sort` and `dir` from the URL; anything unrecognised means the default. */
export function parseSort<Key extends string>(
  params: URLSearchParams,
  keys: readonly Key[],
  fallback: SortState<Key>,
  naturalDirection: Record<Key, SortDirection>,
): SortState<Key> {
  const key = keys.find((candidate) => candidate === params.get('sort'));
  if (key === undefined) return fallback;
  const dir = params.get('dir');
  return { key, dir: dir === 'asc' || dir === 'desc' ? dir : naturalDirection[key] };
}

/** The URL patch for a sort: nothing at all when it is the default. */
export function sortParams<Key extends string>(
  sort: SortState<Key>,
  fallback: SortState<Key>,
): { sort: string | null; dir: string | null } {
  return sort.key === fallback.key && sort.dir === fallback.dir
    ? { sort: null, dir: null }
    : { sort: sort.key, dir: sort.dir };
}
