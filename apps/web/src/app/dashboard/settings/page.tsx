import { Building2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OrganizationForm } from '@/components/organization-form';
import { PLAN_LABELS, fetchOrganization } from '@/lib/organization';

// §41 screen 18 organization settings. The update form now actually submits
// (PATCH /api/organization). There is no organization-deletion endpoint on
// the API, so — per §63 ("destructive actions should never be hidden behind
// ambiguous UI") — this screen does not show a Delete Organization button
// that does nothing. Add one only once the API supports it.
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
        <CardContent className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetaRow
              label="Plan"
              value={PLAN_LABELS[org.plan]}
              badge={<Badge variant="secondary">{PLAN_LABELS[org.plan]}</Badge>}
            />
            <MetaRow
              label="Created"
              value={new Date(org.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            />
          </div>
          <OrganizationForm organization={org} />
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
