import Link from 'next/link';
import type { ReactNode } from 'react';

// Centered auth layout: brand mark above the form card.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <Link href="/" className="font-heading text-xl font-semibold tracking-tight">
        Deployz
      </Link>
      {children}
    </main>
  );
}
