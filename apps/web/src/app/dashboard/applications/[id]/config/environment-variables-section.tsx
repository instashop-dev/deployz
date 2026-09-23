'use client';

import {
  evaluateEnvironmentSetup,
  type EnvironmentProvider,
  type EnvironmentSetting,
  type EnvironmentSetupRow,
  type EnvironmentStage,
} from '@deployz/contracts';
import { ChevronDown } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { SecretInput } from '@/components/secret-input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { saveConfig, type ApplicationConfig, type ConfigEntry, type MaskedConfigEntry } from '@/lib/config';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';
import {
  fetchEnvironmentSettings,
  saveEnvironmentSettings,
  EnvironmentSettingsError,
  type EnvironmentSettingsResponse,
} from '@/lib/environment-settings';

type StatusFilter = 'attention' | 'customer' | 'vendor' | 'deployz' | 'optional' | 'all';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'deployz', label: 'Deployz' },
  { value: 'optional', label: 'Optional' },
  { value: 'all', label: 'All' },
];

const STATUS_BADGE: Record<EnvironmentSetupRow['status'], { label: string; variant: BadgeVariant }> = {
  'needs-decision': { label: 'Needs a decision', variant: 'warning' },
  'missing-value': { label: 'Needs a value', variant: 'destructive' },
  ready: { label: 'Ready', variant: 'success' },
  customer: { label: 'Set by customer', variant: 'info' },
  optional: { label: 'Optional', variant: 'secondary' },
};

const PAGE_SIZE = 50;

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

