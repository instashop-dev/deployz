'use client';

import { Ban, Copy, Link2, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  deployLinkStatusBadge,
  deployLinkUrl,
  fetchDeployLinks,
  generateDeployLink,
  regenerateDeployLink,
  revokeDeployLink,
  type DeployLinkView,
} from '@/lib/deploy-links';
import { errorMessage } from '@/lib/api-client';
import { fetchApplications, type Application } from '@/lib/applications';
import { formatDate } from '@/lib/customers';
import { fetchRegions, type RegionOption } from '@/lib/regions';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

// The vendor side of Deploy Links: pick a customer, an application and a
// region, mint the tokenized link, copy it once. Everything the customer does
// with the link happens on the hosted /deploy page — this card never shows
// deployment internals.

type Pending = 'idle' | 'generating' | 'revoking' | 'regenerating';

/** The copy interaction is identical for every link surface. */
async function copyUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Deploy link copied.');
  } catch {
    toast.error("We couldn't copy the link. Select it and copy it by hand.");
  }
}

export function DeployLinkCard({ customerId }: { customerId: string }) {
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [regionsError, setRegionsError] = useState(false);
  const [links, setLinks] = useState<DeployLinkView[] | null>(null);
  const [revealed, setRevealed] = useState<{ linkId: string; url: string } | null>(null);
  const [pending, setPending] = useState<Pending>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setApplications(null);
    setLinks(null);
    async function run(): Promise<void> {
      try {
        const [apps, currentLinks] = await Promise.all([
          fetchApplications(),
          fetchDeployLinks(customerId),
        ]);
        if (!cancelled) {
          setApplications(apps);
          setLinks(currentLinks);
        }
      } catch {
        if (!cancelled) {
          setApplications([]);
          setLinks(null);
          setError("We couldn't load this card. Try again in a moment.");
        }
      }
    }
    async function runRegions(): Promise<void> {
      try {
        const options = await fetchRegions();
        if (!cancelled) setRegions(options);
      } catch {
        if (!cancelled) setRegionsError(true);
      }
    }
    void run();
    void runRegions();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  function onGenerate(input: { applicationId: string; region: string }): void {
    setPending('generating');
    setError(null);
    generateDeployLink(customerId, input)
      .then((result) => {
        setLinks((current) => [result.link, ...(current ?? [])]);
        setRevealed({
          linkId: result.link.id,
          url: deployLinkUrl(result.link.id, result.token, window.location.origin),
        });
        toast.success('Deploy link created. Copy it now — the secret is shown only once.');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending('idle'));
  }

  function onRevoke(linkId: string): void {
    setPending('revoking');
    setError(null);
    revokeDeployLink(linkId)
      .then(() => fetchDeployLinks(customerId))
      .then((current) => {
        setLinks(current);
        toast.success('Deploy link revoked.');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending('idle'));
  }

  function onRegenerate(linkId: string): void {
    setPending('regenerating');
    setError(null);
    regenerateDeployLink(linkId)
      .then((result) => {
        setLinks((current) =>
          (current ?? []).map((link) => (link.id === result.link.id ? result.link : link)),
        );
        setRevealed({
          linkId: result.link.id,
          url: deployLinkUrl(result.link.id, result.token, window.location.origin),
        });
        toast.success('New link ready. Copy it now — the secret is shown only once.');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending('idle'));
  }

  if (applications === null) {
    return (
      <Card data-testid="deploy-link-card">
        <CardHeader>
          <CardTitle className="text-base">Deploy to AWS</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3" data-testid="deploy-link-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="deploy-link-card">
      <CardHeader>
        <CardTitle className="text-base">Deploy to AWS</CardTitle>
        <CardDescription>
          Let this customer deploy an application into their own AWS account. They open the
          link, connect AWS, and start the deployment themselves.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive" data-testid="deploy-link-error">
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        ) : null}
        {applications.length === 0 ? (
          <div className="flex flex-col items-start gap-2" data-testid="deploy-link-empty">
            <p className="text-sm text-muted-foreground">
              Connect a GitHub repository as an application first — a deploy link always
              deploys one application.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/applications">Go to applications</Link>
            </Button>
          </div>
        ) : (
          <DeployLinkForm
            applications={applications}
            regions={regions}
            regionsError={regionsError}
            pending={pending}
            onGenerate={onGenerate}
          />
        )}
        {links === null ? null : <DeployLinkList links={links} revealed={revealed} pending={pending} onRevoke={onRevoke} onRegenerate={onRegenerate} />}
      </CardContent>
    </Card>
  );
}

function DeployLinkForm({
  applications,
  regions,
  regionsError,
  pending,
  onGenerate,
}: {
  applications: Application[];
  regions: RegionOption[];
  regionsError: boolean;
  pending: Pending;
  onGenerate: (input: { applicationId: string; region: string }) => void;
}) {
  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onGenerate({
      applicationId: String(form.get('application') ?? ''),
      region: String(form.get('region') ?? regions[0]?.value ?? ''),
    });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-testid="deploy-link-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deploy-link-application">Application</Label>
          <select
            id="deploy-link-application"
            name="application"
            className="rounded-lg border bg-transparent px-3 py-2 text-sm"
            defaultValue={applications[0]?.id}
            data-testid="deploy-link-application-select"
          >
            {applications.map((application) => (
              <option key={application.id} value={application.id}>
                {application.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deploy-link-region">AWS region</Label>
          {regionsError ? (
            <p className="text-sm text-muted-foreground">
              We couldn&apos;t load the available regions. Try again in a moment.
            </p>
          ) : (
            <select
              id="deploy-link-region"
              name="region"
              className="rounded-lg border bg-transparent px-3 py-2 text-sm"
              defaultValue={regions[0]?.value}
              data-testid="deploy-link-region-select"
            >
              {regions.map((region) => (
                <option key={region.value} value={region.value}>
                  {region.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={pending !== 'idle' || regionsError || regions.length === 0}
          data-testid="deploy-link-generate"
        >
          <Link2 aria-hidden />
          {pending === 'generating' ? 'Creating link…' : 'Generate deploy link'}
        </Button>
      </div>
    </form>
  );
}

/** Exported for the render tests: states are asserted through props. */
export function DeployLinkList({
  links,
  revealed,
  pending,
  onRevoke,
  onRegenerate,
}: {
  links: DeployLinkView[];
  revealed: { linkId: string; url: string } | null;
  pending: Pending;
  onRevoke: (linkId: string) => void;
  onRegenerate: (linkId: string) => void;
}) {
  const [revoking, setRevoking] = useState<DeployLinkView | null>(null);

  if (links.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border-t pt-4" data-testid="deploy-link-list">
      {links.map((link, index) => (
        <DeployLinkRow
          key={link.id}
          link={link}
          revealedUrl={revealed?.linkId === link.id ? revealed.url : null}
          expanded={index === 0}
          pending={pending}
          onRevoke={() => setRevoking(link)}
          onRegenerate={() => onRegenerate(link.id)}
        />
      ))}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this deploy link?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking?.applicationName ?? 'The application'} can no longer be deployed with
              this link. A customer who opens it sees a message that the link is no longer
              valid. You can generate a new link at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="deploy-link-revoke-confirm"
              onClick={() => {
                if (revoking) onRevoke(revoking.id);
                setRevoking(null);
              }}
            >
              Revoke link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DeployLinkRow({
  link,
  revealedUrl,
  expanded,
  pending,
  onRevoke,
  onRegenerate,
}: {
  link: DeployLinkView;
  revealedUrl: string | null;
  expanded: boolean;
  pending: Pending;
  onRevoke: () => void;
  onRegenerate: () => void;
}) {
  const badge = deployLinkStatusBadge(link.status);
  const canRegenerate = link.status === 'active' && link.deploymentState === 'NOT_INSTALLED';

  if (!expanded) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="deploy-link-row">
        <span className="font-medium">{link.applicationName ?? 'Application'}</span>
        <Badge variant={badge.variant} data-testid={`deploy-link-status-${link.status}`}>
          {badge.label}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Expires {formatDate(link.expiresAt)}
        </span>
        {canRegenerate ? (
          <Button size="sm" variant="ghost" disabled={pending !== 'idle'} onClick={onRegenerate}>
            <RotateCcw aria-hidden />
            Regenerate
          </Button>
        ) : null}
        {link.status === 'active' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== 'idle'}
            onClick={onRevoke}
            data-testid="deploy-link-revoke"
          >
            <Ban aria-hidden />
            Revoke
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="deploy-link-row">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant} data-testid={`deploy-link-status-${link.status}`}>
          {badge.label}
        </Badge>
        {link.applicationName ? (
          <span className="text-sm font-medium">{link.applicationName}</span>
        ) : null}
        {link.region ? <span className="text-xs text-muted-foreground">{link.region}</span> : null}
        <span className="text-xs text-muted-foreground">
          Expires {formatDate(link.expiresAt)}
        </span>
      </div>
      {revealedUrl ? (
        <>
          <code
            data-testid="deploy-link-url"
            className="block truncate rounded-lg border bg-muted px-3 py-2 font-mono text-xs"
          >
            {revealedUrl}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void copyUrl(revealedUrl)} data-testid="deploy-link-copy">
              <Copy aria-hidden />
              Copy link
            </Button>
            <p className="text-xs text-muted-foreground">
              The secret part of this link is shown only once.
            </p>
          </div>
        </>
      ) : link.status === 'active' ? (
        <p className="text-xs text-muted-foreground">
          The link was created earlier in another session. Generate a new one to get a
          copyable URL.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canRegenerate ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== 'idle'}
            onClick={onRegenerate}
            data-testid="deploy-link-regenerate"
          >
            <RotateCcw aria-hidden />
            {pending === 'regenerating' ? 'Creating new link…' : 'Regenerate'}
          </Button>
        ) : null}
        {link.status === 'active' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== 'idle'}
            onClick={onRevoke}
            data-testid="deploy-link-revoke"
          >
            <Ban aria-hidden />
            Revoke
          </Button>
        ) : null}
      </div>
    </div>
  );
}
