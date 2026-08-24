import type { Metadata } from 'next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

export const metadata: Metadata = {
  title: 'Pricing',
  description: '$49/month plus $19 for each healthy customer deployment. No infrastructure resale.',
};

const USAGE_ROWS = [
  { deployments: 'Base only', count: 0, total: '$49' },
  { deployments: '1 deployment', count: 1, total: '$68' },
  { deployments: '5 deployments', count: 5, total: '$144' },
  { deployments: '10 deployments', count: 10, total: '$239' },
  { deployments: '50 deployments', count: 50, total: '$999' },
] as const;

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
          <Link
            href="/"
            className="font-heading text-lg font-semibold tracking-tight"
          >
            Deployz
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/sign-in">Sign In</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/sign-up">Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
        <Link
          href="/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Back to home
        </Link>

        <section className="flex flex-col gap-4">
          <Badge variant="secondary" className="w-fit">Pricing</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">
            $49/month + $19 per deployment
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            A flat base subscription covers your dashboard, GitHub integration, and readiness
            checks. Each healthy customer deployment adds $19/month. Your own test deployment
            is not charged — the per-deployment fee only applies once a customer installs your
            app.
          </p>
        </section>

        <Separator className="my-8" />

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Usage examples</h2>
          <Card>
            <CardHeader>
              <CardTitle>What you pay</CardTitle>
              <CardDescription>
                Base subscription is $49/month. Each healthy deployment adds $19/month.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Deployments</th>
                    <th className="pb-2 text-right font-medium">Monthly total</th>
                  </tr>
                </thead>
                <tbody>
                  {USAGE_ROWS.map((row) => (
                    <tr key={row.count} className="border-b last:border-0">
                      <td className="py-2.5">{row.deployments}</td>
                      <td className="py-2.5 text-right font-medium tabular-nums">{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>

        <section className="mt-8 rounded-xl border border-dashed px-6 py-8 text-center">
          <p className="text-sm font-medium">
            Your customer pays AWS directly for their infrastructure
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Deployz charges you for the dashboard and deployments. Your customer pays their own cloud
            provider for the resources their deployment uses — you never resell infrastructure.
          </p>
        </section>

        <section className="mt-8 flex flex-col items-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up">
              Get Started
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-xs text-muted-foreground">
          Deployz — Deploy your SaaS into customer AWS.
        </div>
      </footer>
    </div>
  );
}
