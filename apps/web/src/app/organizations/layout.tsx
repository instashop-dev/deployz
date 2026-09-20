import Link from 'next/link';
import type { ReactNode } from 'react';

import { DeployzBrand } from '@/components/deployz-brand';

// Centered layout for organization on-boarding screens — same shape as the
// (auth) layout.
export default function OrganizationsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <Link href="/" className="inline-flex">
        <DeployzBrand size="lg" />
      </Link>
      {children}
    </main>
  );
}
