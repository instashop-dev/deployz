'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';

import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { installPlanRegionLabel, installPlanRetentionNote, installPlanRows } from '@/lib/install-plan';
import { confirmPublicInstall } from '@/lib/public-install-confirm';
import { publicInstallErrorMessage, type PublicInstallResolve } from '@/lib/public-install-types';

interface PublicInstallFlowProps {
  linkId: string;
  resolve: PublicInstallResolve;
}

export function PublicInstallFlow({ linkId, resolve }: PublicInstallFlowProps) {
  const router = useRouter();

  const [region, setRegion] = useState(resolve.regions[0]?.value ?? '');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [idempotencyKey] = useState(generateIdempotencyKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planRows = useMemo(() => installPlanRows(resolve.plan), [resolve.plan]);
  const retentionNote = useMemo(() => installPlanRetentionNote(resolve.plan), [resolve.plan]);

  const requiredFilled = resolve.requiredInputs.every(
    (input) => !input.required || (configValues[input.key]?.trim() ?? '') !== '',
  );
  const canSubmit =
    region !== '' && customerName.trim() !== '' && customerEmail.trim() !== '' && requiredFilled;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || pending) return;

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
      const result = await confirmPublicInstall(linkId, {
        idempotencyKey,
        region,
        customer: { name: customerName.trim(), email: customerEmail.trim() },
        config,
      });

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
        <Select value={region} onValueChange={setRegion}>
          <SelectTrigger className="w-full sm:w-[360px]">
            <SelectValue placeholder="Select a region" />
          </SelectTrigger>
          <SelectContent>
            {resolve.regions.map((regionOption) => (
              <SelectItem key={regionOption.value} value={regionOption.value}>
                {regionOption.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section aria-labelledby="public-config" className="flex flex-col gap-4">
        <h2 id="public-config" className="text-base font-semibold">
          Required configuration
        </h2>
        <div className="flex flex-col gap-4">
          {resolve.requiredInputs.map((input) => (
            <div key={input.key} className="flex flex-col gap-2">
              <Label htmlFor={input.key}>
                {input.key}{' '}
                {input.required ? (
                  <span className="text-destructive">*</span>
                ) : (
                  <span className="text-muted-foreground">(Optional)</span>
                )}
              </Label>
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
                  className="flex-1"
                  aria-required={input.required}
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
            </div>
          ))}
        </div>
      </section>

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

      <section aria-labelledby="public-review" className="flex flex-col gap-3">
        <h2 id="public-review" className="text-base font-semibold">
          Review
        </h2>
        <div className="overflow-x-auto rounded-md border">
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
        </div>
        <AwsInfrastructureDetails plan={resolve.plan} region={region} />
        {region ? (
          <p className="text-sm text-muted-foreground">
            Region: {installPlanRegionLabel(region) ?? region}
          </p>
        ) : null}
        {retentionNote ? <p className="text-sm text-muted-foreground">{retentionNote}</p> : null}
        <p className="text-sm font-medium text-foreground">
          PostgreSQL and stored files are retained when the application is disconnected. They can
          continue to generate AWS charges until they are permanently purged.
        </p>
        <p className="text-sm text-muted-foreground">
          AWS bills your account for the resources this deployment creates.
        </p>
        <p className="text-sm text-muted-foreground">
          {canSubmit
            ? 'All required values are filled. You can deploy.'
            : 'Fill all required values to deploy.'}
        </p>
      </section>

      <section aria-label="Deploy actions" className="flex flex-col gap-4">
        <Button
          size="lg"
          type="submit"
          disabled={!canSubmit || pending}
          loading={pending}
          loadingText="Starting deployment…"
        >
          Deploy to AWS
        </Button>
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

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
