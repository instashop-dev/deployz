'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest, errorMessage } from '@/lib/api-client';

export function CreateOrganizationForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiRequest('/api/organizations', { method: 'POST', body: { name } });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="organizationName">Organization name</Label>
        <Input
          id="organizationName"
          data-testid="create-organization-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <Button
        data-testid="create-organization-submit"
        type="submit"
        disabled={pending || name.trim().length === 0}
      >
        {pending ? 'Creating…' : 'Create organization'}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
