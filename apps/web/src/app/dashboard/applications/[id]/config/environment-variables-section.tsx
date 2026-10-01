'use client';

import {
  evaluateEnvironmentSetup,
  type EnvironmentProvider,
  type EnvironmentSetting,
  type EnvironmentSetupRow,
  type EnvironmentStage,
} from '@deployz/contracts';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { SecretInput } from '@/components/secret-input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { saveConfig, type ApplicationConfig, type ConfigEntry, type MaskedConfigEntry } from '@/lib/config';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';
import {
  fetchEnvironmentSettings,
  saveEnvironmentSettings,
  EnvironmentSettingsError,
  type EnvironmentSettingsResponse,
} from '@/lib/environment-settings';

const COLUMN_COUNT = 8;

const STATUS_BADGE: Record<EnvironmentSetupRow['status'], { label: string; variant: BadgeVariant }> = {
  'needs-decision': { label: 'Needs a decision', variant: 'warning' },
  'missing-value': { label: 'Needs a value', variant: 'destructive' },
  ready: { label: 'Ready', variant: 'success' },
  customer: { label: 'Set by customer', variant: 'info' },
  optional: { label: 'Optional', variant: 'secondary' },
};

const PROVIDER_LABEL: Record<EnvironmentProvider, string> = {
  deployz: 'Deployz',
  vendor: 'Vendor',
  customer: 'Customer',
  none: 'Optional / not needed',
};

type EnvGroupId = 'new' | 'attention' | 'vendor' | 'customer' | 'deployz' | 'optional';

const GROUP_LABEL: Record<EnvGroupId, string> = {
  new: 'New values',
  attention: 'Needs attention',
  vendor: 'Set by vendor',
  customer: 'Set by customer',
  deployz: 'Managed by Deployz',
  optional: 'Optional and uncertain',
};

const GROUP_ORDER: readonly EnvGroupId[] = ['new', 'attention', 'vendor', 'customer', 'deployz', 'optional'];

/** A value being added but not yet saved. */
interface DraftEntry {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
}

type EnvItem =
  | { type: 'detected'; key: string; row: EnvironmentSetupRow }
  | { type: 'custom'; key: string; entry: MaskedConfigEntry }
  | { type: 'draft'; key: string; draft: DraftEntry };

/** The setting a row's controls display: the vendor's draft edit, else the saved setting, else the suggestion. */
function currentSetting(row: EnvironmentSetupRow, draft: EnvironmentSetting | undefined): EnvironmentSetting {
  return (
    draft ??
    row.setting ?? {
      key: row.key,
      stage: row.suggestion?.setting.stage ?? row.stage,
      required: row.suggestion?.setting.required ?? row.required,
      secret: row.suggestion?.setting.secret ?? row.secret,
      provider: row.suggestion?.setting.provider ?? (row.effectiveProvider === 'unreviewed' ? 'none' : row.effectiveProvider),
    }
  );
}

/** Keeps a setting inside the model's rules as one field changes. */
function normalizeSetting(next: EnvironmentSetting): EnvironmentSetting {
  const result = { ...next };
  if (result.provider === 'customer' && result.stage === 'build') {
    result.provider = 'vendor';
  }
  if (result.provider === 'deployz' && result.stage === 'build') {
    result.stage = 'runtime';
  }
  if (result.provider === 'none') {
    result.required = false;
  }
  return result;
}

/** The group a detected row sits in — from its SAVED state, so a row does not jump while it is edited. */
function groupFor(row: EnvironmentSetupRow): EnvGroupId {
  if (row.status === 'needs-decision' || row.status === 'missing-value') return 'attention';
  if (row.effectiveProvider === 'vendor') return 'vendor';
  if (row.effectiveProvider === 'customer') return 'customer';
  if (row.effectiveProvider === 'deployz') return 'deployz';
  return 'optional';
}

/** Saved vendor value in words — a secret is never shown. */
function savedValueText(entry: MaskedConfigEntry | null, secret: boolean): string | null {
  if (!entry) return null;
  if (entry.needsReentry) return 'Re-enter this secret';
  if (entry.isSecret || secret) return 'Secret saved';
  return entry.value && entry.value.length > 0 ? entry.value : 'Empty value';
}

