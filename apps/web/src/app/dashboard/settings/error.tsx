'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Error boundary for the organization settings page.
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
        <CardDescription>We couldn&apos;t load your organization settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
