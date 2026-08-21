'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';

import { SecretInput } from '@/components/secret-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchConfig,
  saveConfig,
  type ApplicationConfig,
  type ConfigEntry,
  type MaskedConfigEntry,
} from '@/lib/config';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: ApplicationConfig };

// §31 application configuration screen — vendor defaults (apply to every
// customer) plus customer-specific overrides (win over the defaults). Secrets
// are write-only end to end: the API masks them (value: null), the screen
// renders a masked write-only field, and saving sends only the NEW value.
// The config endpoint 404s for applications without backend rows, so
// fetchConfig/saveConfig fall back to fixture data (same pattern as todo
// 19/25). useSearchParams needs a Suspense boundary at build time.
export default function ApplicationConfigPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConfigScreen />
    </Suspense>
  );
}

function ConfigScreen() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const customerId = searchParams.get('customer');
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const data = await fetchConfig(id, customerId ?? undefined);
        if (cancelled) return;
        setState({ status: 'loaded', data });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "We couldn't load this configuration. Try again in a moment.",
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, customerId]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/dashboard/applications/${id}`}>
            <ArrowLeft aria-hidden className="size-4" />
            Application
          </Link>
        </Button>
      </div>

      {state.status === 'loading' ? <PageSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="config-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="config-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <ConfigBody
          data={state.data}
          onSaved={(next) => setState({ status: 'loaded', data: next })}
        />
      ) : null}
    </div>
  );
}

function ConfigBody({
  data,
  onSaved,
}: {
  data: ApplicationConfig;
  onSaved: (next: ApplicationConfig) => void;
}) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          The values your app needs to run. Defaults apply to every customer; overrides apply to
          one customer and take precedence over the defaults. Secrets are write-only — you can
          replace a secret, but you can never see its current value.
        </p>
      </div>

      <ConfigSection
        title="Defaults"
        description="Apply to every customer unless a customer overrides them."
        testId="config-vendor-defaults"
        applicationId={data.applicationId}
        customerId={null}
        entries={data.vendorDefaults}
        vendorDefaults={data.vendorDefaults}
        editable
        onSaved={onSaved}
      />

      <ConfigSection
        title="Customer overrides"
        description={
          data.customerId
            ? `Apply to customer ${data.customerId} only. They take precedence over the defaults.`
            : 'Apply to one customer and take precedence over the defaults.'
        }
        testId="config-customer-overrides"
        applicationId={data.applicationId}
        customerId={data.customerId}
        entries={data.customerOverrides}
        vendorDefaults={data.vendorDefaults}
        editable={data.customerId !== null}
        onSaved={onSaved}
      />
    </>
  );
}

function ConfigSection({
  title,
  description,
  testId,
  applicationId,
  customerId,
  entries,
  vendorDefaults,
  editable,
  onSaved,
}: {
  title: string;
  description: string;
  testId: string;
  applicationId: string;
  customerId: string | null;
  entries: MaskedConfigEntry[];
  vendorDefaults: MaskedConfigEntry[];
  editable: boolean;
  onSaved: (next: ApplicationConfig) => void;
}) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Bumping the form key remounts the fields after a save: non-secret inputs
  // pick up the saved values and write-only secret inputs reset to empty.
  const [version, setVersion] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const writes: ConfigEntry[] = entries.map((entry) => ({
      key: entry.key,
      value: String(formData.get(entry.key) ?? ''),
      isSecret: entry.isSecret,
    }));
    setSaveState('saving');
    try {
      const next = await saveConfig(applicationId, customerId, writes);
      onSaved(next);
      setVersion((current) => current + 1);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {customerId === null
              ? 'No defaults set yet.'
              : 'No overrides for this customer yet.'}
          </p>
        ) : (
          <form key={version} onSubmit={handleSubmit} className="flex flex-col gap-5">
            {entries.map((entry) => (
              <ConfigField
                key={entry.key}
                entry={entry}
                vendorDefault={vendorDefaults.find((row) => row.key === entry.key) ?? null}
                showVendorValue={customerId !== null}
                disabled={!editable}
                inputId={`${testId}-${entry.key}`}
              />
            ))}
            {editable ? (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saveState === 'saving'}>
                  {saveState === 'saving'
                    ? 'Saving…'
                    : `Save ${title === 'Defaults' ? 'defaults' : 'overrides'}`}
                </Button>
                {saveState === 'saved' ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Saved.
                  </p>
                ) : null}
                {saveState === 'error' ? (
                  <p role="alert" className="text-sm text-destructive">
                    We couldn&apos;t save these values. Try again in a moment.
                  </p>
                ) : null}
              </div>
            ) : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigField({
  entry,
  vendorDefault,
  showVendorValue,
  disabled,
  inputId,
}: {
  entry: MaskedConfigEntry;
  vendorDefault: MaskedConfigEntry | null;
  showVendorValue: boolean;
  disabled: boolean;
  inputId: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="font-mono">
          {entry.key}
        </Label>
        {entry.isSecret ? <Badge variant="outline">Secret</Badge> : null}
      </div>
      {entry.isSecret ? (
        <>
          <SecretInput
            id={inputId}
            name={entry.key}
            placeholder="••••••••"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Secret set — enter a new value to replace it.
          </p>
        </>
      ) : (
        <>
          <Input
            id={inputId}
            name={entry.key}
            defaultValue={entry.value ?? ''}
            disabled={disabled}
          />
          {showVendorValue &&
          vendorDefault &&
          !vendorDefault.isSecret &&
          vendorDefault.value !== entry.value ? (
            <p className="text-xs text-muted-foreground">Default: {vendorDefault.value}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="config-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}
