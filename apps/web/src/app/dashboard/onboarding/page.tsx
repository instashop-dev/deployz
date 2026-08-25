import Link from 'next/link';

import { OnboardingFlow } from '@/components/onboarding-flow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OrganizationForm } from '@/components/organization-form';
import { fetchOnboarding } from '@/lib/onboarding';
import { fetchOrganization } from '@/lib/organization';

// §42 onboarding overview — the six-step first-run flow at a glance, against
// real organization state (GET /api/onboarding), not a hard-coded step. Step 1
// (Connect GitHub) starts on the Applications page; steps 2+ live on each
// application's readiness page. Success is readiness, not first install (§5).
export default async function OnboardingPage() {
  const [{ currentStep, steps }, organization] = await Promise.all([
    fetchOnboarding(),
    fetchOrganization(),
  ]);
  const complete = currentStep >= 6;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get your app ready</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Six steps from your code to a deployment your customers can install.
        </p>
      </div>

      <section aria-labelledby="steps" className="flex flex-col gap-3">
        <h2 id="steps" className="text-base font-semibold">
          Getting your app ready
        </h2>
        <OnboardingFlow currentStep={currentStep} completed={steps.map((step) => step.completed)} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{complete ? 'Give your next customer a deployment' : 'Start with your code'}</CardTitle>
          <CardDescription>
            {complete
              ? 'Your application is ready. Create a deployment in a customer account.'
              : 'Connect GitHub and choose the repository we should analyse.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href={complete ? '/dashboard/deployments/new' : '/dashboard/applications'}>
              {complete ? 'Create Customer Deployment' : 'Connect GitHub'}
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Name your organization</CardTitle>
          <CardDescription>
            Your customers see this name on their install page — &ldquo;{organization.name} wants
            to deploy inside your AWS account&rdquo;. It starts as the first part of your email
            address, which is rarely what you want a customer to read.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationForm organization={organization} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bring in your team</CardTitle>
          <CardDescription>
            Invite the people who work on this application with you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/dashboard/settings/members">Invite teammates</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
