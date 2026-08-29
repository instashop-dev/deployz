import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { SetupProgress } from '@/components/setup-progress';
import { Button } from '@/components/ui/button';

/** The three things between a new organization and its first customer. */
const SETUP_STEPS = [
  'Connect application',
  'Review deployment setup',
  'Deploy first customer',
] as const;

// State A — nothing is connected yet. One heading, one action, and the short
// track that action starts. "Connect GitHub repository" goes to the existing
// Applications page, where the GitHub installation and repository choice live.
export function GetStartedCard() {
  return (
    <section aria-labelledby="get-started" className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 id="get-started" className="text-2xl font-semibold tracking-tight">
          Get your first customer deployed
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Connect your application and Deployz will prepare it for private deployment on AWS.
        </p>
      </div>

      <div>
        <Button asChild>
          <Link href="/dashboard/applications">
            Connect GitHub repository
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>

      <SetupProgress steps={SETUP_STEPS} currentStep={1} />
    </section>
  );
}