// Environment variables — ONE table for the detected variables (with the
// vendor's saved decisions) and every other vendor default. The vendor scope
// saves here; the customer scope keeps its own overrides section. Secrets are
// write-only end to end: the API masks them and saving sends only the NEW
// value.
export function EnvironmentVariablesSection({
  applicationId,
  vendorDefaults,
  onValuesSaved,
  onSaved,
}: {
  applicationId: string;
  vendorDefaults: MaskedConfigEntry[];
  onValuesSaved: (next: ApplicationConfig) => void;
  /** After a complete save — lets the page refresh what depends on it. */
  onSaved?: () => void;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'loaded'; response: EnvironmentSettingsResponse }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchEnvironmentSettings(applicationId)
      .then((response) => {
        if (!cancelled) setState({ status: 'loaded', response });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  return (
    <EnvironmentVariablesTable
      applicationId={applicationId}
      loadState={state.status}
      response={state.status === 'loaded' ? state.response : null}
      vendorDefaults={vendorDefaults}
      onValuesSaved={onValuesSaved}
      onSettingsSaved={(response) => setState({ status: 'loaded', response })}
      onSaved={onSaved}
    />
  );
}

function EnvironmentVariablesTable({
  applicationId,
  loadState,
  response,
  vendorDefaults,
  onValuesSaved,
  onSettingsSaved,
  onSaved,
}: {
  applicationId: string;
  loadState: 'loading' | 'error' | 'loaded';
  response: EnvironmentSettingsResponse | null;
  vendorDefaults: MaskedConfigEntry[];
  onValuesSaved: (next: ApplicationConfig) => void;
  onSettingsSaved: (response: EnvironmentSettingsResponse) => void;
  onSaved?: (() => void) | undefined;
}) {
  const [drafts, setDrafts] = useState<Map<string, EnvironmentSetting>>(new Map());
  const [valueDrafts, setValueDrafts] = useState<Map<string, string>>(new Map());
  const [newEntries, setNewEntries] = useState<DraftEntry[]>([]);
  const [nextEntryId, setNextEntryId] = useState(0);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'partial' | 'error'>('idle');
  const [problems, setProblems] = useState<string[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);

  const variables = useMemo(() => response?.variables ?? [], [response]);
  const savedSettings = useMemo(() => response?.settings ?? [], [response]);
  const deployzKeys = useMemo(() => new Set(response?.deployzKeys ?? []), [response]);
  const vendorValueKeys = useMemo(() => new Set(response?.vendorValueKeys ?? []), [response]);

  const liveSettings = useMemo<EnvironmentSetting[]>(() => {
    const byKey = new Map(savedSettings.map((setting) => [setting.key, setting]));
    for (const [key, setting] of drafts) byKey.set(key, setting);
    return Array.from(byKey.values());
  }, [savedSettings, drafts]);

  const evaluation = useMemo(
    () => evaluateEnvironmentSetup({ variables, settings: liveSettings, vendorValueKeys }),
    [variables, liveSettings, vendorValueKeys],
  );
  const savedEvaluation = useMemo(
    () => evaluateEnvironmentSetup({ variables, settings: savedSettings, vendorValueKeys }),
    [variables, savedSettings, vendorValueKeys],
  );

  const rowsByKey = useMemo(() => new Map(evaluation.rows.map((row) => [row.key, row])), [evaluation.rows]);
  const vendorByKey = useMemo(() => new Map(vendorDefaults.map((entry) => [entry.key, entry])), [vendorDefaults]);
  // A saved vendor default no variable row covers — added by hand, or before
  // any analysis. It has its own row so a saved value is never hidden; when
  // the variable list failed to load, every default shows here.
  const customEntries = useMemo(
    () => (loadState === 'loading' ? [] : vendorDefaults.filter((entry) => !rowsByKey.has(entry.key))),
    [loadState, vendorDefaults, rowsByKey],
  );

  const groups = useMemo(() => {
    const byGroup = new Map<EnvGroupId, EnvItem[]>(GROUP_ORDER.map((id) => [id, []]));
    for (const draft of newEntries) byGroup.get('new')!.push({ type: 'draft', key: `new-${draft.id}`, draft });
    for (const saved of savedEvaluation.rows) {
      const row = rowsByKey.get(saved.key);
      if (row) byGroup.get(groupFor(saved))!.push({ type: 'detected', key: row.key, row });
    }
    for (const entry of customEntries) byGroup.get('vendor')!.push({ type: 'custom', key: entry.key, entry });
    return GROUP_ORDER.map((id) => ({ id, items: byGroup.get(id)! })).filter((group) => group.items.length > 0);
  }, [newEntries, savedEvaluation.rows, rowsByKey, customEntries]);

  const dirty = drafts.size > 0 || valueDrafts.size > 0 || newEntries.length > 0 || removed.size > 0;

  // A saved decision for a key the latest analysis no longer finds. Such a
  // key has no row, yet a stale "required" decision can still block a
  // release. The data cannot tell a vendor-added key from a stale one, so
  // the vendor is shown each and keeps the choice; nothing is deleted.
  const staleSettings = useMemo(() => {
    if (loadState !== 'loaded') return [];
    const detected = new Set(variables.map((variable) => variable.key));
    return liveSettings.filter(
      (setting) => !detected.has(setting.key) && (setting.required || setting.provider !== 'none'),
    );
  }, [loadState, variables, liveSettings]);

  function markNotNeeded(setting: EnvironmentSetting): void {
    setDrafts((current) =>
      new Map(current).set(setting.key, normalizeSetting({ ...setting, provider: 'none', required: false })),
    );
    markChanged();
  }

  function markChanged(): void {
    setSaveState('idle');
    setDraftError(null);
  }

  function updateRow(key: string, patch: Partial<EnvironmentSetting>): void {
    const row = rowsByKey.get(key);
    if (!row) return;
    const next = normalizeSetting({ ...currentSetting(row, drafts.get(key)), ...patch });
    setDrafts((current) => new Map(current).set(key, next));
    markChanged();
  }

  function bulkApply(patch: Partial<Pick<EnvironmentSetting, 'provider' | 'stage' | 'required'>>): void {
    setDrafts((current) => {
      const copy = new Map(current);
      for (const key of selected) {
        const row = rowsByKey.get(key);
        if (!row) continue;
        copy.set(key, normalizeSetting({ ...currentSetting(row, copy.get(key)), ...patch }));
      }
      return copy;
    });
    markChanged();
  }

  // The suggestion each undecided row already displays becomes its decision.
  // Nothing is saved until Save changes, like every other edit here.
  const undecidedKeys = evaluation.rows.filter((row) => row.status === 'needs-decision').map((row) => row.key);

  function acceptSuggestions(): void {
    setDrafts((current) => {
      const copy = new Map(current);
      for (const key of undecidedKeys) {
        const row = rowsByKey.get(key);
        if (row) copy.set(key, currentSetting(row, copy.get(key)));
      }
      return copy;
    });
    markChanged();
  }

  function setValueDraft(key: string, value: string): void {
    setValueDrafts((current) => new Map(current).set(key, value));
    markChanged();
  }

  function toggleSelected(key: string): void {
    setSelected((current) => {
      const copy = new Set(current);
      if (copy.has(key)) copy.delete(key);
      else copy.add(key);
      return copy;
    });
  }

  function toggleRemoved(key: string): void {
    setRemoved((current) => {
      const copy = new Set(current);
      if (copy.has(key)) copy.delete(key);
      else copy.add(key);
      return copy;
    });
    markChanged();
  }

  function addEntry(isSecret: boolean): void {
    setNewEntries((current) => [...current, { id: nextEntryId, key: '', value: '', isSecret }]);
    setNextEntryId((current) => current + 1);
    markChanged();
  }

  function updateEntry(id: number, patch: Partial<DraftEntry>): void {
    setNewEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
    markChanged();
  }

  /** The API rejects an empty or duplicate key and drops an empty secret as "unchanged" — catch all three first. */
  function validateNewEntries(): string | null {
    const known = new Set([...rowsByKey.keys(), ...customEntries.map((entry) => entry.key)]);
    for (const entry of newEntries) {
      const key = entry.key.trim();
      if (key.length === 0) return 'Give every new value a name.';
      if (known.has(key)) return `${key} already exists. Edit the existing one instead.`;
      if (entry.isSecret && entry.value.length === 0) return `Enter a value for ${key}.`;
      known.add(key);
    }
    return null;
  }

  async function handleSave(): Promise<void> {
    const invalid = validateNewEntries();
    if (invalid) {
      setDraftError(invalid);
      return;
    }
    setSaveState('saving');
    setProblems([]);

    // Entering a value accepts the decision the row displays: without this,
    // a suggested "Set by vendor" row saves its value but never its
    // decision, and stays "Needs a decision".
    const settingsByKey = new Map(liveSettings.map((setting) => [setting.key, setting]));
    let decisionsAccepted = false;
    for (const [key, value] of valueDrafts) {
      const row = rowsByKey.get(key);
      if (value.length === 0 || settingsByKey.has(key) || !row) continue;
      settingsByKey.set(key, currentSetting(row, undefined));
      decisionsAccepted = true;
    }

    let settingsSaved = false;
    if (response && (drafts.size > 0 || decisionsAccepted)) {
      try {
        onSettingsSaved(await saveEnvironmentSettings(applicationId, Array.from(settingsByKey.values())));
        setDrafts(new Map());
        setSelected(new Set());
        settingsSaved = true;
      } catch (error) {
        setSaveState('error');
        if (error instanceof EnvironmentSettingsError) setProblems(error.problems);
        return;
      }
    }

    const entries: ConfigEntry[] = [];
    for (const [key, value] of valueDrafts) {
      const custom = customEntries.find((entry) => entry.key === key);
      if (custom) {
        // An empty secret means "leave unchanged"; a removed value is not written.
        if ((custom.isSecret && value.length === 0) || removed.has(key)) continue;
        entries.push({ key, value, isSecret: custom.isSecret });
      } else if (value.length > 0) {
        entries.push({ key, value, isSecret: settingsByKey.get(key)?.secret ?? false });
      }
    }
    for (const entry of newEntries) entries.push({ key: entry.key.trim(), value: entry.value, isSecret: entry.isSecret });

    if (entries.length > 0 || removed.size > 0) {
      try {
        onValuesSaved(await saveConfig(applicationId, null, entries, Array.from(removed)));
      } catch {
        setSaveState(settingsSaved ? 'partial' : 'error');
        return;
      }
      // Which variables have a value is the server's answer — re-read it so
      // a saved value clears "Needs a value" truthfully.
      if (response) {
        await fetchEnvironmentSettings(applicationId).then(onSettingsSaved, () => undefined);
      }
    }

    setValueDrafts(new Map());
    setNewEntries([]);
    setRemoved(new Set());
    setSelected(new Set());
    setExpanded(null);
    setSaveState('saved');
    onSaved?.();
  }

  const counts = evaluation.counts;
  const summary =
    response === null
      ? null
      : `${counts.needsDecision} need${counts.needsDecision === 1 ? 's' : ''} a decision · ${counts.missingValue} need${counts.missingValue === 1 ? 's' : ''} a value · ${counts.customer} set by customers · ${counts.deployz} managed by Deployz · ${counts.optional} optional`;

  return (
    <Card id="environment-variables" className="scroll-mt-20" data-testid="environment-variables-section">
      <CardHeader>
        <CardTitle>Environment variables</CardTitle>
        {summary ? <CardDescription data-testid="environment-variables-summary">{summary}</CardDescription> : null}
        <p className="text-xs text-muted-foreground">
          Every detected variable is listed. Detected names are a draft. Nothing is required until you decide.
        </p>
        <CardAction className="flex flex-wrap gap-2">
          {undecidedKeys.length > 0 ? (
            <Button
              type="button"
              size="sm"
              data-testid="environment-variables-accept-suggestions"
              onClick={acceptSuggestions}
            >
              Accept {undecidedKeys.length} suggested {undecidedKeys.length === 1 ? 'decision' : 'decisions'}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="environment-variables-add-value"
            onClick={() => addEntry(false)}
          >
            Add value
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="environment-variables-add-secret"
            onClick={() => addEntry(true)}
          >
            Add secret
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loadState === 'error' ? (
          <Alert data-testid="environment-variables-error">
            <AlertDescription>
              We couldn&apos;t load the detected environment variables. Your saved values are shown below. Reload the
              page to try again.
            </AlertDescription>
          </Alert>
        ) : null}

        {staleSettings.length > 0 ? (
          <Alert data-testid="environment-variables-stale">
            <AlertTitle>Variables not found in the latest analysis</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>
                The latest analysis did not find these variables. If your application no longer reads one, mark it not
                needed. Variables you added yourself can stay.
              </span>
              <ul className="flex flex-col gap-1">
                {staleSettings.map((setting) => (
                  <li key={setting.key} className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs break-all">{setting.key}</code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`environment-variables-stale-${setting.key}`}
                      aria-label={`Mark ${setting.key} not needed`}
                      onClick={() => markNotNeeded(setting)}
                    >
                      Mark not needed
                    </Button>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {selected.size > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2"
            data-testid="environment-variables-bulk-toolbar"
          >
            <span className="text-sm font-medium">{selected.size} selected</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set(evaluation.rows.map((row) => row.key)))}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="environment-variables-bulk-optional"
              onClick={() => bulkApply({ provider: 'none', required: false })}
            >
              Mark optional
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => bulkApply({ provider: 'vendor', stage: 'runtime' })}>
              Set by vendor
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => bulkApply({ provider: 'customer', stage: 'runtime' })}>
              Set by customer
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        ) : null}

        <Table
          data-testid="environment-variables-table"
          className="min-w-[56rem] max-md:block max-md:min-w-0 max-md:[&_thead]:hidden max-md:[&_tbody]:block max-md:[&_tr]:flex max-md:[&_tr]:flex-wrap max-md:[&_tr]:items-center max-md:[&_tr]:gap-x-4 max-md:[&_tr]:gap-y-1 max-md:[&_tr]:px-1 max-md:[&_tr]:py-1.5 max-md:[&_td]:block max-md:[&_td]:p-1 max-md:[&_th]:block max-md:[&_td:first-child]:w-full max-md:[&_td[colspan]]:w-full max-md:[&_th[colspan]]:w-full max-md:[&_td:empty]:hidden"
        >
          <TableHeader>
            <TableRow>
              <TableHead>Variable</TableHead>
              <TableHead>When used</TableHead>
              <TableHead>Who provides</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Secret</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={loadState === 'loading' || undefined}>
            {groups.map((group) => (
              <Fragment key={group.id}>
                <TableRow className="bg-muted/50 hover:bg-muted/50" data-testid={`environment-variables-group-${group.id}`}>
                  <TableHead colSpan={COLUMN_COUNT} scope="colgroup" className="text-foreground">
                    {GROUP_LABEL[group.id]}
                    {group.id === 'new' ? null : ` · ${group.items.length}`}
                  </TableHead>
                </TableRow>
                {group.items.map((item) =>
                  item.type === 'detected' ? (
                    <DetectedRow
                      key={item.key}
                      row={item.row}
                      setting={currentSetting(item.row, drafts.get(item.key))}
                      decided={item.row.setting !== null || drafts.has(item.key)}
                      vendorEntry={vendorByKey.get(item.key) ?? null}
                      valueDraft={valueDrafts.get(item.key)}
                      selected={selected.has(item.key)}
                      expanded={expanded === item.key}
                      deployzKeys={deployzKeys}
                      onToggleSelected={() => toggleSelected(item.key)}
                      onToggleExpanded={() => setExpanded(expanded === item.key ? null : item.key)}
                      onUpdate={(patch) => updateRow(item.key, patch)}
                      onValueDraft={(value) => setValueDraft(item.key, value)}
                    />
                  ) : item.type === 'custom' ? (
                    <CustomRow
                      key={item.key}
                      entry={item.entry}
                      valueDraft={valueDrafts.get(item.key)}
                      removed={removed.has(item.key)}
                      expanded={expanded === item.key}
                      onToggleExpanded={() => setExpanded(expanded === item.key ? null : item.key)}
                      onToggleRemoved={() => toggleRemoved(item.key)}
                      onValueDraft={(value) => setValueDraft(item.key, value)}
                    />
                  ) : (
                    <TableRow key={item.key} data-testid="config-draft">
                      <TableCell colSpan={COLUMN_COUNT}>
                        <DraftField
                          draft={item.draft}
                          inputId={`environment-new-${item.draft.id}`}
                          onChange={(patch) => updateEntry(item.draft.id, patch)}
                          onRemove={() => {
                            setNewEntries((current) => current.filter((entry) => entry.id !== item.draft.id));
                            setDraftError(null);
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </Fragment>
            ))}
            {loadState === 'loading' ? <LoadingRows /> : null}
            {loadState !== 'loading' && groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-muted-foreground" data-testid="environment-variables-empty">
                  No environment variables yet. Detected variables show here after an analysis. Use Add value or Add
                  secret to set your own.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        {draftError ? (
          <p role="alert" className="text-sm text-destructive">
            {draftError}
          </p>
        ) : null}
        {problems.length > 0 ? (
          <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button
            type="button"
            onClick={handleSave}
            loading={saveState === 'saving'}
            loadingText="Saving environment variables…"
            disabled={!dirty}
          >
            Save changes
          </Button>
          {saveState === 'saved' ? (
            <p role="status" className="text-sm text-muted-foreground">
              Saved.
            </p>
          ) : null}
          {saveState === 'partial' ? (
            <p role="alert" className="text-sm text-destructive" data-testid="environment-variables-partial-save">
              Your variable decisions were saved, but the values were not. Save again to retry the values.
            </p>
          ) : null}
          {saveState === 'error' && problems.length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              We couldn&apos;t save these changes. Nothing was saved. Try again in a moment.
            </p>
          ) : null}
          {dirty && saveState !== 'saving' ? <p className="text-xs text-muted-foreground">Unsaved changes.</p> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Changes apply to new release builds and new installations. Existing customer deployments do not change.
        </p>
      </CardContent>
    </Card>
  );
}

function YesNo({ value }: { value: boolean }) {
  return <span>{value ? 'Yes' : 'No'}</span>;
}

function DetectedRow({
  row,
  setting,
  decided,
  vendorEntry,
  valueDraft,
  selected,
  expanded,
  deployzKeys,
  onToggleSelected,
  onToggleExpanded,
  onUpdate,
  onValueDraft,
}: {
  row: EnvironmentSetupRow;
  setting: EnvironmentSetting;
  decided: boolean;
  vendorEntry: MaskedConfigEntry | null;
  valueDraft: string | undefined;
  selected: boolean;
  expanded: boolean;
  deployzKeys: Set<string>;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onUpdate: (patch: Partial<EnvironmentSetting>) => void;
  onValueDraft: (value: string) => void;
}) {
  const badge = STATUS_BADGE[row.status];
  const valueText =
    valueDraft !== undefined && valueDraft.length > 0
      ? setting.secret
        ? 'New secret entered'
        : valueDraft
      : setting.provider === 'customer'
        ? 'Customer enters it at install'
        : setting.provider === 'deployz'
          ? 'Set by Deployz at install'
          : setting.provider === 'vendor'
            ? (savedValueText(vendorEntry, setting.secret) ?? 'Not set')
            : vendorEntry
              ? 'Saved value not used'
              : null;

  return (
    <>
      <TableRow id={`env-row-${row.key}`} className="scroll-mt-20" data-testid={`environment-variable-row-${row.key}`}>
        <TableCell className="align-top">
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              aria-label={`Select ${row.key}`}
              checked={selected}
              onChange={onToggleSelected}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="font-mono text-xs break-all">{row.key}</code>
                {decided ? null : <Badge variant="secondary">Suggested</Badge>}
                {row.suggestion?.certainty === 'uncertain' ? <Badge variant="outline">Uncertain</Badge> : null}
              </div>
              {row.suggestion ? <span className="text-xs text-muted-foreground">{row.suggestion.reason}</span> : null}
            </div>
          </div>
        </TableCell>
        <TableCell data-label="When used: " className="align-top max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]">
          {setting.stage === 'build' ? 'Build' : 'Runtime'}
        </TableCell>
        <TableCell data-label="Who provides: " className="align-top max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]">
          {PROVIDER_LABEL[setting.provider]}
        </TableCell>
        <TableCell className="align-top">
          {valueText ? (
            <span
              className={cn('break-all', vendorEntry?.needsReentry && valueDraft === undefined && TONE_TEXT.attention)}
              data-testid={`environment-variable-value-${row.key}`}
            >
              {valueText}
            </span>
          ) : null}
        </TableCell>
        <TableCell data-label="Required: " className="align-top max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]">
          <YesNo value={setting.required} />
        </TableCell>
        <TableCell data-label="Secret: " className="align-top max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]">
          <YesNo value={setting.secret} />
        </TableCell>
        <TableCell className="align-top">
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </TableCell>
        <TableCell className="align-top">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Close' : row.status === 'needs-decision' ? 'Review' : 'Edit'} ${row.key}`}
            data-testid={`environment-variable-edit-${row.key}`}
            onClick={onToggleExpanded}
          >
            {expanded ? 'Close' : row.status === 'needs-decision' ? 'Review' : 'Edit'}
          </Button>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLUMN_COUNT} className="bg-muted/30">
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>When used</Label>
                  <Select value={setting.stage} onValueChange={(value) => onUpdate({ stage: value as EnvironmentStage })}>
                    <SelectTrigger size="sm" aria-label={`When ${row.key} is used`} data-testid={`environment-variable-${row.key}-stage`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="build">Build</SelectItem>
                      <SelectItem value="runtime">Runtime</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Who provides</Label>
                  <Select
                    value={setting.provider}
                    onValueChange={(value) => onUpdate({ provider: value as EnvironmentProvider })}
                  >
                    <SelectTrigger size="sm" aria-label={`Who provides ${row.key}`} data-testid={`environment-variable-${row.key}-provider`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deployz" disabled={!deployzKeys.has(row.key)}>
                        Managed by Deployz
                      </SelectItem>
                      <SelectItem value="vendor">Set by vendor</SelectItem>
                      <SelectItem value="customer" disabled={setting.stage === 'build'}>
                        Set by customer
                      </SelectItem>
                      <SelectItem value="none">Optional / not needed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id={`env-required-${row.key}`}
                    checked={setting.required}
                    disabled={setting.provider === 'none'}
                    onCheckedChange={(checked) => onUpdate({ required: checked })}
                  />
                  <Label htmlFor={`env-required-${row.key}`}>Required</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id={`env-secret-${row.key}`}
                    checked={setting.secret}
                    onCheckedChange={(checked) => onUpdate({ secret: checked })}
                  />
                  <Label htmlFor={`env-secret-${row.key}`}>Secret</Label>
                </div>
              </div>
              <RowDetail
                row={row}
                setting={setting}
                vendorEntry={vendorEntry}
                valueDraft={valueDraft ?? ''}
                onValueDraft={onValueDraft}
                onUpdate={onUpdate}
              />
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function RowDetail({
  row,
  setting,
  vendorEntry,
  valueDraft,
  onValueDraft,
  onUpdate,
}: {
  row: EnvironmentSetupRow;
  setting: EnvironmentSetting;
  vendorEntry: MaskedConfigEntry | null;
  valueDraft: string;
  onValueDraft: (value: string) => void;
  onUpdate: (patch: Partial<EnvironmentSetting>) => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid={`environment-variable-detail-${row.key}`}>
      {setting.provider === 'vendor' ? (
        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor={`env-value-${row.key}`}>Value</Label>
          {setting.secret ? (
            <>
              <SecretInput
                id={`env-value-${row.key}`}
                value={valueDraft}
                onChange={(event) => onValueDraft(event.target.value)}
                placeholder="••••••••"
              />
              {vendorEntry?.isSecret ? (
                <p className="text-xs text-muted-foreground">A value is saved. Enter a new value to replace it.</p>
              ) : null}
              {vendorEntry?.needsReentry ? (
                <p className={cn('text-xs', TONE_TEXT.attention)} data-testid={`environment-variable-reentry-${row.key}`}>
                  Re-enter this secret.
                </p>
              ) : null}
              {setting.stage === 'runtime' ? (
                <Alert variant="destructive" data-testid={`environment-variable-runtime-warning-${row.key}`}>
                  <AlertDescription>
                    This value is stored in each customer&apos;s AWS account. The customer who owns that account can
                    read it. Use Set by customer for values the customer must not see.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive" data-testid={`environment-variable-build-warning-${row.key}`}>
                  <AlertDescription>
                    Build values are baked into the release image. Anyone who can pull the image, including customers,
                    may be able to read them.
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <Input id={`env-value-${row.key}`} value={valueDraft} onChange={(event) => onValueDraft(event.target.value)} />
          )}
        </div>
      ) : null}

      {setting.provider === 'customer' ? (
        <div className="flex max-w-xl flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`env-label-${row.key}`}>Label</Label>
            <Input
              id={`env-label-${row.key}`}
              maxLength={80}
              value={setting.label ?? ''}
              onChange={(event) => onUpdate({ label: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`env-help-${row.key}`}>Help text</Label>
            <Input
              id={`env-help-${row.key}`}
              maxLength={300}
              value={setting.help ?? ''}
              onChange={(event) => onUpdate({ help: event.target.value })}
            />
          </div>
          <div className="rounded-lg border p-3" data-testid={`environment-variable-customer-preview-${row.key}`}>
            <p className="text-sm font-medium">
              {setting.label && setting.label.length > 0 ? setting.label : row.key}
              {setting.required ? <span className="ml-1 text-destructive">*</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">{row.key}</p>
            {setting.help ? <p className="mt-1 text-xs text-muted-foreground">{setting.help}</p> : null}
            <Input className="mt-2" type={setting.secret ? 'password' : 'text'} disabled placeholder="Customer enters this" />
          </div>
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Show technical details</summary>
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {(row.suggestion?.evidence ?? []).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// A saved vendor default no detected variable covers. Its value edits in
// place; removal is staged until Save, so a mis-click is undoable.
function CustomRow({
  entry,
  valueDraft,
  removed,
  expanded,
  onToggleExpanded,
  onToggleRemoved,
  onValueDraft,
}: {
  entry: MaskedConfigEntry;
  valueDraft: string | undefined;
  removed: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleRemoved: () => void;
  onValueDraft: (value: string) => void;
}) {
  const inputId = `env-custom-${entry.key}`;
  const valueText =
    valueDraft !== undefined && (valueDraft.length > 0 || !entry.isSecret)
      ? entry.isSecret
        ? 'New secret entered'
        : valueDraft || 'Empty value'
      : savedValueText(entry, entry.isSecret);

  return (
    <>
      <TableRow
        id={`env-row-${entry.key}`}
        className={cn('scroll-mt-20', removed && 'opacity-60')}
        data-testid={`environment-custom-row-${entry.key}`}
      >
        <TableCell className="align-top">
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="font-mono text-xs break-all">{entry.key}</code>
            <Badge variant="outline">Custom</Badge>
          </div>
        </TableCell>
        <TableCell className="align-top" />
        <TableCell className="align-top">Vendor</TableCell>
        <TableCell className="align-top">
          <span className={cn('break-all', entry.needsReentry && valueDraft === undefined && TONE_TEXT.attention)}>
            {valueText}
          </span>
        </TableCell>
        <TableCell className="align-top" />
        <TableCell className="align-top">
          <YesNo value={entry.isSecret} />
        </TableCell>
        <TableCell className="align-top">
          {removed ? <Badge variant="warning">Removing</Badge> : <Badge variant="secondary">Saved</Badge>}
        </TableCell>
        <TableCell className="align-top">
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Close' : 'Edit'} ${entry.key}`}
              disabled={removed}
              onClick={onToggleExpanded}
            >
              {expanded ? 'Close' : 'Edit'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${removed ? 'Keep' : 'Remove'} ${entry.key}`}
              onClick={onToggleRemoved}
            >
              {removed ? 'Keep' : 'Remove'}
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {removed ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLUMN_COUNT} className="text-xs text-muted-foreground">
            {entry.key} is removed when you save.
            {entry.isSecret ? ' The value is deleted from the customer’s own secret store too.' : ''}
          </TableCell>
        </TableRow>
      ) : expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLUMN_COUNT} className="bg-muted/30">
            <div className="flex max-w-xl flex-col gap-2 py-2">
              <Label htmlFor={inputId} className="font-mono">
                {entry.key}
              </Label>
              {entry.isSecret ? (
                <>
                  <SecretInput
                    id={inputId}
                    value={valueDraft ?? ''}
                    onChange={(event) => onValueDraft(event.target.value)}
                    placeholder="••••••••"
                  />
                  <p className="text-xs text-muted-foreground">Secret set — enter a new value to replace it.</p>
                  {entry.needsReentry ? <p className={cn('text-xs', TONE_TEXT.attention)}>Re-enter this secret.</p> : null}
                </>
              ) : (
                <Input id={inputId} value={valueDraft ?? entry.value ?? ''} onChange={(event) => onValueDraft(event.target.value)} />
              )}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

// A value being added. The name is checked on save (empty, duplicate); the
// value goes through a write-only secret field when the draft is a secret.
function DraftField({
  draft,
  inputId,
  onChange,
  onRemove,
}: {
  draft: DraftEntry;
  inputId: string;
  onChange: (patch: Partial<DraftEntry>) => void;
  onRemove: () => void;
}) {
  const valueId = `${inputId}-value`;
  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">New {draft.isSecret ? 'secret' : 'value'}</p>
        {draft.isSecret ? <Badge variant="secondary">Secret</Badge> : null}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={inputId}>Name</Label>
          <Input
            id={inputId}
            className="font-mono"
            autoComplete="off"
            placeholder="LOG_LEVEL"
            value={draft.key}
            onChange={(event) => onChange({ key: event.target.value })}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={valueId}>Value</Label>
          {draft.isSecret ? (
            <SecretInput id={valueId} value={draft.value} onChange={(event) => onChange({ value: event.target.value })} />
          ) : (
            <Input id={valueId} autoComplete="off" value={draft.value} onChange={(event) => onChange({ value: event.target.value })} />
          )}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <>
      <TableRow>
        <TableCell colSpan={COLUMN_COUNT} className="sr-only" role="status">
          Loading environment variables…
        </TableCell>
      </TableRow>
      {[0, 1, 2].map((index) => (
        <TableRow key={index} aria-hidden data-testid="environment-variables-loading">
          {Array.from({ length: COLUMN_COUNT }, (_, cell) => (
            <TableCell key={cell}>
              <Skeleton className="h-4 w-full max-w-24" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
