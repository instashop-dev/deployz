'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { authClient } from '../../../lib/auth-client';

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const { error: failure } = await authClient.signUp.email({
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    if (failure) {
      setError(failure.message ?? 'sign-up failed');
      return;
    }
    router.push('/');
  }

  return (
    <main>
      <h1>Sign up</h1>
      <form onSubmit={onSubmit}>
        <label>
          Name <input name="name" autoComplete="name" required />
        </label>
        <label>
          Email <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password{' '}
          <input name="password" type="password" autoComplete="new-password" required minLength={8} />
        </label>
        <button type="submit">Create account</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <p>
        <Link href="/sign-in">Already have an account? Sign in</Link>
      </p>
    </main>
  );
}
