import { Skeleton } from '@/components/ui/skeleton';

// Route-level skeleton for the hosted customer deploy page. Matches the
// page's most common layout — title, subtitle, the deployment review card,
// and the launch action — so the page never flashes empty while the server
// resolves the deploy link.
export default function DeployPageLoading() {
  return (
    <div className="flex flex-col gap-8" data-testid="deploy-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full max-w-sm" />
        <Skeleton className="h-4 w-full max-w-xs" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
      <Skeleton className="h-11 w-40" />
    </div>
  );
}
