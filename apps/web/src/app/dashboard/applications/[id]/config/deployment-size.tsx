'use client';

import { useEffect, useId, useState } from 'react';

import {
  allowedSizeTiers,
  currentInfrastructureSizeProfile,
  INFRASTRUCTURE_SIZE_TIERS,
  type DeploymentPlan,
  type InfrastructureSizeTier,
} from '@deployz/contracts';

import { SizeSelect } from '@/components/size-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api-client';
import { fetchApplicationPlan, updateApplicationSizes, type Application } from '@/lib/applications';
import { estimateKind, type EstimateKind } from '@/lib/configuration-inventory';
import { formatMonthlyRange } from '@/lib/footprint';
import { regionOptionLabel } from '@/lib/regions';
import { sizeTierCompute, sizeTierLabel } from '@/lib/size-tiers';
import { cn } from '@/lib/utils';

const ESTIMATE_KIND_COPY: Record<EstimateKind, { label: string; variant: 'secondary' | 'warning' | 'outline' }> = {
  complete: { label: 'Complete estimate', variant: 'secondary' },
  'baseline-plus-usage': { label: 'Baseline plus usage', variant: 'secondary' },
  partial: { label: 'Partial estimate', variant: 'warning' },
  unavailable: { label: 'Estimate unavailable', variant: 'outline' },
};

// `undefined` while the size's plan is loading, `null` when it could not be loaded.
type SizePlans = Partial<Record<InfrastructureSizeTier, DeploymentPlan | null>>;

function usageSuffix(kind: EstimateKind): string {
  return kind === 'baseline-plus-usage' || kind === 'partial' ? ' + usage' : '';
}

