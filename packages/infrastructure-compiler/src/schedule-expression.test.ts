import { describe, expect, it } from 'vitest';

import type { ScheduleExpression } from '@deployz/contracts';

import { translateScheduleExpression } from './schedule-expression.js';

// Schedule expression translation (Phase 5C) — AWS-specific, pure. Covers
// rate singularization, cron pass-through fields, day-of-week expansion
// (names, ranges, steps, 7 = Sunday) and the day-of-month/day-of-week `?`
// swap.

describe('translateScheduleExpression', () => {
  it('formats a rate, singularizing the unit only when the value is 1', () => {
    expect(translateScheduleExpression({ type: 'rate', value: 1, unit: 'minutes' })).toBe('rate(1 minute)');
    expect(translateScheduleExpression({ type: 'rate', value: 5, unit: 'minutes' })).toBe('rate(5 minutes)');
    expect(translateScheduleExpression({ type: 'rate', value: 1, unit: 'hours' })).toBe('rate(1 hour)');
    expect(translateScheduleExpression({ type: 'rate', value: 2, unit: 'days' })).toBe('rate(2 days)');
  });

  it('passes minute/hour/month through unchanged and swaps day-of-week * for ?', () => {
    expect(translateScheduleExpression({ type: 'cron', cron: '0 3 * * *' })).toBe('cron(0 3 * * ? *)');
    expect(translateScheduleExpression({ type: 'cron', cron: '*/15 9-17 * * *' })).toBe('cron(*/15 9-17 * * ? *)');
  });

  it('swaps day-of-month for ? and expands a restricted day-of-week to sorted AWS day numbers', () => {
    // MON-FRI: standard MON=1..FRI=5 -> AWS MON=2..FRI=6.
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * MON-FRI' })).toBe('cron(0 9 ? * 2,3,4,5,6 *)');
    // Named single day.
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * WED' })).toBe('cron(0 9 ? * 4 *)');
    // Comma list of numbers, including 0 (SUN).
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * 0,3' })).toBe('cron(0 9 ? * 1,4 *)');
    // 7 also means Sunday — folds to the same AWS day number as 0.
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * 7' })).toBe('cron(0 9 ? * 1 *)');
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * 0,7' })).toBe('cron(0 9 ? * 1 *)');
    // A range ending on 7 (Friday–Sunday) folds 7 to Sunday only after expansion.
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * 5-7' })).toBe('cron(0 9 ? * 1,6,7 *)');
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * */2' })).toBe('cron(0 9 ? * 1,3,5,7 *)');
    // Step: every other day starting Monday (1,3,5 standard -> MON,WED,FRI).
    expect(translateScheduleExpression({ type: 'cron', cron: '0 9 * * 1-6/2' })).toBe('cron(0 9 ? * 2,4,6 *)');
  });

  it('is a pure function of its input (same expression -> same string)', () => {
    const expr: ScheduleExpression = { type: 'cron', cron: '0 3 1,15 * *' };
    expect(translateScheduleExpression(expr)).toBe(translateScheduleExpression({ ...expr }));
  });
});
