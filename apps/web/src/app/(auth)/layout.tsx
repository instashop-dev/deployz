import Link from 'next/link';
import type { ReactNode } from 'react';

import { DeployzBrand } from '@/components/deployz-brand';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '@/lib/legal-links';

// Centered auth layout: brand mark above the form card, on a quiet muted
// surface that separates the auth flow from the marketing pages behind it.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-muted/40 px-4 py-8">
      <Link href="/" className="inline-flex">
        <DeployzBrand />
      </Link>
      {children}
      <nav aria-label="Legal" className="flex gap-4 text-xs text-muted-foreground">
        <a
          href={TERMS_OF_SERVICE_URL}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-4 hover:underline"
        >
          Terms of Service
        </a>
        <a
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-4 hover:underline"
        >
          Privacy Policy
        </a>
      </nav>
    </main>
  );
}
