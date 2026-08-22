'use client';

import { ArrowLeft, CheckCircle2, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { SecretInput } from '@/components/secret-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

const APPLICATIONS = [
  { id: 'fixture-repo-1', name: 'express-api' },
  { id: 'fixture-repo-2', name: 'legacy-redis' },
] as const;

const REGIONS = [
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'eu-west-1', label: 'Europe (Ireland)' },
  { value: 'eu-central-1', label: 'Europe (Frankfurt)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
] as const;

const VERSIONS = ['v1.0.0', 'v1.1.0', 'v1.2.0'] as const;

const SECRET_KEYS = ['DATABASE_URL', 'API_KEY'] as const;

const selectClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30';

export default function NewDeploymentPage() {
  const [installLink, setInstallLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const installationName = String(form.get('installationName') ?? '');
    const slug = installationName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const installationId = slug || 'new-installation';
    setInstallLink(`deployz.com/install/${installationId}`);
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden className="size-4" />
            Deployments
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create Customer Deployment</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add a customer and generate their install link. The customer opens the link and signs in
          to their own cloud account — their credentials never touch Deployz.
        </p>
      </div>

      {installLink ? (
        <InstallLinkCard link={installLink} onReset={() => setInstallLink(null)} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Customer details</CardTitle>
            <CardDescription>
              The customer and their deployment details. Required secrets are sent to the
              customer&apos;s account at install time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="customerName">Customer name</Label>
                  <Input id="customerName" name="customerName" required />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="customerEmail">Customer email</Label>
                  <Input id="customerEmail" name="customerEmail" type="email" required />
                </div>
              </div>

              <Separator />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="application">Application</Label>
                  <select id="application" name="application" className={selectClass} required defaultValue={APPLICATIONS[0]!.id}>
                    {APPLICATIONS.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="region">AWS region</Label>
                  <select id="region" name="region" className={selectClass} required defaultValue={REGIONS[0]!.value}>
                    {REGIONS.map((region) => (
                      <option key={region.value} value={region.value}>
                        {region.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="installationName">Installation name</Label>
                  <Input id="installationName" name="installationName" required />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="version">Application version</Label>
                  <select id="version" name="version" className={selectClass} required defaultValue={VERSIONS[0]}>
                    {VERSIONS.map((version) => (
                      <option key={version} value={version}>
                        {version}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <Separator />

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Label>Required secrets</Label>
                  <Badge variant="outline">Write-only</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  These secrets are sent to the customer&apos;s account at install time. You can
                  replace a secret later, but you can never see its current value.
                </p>
                {SECRET_KEYS.map((key) => (
                  <div key={key} className="flex flex-col gap-2">
                    <Label htmlFor={key} className="font-mono">{key}</Label>
                    <SecretInput id={key} name={key} placeholder="••••••••" />
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Creating…' : 'Create Customer Deployment'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InstallLinkCard({ link, onReset }: { link: string; onReset: () => void }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
          <CardTitle>Deployment created</CardTitle>
        </div>
        <CardDescription>
          Send this install link to your customer. They will sign in to their own cloud account —
          their credentials never touch Deployz.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2.5">
          <code className="flex-1 break-all font-mono text-sm">{link}</code>
          <Button asChild variant="outline" size="sm">
            <a href={`https://${link}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden className="size-4" />
              Open
            </a>
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">Back to deployments</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onReset}>
            Create another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
