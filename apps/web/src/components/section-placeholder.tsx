import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Placeholder body for shell sections whose real pages land in later todos.
export function SectionPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>This section arrives in a later milestone.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
