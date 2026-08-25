import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The page itself is a client component, which cannot export metadata — this
// segment layout is where the title lives. Without it every public page
// rendered the same "Deployz" title.
export const metadata: Metadata = {
  title: 'Sign up',
  description: 'Create your Deployz account.',
};

export default function SignUpLayout({ children }: { children: ReactNode }) {
  return children;
}
