import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// Suspense fallback while the signed-in user's data resolves.
export default function NewOrganizationLoading() {
  return (
    <Card className="w-full max-w-sm" aria-busy="true">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-56" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-24 w-full rounded-xl" />
      </CardContent>
    </Card>
  );
}
