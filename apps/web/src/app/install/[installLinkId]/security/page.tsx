import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { ArchitectureDiagram } from '@/components/architecture-diagram';
import { fetchInstallData } from '@/lib/install-data';
import { Button } from '@/components/ui/button';
import {
  AWS_RESOURCES_CREATED,
  DATA_NOT_SENT_TO_DEPLOYZ,
  DATA_SENT_TO_DEPLOYZ,
  DELETION_STEPS,
  DENIED_LOG_READ_ACTIONS,
  PASS_ROLE_RESOURCE_ARN,
  PASSED_TO_SERVICE,
  PHASE_1_LOG_WRITE_ACTIONS,
  PHASE_1_SECRET_ACTIONS,
  PHASE_2_ACM_MANAGE_ACTIONS,
  PHASE_2_ACM_REQUEST_ACTIONS,
  PHASE_2_APP_RESOURCE_ACTIONS,
  PHASE_2_CREATE_STACK_ACTIONS,
  PHASE_2_DOMAIN_INGRESS_ACTIONS,
  PHASE_2_MANAGE_STACK_ACTIONS,
  PHASE_2_PASS_ROLE_ACTION,
  RAW_LOGS_GUARANTEE,
  REQUEST_TAG_CONDITION,
  RESOURCE_TAG_CONDITION,
  REVOKE_STEPS,
  TAG_BOUNDARY_KEY,
} from '@/lib/security-details';

export const metadata: Metadata = {
  title: 'Security details · Deployz',
  robots: { index: false, follow: false },
};

// PHASE_2_DOMAIN_INGRESS_ACTIONS mixes read-only ELB `Describe*` lookups
// (which AWS does not allow scoping by tag) with tag-scoped listener writes.
// Split for disclosure so each group can be labeled with its actual
// condition — mirrors the split bootstrap-stack.ts makes when building the
// two IAM statements.
const domainIngressReadActions = PHASE_2_DOMAIN_INGRESS_ACTIONS.filter((action) =>
  action.startsWith('elasticloadbalancing:Describe'),
);
const domainIngressWriteActions = PHASE_2_DOMAIN_INGRESS_ACTIONS.filter(
  (action) => !action.startsWith('elasticloadbalancing:Describe'),
);

