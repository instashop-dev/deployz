'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSignOut() {
    setPending(true);
    await authClient.signOut();
    router.push('/');
    router.refresh();
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={onSignOut} disabled={pending}>
      <LogOut aria-hidden />
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
