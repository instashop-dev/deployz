// Configuration-tab mapper — reduces the readiness detection facts, the
// server-computed database/cache/storage requirements, and any unresolved
// findings into one vendor-facing table: one row per setting, in a fixed
// order, with plain-English value/result/action words (never "Passed", never
// "Not required", never an em dash or an empty value).
//
// This module never re-derives detection or override logic itself — it reads
// `deriveReadinessRows`/`detectedFactRows` (the detection + override source
// of truth) and `readiness.requirements` (the database/cache/storage source
// of truth), then translates their output into the Configuration tab's own
// vocabulary and grouping.

import type { Application } from './applications';
import {
  detectedFactRows,
  deriveReadinessRows,
  type ApplicationReadiness,
  type DetectedFactRow,
  type EditableReadinessField,
  type ReadinessFinding,
  type ReadinessTableSetting,
} from './readiness';

export type ConfigurationResultLabel = 'Ready' | 'Not used' | 'Change required' | 'Recommended' | 'Needs review';
export type ConfigurationResultVariant = 'success' | 'secondary' | 'destructive' | 'warning';

export interface ConfigurationRowResult {
  label: ConfigurationResultLabel;
  variant: ConfigurationResultVariant;
}

export type ConfigurationRowAction =
  | { label: 'Edit' | 'Add'; kind: 'edit'; field: EditableReadinessField }
  | { label: 'Fix'; kind: 'fix' }
  | null;

export interface ConfigurationRow {
  id: string;
  label: string;
  value: string;
  detail: string | null;
  result: ConfigurationRowResult;
  action: ConfigurationRowAction;
  blocking: boolean;
  help: string | null;
  findingIds: string[];
}

export interface AnalysisDetail {
  id: string;
  label: string;
  lines: string[];
}

const READY: ConfigurationRowResult = { label: 'Ready', variant: 'success' };
const NOT_USED: ConfigurationRowResult = { label: 'Not used', variant: 'secondary' };
const CHANGE_REQUIRED: ConfigurationRowResult = { label: 'Change required', variant: 'destructive' };
const RECOMMENDED: ConfigurationRowResult = { label: 'Recommended', variant: 'warning' };
const NEEDS_REVIEW: ConfigurationRowResult = { label: 'Needs review', variant: 'warning' };

const STORAGE_NOT_WIRED_HELP =
  'Every deployment gets a storage bucket; this setting controls whether the app is wired to it.';

const CATEGORY_TO_ROW_ID: Record<string, string | undefined> = {
  database: 'database',
  cache: 'redis',
  storage: 'storage',
  health: 'health',
  network: 'port',
  workers: 'worker',
};

/** Every fixed row id the settings section can render, in the required order. */
const SETTING_ROW_IDS = [
  'runtime',
  'build',
  'start',
  'port',
  'health',
  'database',
  'redis',
  'storage',
  'migrations',
  'worker',
] as const;

/** Whether a row id belongs to the fixed setting rows (as opposed to a
 *  finding-only row created for an unmapped category). */
export function isSettingRowId(id: string): boolean {
  return (SETTING_ROW_IDS as readonly string[]).includes(id);
}

function byId(rows: ReadinessTableSetting[]): Map<string, ReadinessTableSetting> {
  return new Map(rows.map((row) => [row.id, row]));
}

// Runtime/build/start/port are facts Deployz needs from the repository — an
// undetected one is a gap to review, not a toggle the vendor turned off.
function coreFactRow(found: boolean): ConfigurationRowResult {
  return found ? READY : NEEDS_REVIEW;
}

// Database/cache/storage/health-check/migrations are optional capabilities —
// an unconfigured one is simply not used, never a gap.
function optionalRow(used: boolean): ConfigurationRowResult {
  return used ? READY : NOT_USED;
}

function buildRuntimeRow(facts: Map<string, DetectedFactRow>): ConfigurationRow {
  const runtime = facts.get('runtime');
  const framework = facts.get('framework');
  const found = runtime?.found === true;
  const value = found && framework?.found ? `${runtime.value} · ${framework.value}` : found ? runtime.value : 'Not detected';
  return {
    id: 'runtime',
    label: 'Runtime',
    value,
    detail: null,
    result: coreFactRow(found),
    action: null,
    blocking: false,
    help: null,
    findingIds: [],
  };
}

