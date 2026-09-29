import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schedules — Phase 5C. The AWS-independent description of WHEN a scheduled
// job runs: a standard five-field cron expression or a fixed rate, an
// optional IANA timezone, and a bounded delivery-retry policy. The compiler
// translates it to the target service's syntax; nothing here is AWS-specific.
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

interface CronFieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

/** minute hour day-of-month month day-of-week (day-of-week: 0-6, Sunday = 0; 7 also means Sunday). */
const CRON_FIELDS: readonly CronFieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
];

function atomValue(atom: string, spec: CronFieldSpec): number | null {
  if (/^\d+$/.test(atom)) {
    const value = Number(atom);
    return value >= spec.min && value <= spec.max ? value : null;
  }
  const index = spec.names?.indexOf(atom.toUpperCase()) ?? -1;
  if (index < 0) return null;
  // Month names are 1-based; day names are 0-based (SUN = 0).
  return spec.name === 'month' ? index + 1 : index;
}

function validateCronField(field: string, spec: CronFieldSpec): string | null {
  for (const part of field.split(',')) {
    const [range, step, extra] = part.split('/');
    if (extra !== undefined || range === undefined || range.length === 0) return `invalid ${spec.name} "${field}"`;
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > spec.max)) {
      return `invalid ${spec.name} step "${field}"`;
    }
    if (range === '*') continue;
    const bounds = range.split('-');
    if (bounds.length > 2) return `invalid ${spec.name} range "${field}"`;
    const values = bounds.map((atom) => atomValue(atom, spec));
    if (values.some((value) => value === null)) return `invalid ${spec.name} value "${field}"`;
    if (values.length === 2 && values[0]! > values[1]!) return `invalid ${spec.name} range "${field}"`;
  }
  return null;
}

/**
 * Validate a standard five-field cron expression. Returns the reason it is
 * invalid, or null. Macros (`@daily`), seconds/year fields, `L`/`W`/`#`
 * modifiers and `?` are rejected — the model stays the portable subset.
 * Restricting BOTH day-of-month and day-of-week is rejected: its meaning
 * (either day matches) is not portable across schedulers.
 */
export function cronExpressionError(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 'cron expression must have exactly five fields';
  for (let i = 0; i < CRON_FIELDS.length; i++) {
    const error = validateCronField(fields[i]!, CRON_FIELDS[i]!);
    if (error !== null) return error;
  }
  if (fields[2] !== '*' && fields[4] !== '*') {
    return 'cron expression may not restrict both day-of-month and day-of-week';
  }
  return null;
}

/** An IANA timezone name the runtime recognises (e.g. 'Europe/Berlin', 'UTC'). */
export function isValidTimezone(timezone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export const scheduleExpressionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('cron'),
      /** Standard five-field cron (minute hour day-of-month month day-of-week). */
      cron: z.string().min(1),
    })
    .strict()
    .refine((value) => cronExpressionError(value.cron) === null, {
      message: 'invalid cron expression',
      path: ['cron'],
    }),
  z
    .object({
      type: z.literal('rate'),
      value: z.number().int().min(1).max(1000),
      unit: z.enum(['minutes', 'hours', 'days']),
    })
    .strict(),
]);
export type ScheduleExpression = z.infer<typeof scheduleExpressionSchema>;

/** Bounded delivery-retry policy for one schedule invocation. */
export const scheduleRetryPolicySchema = z
  .object({
    /** Retries after a failed invocation (0 = none). */
    maximumRetryAttempts: z.number().int().min(0).max(185),
    /** How long an undelivered invocation stays eligible for retry. */
    maximumEventAgeSeconds: z.number().int().min(60).max(86400),
  })
  .strict();
export type ScheduleRetryPolicy = z.infer<typeof scheduleRetryPolicySchema>;

export const DEFAULT_SCHEDULE_RETRY_POLICY: ScheduleRetryPolicy = {
  maximumRetryAttempts: 3,
  maximumEventAgeSeconds: 3600,
};

export const scheduleTimezoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimezone, { message: 'unknown timezone' });
