import Link from 'next/link';

import { Button } from '@/components/ui/button';

// The stock Next.js 404 is unbranded and says nothing useful. This is the
// same page in the product's own voice, with a way back.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">This page doesn&apos;t exist</h1>
      <p className="text-sm text-muted-foreground">
        The link may be out of date, or the page may have moved.
      </p>
      <Button asChild>
        <Link href="/">Back to Deployz</Link>
      </Button>
    </main>
  );
}
