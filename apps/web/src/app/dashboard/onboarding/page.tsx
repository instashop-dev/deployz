import Link from 'next/link';

import { OnboardingFlow } from '@/components/onboarding-flow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// §42 onboarding overview — the six-step first-run flow at a glance. Step 1
// (Connect GitHub) starts on the Applications page; steps 2+ live on each
// application's readiness page. Success is readiness, not first install (§5).
export default function OnboardingPage() {
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
        <OnboardingFlow currentStep={1} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Start with your code</CardTitle>
          <CardDescription>
            Connect GitHub and choose the repository we should analyse.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/dashboard/applications">Connect GitHub</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