// Deployment sizes and the per-deployment AWS estimate. The vendor sets the
// recommended size and the smallest size customers may use; both apply to
// links and deployments created later. Every number is that size's plan
// `costEstimate` — this card only formats it.
export function DeploymentSize({
  application,
  plan,
  externalServices,
  unestimatedWorkload,
  onSaved,
}: {
  application: Application;
  plan: DeploymentPlan | null;
  externalServices: string[];
  unestimatedWorkload: boolean;
  onSaved: () => Promise<void>;
}) {
  const defaultId = useId();
  const minimumId = useId();
  const [plans, setPlans] = useState<SizePlans>({});
  const [defaultSize, setDefaultSize] = useState(application.defaultSizeProfile);
  const [minimumSize, setMinimumSize] = useState(application.minimumSizeProfile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPlans({});
    for (const tier of INFRASTRUCTURE_SIZE_TIERS) {
      fetchApplicationPlan(application.id, tier).then(
        (sizePlan) => !cancelled && setPlans((current) => ({ ...current, [tier]: sizePlan })),
        () => !cancelled && setPlans((current) => ({ ...current, [tier]: null })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [application.id, plan]);

  useEffect(() => {
    setDefaultSize(application.defaultSizeProfile);
    setMinimumSize(application.minimumSizeProfile);
  }, [application.defaultSizeProfile, application.minimumSizeProfile]);

  function changeMinimum(tier: InfrastructureSizeTier): void {
    setMinimumSize(tier);
    if (!allowedSizeTiers(tier).includes(defaultSize)) setDefaultSize(tier);
    setSaved(false);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateApplicationSizes(application.id, { defaultSizeProfile: defaultSize, minimumSizeProfile: minimumSize });
      await onSaved();
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const dirty = defaultSize !== application.defaultSizeProfile || minimumSize !== application.minimumSizeProfile;
  const recommendedPlan = plans[defaultSize] ?? (defaultSize === application.defaultSizeProfile ? plan : null);
  const estimate = recommendedPlan?.costEstimate ?? null;
  const kind = estimateKind(estimate);
  const range = estimate ? formatMonthlyRange(estimate.monthlyMin, estimate.monthlyMax) : null;
  const region = recommendedPlan?.region ?? null;
  const hasDatabase = plan ? plan.components.some((component) => component.kind === 'database') : application.databaseRequired;
  const hasCache = plan ? plan.components.some((component) => component.kind === 'cache') : application.redisRequired;

  return (
    <Card id="deployment-size" className="scroll-mt-20" data-testid="deployment-size">
      <CardHeader>
        <CardTitle>Deployment size</CardTitle>
        <CardDescription>
          Customers see the recommended size first and can choose any size at or above the minimum. Changes apply
          to new install links and new deployments only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul aria-label="Deployment sizes" className="grid gap-2 sm:grid-cols-3">
          {INFRASTRUCTURE_SIZE_TIERS.map((tier) => {
            const profile = currentInfrastructureSizeProfile(tier);
            const sizeEstimate = plans[tier]?.costEstimate ?? null;
            const sizeRange = sizeEstimate ? formatMonthlyRange(sizeEstimate.monthlyMin, sizeEstimate.monthlyMax) : null;
            const belowMinimum = !allowedSizeTiers(minimumSize).includes(tier);
            return (
              <li
                key={tier}
                aria-current={tier === defaultSize || undefined}
                data-testid={`deployment-size-${tier}`}
                className={cn(
                  'flex flex-col gap-0.5 rounded-lg border px-3 py-2',
                  tier === defaultSize ? 'border-primary' : 'text-muted-foreground',
                )}
              >
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {sizeTierLabel(tier)}
                  {tier === defaultSize ? <Badge variant="secondary">Recommended</Badge> : null}
                  {tier === minimumSize ? <Badge variant="outline">Minimum</Badge> : null}
                  {belowMinimum ? <Badge variant="outline">Not offered</Badge> : null}
                </span>
                <span className="text-xs">{sizeTierCompute(tier)} per service</span>
                {hasDatabase ? (
                  <span className="text-xs">Database {profile.database.instanceClass}</span>
                ) : null}
                {hasCache ? <span className="text-xs">Cache {profile.cache.nodeType}</span> : null}
                <span className="text-xs font-medium" data-testid={`deployment-size-${tier}-cost`}>
                  {plans[tier] === undefined
                    ? 'Loading estimate…'
                    : sizeRange
                      ? `${sizeRange}${usageSuffix(estimateKind(sizeEstimate))}`
                      : 'Estimate unavailable'}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={defaultId}>Recommended size</Label>
            <SizeSelect
              id={defaultId}
              value={defaultSize}
              tiers={allowedSizeTiers(minimumSize)}
              onValueChange={(tier) => {
                setDefaultSize(tier);
                setSaved(false);
              }}
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={minimumId}>Minimum supported size</Label>
            <SizeSelect
              id={minimumId}
              value={minimumSize}
              tiers={INFRASTRUCTURE_SIZE_TIERS}
              onValueChange={changeMinimum}
              disabled={saving}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!dirty}
            loading={saving}
            loadingText="Saving sizes…"
            onClick={() => void save()}
            data-testid="deployment-size-save"
          >
            Save sizes
          </Button>
          {saved ? (
            <p role="status" className="text-sm text-muted-foreground">
              Saved.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive" data-testid="deployment-size-error">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5 border-t pt-4" data-testid="deployment-cost">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              Estimated AWS cost per deployment ({sizeTierLabel(defaultSize)})
            </span>
            <Badge variant={ESTIMATE_KIND_COPY[kind].variant} data-testid="deployment-cost-kind">
              {ESTIMATE_KIND_COPY[kind].label}
            </Badge>
          </div>
          <p className="text-2xl font-semibold tracking-tight" data-testid="deployment-cost-total">
            {range ? `${range}${usageSuffix(kind)}` : 'Unavailable'}
          </p>
          {kind === 'partial' ? (
            <p className="text-sm text-muted-foreground">Some resources could not be priced. The real cost is higher.</p>
          ) : null}
          {unestimatedWorkload ? (
            <p className="text-sm text-muted-foreground">The background worker is not estimated.</p>
          ) : null}
          <p className="text-xs text-muted-foreground" data-testid="deployment-cost-assumptions">
            {region ? `Region: ${regionOptionLabel(region)}` : 'Region: US East (N. Virginia) baseline. The customer’s region can change the price.'}{' '}
            · On-demand prices · 730 hours a month · USD
          </p>
          {estimate && estimate.usageDependent.length > 0 ? (
            <p className="text-xs text-muted-foreground">Not included: {estimate.usageDependent.join(', ')}.</p>
          ) : null}
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="deployment-cost-charges">
            <li>AWS charges go to the customer’s AWS account.</li>
            <li>Deployz fees are not included in this estimate.</li>
            <li>
              External services
              {externalServices.length > 0 ? ` (${externalServices.join(', ')})` : ''} are billed separately and not
              estimated.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