function ActionList({ actions }: { actions: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {actions.map((action) => (
        <li key={action}>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{action}</code>
        </li>
      ))}
    </ul>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

// §45 Security Details — the HONEST trust story. The top level is §65
// jargon-free; every exact permission name lives inside expandable technical
// detail rendered from @/lib/security-details (locked against the actual
// bootstrap template by apps/web/test/security-details.test.ts). We
// deliberately do NOT claim "tightly scoped" permissions: phase 2 is
// substantial, and the page says so.
export default async function SecurityDetailsPage({
  params,
}: {
  params: Promise<{ installLinkId: string }>;
}) {
  const { installLinkId } = await params;
  // Resolve the link first: this page used to render the full security story
  // for any id at all, including ones the parent route had already told the
  // reader were invalid.
  const data = await fetchInstallData(installLinkId);

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn&apos;t valid</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This installation link doesn&apos;t match an active deployment. Contact whoever sent you
          this link for a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security details</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The plain-English version first. The exact technical permissions are at the bottom —
          expand any section to see them, exactly as they appear in what you deploy.
        </p>
      </div>

      <section aria-labelledby="resources-created" className="flex flex-col gap-3">
        <h2 id="resources-created" className="text-base font-semibold">
          Exact AWS resources created
        </h2>
        <p className="text-sm text-muted-foreground">
          This is the complete resource list — not permission names, the actual things provisioned
          in your account:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {AWS_RESOURCES_CREATED.map((resource) => (
            <li key={resource}>{resource}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="architecture" className="flex flex-col gap-3">
        <h2 id="architecture" className="text-base font-semibold">
          How it fits together
        </h2>
        <ArchitectureDiagram />
      </section>

      <section aria-labelledby="can-do" className="flex flex-col gap-3">
        <h2 id="can-do" className="text-base font-semibold">
          What the relay can do
        </h2>
        <ul className="flex list-disc flex-col gap-3 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="font-medium text-foreground">At install time: almost nothing.</strong>{' '}
            It can write its own activity log, and it can read and refresh its own access key.
            That&apos;s the complete list.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              After it checks in with Deployz: set up and maintain your app.
            </strong>{' '}
            It can create, update, and remove the resources that make up your application — but
            only resources tagged as belonging to your installation. Everything else in your
            account stays off-limits.
          </li>
        </ul>
      </section>

      <section aria-labelledby="cant-do" className="flex flex-col gap-3">
        <h2 id="cant-do" className="text-base font-semibold">
          What the relay can never do
        </h2>
        <ul className="flex list-disc flex-col gap-3 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="font-medium text-foreground">Reach into your account.</strong> The
            relay only calls out to Deployz. Nothing — including Deployz — can connect inward.
          </li>
          <li>
            <strong className="font-medium text-foreground">Read your logs.</strong> It can write
            its own activity log, but it has no permission to read any logs back — yours or its
            own.
          </li>
          <li>
            <strong className="font-medium text-foreground">Grow its own permissions.</strong> A
            ceiling is fixed at install time. Even after check-in, the relay can never exceed what
            you see on this page.
          </li>
          <li>
            <strong className="font-medium text-foreground">Act as anyone else.</strong> The relay
            acts only as itself — it never takes over other identities in your account, and it
            never touches another customer&apos;s account.
          </li>
          <li>
            <strong className="font-medium text-foreground">Hold your credentials.</strong> Deployz
            never asks for or stores your AWS password, access keys, or account credentials.
          </li>
        </ul>
      </section>

      <section aria-labelledby="honest-version" className="flex flex-col gap-3">
        <h2 id="honest-version" className="text-base font-semibold">
          The honest version
        </h2>
        <p className="text-sm text-muted-foreground">
          We won&apos;t claim these permissions are tiny. After check-in, the relay holds
          substantial permissions — enough to install and update your app without asking you to
          click through setup screens. What keeps that safe is the boundary: every action is
          limited to resources carrying your installation&apos;s tag, the ceiling fixed at install
          time caps it forever, and the relay can never read your data back.
        </p>
      </section>

      <section aria-labelledby="data-sent" className="flex flex-col gap-3">
        <h2 id="data-sent" className="text-base font-semibold">
          Data sent to Deployz
        </h2>
        <p className="text-sm text-muted-foreground">
          Only operational metadata about the deployment — never your application data:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {DATA_SENT_TO_DEPLOYZ.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="data-not-sent" className="flex flex-col gap-3">
        <h2 id="data-not-sent" className="text-base font-semibold">
          Data not sent to Deployz
        </h2>
        <p className="text-sm text-muted-foreground">These stay inside your AWS account:</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {DATA_NOT_SENT_TO_DEPLOYZ.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{RAW_LOGS_GUARANTEE}</p>
      </section>

      <section aria-labelledby="revoke" className="flex flex-col gap-3">
        <h2 id="revoke" className="text-base font-semibold">
          How to revoke Deployz
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
          {REVOKE_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="deletion" className="flex flex-col gap-3">
        <h2 id="deletion" className="text-base font-semibold">
          How deletion works
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
          {DELETION_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="technical-detail" className="flex flex-col gap-3">
        <h2 id="technical-detail" className="text-base font-semibold">
          Technical detail
        </h2>
        <p className="text-sm text-muted-foreground">
          Expand a section to see the exact permissions, exactly as they appear in the template
          you deploy.
        </p>

        <div className="flex flex-col gap-3">
          <DetailSection title="Phase 1 — granted at install time">
            <p>Write its own activity log:</p>
            <ActionList actions={PHASE_1_LOG_WRITE_ACTIONS} />
            <p>Read and refresh its own access key (scoped to that one secret, nothing else):</p>
            <ActionList actions={PHASE_1_SECRET_ACTIONS} />
          </DetailSection>

          <DetailSection title="Phase 2 — granted only after the relay's first check-in">
            <p>
              Create and update your app&apos;s resources — only when the request carries your
              installation tag (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{REQUEST_TAG_CONDITION}</code>):
            </p>
            <ActionList actions={PHASE_2_CREATE_STACK_ACTIONS} />
            <p>
              Manage and remove them — only on resources already carrying your tag (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{RESOURCE_TAG_CONDITION}</code>):
            </p>
            <ActionList actions={PHASE_2_MANAGE_STACK_ACTIONS} />
            <p>Reconcile your app&apos;s running resources — same tag boundary:</p>
            <ActionList actions={PHASE_2_APP_RESOURCE_ACTIONS} />
            <p>
              Request the TLS certificate for a custom domain you configure — only when the
              request carries your installation tag (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{REQUEST_TAG_CONDITION}</code>):
            </p>
            <ActionList actions={PHASE_2_ACM_REQUEST_ACTIONS} />
            <p>
              Look up and remove that certificate — only on a certificate already carrying your
              tag (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{RESOURCE_TAG_CONDITION}</code>):
            </p>
            <ActionList actions={PHASE_2_ACM_MANAGE_ACTIONS} />
            <p>
              Read your load balancer&apos;s listeners, certificates, tags, and routing rules —
              these are read-only lookups that AWS does not let us restrict by tag, so they are
              not limited to your installation:
            </p>
            <ActionList actions={domainIngressReadActions} />
            <p>
              Attach that certificate to your load balancer and manage the HTTPS listener it
              serves — only on load-balancer resources already carrying your tag (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{RESOURCE_TAG_CONDITION}</code>):
            </p>
            <ActionList actions={domainIngressWriteActions} />
            <p>
              Hand your app&apos;s own service role to the deployment service — limited to{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{PASS_ROLE_RESOURCE_ARN}</code>{' '}
              and only to{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{PASSED_TO_SERVICE}</code>:
            </p>
            <ActionList actions={[PHASE_2_PASS_ROLE_ACTION]} />
          </DetailSection>

          <DetailSection title="Explicitly not granted — anywhere">
            <p>
              These permissions appear nowhere in what you deploy. The relay writes its own
              activity log; it can never read any logs back:
            </p>
            <ActionList actions={DENIED_LOG_READ_ACTIONS} />
            <p>
              The install-time ceiling (a permissions boundary) is the union of phases 1 and 2 —
              the relay&apos;s permissions can never grow beyond this page. Every phase-2 action
              is constrained by the <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{TAG_BOUNDARY_KEY}</code>{' '}
              tag boundary.
            </p>
          </DetailSection>
        </div>
      </section>

      <section aria-label="Back to install" className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button asChild variant="ghost" size="lg">
          <Link href={`/install/${encodeURIComponent(installLinkId)}`}>Back to install</Link>
        </Button>
      </section>
    </div>
  );
}