export function EnvironmentVariablesSection({
  applicationId,
  vendorDefaults,
  onValuesSaved,
}: {
  applicationId: string;
  vendorDefaults: MaskedConfigEntry[];
  onValuesSaved: (next: ApplicationConfig) => void;
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

  if (state.status === 'loading') {
    return (
      <Card data-testid="environment-variables-loading">
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (state.status === 'error') {
    return (
      <Card data-testid="environment-variables-error">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          We couldn&apos;t load environment variables. Try again in a moment.
        </CardContent>
      </Card>
    );
  }

  return (
    <EnvironmentVariablesTable
      applicationId={applicationId}
      response={state.response}
      vendorDefaults={vendorDefaults}
      onValuesSaved={onValuesSaved}
      onSettingsSaved={(response) => setState({ status: 'loaded', response })}
    />
  );
}

function EnvironmentVariablesTable({
  applicationId,
  response,
  vendorDefaults,
  onValuesSaved,
  onSettingsSaved,
}: {
  applicationId: string;
  response: EnvironmentSettingsResponse;
  vendorDefaults: MaskedConfigEntry[];
  onValuesSaved: (next: ApplicationConfig) => void;
  onSettingsSaved: (response: EnvironmentSettingsResponse) => void;
}) {
  const [drafts, setDrafts] = useState<Map<string, EnvironmentSetting>>(new Map());
  const [valueDrafts, setValueDrafts] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [problems, setProblems] = useState<string[]>([]);

  const deployzKeys = useMemo(() => new Set(response.deployzKeys), [response.deployzKeys]);
  const vendorValueKeys = useMemo(() => new Set(response.vendorValueKeys), [response.vendorValueKeys]);

  const liveSettings = useMemo<EnvironmentSetting[]>(() => {
    const byKey = new Map((response.settings ?? []).map((setting) => [setting.key, setting]));
    for (const [key, setting] of drafts) byKey.set(key, setting);
    return Array.from(byKey.values());
  }, [response.settings, drafts]);

  const evaluation = useMemo(
    () => evaluateEnvironmentSetup({ variables: response.variables, settings: liveSettings, vendorValueKeys }),
    [response.variables, liveSettings, vendorValueKeys],
  );

  const rowsByKey = useMemo(() => new Map(evaluation.rows.map((row) => [row.key, row])), [evaluation.rows]);

  const dirty = drafts.size > 0 || valueDrafts.size > 0;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return evaluation.rows.filter((row) => {
      if (query.length > 0 && !row.key.toLowerCase().includes(query)) return false;
      if (statusFilter === 'attention') return row.status === 'needs-decision' || row.status === 'missing-value';
      if (statusFilter === 'customer') return row.status === 'customer';
      if (statusFilter === 'vendor') return row.effectiveProvider === 'vendor';
      if (statusFilter === 'deployz') return row.effectiveProvider === 'deployz';
      if (statusFilter === 'optional') return row.status === 'optional';
      return true;
    });
  }, [evaluation.rows, search, statusFilter]);

  const primaryRows = filtered.filter((row) => row.status !== 'optional');
  const collapsedRows = filtered.filter((row) => row.status === 'optional');
  const visiblePrimaryRows = primaryRows.slice(0, visibleCount);

  function updateRow(key: string, patch: Partial<EnvironmentSetting>): void {
    const row = rowsByKey.get(key);
    if (!row) return;
    const base = currentSetting(row, drafts.get(key));
    const next = normalizeSetting({ ...base, ...patch });
    setDrafts((current) => {
      const copy = new Map(current);
      copy.set(key, next);
      return copy;
    });
  }

  function bulkApply(patch: Partial<Pick<EnvironmentSetting, 'provider' | 'stage' | 'required'>>): void {
    setDrafts((current) => {
      const copy = new Map(current);
      for (const key of selected) {
        const row = rowsByKey.get(key);
        if (!row) continue;
        const base = currentSetting(row, copy.get(key));
        copy.set(key, normalizeSetting({ ...base, ...patch }));
      }
      return copy;
    });
  }

  function toggleSelected(key: string): void {
    setSelected((current) => {
      const copy = new Set(current);
      if (copy.has(key)) copy.delete(key);
      else copy.add(key);
      return copy;
    });
  }

  function selectAllMatching(): void {
    setSelected(new Set(filtered.map((row) => row.key)));
  }

  async function handleSave(): Promise<void> {
    setSaveState('saving');
    setProblems([]);
    try {
      const settingsResponse = await saveEnvironmentSettings(applicationId, liveSettings);
      const valueEntries: ConfigEntry[] = [];
      for (const [key, value] of valueDrafts) {
        if (value.length === 0) continue;
        const setting = liveSettings.find((s) => s.key === key);
        valueEntries.push({ key, value, isSecret: setting?.secret ?? false });
      }
      if (valueEntries.length > 0) {
        const configResult = await saveConfig(applicationId, null, valueEntries);
        onValuesSaved(configResult);
      }
      onSettingsSaved(settingsResponse);
      setDrafts(new Map());
      setValueDrafts(new Map());
      setSelected(new Set());
      setSaveState('saved');
    } catch (error) {
      setSaveState('error');
      if (error instanceof EnvironmentSettingsError) setProblems(error.problems);
    }
  }

  const summary = `${evaluation.counts.needsDecision} need${evaluation.counts.needsDecision === 1 ? 's' : ''} a decision · ${evaluation.counts.missingValue} need${evaluation.counts.missingValue === 1 ? 's' : ''} a value · ${evaluation.counts.customer} set by customers · ${evaluation.counts.deployz} managed by Deployz · ${evaluation.counts.optional} optional`;

  return (
    <Card id="environment-variables" data-testid="environment-variables-section">
      <CardHeader>
        <CardTitle>Environment variables</CardTitle>
        <CardDescription data-testid="environment-variables-summary">{summary}</CardDescription>
        <p className="text-xs text-muted-foreground">
          Detected names are a draft. Nothing is required until you decide.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search variables"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xs"
            data-testid="environment-variables-search"
          />
          <Tabs value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <TabsList>
              {STATUS_FILTERS.map((filter) => (
                <TabsTrigger key={filter.value} value={filter.value} data-testid={`environment-variables-filter-${filter.value}`}>
                  {filter.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {selected.size > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2"
            data-testid="environment-variables-bulk-toolbar"
          >
            <span className="text-sm font-medium">{selected.size} selected</span>
            <Button type="button" variant="outline" size="sm" onClick={selectAllMatching}>
              Select all matching
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => bulkApply({ provider: 'vendor', stage: 'runtime' })}
            >
              Set by vendor
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => bulkApply({ provider: 'customer', stage: 'runtime' })}
            >
              Set by customer
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        ) : null}

        <EnvironmentVariablesRows
          rows={visiblePrimaryRows}
          drafts={drafts}
          valueDrafts={valueDrafts}
          selected={selected}
          expanded={expanded}
          deployzKeys={deployzKeys}
          vendorDefaults={vendorDefaults}
          onToggleSelected={toggleSelected}
          onExpand={setExpanded}
          onUpdate={updateRow}
          onValueDraft={(key, value) =>
            setValueDrafts((current) => {
              const copy = new Map(current);
              copy.set(key, value);
              return copy;
            })
          }
        />

        {primaryRows.length > visibleCount ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, primaryRows.length - visibleCount)} more
          </Button>
        ) : null}

        {collapsedRows.length > 0 ? (
          <Collapsible data-testid="environment-variables-optional">
            <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium">
              Optional and uncertain ({collapsedRows.length})
              <ChevronDown aria-hidden className="size-4" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <EnvironmentVariablesRows
                rows={collapsedRows}
                drafts={drafts}
                valueDrafts={valueDrafts}
                selected={selected}
                expanded={expanded}
                deployzKeys={deployzKeys}
                vendorDefaults={vendorDefaults}
                onToggleSelected={toggleSelected}
                onExpand={setExpanded}
                onUpdate={updateRow}
                onValueDraft={(key, value) =>
                  setValueDrafts((current) => {
                    const copy = new Map(current);
                    copy.set(key, value);
                    return copy;
                  })
                }
              />
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {problems.length > 0 ? (
          <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-3 border-t pt-4">
          <Button type="button" onClick={handleSave} loading={saveState === 'saving'} disabled={!dirty}>
            Save changes
          </Button>
          {saveState === 'saved' ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
          {saveState === 'error' && problems.length === 0 ? (
            <p className="text-sm text-destructive">We couldn&apos;t save these settings. Try again in a moment.</p>
          ) : null}
          {dirty ? <p className="text-xs text-muted-foreground">Unsaved changes.</p> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Changes apply to new release builds and new installations. Existing customer deployments do not change.
        </p>
      </CardContent>
    </Card>
  );
}

function EnvironmentVariablesRows({
  rows,
  drafts,
  valueDrafts,
  selected,
  expanded,
  deployzKeys,
  vendorDefaults,
  onToggleSelected,
  onExpand,
  onUpdate,
  onValueDraft,
}: {
  rows: EnvironmentSetupRow[];
  drafts: Map<string, EnvironmentSetting>;
  valueDrafts: Map<string, string>;
  selected: Set<string>;
  expanded: string | null;
  deployzKeys: Set<string>;
  vendorDefaults: MaskedConfigEntry[];
  onToggleSelected: (key: string) => void;
  onExpand: (key: string | null) => void;
  onUpdate: (key: string, patch: Partial<EnvironmentSetting>) => void;
  onValueDraft: (key: string, value: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No variables match.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Variable</TableHead>
          <TableHead>When used</TableHead>
          <TableHead>Who provides</TableHead>
          <TableHead>Required</TableHead>
          <TableHead>Secret</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const setting = currentSetting(row, drafts.get(row.key));
          const isDraft = row.setting === null;
          const badge = STATUS_BADGE[row.status];
          return (
            <Fragment key={row.key}>
              <TableRow data-testid={`environment-variable-row-${row.key}`}>
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.key}`}
                    checked={selected.has(row.key)}
                    onChange={() => onToggleSelected(row.key)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-xs">{row.key}</code>
                      {isDraft ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Suggested
                        </Badge>
                      ) : null}
                      {row.suggestion?.certainty === 'uncertain' ? (
                        <Badge variant="outline" className="text-[10px]">
                          Uncertain
                        </Badge>
                      ) : null}
                    </div>
                    {row.suggestion ? (
                      <span className="text-xs text-muted-foreground">{row.suggestion.reason}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <Select
                    value={setting.stage}
                    onValueChange={(value) => onUpdate(row.key, { stage: value as EnvironmentStage })}
                  >
                    <SelectTrigger size="sm" data-testid={`environment-variable-${row.key}-stage`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="build">Build</SelectItem>
                      <SelectItem value="runtime">Runtime</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Select
                    value={setting.provider}
                    onValueChange={(value) => onUpdate(row.key, { provider: value as EnvironmentProvider })}
                  >
                    <SelectTrigger size="sm" data-testid={`environment-variable-${row.key}-provider`}>
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
                </TableCell>
                <TableCell>
                  <Switch
                    checked={setting.required}
                    disabled={setting.provider === 'none'}
                    onCheckedChange={(checked) => onUpdate(row.key, { required: checked })}
                    aria-label={`${row.key} required`}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={setting.secret}
                    onCheckedChange={(checked) => onUpdate(row.key, { secret: checked })}
                    aria-label={`${row.key} secret`}
                  />
                </TableCell>
                <TableCell>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`environment-variable-edit-${row.key}`}
                    onClick={() => onExpand(expanded === row.key ? null : row.key)}
                  >
                    {expanded === row.key ? 'Close' : 'Edit'}
                  </Button>
                </TableCell>
              </TableRow>
              {expanded === row.key ? (
                <TableRow>
                  <TableCell colSpan={8} className="bg-muted/30">
                    <RowDetail
                      row={row}
                      setting={setting}
                      vendorDefaults={vendorDefaults}
                      valueDraft={valueDrafts.get(row.key) ?? ''}
                      onValueDraft={(value) => onValueDraft(row.key, value)}
                      onUpdate={(patch) => onUpdate(row.key, patch)}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function RowDetail({
  row,
  setting,
  vendorDefaults,
  valueDraft,
  onValueDraft,
  onUpdate,
}: {
  row: EnvironmentSetupRow;
  setting: EnvironmentSetting;
  vendorDefaults: MaskedConfigEntry[];
  valueDraft: string;
  onValueDraft: (value: string) => void;
  onUpdate: (patch: Partial<EnvironmentSetting>) => void;
}) {
  const vendorEntry = vendorDefaults.find((entry) => entry.key === row.key) ?? null;

  return (
    <div className="flex flex-col gap-3 py-2" data-testid={`environment-variable-detail-${row.key}`}>
      {setting.provider === 'vendor' ? (
        <div className="flex flex-col gap-2">
          {setting.secret ? (
            <>
              <Label htmlFor={`env-value-${row.key}`}>Value</Label>
              <SecretInput
                id={`env-value-${row.key}`}
                value={valueDraft}
                onChange={(event) => onValueDraft(event.target.value)}
                placeholder="••••••••"
              />
              {vendorEntry?.value !== undefined && vendorEntry?.isSecret ? (
                <p className="text-xs text-muted-foreground">
                  A value is saved. Enter a new value to replace it.
                </p>
              ) : null}
              {vendorEntry?.needsReentry ? (
                <p
                  className={cn('text-xs', TONE_TEXT.attention)}
                  data-testid={`environment-variable-reentry-${row.key}`}
                >
                  Re-enter this secret.
                </p>
              ) : null}
              {setting.stage === 'runtime' ? (
                <Alert variant="destructive" data-testid={`environment-variable-runtime-warning-${row.key}`}>
                  <AlertDescription>
                    This value is stored in each customer&apos;s AWS account. The customer who owns that account
                    can read it. Use Set by customer for values the customer must not see.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive" data-testid={`environment-variable-build-warning-${row.key}`}>
                  <AlertDescription>
                    Build values are baked into the release image. Anyone who can pull the image, including
                    customers, may be able to read them.
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <>
              <Label htmlFor={`env-value-${row.key}`}>Value</Label>
              <Input
                id={`env-value-${row.key}`}
                value={valueDraft}
                onChange={(event) => onValueDraft(event.target.value)}
              />
            </>
          )}
        </div>
      ) : null}

      {setting.provider === 'customer' ? (
        <div className="flex flex-col gap-3">
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
