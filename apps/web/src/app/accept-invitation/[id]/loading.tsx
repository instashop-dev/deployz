import { Skeleton } from '@/components/ui/skeleton';

// Suspense fallback while the invitation lookup resolves.
export default function AcceptInvitationLoading() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <Skeleton className="h-7 w-28" />
      <Skeleton className="h-56 w-full max-w-sm rounded-xl" aria-busy="true" />
    </main>
  );
}
