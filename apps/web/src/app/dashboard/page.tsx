import Link from 'next/link';

import { Button } from '@/components/ui/button';

// §43 empty state: no deployments exist yet — friendly, jargon-free copy
// (§65), a primary CTA, and a secondary learn link. Real deployment data
// arrives with the deployments API in a later todo; until then this is the
// only honest state — no fake rows, no placeholder cards.
export default function DeploymentsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every customer installation of your app, in one place.
        </p>
      </div>

      <section
        aria-labelledby="empty-deployments"
        className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <h2 id="empty-deployments" className="text-lg font-semibold">
          No deployments yet
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          When a customer installs your app, their deployment shows up here with its status and
          health. Add your first customer to get started.
        </p>
        <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
          <Button asChild>
            <Link href="/dashboard/customers">Add your first customer</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="#how-it-works">Learn how it works</Link>
          </Button>
        </div>
      </section>

      <section aria-labelledby="how-it-works" className="flex flex-col gap-3">
        <h2 id="how-it-works" className="text-base font-semibold">
          How it works
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
          <li>Connect your repository — we check that your app is ready to deploy.</li>
          <li>
            Your customer opens your install link and signs in to their own cloud account. Their
            credentials never touch Deployz.
          </li>
          <li>Their deployment appears here, and we keep it healthy and up to date.</li>
        </ol>
      </section>
    </div>
  );
}
