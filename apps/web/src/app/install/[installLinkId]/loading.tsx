import { Skeleton } from '@/components/ui/skeleton';

// Route-level skeleton for the public install page. Matches the page's most
// common layout — title, subtitle, a details grid, and the "Deployz will
// create" table — so the shell (install/layout.tsx) never flashes empty
// while the server fetches the install data.
export default function InstallPageLoading() {
  return (
    <div className="flex flex-col gap-8" data-testid="install-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full max-w-sm" />
        <Skeleton className="h-4 w-full max-w-xs" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-48 w-full rounded-md" />
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-11 w-40" />
        <Skeleton className="h-11 w-32" />
      </div>
    </div>
  );
}