function buildFactRow(id: 'build' | 'start', label: string, facts: Map<string, DetectedFactRow>): ConfigurationRow {
  const fact = facts.get(id);
  const found = fact?.found === true;
  return {
    id,
    label,
    value: found ? fact.value : 'Not detected',
    detail: null,
    result: coreFactRow(found),
    action: null,
    blocking: false,
    help: null,
    findingIds: [],
  };
}

function detailForOverride(row: ReadinessTableSetting): string | null {
  return row.overridden && row.detectedValue ? `Set by you · detected: ${row.detectedValue}` : null;
}

function buildPortRow(settings: Map<string, ReadinessTableSetting>): ConfigurationRow {
  const row = settings.get('port');
  const hasValue = row !== undefined && row.value !== '';
  return {
    id: 'port',
    label: 'Port',
    value: hasValue ? row!.value : 'Not detected',
    detail: row ? detailForOverride(row) : null,
    result: row?.overridden ? READY : coreFactRow(hasValue),
    action: { label: 'Edit', kind: 'edit', field: 'containerPort' },
    blocking: false,
    help: null,
    findingIds: [],
  };
}

/** Health check and migrations: optional editable fields that go from "Add"
 *  to "Edit" once a value exists, using the same effective/detected/override
 *  values `deriveReadinessRows` already resolved. */
function buildOptionalFieldRow(
  id: 'health' | 'migrations',
  label: string,
  field: EditableReadinessField,
  emptyValueWord: string,
  settings: Map<string, ReadinessTableSetting>,
): ConfigurationRow {
  const row = settings.get(id);
  const hasValue = row !== undefined && row.value !== '';
  return {
    id,
    label,
    value: hasValue ? row!.value : emptyValueWord,
    detail: row ? detailForOverride(row) : null,
    result: row?.overridden ? READY : optionalRow(hasValue),
    action: { label: hasValue ? 'Edit' : 'Add', kind: 'edit', field },
    blocking: false,
    help: null,
    findingIds: [],
  };
}

/** Database/cache/storage: the server-computed requirements summary is the
 *  only source of truth for effective/detected/overridden — reading it
 *  directly here (rather than the display text `deriveReadinessRows` builds
 *  for the old readiness table) keeps the "Not used" / help copy correct even
 *  when a vendor override disagrees with what was detected. */
function buildRequirementRow(
  id: 'database' | 'redis' | 'storage',
  label: string,
  field: EditableReadinessField,
  usedValue: string,
  requirements: ApplicationReadiness['requirements'],
  notUsedHelp: string | null,
): ConfigurationRow {
  const requirement = requirements?.[id];
  if (!requirement) {
    return {
      id,
      label,
      value: 'Needs review',
      detail: null,
      result: NEEDS_REVIEW,
      action: { label: 'Add', kind: 'edit', field },
      blocking: false,
      help: null,
      findingIds: [],
    };
  }
  const used = requirement.effective;
  const detail = requirement.overridden
    ? `Set by you · detected: ${requirement.detected ? usedValue : 'Not used'}`
    : null;
  return {
    id,
    label,
    value: used ? usedValue : 'Not used',
    detail,
    result: requirement.overridden || used ? READY : NOT_USED,
    action: { label: used ? 'Edit' : 'Add', kind: 'edit', field },
    blocking: false,
    help: used ? null : notUsedHelp,
    findingIds: [],
  };
}

function buildWorkerRow(workerCommand: string): ConfigurationRow {
  return {
    id: 'worker',
    label: 'Background worker',
    value: workerCommand,
    detail: null,
    result: READY,
    action: null,
    blocking: false,
    help: null,
    findingIds: [],
  };
}

function buildExtraFindingRow(finding: ReadinessFinding): ConfigurationRow {
  const required = finding.severity === 'required';
  return {
    id: `finding-${finding.id}`,
    label: finding.title,
    value: finding.suggestedOutcome,
    detail: null,
    result: required ? CHANGE_REQUIRED : RECOMMENDED,
    action: { label: 'Fix', kind: 'fix' },
    blocking: required,
    help: finding.plainEnglishExplanation,
    findingIds: [finding.id],
  };
}

