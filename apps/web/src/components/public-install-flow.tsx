'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { Badge } from '@/components/ui/badge';
import { FootprintCost } from '@/components/footprint-cost';
import { FootprintSummary } from '@/components/footprint-summary';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TablePanel } from '@/components/table-panel';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { installPlanRegionLabel, installPlanRetentionNote, installPlanRows } from '@/lib/install-plan';
import { fetchPublicInstallPlan } from '@/lib/public-install-data';
import { confirmPublicInstall } from '@/lib/public-install-confirm';
import {
  publicInstallErrorMessage,
  type PublicInstallInput,
  type PublicInstallResolve,
} from '@/lib/public-install-types';
import type { DeploymentPlan } from '@deployz/contracts';

interface PublicInstallFlowProps {
  linkId: string;
  resolve: PublicInstallResolve;
  /** Invitation token for targeted invitations; undefined for reusable links. */
  token?: string;
  /** A targeted invitation already names the customer — no details to enter. */
  customerKnown?: boolean;
}

export function PublicInstallFlow({ linkId, resolve, token, customerKnown = false }: PublicInstallFlowProps) {
  const router = useRouter();

  // Vendor recommendation is a preselection hint the customer may change.
  // Materially simpler and consistent with current UX. Otherwise the region
  // starts empty — the customer must pick explicitly, and confirm stays
  // disabled until they do (no silent first-region default).
  const [region, setRegion] = useState(
    resolve.recommendedRegion &&
      resolve.regions.some((option) => option.value === resolve.recommendedRegion)
      ? resolve.recommendedRegion
      : '',
  );
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [idempotencyKey] = useState(generateIdempotencyKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The plan is re-derived per selected Region (Phase 3): pricing stays on
  // the server; the client only renders it. `fetchedFor` is the region the
  // in-flight (or last applied) fetch belongs to, so a slow older response
  // can never override a newer selection.
  const [plan, setPlan] = useState<DeploymentPlan>(resolve.plan);
  const [planLoading, setPlanLoading] = useState(false);
  const [estimateUnavailable, setEstimateUnavailable] = useState(resolve.plan.costEstimate == null);
  const requestedRegionRef = useRef<string | null>(region);

  useEffect(() => {
    if (region === '') return;
    requestedRegionRef.current = region;
    const requested = region;
    setPlanLoading(true);
    void fetchPublicInstallPlan(linkId, region, token).then((freshPlan) => {
      if (requestedRegionRef.current !== requested) return; // stale response
      setPlanLoading(false);
      if (freshPlan === null) {
        // Keep the previous infrastructure preview; only the estimate degrades.
        setEstimateUnavailable(true);
        return;
      }
      setPlan(freshPlan);
      setEstimateUnavailable(freshPlan.costEstimate == null);
    });
  }, [linkId, region, token]);

  const planRows = useMemo(() => installPlanRows(plan), [plan]);
  const retentionNote = useMemo(() => installPlanRetentionNote(plan), [plan]);

  const settingErrors = useMemo(
    () =>
      Object.fromEntries(
        resolve.requiredInputs.map((input) => [input.key, settingFieldError(input, configValues[input.key] ?? '')]),
      ),
    [resolve.requiredInputs, configValues],
  );
  const settingsValid = resolve.requiredInputs.every((input) => settingErrors[input.key] === null);
  const settingsCompleteCount = resolve.requiredInputs.filter((input) => settingErrors[input.key] === null).length;
  const settingsTotal = resolve.requiredInputs.length;

  const canSubmit =
    region !== '' &&
    settingsValid &&
    (customerKnown || (customerName.trim() !== '' && customerEmail.trim() !== ''));

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || pending) {
      setTouched(Object.fromEntries(resolve.requiredInputs.map((input) => [input.key, true])));
      return;
    }

    setPending(true);
    setError(null);

    const config = resolve.requiredInputs
      .map((input) => {
        const value = configValues[input.key] ?? '';
        if (input.secret ? value === '' : value.trim() === '') return null;
        return { key: input.key, value: input.secret ? value : value.trim(), isSecret: input.secret };
      })
      .filter((item): item is { key: string; value: string; isSecret: boolean } => item !== null);

    try {
      const result = await confirmPublicInstall(
        linkId,
        {
          idempotencyKey,
          region,
          // A targeted invitation forbids re-naming its customer; a reusable
          // link requires it.
          ...(customerKnown
            ? {}
            : { customer: { name: customerName.trim(), email: customerEmail.trim() } }),
          config,
        },
        token,
      );

      if (result.ok) {
        router.push(`/install/${result.installLinkId}`);
        return;
      }

      setError(publicInstallErrorMessage(result.code));
    } catch {
      setError(publicInstallErrorMessage('UNKNOWN'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Install {resolve.application.name}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Published by {resolve.publisher.name}
        </p>
      </div>

      <section aria-labelledby="public-identity" className="flex flex-col gap-4">
        <h2 id="public-identity" className="text-base font-semibold">
          Application
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              Application
            </h3>
            <p className="mt-1 text-sm font-medium">{resolve.application.name}</p>
          </div>
          <div>
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              Publisher
            </h3>
            <p className="mt-1 text-sm font-medium">{resolve.publisher.name}</p>
          </div>
          <div>
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              Release
            </h3>
            <p className="mt-1 text-sm font-medium">Release {resolve.release.version}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="public-region" className="flex flex-col gap-3">
        <h2 id="public-region" className="text-base font-semibold">
          AWS region
        </h2>
        {resolve.recommendedRegion ? (
          <p className="text-sm text-muted-foreground">
            {resolve.publisher.name} recommends {installPlanRegionLabel(resolve.recommendedRegion) ?? resolve.recommendedRegion}. You make the final choice.
          </p>
        ) : null}
        <Select value={region} onValueChange={setRegion}>
          <SelectTrigger className="w-full sm:w-[360px]">
            <SelectValue placeholder="Select a region" />
          </SelectTrigger>
          <SelectContent>
            {resolve.regions.map((regionOption) => (
              <SelectItem key={regionOption.value} value={regionOption.value}>
                <span className="flex items-center gap-2">
                  {regionOption.label}
                  {regionOption.value === resolve.recommendedRegion ? <Badge variant="secondary">Recommended</Badge> : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      {settingsTotal > 0 ? (
        <section aria-labelledby="public-config" className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="public-config" className="text-base font-semibold">
              Application settings
            </h2>
            <p className="text-xs text-muted-foreground" data-testid="settings-completion">
              {settingsCompleteCount === settingsTotal
                ? 'All settings complete'
                : `${settingsCompleteCount} of ${settingsTotal} settings complete`}
            </p>
          </div>
          <div className="flex flex-col gap-4">
            {resolve.requiredInputs.map((input) => {
              const fieldError = settingErrors[input.key];
              const showError = touched[input.key] === true && fieldError !== null;
              return (
                <div key={input.key} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={input.key}>{input.label ?? humanizeSettingKey(input.key)}</Label>
                    <span className="text-xs text-muted-foreground">
                      {input.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  {input.help ? <p className="text-xs text-muted-foreground">{input.help}</p> : null}
                  <div className="flex items-center gap-2">
                    <Input
                      id={input.key}
                      type={input.secret && !showSecret[input.key] ? 'password' : 'text'}
                      value={configValues[input.key] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setConfigValues((previous) => ({
                          ...previous,
                          [input.key]: value,
                        }));
                      }}
                      onBlur={() => setTouched((previous) => ({ ...previous, [input.key]: true }))}
                      className="flex-1"
                      autoComplete="off"
                      aria-required={input.required}
                      aria-invalid={showError || undefined}
                    />
                    {input.secret ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setShowSecret((previous) => ({
                            ...previous,
                            [input.key]: !previous[input.key],
                          }))
                        }
                        aria-label={showSecret[input.key] ? 'Hide value' : 'Show value'}
                      >
                        {showSecret[input.key] ? <EyeOff /> : <Eye />}
                      </Button>
                    ) : null}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground">{input.key}</p>
                  {showError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {fieldError}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {customerKnown ? null : (
        <section aria-labelledby="public-customer" className="flex flex-col gap-4">
          <h2 id="public-customer" className="text-base font-semibold">
            Your details
          </h2>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="customer-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customer-name"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="customer-email">
                Email <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customer-email"
                type="email"
                value={customerEmail}
                onChange={(event) => setCustomerEmail(event.target.value)}
                required
              />
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="public-review" className="flex flex-col gap-3">
        <h2 id="public-review" className="text-base font-semibold">
          Review
        </h2>
        <TablePanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead>What happens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {planRows.map((row) => (
                <TableRow key={row.kind}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-muted-foreground">{row.whatHappens}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
        <FootprintSummary footprint={plan.footprint} stage="planned" />
        <AwsInfrastructureDetails plan={plan} region={region} />
        {region ? (
          <p className="text-sm text-muted-foreground">
            Region: {installPlanRegionLabel(region) ?? region}
          </p>
        ) : null}
        {planLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Spinner aria-hidden /> Updating estimate…
          </p>
        ) : null}
        {retentionNote ? <p className="text-sm text-muted-foreground">{retentionNote}</p> : null}
        <p className="text-sm font-medium text-foreground">
          PostgreSQL and stored files are retained when the application is disconnected. They can
          continue to generate AWS charges until they are permanently purged.
        </p>
        {estimateUnavailable ? (
          <p className="text-sm text-muted-foreground">Estimate unavailable for this Region.</p>
        ) : (
          <FootprintCost estimate={plan.costEstimate} />
        )}
        <p className="text-sm text-muted-foreground">
          {canSubmit
            ? 'All required values are filled. You can deploy.'
            : 'Fill all required values to deploy.'}
        </p>
      </section>

      <section aria-label="Deploy actions" className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Verify your AWS account and Region in the AWS console before stack creation.
        </p>
        <Button
          size="lg"
          type="submit"
          disabled={!canSubmit || pending}
          loading={pending}
          loadingText="Preparing deployment…"
        >
          Continue to setup
        </Button>
        {!settingsValid ? (
          <p className="text-sm text-muted-foreground">
            Complete the required application settings to continue.
          </p>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Installation failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </section>
    </form>
  );
}

/** "DATABASE_URL" → "Database url" — used only when the vendor set no label. */
function humanizeSettingKey(key: string): string {
  const words = key.toLowerCase().split('_').filter((word) => word.length > 0);
  if (words.length === 0) return key;
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An absolute URL of any scheme (https://, postgres://, redis://, …). */
function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value).protocol !== 'javascript:';
  } catch {
    return false;
  }
}

/**
 * Presence + safe-format validation for one application setting. Trims
 * whitespace for non-secret values (a secret's exact bytes matter). Returns
 * a short plain-English error, or null when the value is acceptable.
 */
function settingFieldError(input: PublicInstallInput, rawValue: string): string | null {
  const value = input.secret ? rawValue : rawValue.trim();
  if (input.required && value === '') return 'This value is required.';
  if (value === '') return null;
  if (value.length > 4096) return 'This value must be 4096 characters or fewer.';
  if (/_URL$|_URI$/.test(input.key)) {
    if (!isAbsoluteUrl(value)) return 'Enter a full URL, for example https://example.com.';
  } else if (/_EMAIL$/.test(input.key)) {
    if (!EMAIL_PATTERN.test(value)) return 'Enter a valid email address.';
  } else if (/_PORT$/.test(input.key)) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'Enter a port number from 1 to 65535.';
    }
  }
  return null;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
