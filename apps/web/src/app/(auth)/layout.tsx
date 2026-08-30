import Link from 'next/link';
import type { ReactNode } from 'react';

// Centered auth layout: brand mark above the form card, on a quiet muted
// surface that separates the auth flow from the marketing pages behind it.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-muted/40 px-4 py-8">
      <Link
        href="/"
        className="flex items-center gap-2 font-heading text-lg font-semibold tracking-tight"
      >
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground"
        >
          D
        </span>
        Deployz
      </Link>
      {children}
    </main>
  );
}
