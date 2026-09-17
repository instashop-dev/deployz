import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// Suspense fallback while the GitHub App setup redirect page resolves the
// signed-in/installation state server-side, matching the SetupCard layout.
export default function GithubSetupLoading() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8"
      aria-busy="true"
    >
      <Skeleton className="h-6 w-24" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-32" />
        </CardContent>
      </Card>
    </main>
  );
}
