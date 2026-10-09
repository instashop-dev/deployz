import Link from 'next/link';

import { Button } from '@/components/ui/button';

/**
 * The single "Before you deploy" information section: the data-boundary
 * and retention facts the customer needs before approving the connector.
 * The AWS billing note sits with the cost estimate, so it is not repeated
 * here. `retention` is the plan's own retained-resource sentence when it
 * has one.
 */
export function BeforeYouDeploySection({
  retention,
  securityHref,
}: {
  retention?: string | null;
  securityHref?: string;
}) {
  return (
    <section aria-labelledby="before-you-deploy" className="flex flex-col gap-3 rounded-lg bg-muted/50 p-4">
      <h2 id="before-you-deploy" className="text-sm font-semibold">
        Before you deploy
      </h2>
      <ul className="flex flex-col gap-2 pl-0 text-sm text-muted-foreground">
        <Bullet>Deployz never receives or stores your AWS credentials.</Bullet>
        <Bullet>Your application data and logs remain in your AWS account.</Bullet>
        <Bullet>
          {retention ??
            'Persistent resources stay in your account after removal and may keep incurring AWS charges.'}
        </Bullet>
      </ul>
      {securityHref ? (
        <Button asChild variant="link" size="sm" className="h-auto w-fit px-0" data-testid="before-you-deploy-security">
          <Link href={securityHref}>Security &amp; permissions details</Link>
        </Button>
      ) : null}
    </section>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
      <span>{children}</span>
    </li>
  );
}
