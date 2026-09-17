'use client';

import { useEffect, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Route-level error boundary for the profile page.
export default function ProfileError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
        <CardDescription>We couldn&apos;t load your profile settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button loading={isPending} loadingText="Trying again…" onClick={() => startTransition(() => reset())}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
