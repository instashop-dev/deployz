'use client';

import { ArrowLeft, CheckCircle2, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { fetchApplications, type Application } from '@/lib/applications';
import { createCustomerRecord, createDeploymentRecord } from '@/lib/deployments';

// §12/§41 screen 12 "Create customer deployment" — previously this only
// formatted a slug client-side and rendered a fake install link; nothing was
// ever persisted. Now it creates a real Customer (POST /api/customers), then
// a real Deployment (POST /api/deployments), and shows the install link built
// from the REAL installationId the API returns.

const REGIONS = [
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-east-2', label: 'US East (Ohio)' },
  { value: 'us-west-1', label: 'US West (N. California)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'ca-central-1', label: 'Canada (Central)' },
  { value: 'sa-east-1', label: 'South America (São Paulo)' },
  { value: 'eu-west-1', label: 'Europe (Ireland)' },
  { value: 'eu-west-2', label: 'Europe (London)' },
  { value: 'eu-west-3', label: 'Europe (Paris)' },
  { value: 'eu-central-1', label: 'Europe (Frankfurt)' },
  { value: 'eu-north-1', label: 'Europe (Stockholm)' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { value: 'ap-northeast-2', label: 'Asia Pacific (Seoul)' },
  { value: 'ap-northeast-3', label: 'Asia Pacific (Osaka)' },
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
] as const;

const selectClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30';

export default function NewDeploymentPage() {
  return (
    <Suspense fallback={null}>
      <NewDeploymentScreen />
    </Suspense>
  );
}

type AppsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'loaded'; applications: Application[] };

function NewDeploymentScreen() {
  const searchParams = useSearchParams();
  const preselectedApplicationId = searchParams.get('applicationId');
  const isTestDeployment = searchParams.get('test') === 'true';

  const [appsState, setAppsState] = useState<AppsState>({ status: 'loading' });
  const [installLink, setInstallLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdCustomerId, setCreatedCustomerId] = useState<string | null>(null);
  const [createdApplicationId, setCreatedApplicationId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const applications = await fetchApplications();
        if (cancelled) return;
        setAppsState(
          applications.length === 0 ? { status: 'empty' } : { status: 'loaded', applications },
        );
      } catch {
        if (!cancelled) setAppsState({ status: 'error' });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const customerName = String(form.get('customerName') ?? '').trim();
    const customerEmail = String(form.get('customerEmail') ?? '').trim();
    const applicationId = String(form.get('application') ?? '');
    const region = String(form.get('region') ?? REGIONS[0].value);

    try {
      const customer = await createCustomerRecord({ name: customerName, email: customerEmail });
      const deployment = await createDeploymentRecord({
        applicationId,
        customerId: customer.id,
        region,
        isTestDeployment,
      });
      setCreatedCustomerId(customer.id);
      setCreatedApplicationId(applicationId);
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      setInstallLink(`${origin}/install/${deployment.installLinkId}`);
    } catch {
      setError("We couldn't create this deployment. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/deployments">
            <ArrowLeft aria-hidden className="size-4" />
            Deployments
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isTestDeployment ? 'Create Test Deployment' : 'Create Customer Deployment'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isTestDeployment
            ? "Deploy your own app as a test — it won't be billed."
            : 'Add a customer and generate their install link. The customer opens the link and signs in to their own cloud account — their credentials never touch Deployz.'}
        </p>
      </div>

      {installLink ? (
        <InstallLinkCard
          link={installLink}
          customerId={createdCustomerId}
          applicationId={createdApplicationId}
          onReset={() => setInstallLink(null)}
        />
      ) : appsState.status === 'loading' ? (
        <p className="text-sm text-muted-foreground">Loading your applications…</p>
      ) : appsState.status === 'empty' ? (
        <section className="rounded-xl border border-dashed px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Connect an application first</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            You need at least one application before you can create a deployment.
          </p>
          <Button asChild className="mt-4">
            <Link href="/dashboard/applications">Connect GitHub</Link>
          </Button>
        </section>
      ) : appsState.status === 'error' ? (
        <p className="text-sm text-destructive">
          We couldn&apos;t load your applications. Try again in a moment.
        </p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Customer details</CardTitle>
            <CardDescription>
              The customer and their deployment details. Application secrets are configured
              afterward, from the deployment&apos;s Configuration page.
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
                  <select
                    id="application"
                    name="application"
                    className={selectClass}
                    required
                    defaultValue={preselectedApplicationId ?? appsState.applications[0]?.id}
                  >
                    {appsState.applications.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="region">AWS region</Label>
                  <select id="region" name="region" className={selectClass} required defaultValue={REGIONS[0].value}>
                    {REGIONS.map((region) => (
                      <option key={region.value} value={region.value}>
                        {region.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Creating…' : isTestDeployment ? 'Create Test Deployment' : 'Create Customer Deployment'}
                </Button>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InstallLinkCard({
  link,
  customerId,
  applicationId,
  onReset,
}: {
  link: string;
  customerId: string | null;
  applicationId: string | null;
  onReset: () => void;
}) {
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
            <a href={link} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden className="size-4" />
              Open
            </a>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/deployments">Back to deployments</Link>
          </Button>
          {applicationId && customerId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/applications/${applicationId}/config?customer=${customerId}`}>
                Set up configuration
              </Link>
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onReset}>
            Create another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