/** Fold a row's mapped findings in: a required finding always wins the
 *  result and always points at Fix instructions — keeping this simple avoids
 *  a second "is this editable field enough to resolve it" judgement call. */
function applyFindings(row: ConfigurationRow, findings: ReadinessFinding[]): ConfigurationRow {
  if (findings.length === 0) return row;
  const required = findings.find((finding) => finding.severity === 'required');
  const chosen = required ?? findings[0]!;
  return {
    ...row,
    result: required ? CHANGE_REQUIRED : RECOMMENDED,
    blocking: required !== undefined,
    action: { label: 'Fix', kind: 'fix' },
    help: chosen.plainEnglishExplanation,
    findingIds: findings.map((finding) => finding.id),
  };
}

function sortRows(rows: ConfigurationRow[]): ConfigurationRow[] {
  const rank = (row: ConfigurationRow): number => {
    if (row.blocking) return 0;
    if (row.result.label === 'Recommended' || row.result.label === 'Needs review') return 1;
    return 2;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/**
 * Build the Configuration tab's setting rows. Returns an empty list while
 * analysis has not completed (or completed without any detected facts, which
 * only a legacy analysis result could leave null) — there is nothing real to
 * show yet, never a fabricated row.
 */
export function deriveConfigurationRows(application: Application, readiness: ApplicationReadiness): ConfigurationRow[] {
  if (readiness.analysisStatus !== 'COMPLETE' || !readiness.detected) return [];

  const settings = byId(
    deriveReadinessRows(application, readiness).filter(
      (row): row is ReadinessTableSetting => row.kind === 'setting',
    ),
  );

  const facts = new Map(detectedFactRows(readiness.detected).map((fact) => [fact.id, fact]));

  const rows: ConfigurationRow[] = [
    buildRuntimeRow(facts),
    buildFactRow('build', 'Build command', facts),
    buildFactRow('start', 'Start command', facts),
    buildPortRow(settings),
    buildOptionalFieldRow('health', 'Health check', 'healthPath', 'Not set', settings),
    buildRequirementRow('database', 'Database', 'databaseRequired', 'PostgreSQL database', readiness.requirements, null),
    buildRequirementRow('redis', 'Cache / queue', 'redisRequired', 'Redis cache', readiness.requirements, null),
    buildRequirementRow(
      'storage',
      'File storage',
      'storageRequired',
      'Object storage bucket',
      readiness.requirements,
      STORAGE_NOT_WIRED_HELP,
    ),
    buildOptionalFieldRow('migrations', 'Database migrations', 'migrationCommand', 'None', settings),
  ];
  if (application.workerCommand) rows.push(buildWorkerRow(application.workerCommand));

  const rowIds = new Set(rows.map((row) => row.id));
  const findingsByRow = new Map<string, ReadinessFinding[]>();
  const extraRows: ConfigurationRow[] = [];

  for (const finding of readiness.findings) {
    const targetId = CATEGORY_TO_ROW_ID[finding.category];
    if (targetId && rowIds.has(targetId)) {
      const existing = findingsByRow.get(targetId) ?? [];
      existing.push(finding);
      findingsByRow.set(targetId, existing);
    } else {
      extraRows.push(buildExtraFindingRow(finding));
    }
  }

  const settingRows = rows.map((row) => applyFindings(row, findingsByRow.get(row.id) ?? []));
  return sortRows([...settingRows, ...extraRows]);
}

/**
 * The collapsed "Analysis details" section: the raw detection evidence
 * (file + reason) behind each detected fact, plus the list of checks the
 * server reported as passed. Neither belongs in the settings table itself —
 * that table shows the vendor's configuration, not the analyser's audit
 * trail.
 */
export function deriveAnalysisDetails(readiness: ApplicationReadiness): AnalysisDetail[] {
  const details: AnalysisDetail[] = [];

  if (readiness.detected) {
    for (const fact of detectedFactRows(readiness.detected)) {
      if (fact.evidence.length === 0) continue;
      details.push({
        id: fact.id,
        label: fact.label,
        lines: fact.evidence.map((item) => (item.file ? `${item.file} — ${item.reason}` : item.reason)),
      });
    }
  }

  if (readiness.passed.length > 0) {
    details.push({
      id: 'checks-completed',
      label: 'Checks completed',
      lines: readiness.passed.map((check) => check.label),
    });
  }

  return details;
}
