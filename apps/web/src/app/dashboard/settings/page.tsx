import { Building2, CreditCard, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  PLAN_LABELS,
  STRIPE_STATUS_LABELS,
  fetchOrganization,
} from '@/lib/organization';

export default async function SettingsPage() {
  const org = await fetchOrganization();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your organization details and billing status.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>Organization</CardTitle>
          </div>
          <CardDescription>Your organization identity in Deployz.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetaRow label="Organization name" value={org.name} />
            <MetaRow label="Slug" value={org.slug} />
            <MetaRow
              label="Plan"
              value={PLAN_LABELS[org.plan]}
              badge={<Badge variant="secondary">{PLAN_LABELS[org.plan]}</Badge>}
            />
            <MetaRow
              label="Stripe status"
              value={STRIPE_STATUS_LABELS[org.stripeStatus]}
              badge={
                <Badge variant={org.stripeStatus === 'ACTIVE' ? 'default' : 'outline'}>
                  {STRIPE_STATUS_LABELS[org.stripeStatus]}
                </Badge>
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CreditCard className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>Update Organization</CardTitle>
          </div>
          <CardDescription>Change your organization name.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="orgName">Organization name</Label>
              <Input id="orgName" name="orgName" defaultValue={org.name} required />
            </div>
            <div>
              <Button type="submit">Update Organization</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Separator />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Trash2 className="size-5 text-destructive" aria-hidden />
            <CardTitle className="text-destructive">Danger zone</CardTitle>
          </div>
          <CardDescription>
            Deleting your organization removes all deployments, customers, and billing data. This
            action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive">Delete Organization</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function MetaRow({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm font-medium">
        {value}
        {badge}
      </dd>
    </div>
  );
}
