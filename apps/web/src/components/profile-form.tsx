'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

// Updates the display name through Better Auth's built-in endpoint.
export function ProfileForm({ name }: { name: string }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);
    const { error: failure } = await authClient.updateUser({ name: value });
    setPending(false);
    if (failure) {
      setError(failure.message ?? 'We could not save this change. Try again in a moment.');
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="profileName">Name</Label>
        <Input
          id="profileName"
          data-testid="profile-name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          data-testid="profile-save"
          type="submit"
          disabled={pending || value.trim().length === 0}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
