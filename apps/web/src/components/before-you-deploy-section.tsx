import Link from 'next/link';

import { Button } from '@/components/ui/button';

/**
 * The single "Before you deploy" information section. Consolidates the
 * scattered explanatory/security copy into one scannable list — what the
 * customer needs to know before approving the connector. The detailed
 * Security details page stays reachable through the secondary link at
 * the bottom of the section.
 */
export function BeforeYouDeploySection({ securityHref }: { securityHref?: string }) {
  return (
    <section aria-labelledby="before-you-deploy" className="flex flex-col gap-3">
      <h2 id="before-you-deploy" className="text-base font-semibold">
        Before you deploy
      </h2>
      <ul className="flex flex-col gap-2 pl-0 text-sm text-muted-foreground">
        <Bullet>AWS charges are billed directly to you. Actual costs depend on usage.</Bullet>
        <Bullet>Deployz never receives or stores your AWS credentials.</Bullet>
        <Bullet>Your application data and logs remain in your AWS account.</Bullet>
        <Bullet>Persistent resources stay in your account after removal and may keep incurring AWS charges.</Bullet>
      </ul>
      {securityHref ? (
        <Button asChild variant="outline" size="sm" className="w-fit" data-testid="before-you-deploy-security">
          <Link href={securityHref}>Security &amp; permissions details</Link>
        </Button>
      ) : null}
    </section>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-foreground" />
      <span>{children}</span>
    </li>
  );
}