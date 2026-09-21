import { describe, expect, it } from 'vitest';

import {
  compareText,
  compareTime,
  matchesSearch,
  nextSort,
  parseSort,
  sortParams,
  withDirection,
  type SortDirection,
  type SortState,
} from '../src/lib/list-view';

type Key = 'name' | 'date';
const KEYS = ['name', 'date'] as const;
const NATURAL: Record<Key, SortDirection> = { name: 'asc', date: 'desc' };
const DEFAULT: SortState<Key> = { key: 'date', dir: 'desc' };

describe('matchesSearch', () => {
  it('matches every word anywhere in the fields, case-insensitively', () => {
    expect(matchesSearch(['Acme Corp', 'ops@acme.example'], 'ACME')).toBe(true);
    expect(matchesSearch(['Acme Corp', 'Docs'], 'docs acme')).toBe(true);
    expect(matchesSearch(['Acme Corp', 'Docs'], 'acme sheets')).toBe(false);
  });

  it('treats a blank query as everything and skips missing fields', () => {
    expect(matchesSearch(['x'], '')).toBe(true);
    expect(matchesSearch(['x'], '   ')).toBe(true);
    expect(matchesSearch([null, undefined, 'found'], 'found')).toBe(true);
    expect(matchesSearch([null, undefined], 'found')).toBe(false);
  });
});

describe('comparisons', () => {
  it('orders text naturally and ignores case', () => {
    expect(['b', 'A', 'a10', 'a2'].sort(compareText)).toEqual(['A', 'a2', 'a10', 'b']);
  });

  it('orders time oldest first and treats missing or invalid as oldest', () => {
    expect(compareTime('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toBeLessThan(0);
    expect(compareTime(null, '2026-01-02T00:00:00Z')).toBeLessThan(0);
    expect(compareTime('2026-01-02T00:00:00Z', 'garbage')).toBeGreaterThan(0);
    expect(compareTime(null, 'garbage')).toBe(0);
  });

  it('flips a comparison for descending', () => {
    expect(withDirection(3, 'asc')).toBe(3);
    expect(withDirection(3, 'desc')).toBe(-3);
  });
});

describe('nextSort', () => {
  it('flips the active column and starts a new one in its natural direction', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name', NATURAL)).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name', NATURAL)).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'date', NATURAL)).toEqual({ key: 'date', dir: 'desc' });
  });
});

describe('parseSort / sortParams', () => {
  const parse = (query: string) => parseSort(new URLSearchParams(query), KEYS, DEFAULT, NATURAL);

  it('reads a valid sort, defaults a missing direction to the natural one', () => {
    expect(parse('sort=name&dir=desc')).toEqual({ key: 'name', dir: 'desc' });
    expect(parse('sort=name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('falls back to the default for anything unrecognised', () => {
    expect(parse('')).toEqual(DEFAULT);
    expect(parse('sort=other&dir=asc')).toEqual(DEFAULT);
    expect(parse('dir=asc')).toEqual(DEFAULT);
  });

  it('writes nothing to the URL for the default sort, and both params otherwise', () => {
    expect(sortParams(DEFAULT, DEFAULT)).toEqual({ sort: null, dir: null });
    expect(sortParams({ key: 'date', dir: 'asc' }, DEFAULT)).toEqual({ sort: 'date', dir: 'asc' });
    expect(sortParams({ key: 'name', dir: 'desc' }, DEFAULT)).toEqual({ sort: 'name', dir: 'desc' });
  });
});
