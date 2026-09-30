import { Button } from '@/components/ui/button';

/**
 * Shown when the control plane cannot answer a customer's install page. It
 * says nothing about the link itself, so it never calls the link expired or
 * invalid — a customer who reads that stops trying a link that still works.
 */
export function InstallLoadError({ href }: { href: string }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">We can&apos;t load this page right now</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This is a temporary problem on our side. Your install link is still valid. Try again in a
        minute.
      </p>
      <Button asChild variant="outline" className="w-fit">
        <a href={href}>Try again</a>
      </Button>
    </div>
  );
}
