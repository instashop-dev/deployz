'use client';

import { ArrowLeft, CheckCircle2, Copy, ExternalLink, PackageX } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';

import { copyInstallLink } from '@/components/copy-install-link';
import { CustomerPicker } from '@/components/customer-picker';
import { ManageBillingButton } from '@/components/manage-billing-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import { fetchApplications, type Application } from '@/lib/applications';
import {
  createCheckoutIntent,
  fetchBillingConfig,
  fetchSubscriptionStatus,
  openSubscriptionCheckout,
} from '@/lib/billing-checkout';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';
import {
  createCustomerRecord,
  createDeploymentErrorMessage,
  createDeploymentRecord,
  existingTestDeploymentId,
  matchesRememberedCustomer,
  readinessFindingMessages,
  type RememberedCustomer,
} from '@/lib/deployments';
import {
  createInvitation,
  fetchCustomers,
  initialCustomerSelection,
  matchingCustomerByEmail,
  NEW_CUSTOMER_VALUE,
  type Customer,
} from '@/lib/customers';
import { fetchApplicationPreflight, type PreflightResult } from '@/lib/preflight';
import { fetchRegions, type RegionOption } from '@/lib/regions';
import {
  BuildConfigurationMissingError,
  createRelease,
  fetchReleases,
  firstReleaseInput,
  installReleaseState,
  type InstallReleaseState,
} from '@/lib/releases';
import { PreflightSummary } from '@/components/preflight-summary';

/** Readiness rejection codes the "Review the application's readiness
 *  findings" link applies to (§19) — every other error is shown as plain
 *  text with no link. */
const READINESS_ERROR_CODES = new Set(['MANIFEST_NOT_COMPATIBLE', 'MANIFEST_NEEDS_CONFIGURATION']);

// §12/§41 screen 12 "Create installation" — the invitation-first model: the
// vendor picks a customer (creating one when needed) and an application, and
// may RECOMMEND an AWS region. No deployment exists yet — the customer opens
// the one-time installation link, chooses the final region, and confirms;
// only that confirmation creates the deployment (and only then is billing
// checked). A `?test=true` deployment stays the vendor's own free test: it
// is created directly with a vendor-chosen region because no customer is
// involved.
//
// Region options come from GET /api/regions (never hardcoded here): the
// control plane serves only regions whose regional bootstrap artifacts are
// confirmed published, so the UI cannot offer a region that would fail to
// install.

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

type CustomersState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; customers: Customer[] };

