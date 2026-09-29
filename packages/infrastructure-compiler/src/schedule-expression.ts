import type { ScheduleExpression } from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Schedule expression translation — Phase 5C. AWS-specific: turns the
// AWS-independent `ScheduleExpression` (contracts) into the syntax EventBridge
// Scheduler expects. Pure — no AWS calls, no clock.
//
// rate: `rate(<value> <unit>)`, unit singularized when value is 1.
// cron: standard five-field `minute hour day-of-month month day-of-week` ->
//   `cron(minute hour dom month dow *)`. AWS cron requires exactly one of
//   day-of-month/day-of-week to be `?` — contracts guarantees the standard
//   expression never restricts both, so:
//     - day-of-week `*` -> day-of-week becomes `?`, day-of-month passes through.
//     - otherwise day-of-month becomes `?` and day-of-week is EXPANDED to an
//       explicit, sorted, comma-separated list of AWS day numbers (AWS:
//       SUN=1..SAT=7; standard cron: 0 or 7=SUN, 1=MON..6=SAT).
// ---------------------------------------------------------------------------

const STANDARD_DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/** Standard cron day-of-week atom (0-7, SUN/MON/…/SAT) -> its 0-7 value; 7 folds to SUN only after range expansion. */
function standardDayAtomValue(atom: string): number {
  if (/^\d+$/.test(atom)) {
    const value = Number(atom);
    if (value < 0 || value > 7) throw new Error(`schedule-expression: invalid day-of-week atom "${atom}"`);
    return value;
  }
  const index = STANDARD_DAY_NAMES.indexOf(atom.toUpperCase() as (typeof STANDARD_DAY_NAMES)[number]);
  if (index < 0) throw new Error(`schedule-expression: invalid day-of-week atom "${atom}"`);
  return index;
}

/** Standard 0-6 (SUN=0) -> AWS 1-7 (SUN=1). */
function toAwsDayNumber(standard: number): number {
  return standard + 1;
}

/**
 * Expand a standard cron day-of-week field (names, ranges, `/step`, commas,
 * `7`=Sunday) into a sorted, deduplicated, comma-separated list of AWS day
 * numbers (SUN=1..SAT=7). Never receives `*` — the caller maps that to `?`.
 */
function expandDayOfWeekField(field: string): string {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, step] = part.split('/');
    const stepValue = step !== undefined ? Number(step) : 1;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = 0;
      hi = 7;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      lo = standardDayAtomValue(a!);
      hi = standardDayAtomValue(b!);
    } else {
      lo = hi = standardDayAtomValue(range!);
    }
    for (let v = lo; v <= hi; v += stepValue) {
      values.add(toAwsDayNumber(v % 7));
    }
  }
  if (values.size === 0) throw new Error(`schedule-expression: day-of-week "${field}" selects no day`);
  return [...values].sort((a, b) => a - b).join(',');
}

/** Singularize a rate unit when the value is exactly 1 ("minutes" -> "minute"). */
function singularize(unit: 'minutes' | 'hours' | 'days'): string {
  return unit.slice(0, -1);
}

/** Translate a portable `ScheduleExpression` into an EventBridge Scheduler `ScheduleExpression` string. */
export function translateScheduleExpression(expression: ScheduleExpression): string {
  if (expression.type === 'rate') {
    const unit = expression.value === 1 ? singularize(expression.unit) : expression.unit;
    return `rate(${expression.value} ${unit})`;
  }

  const fields = expression.cron.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const awsDayOfMonth = dayOfWeek === '*' ? dayOfMonth : '?';
  const awsDayOfWeek = dayOfWeek === '*' ? '?' : expandDayOfWeekField(dayOfWeek!);
  return `cron(${minute} ${hour} ${awsDayOfMonth} ${month} ${awsDayOfWeek} *)`;
}
