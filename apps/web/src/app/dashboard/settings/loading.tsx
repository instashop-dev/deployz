import { Skeleton } from '@/components/ui/skeleton';

// Suspense fallback for the organization settings page.
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
