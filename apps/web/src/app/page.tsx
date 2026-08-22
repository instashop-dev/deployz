import { ArrowRight, CheckCircle2, Cloud, GitBranch, HeartPulse, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card';

const FEATURES = [
  {
    icon: GitBranch,
    title: 'Connect GitHub',
    description: 'Link your repository. We analyse it and check it is ready to deploy.',
  },
  {
    icon: CheckCircle2,
    title: 'Ready',
    description: 'We verify your app has what it needs — a Dockerfile, a health endpoint, and a supported database.',
  },
  {
    icon: Cloud,
    title: 'Deploy to Customer AWS',
    description: 'Your customer opens an install link and signs in to their own cloud account. Their credentials never touch us.',
  },
  {
    icon: HeartPulse,
    title: 'Healthy',
    description: 'We keep every customer deployment healthy and up to date, all from one dashboard.',
  },
] as const;

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <span className="font-heading text-lg font-semibold tracking-tight">Deployz</span>
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

      <main className="flex flex-1 flex-col">
        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-4 py-20 text-center">
          <Badge variant="secondary">Deploy into customer cloud accounts</Badge>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Deploy your SaaS into customer AWS
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Stop wrestling with per-customer infrastructure. Connect your repo, send your customer an
            install link, and we handle the rest — their cloud, their data, your dashboard.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/sign-up">
                Get Started
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/sign-in">Sign In</Link>
            </Button>
          </div>
        </section>

        <section className="border-y bg-muted/30">
          <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <Card key={feature.title}>
                <CardContent className="flex flex-col gap-3">
                  <feature.icon className="size-6 text-muted-foreground" aria-hidden />
                  <CardTitle>{feature.title}</CardTitle>
                  <CardDescription>{feature.description}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
          <ShieldCheck className="size-10 text-muted-foreground" aria-hidden />
          <p className="text-xl font-medium">
            Customer infrastructure and data stay in customer AWS
          </p>
          <p className="max-w-lg text-sm text-muted-foreground">
            Your customer connects their own cloud account through a unique install link. We never see
            their credentials, and their data never touches our infrastructure. You get visibility and
            control; they get security and ownership.
          </p>
        </section>

        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-12 text-center">
          <Button asChild size="lg">
            <Link href="/sign-up">
              Get Started
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
          <Link
            href="/pricing"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            See pricing
          </Link>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 text-xs text-muted-foreground">
          Deployz — Deploy your SaaS into customer AWS.
        </div>
      </footer>
    </div>
  );
}