function NewDeploymentScreen() {
  const searchParams = useSearchParams();
  const preselectedApplicationId = searchParams.get('applicationId');
  const preselectedCustomerId = searchParams.get('customerId');
  const isTestDeployment = searchParams.get('test') === 'true';

  const [appsState, setAppsState] = useState<AppsState>({ status: 'loading' });
  const [customersState, setCustomersState] = useState<CustomersState>({ status: 'loading' });
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(NEW_CUSTOMER_VALUE);
  const [customerSelectionInitialized, setCustomerSelectionInitialized] = useState(false);
  const [customerEmailInput, setCustomerEmailInput] = useState('');
  // Guards a duplicate submit fired before React re-renders the disabled
  // submit button — `pending` state alone lags one tick behind a fast second
  // click.
  const submittingRef = useRef(false);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [regionsError, setRegionsError] = useState(false);
  // Test mode only: the created deployment's install link.
  const [installLink, setInstallLink] = useState<string | null>(null);
  // Customer mode: the created invitation's one-time reveal — the URL carries
  // the token as its fragment, plus the token shown separately.
  const [invitation, setInvitation] = useState<{ url: string; token: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdCustomerId, setCreatedCustomerId] = useState<string | null>(null);
  const [createdApplicationId, setCreatedApplicationId] = useState<string | null>(null);
  // The customer created by an earlier failed attempt (§12) — reused on
  // retry instead of inserting a duplicate customer row (CANARY-004).
  const [rememberedCustomer, setRememberedCustomer] = useState<RememberedCustomer | null>(null);
  // Set only for a readiness rejection, so the error can link to the
  // application's readiness findings.
  const [readinessApplicationId, setReadinessApplicationId] = useState<string | null>(null);
  const [readinessFindings, setReadinessFindings] = useState<string[]>([]);
  // Set only for a TEST_DEPLOYMENT_EXISTS conflict, so the error can link to
  // the application's existing test deployment (Paddle migration Phase 7).
  const [conflictingTestDeploymentId, setConflictingTestDeploymentId] = useState<string | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(preselectedApplicationId);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  // Null while unknown (or unloadable): the API stays the authority then.
  const [releaseState, setReleaseState] = useState<InstallReleaseState | null>(null);
  // Customer mode: the vendor's subscription status. An evaluation or
  // canceled vendor needs a self-serve way to start a subscription before
  // customers can confirm installations; past-due/paused vendors need the
  // portal instead. Test mode never hits this (test deployments are free).
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null | undefined>(undefined);
  const [checkoutState, setCheckoutState] = useState<'idle' | 'opening' | 'paid'>('idle');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const customers = await fetchCustomers();
        if (!cancelled) setCustomersState({ status: 'loaded', customers });
      } catch {
        // The new-customer path still works without the list.
        if (!cancelled) setCustomersState({ status: 'error' });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // The customer list decides the default selection: the `?customerId=` from
  // the URL when it names a real customer, else "create new" — set once, the
  // same pattern as the application default below.
  useEffect(() => {
    if (customersState.status !== 'loaded' || customerSelectionInitialized) return;
    setSelectedCustomerId(initialCustomerSelection(customersState.customers, preselectedCustomerId));
    setCustomerSelectionInitialized(true);
  }, [customersState, customerSelectionInitialized, preselectedCustomerId]);

  // The applications list decides the default selection; the preflight
  // follows whichever application is selected.
  useEffect(() => {
    if (appsState.status !== 'loaded' || selectedApplicationId !== null) return;
    setSelectedApplicationId(appsState.applications[0]?.id ?? null);
  }, [appsState, selectedApplicationId]);

  useEffect(() => {
    if (!selectedApplicationId) return;
    let cancelled = false;
    setPreflight(null);
    fetchApplicationPreflight(selectedApplicationId)
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch(() => {
        // The form still works without the preview; the API enforces the gate.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedApplicationId]);

  // Customer mode: fetch the vendor's subscription status so the page can
  // show the self-serve subscription entry (evaluation/canceled) or the
  // portal link (past-due/paused). Test mode skips this (free deployments).
  useEffect(() => {
    if (isTestDeployment) return;
    let cancelled = false;
    fetchSubscriptionStatus()
      .then((status) => {
        if (!cancelled) setSubscriptionStatus(status);
      })
      .catch(() => {
        // The page still works without the notice; the API enforces the gate.
      });
    return () => {
      cancelled = true;
    };
  }, [isTestDeployment]);

  // Region options come from the control plane so only confirmed-deployable
  // regions are ever offered. A failure to load them is a hard error — a form
  // that defaulted to a stale hardcoded region would let the vendor create a
  // deployment in a region that cannot install.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const options = await fetchRegions();
        if (cancelled) return;
        setRegions(options);
        setRegionsError(false);
      } catch {
        if (!cancelled) setRegionsError(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // A `?customerId=` preselection is not known until the list loads. The
  // new-customer inputs stay hidden until then, so they do not flash.
  const awaitingPreselection =
    preselectedCustomerId !== null && customersState.status === 'loading';
  const usingExistingCustomer = selectedCustomerId !== NEW_CUSTOMER_VALUE;
  const selectedApplication =
    appsState.status === 'loaded'
      ? appsState.applications.find((app) => app.id === selectedApplicationId)
      : undefined;
  const duplicateCustomer =
    !usingExistingCustomer && customersState.status === 'loaded'
      ? matchingCustomerByEmail(customersState.customers, customerEmailInput)
      : null;

  function resetCustomerSelection(): void {
    setSelectedCustomerId(
      initialCustomerSelection(
        customersState.status === 'loaded' ? customersState.customers : [],
        preselectedCustomerId,
      ),
    );
    setCustomerEmailInput('');
  }

  // Customer mode: a subscribe-only checkout intent (no parked deployment)
  // opens Paddle's overlay; when the vendor pays, the webhook activates the
  // subscription and customers can then confirm their invitations.
  async function onStartSubscription(): Promise<void> {
    setCheckoutError(null);
    setCheckoutState('opening');
    try {
      const config = await fetchBillingConfig();
      const intent = await createCheckoutIntent({});
      const outcome = await openSubscriptionCheckout(config, intent.transactionId);
      setCheckoutState(outcome === 'completed' ? 'paid' : 'idle');
    } catch (caught) {
      setCheckoutError(errorMessage(caught));
      setCheckoutState('idle');
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // A second submit while the first is still in flight must do nothing —
    // `pending` alone can lag a tick behind a fast double click.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    setReadinessApplicationId(null);
    setReadinessFindings([]);
    setConflictingTestDeploymentId(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const customerName = String(form.get('customerName') ?? '').trim();
    const customerEmail = String(form.get('customerEmail') ?? '').trim();
    const customerCompany = String(form.get('customerCompany') ?? '').trim();
    const applicationId = String(form.get('application') ?? '');
    const region = String(form.get('region') ?? '');

    let customerId: string | null = null;
    try {
      if (usingExistingCustomer) {
        // The vendor picked a customer that already exists — never create a
        // second row for them.
        customerId = selectedCustomerId;
      } else if (matchesRememberedCustomer(rememberedCustomer, customerName, customerEmail)) {
        // A prior failed attempt may already have created this customer —
        // reuse it rather than inserting a duplicate (CANARY-004).
        customerId = rememberedCustomer.id;
      } else {
        const customer = await createCustomerRecord({
          name: customerName,
          email: customerEmail,
          company: customerCompany || null,
        });
        customerId = customer.id;
        // "Create another" must offer this customer in the picker.
        setCustomersState((current) =>
          current.status === 'loaded'
            ? {
                status: 'loaded',
                customers: [...current.customers, { ...customer, updatedAt: customer.createdAt }],
              }
            : current,
        );
        setRememberedCustomer({ id: customer.id, name: customerName, email: customerEmail });
      }
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      if (isTestDeployment) {
        // The vendor's own free test: created directly with the chosen region.
        const deployment = await createDeploymentRecord({
          applicationId,
          customerId,
          region: region || regions[0]?.value || '',
          deploymentType: 'TEST',
        });
        setCreatedCustomerId(customerId);
        setCreatedApplicationId(applicationId);
        setInstallLink(`${origin}/install/${deployment.installLinkId}`);
      } else {
        // The invitation-first path: no deployment row and no entitlement
        // use here — the customer confirms later, and billing is checked at
        // that confirmation, not before.
        const created = await createInvitation({
          customerId,
          applicationId,
          ...(region !== '' ? { recommendedRegion: region } : {}),
        });
        setCreatedCustomerId(customerId);
        setCreatedApplicationId(applicationId);
        // One shareable URL: the one-time token rides as its fragment.
        setInvitation({
          url: `${origin}/install/${created.id}#${created.token}`,
          token: created.token,
        });
      }
    } catch (caught) {
      setError(createDeploymentErrorMessage(caught));
      if (caught instanceof ApiRequestError && READINESS_ERROR_CODES.has(caught.code)) {
        setReadinessApplicationId(applicationId);
        setReadinessFindings(readinessFindingMessages(caught.details));
      }
      setConflictingTestDeploymentId(existingTestDeploymentId(caught));
    } finally {
      setPending(false);
      submittingRef.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-6">
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
          {isTestDeployment ? 'Create Test Deployment' : 'Create installation'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isTestDeployment
            ? 'Deploy your own app as a free test deployment. It does not affect billing.'
            : 'Select a customer or add a new one, then create their installation invitation. Your customer opens the link, chooses the AWS region, and confirms — a deployment is created only after their confirmation.'}
        </p>
      </div>

      {/* Customer mode: an evaluation or canceled vendor needs a self-serve
          way to start a subscription before customers can confirm invitations. */}
      {!isTestDeployment && (subscriptionStatus === null || subscriptionStatus === 'CANCELED') ? (
        <Card>
          <CardHeader>
            <CardTitle>Start your subscription</CardTitle>
            <CardDescription>
              Invitations you send can only be confirmed by customers once your subscription is
              active. Billing starts with your subscription — see What it costs for details.
              Test deployments stay free.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {checkoutState === 'paid' ? (
              <p className="text-sm text-muted-foreground">
                Payment received. Your subscription is starting — your customers can now confirm
                installations.
              </p>
            ) : (
              <Button
                onClick={() => void onStartSubscription()}
                loading={checkoutState === 'opening'}
                loadingText="Opening checkout…"
              >
                Start subscription
              </Button>
            )}
            {checkoutError ? (
              <p role="alert" className="text-sm text-destructive">
                {checkoutError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Customer mode: a past-due or paused vendor needs the Paddle portal
          to fix their subscription, not a new checkout. */}
      {!isTestDeployment && (subscriptionStatus === 'PAST_DUE' || subscriptionStatus === 'PAUSED') ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {subscriptionStatus === 'PAST_DUE' ? 'Update your payment details' : 'Resume your subscription'}
            </CardTitle>
            <CardDescription>
              {subscriptionStatus === 'PAST_DUE'
                ? 'Your last payment did not go through. Once it is sorted, your customers can confirm their installations.'
                : 'Your subscription is paused. Resume it on the billing portal, then your customers can confirm their installations.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManageBillingButton
              target={subscriptionStatus === 'PAST_DUE' ? 'updatePaymentMethod' : 'overview'}
              variant="default"
            >
              {subscriptionStatus === 'PAST_DUE' ? 'Update payment details' : 'Open billing portal'}
            </ManageBillingButton>
          </CardContent>
        </Card>
      ) : null}

      {invitation ? (
        <InvitationLinkCard
          url={invitation.url}
          customerId={createdCustomerId}
          applicationId={createdApplicationId}
          onReset={() => {
            setInvitation(null);
            resetCustomerSelection();
          }}
        />
      ) : installLink ? (
        <InstallLinkCard
          link={installLink}
          customerId={createdCustomerId}
          applicationId={createdApplicationId}
          onReset={() => {
            setInstallLink(null);
            resetCustomerSelection();
          }}
        />
      ) : appsState.status === 'loading' ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading your applications…
        </p>
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
            <CardTitle>{isTestDeployment ? 'Test deployment details' : 'Customer details'}</CardTitle>
            <CardDescription>
              {isTestDeployment
                ? 'The customer and application for this test deployment.'
                : 'The customer and application for this installation. Application secrets can be configured for the customer afterward, from the application’s Configuration page.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <CustomerPicker
                  customers={customersState.status === 'loaded' ? customersState.customers : []}
                  value={selectedCustomerId}
                  onChange={setSelectedCustomerId}
                  disabled={pending}
                  loading={customersState.status === 'loading'}
                />
                {customersState.status === 'error' ? (
                  <p className="text-sm text-muted-foreground">
                    We couldn&apos;t load your customers. You can still create a new customer.
                  </p>
                ) : null}
              </div>

              {usingExistingCustomer || awaitingPreselection ? null : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="customerName">Customer name</Label>
                    <Input id="customerName" name="customerName" required />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="customerEmail">Customer email</Label>
                    <Input
                      id="customerEmail"
                      name="customerEmail"
                      type="email"
                      required
                      value={customerEmailInput}
                      onChange={(event) => setCustomerEmailInput(event.currentTarget.value)}
                    />
                    {duplicateCustomer ? (
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>A customer with this email already exists.</span>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() => setSelectedCustomerId(duplicateCustomer.id)}
                        >
                          Use existing customer
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="customerCompany">Company (optional)</Label>
                    <Input id="customerCompany" name="customerCompany" />
                  </div>
                </div>
              )}

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
                    onChange={(event) => setSelectedApplicationId(event.currentTarget.value)}
                  >
                    {appsState.applications.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="region">
                    {isTestDeployment ? 'AWS region' : 'Recommended AWS region'}
                  </Label>
                  {regionsError ? (
                    <p className="text-sm text-destructive">
                      We couldn&apos;t load the available regions. Try again in a moment.
                    </p>
                  ) : regions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No regions are available for installation yet.
                    </p>
                  ) : (
                    <>
                      <select
                        id="region"
                        name="region"
                        className={selectClass}
                        {...(isTestDeployment ? { required: true, defaultValue: regions[0]?.value } : { defaultValue: '' })}
                      >
                        {isTestDeployment ? null : <option value="">No recommendation</option>}
                        {regions.map((region) => (
                          <option key={region.value} value={region.value}>
                            {region.label}
                          </option>
                        ))}
                      </select>
                      {isTestDeployment ? null : (
                        <p className="text-xs text-muted-foreground">
                          Optional. Your customer makes the final region choice before deployment.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {preflight ? (
                <PreflightSummary
                  result={preflight}
                  title="Deployment preflight — with your default configuration"
                />
              ) : null}

              {selectedApplication ? (
                <ReleaseRequirement
                  key={selectedApplication.id}
                  application={selectedApplication}
                  onStateChange={setReleaseState}
                />
              ) : null}

              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  disabled={
                    (isTestDeployment && (regionsError || regions.length === 0)) ||
                    awaitingPreselection ||
                    (releaseState !== null && releaseState.kind !== 'ready')
                  }
                  loading={pending}
                  loadingText={isTestDeployment ? 'Creating deployment…' : 'Creating invitation…'}
                >
                  {isTestDeployment ? 'Run free test deployment' : 'Create installation'}
                </Button>
                {error ? (
                  <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
                    <p>{error}</p>
                    {readinessFindings.length > 0 ? (
                      <ul className="list-disc pl-5">
                        {readinessFindings.map((finding) => (
                          <li key={finding}>{finding}</li>
                        ))}
                      </ul>
                    ) : null}
                    {readinessApplicationId ? (
                      <Link
                        href={`/dashboard/applications/${readinessApplicationId}`}
                        className="underline underline-offset-4"
                      >
                        Review the application&apos;s readiness findings
                      </Link>
                    ) : null}
                    {conflictingTestDeploymentId ? (
                      <Link
                        href={`/dashboard/deployments/${conflictingTestDeploymentId}`}
                        className="underline underline-offset-4"
                      >
                        View the existing test deployment
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** How often a building release is re-checked. */
const RELEASE_POLL_MS = 10_000;

/**
 * The release a new deployment installs. The install runs the application's
 * newest built release, so an application with none cannot be deployed yet:
 * say which release will run, or offer to build the first one and follow the
 * build until it is ready.
 */
function ReleaseRequirement({
  application,
  onStateChange,
}: {
  application: Application;
  onStateChange: (state: InstallReleaseState | null) => void;
}) {
  const [state, setState] = useState<InstallReleaseState | null>(null);
  const [lastFailed, setLastFailed] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(false);
  const [missingBuildKeys, setMissingBuildKeys] = useState<string[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const firstRelease = firstReleaseInput(application.detectedMetadata);
  const releasesHref = `/dashboard/applications/${application.id}/releases`;

  useEffect(() => {
    onStateChange(state);
  }, [state, onStateChange]);

  useEffect(() => {
    let cancelled = false;
    fetchReleases(application.id)
      .then((releases) => {
        if (cancelled) return;
        setState(installReleaseState(releases));
        setLastFailed(releases.some((r) => r.status === 'FAILED'));
      })
      .catch(() => {
        // Unknown is not "none": the API still refuses a deployment without a release.
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [application.id, reloadTick]);

  useEffect(() => {
    if (state?.kind !== 'building') return;
    const timer = setTimeout(() => setReloadTick((tick) => tick + 1), RELEASE_POLL_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function onBuild(): Promise<void> {
    if (!firstRelease) return;
    setBuilding(true);
    setBuildError(false);
    setMissingBuildKeys(null);
    try {
      const release = await createRelease(application.id, firstRelease);
      setState(installReleaseState([release]));
    } catch (err) {
      if (err instanceof BuildConfigurationMissingError) {
        setMissingBuildKeys(err.keys);
      } else {
        setBuildError(true);
      }
    } finally {
      setBuilding(false);
    }
  }

  if (state === null) return null;

  if (state.kind === 'ready') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="install-release">
        Installs release {state.release.version}, the newest built release of {application.name}.
      </p>
    );
  }

  if (state.kind === 'building') {
    return (
      <Alert data-testid="install-release-building">
        <Spinner aria-hidden />
        <AlertTitle>Release {state.release.version} is building</AlertTitle>
        <AlertDescription>
          You can create the deployment when the build is ready. This page updates automatically.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert data-testid="install-release-missing">
      <PackageX aria-hidden />
      <AlertTitle>{application.name} has no built release</AlertTitle>
      <AlertDescription>
        <p>
          {lastFailed
            ? 'The last build failed. A deployment installs a built release of the application, so build a new one first.'
            : 'A deployment installs a built release of the application, so build one first.'}
        </p>
        {buildError ? (
          <p className="text-destructive">
            We couldn&apos;t start the build. Try again, or create the release from the Releases page.
          </p>
        ) : null}
        {missingBuildKeys ? (
          <p className="text-destructive">
            Set these build values before you build a release: {missingBuildKeys.join(', ')}.{' '}
            <Link
              href={`/dashboard/applications/${application.id}/config#environment-variables`}
              className="underline underline-offset-4"
            >
              Review configuration
            </Link>
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {firstRelease ? (
            <Button
              type="button"
              size="sm"
              onClick={() => void onBuild()}
              loading={building}
              loadingText="Starting build…"
            >
              Build release from commit {firstRelease.gitSha.slice(0, 7)}
            </Button>
          ) : null}
          <Button asChild type="button" size="sm" variant={firstRelease ? 'ghost' : 'default'}>
            <Link href={releasesHref}>Go to Releases</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The invitation-first success state. The URL carries the one-time token as
 * its fragment, so one copy action hands the customer everything they need.
 * No deployment exists yet — the customer's confirmation creates it.
 */
function InvitationLinkCard({
  url,
  customerId,
  applicationId,
  onReset,
}: {
  url: string;
  customerId: string | null;
  applicationId: string | null;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
          <CardTitle>Installation invitation created</CardTitle>
        </div>
        <CardDescription>
          Send this installation link to your customer — it carries the one-time token, so nothing
          else is needed. The customer chooses the final AWS region and confirms; a deployment is
          created only after their confirmation. The token is shown only once and cannot be
          retrieved again.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2.5">
          <code className="flex-1 break-all font-mono text-sm">{url}</code>
          <Button size="sm" onClick={() => void copyInstallLink(url)}>
            <Copy aria-hidden className="size-4" />
            Copy link
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noopener noreferrer">
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
          <Button size="sm" onClick={() => void copyInstallLink(link)}>
            <Copy aria-hidden className="size-4" />
            Copy install link
          </Button>
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
