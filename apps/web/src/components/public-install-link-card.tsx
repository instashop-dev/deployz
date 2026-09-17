'use client';

import { Copy, ExternalLink, Link2, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  type PublicInstallLinkView,
  createPublicInstallLink,
  fetchPublicInstallLinks,
  publicInstallHtmlSnippet,
  publicInstallLinkStatusBadge,
  regeneratePublicInstallLink,
  revokePublicInstallLink,
  setPublicInstallLinkEnabled,
} from '@/lib/public-install-links';
import { ApiRequestError, errorMessage } from '@/lib/api-client';

import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch, SwitchThumb } from '@/components/ui/switch';

type Pending =
  | 'idle'
  | 'creating'
  | 'enabling'
  | 'disabling'
  | 'regenerating'
  | 'revoking';

async function copyText(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch {
    toast.error('We could not copy the text. Copy it by hand.');
  }
}

interface PublicInstallLinkCardProps {
  applicationId: string;
}

export function PublicInstallLinkCard({
  applicationId,
}: PublicInstallLinkCardProps) {
  const [links, setLinks] = useState<PublicInstallLinkView[] | null>(null);
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending>('idle');
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const next = await fetchPublicInstallLinks(applicationId);
    setLinks(next);
  }

  useEffect(() => {
    let cancelled = false;
    setLinks(null);
    setError(null);
    fetchPublicInstallLinks(applicationId)
      .then((next) => {
        if (!cancelled) setLinks(next);
      })
      .catch(() => {
        if (!cancelled) {
          setLinks([]);
          setError('We could not load the public install link. Try again in a moment.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  function handleCreate(): void {
    setPending('creating');
    setError(null);
    createPublicInstallLink(applicationId)
      .then((created) => {
        setSnippets((prev) => ({ ...prev, [created.id]: created.htmlSnippet }));
        return refresh();
      })
      .then(() => {
        toast.success('Public install link created.');
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiRequestError) {
          if (cause.code === 'RELEASE_NOT_PUBLISHED') {
            setError('This application has no published release. Publish a release before you create a public install link.');
            return;
          }
          if (cause.code === 'PUBLIC_INSTALL_LINK_EXISTS') {
            setError('A live public install link already exists for this application.');
            void refresh();
            return;
          }
          if (cause.code === 'UNAUTHORIZED') {
            setError('You are signed out. Sign in again to continue.');
            return;
          }
        }
        setError(errorMessage(cause));
      })
      .finally(() => setPending('idle'));
  }

  function handleToggle(linkId: string, enabled: boolean): void {
    setPending(enabled ? 'enabling' : 'disabling');
    setError(null);
    setPublicInstallLinkEnabled(linkId, enabled)
      .then(() => refresh())
      .then(() => {
        toast.success(enabled ? 'Public install link enabled.' : 'Public install link disabled.');
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiRequestError) {
          if (cause.code === 'PUBLIC_INSTALL_LINK_REVOKED') {
            setError('This installation link has been revoked and cannot be enabled again.');
            return;
          }
          if (cause.code === 'UNAUTHORIZED') {
            setError('You are signed out. Sign in again to continue.');
            return;
          }
        }
        setError(errorMessage(cause));
      })
      .finally(() => setPending('idle'));
  }

  function handleRevoke(linkId: string): Promise<void> {
    setPending('revoking');
    setError(null);
    return revokePublicInstallLink(linkId)
      .then(() => refresh())
      .then(() => {
        toast.success('Public install link revoked.');
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
      })
      .finally(() => setPending('idle'));
  }

  function handleRegenerate(linkId: string): Promise<void> {
    setPending('regenerating');
    setError(null);
    return regeneratePublicInstallLink(linkId)
      .then((created) => {
        setSnippets((prev) => ({ ...prev, [created.id]: created.htmlSnippet }));
        return refresh();
      })
      .then(() => {
        toast.success('Public install link regenerated.');
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
      })
      .finally(() => setPending('idle'));
  }

  if (links === null) {
    return (
      <Card data-testid="public-install-link-card">
        <CardHeader>
          <CardTitle className="text-base">Deploy to AWS</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3" data-testid="public-install-link-loading" aria-busy="true">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  const liveLink = links.find((link) => link.status !== 'revoked') ?? null;

  return (
    <Card data-testid="public-install-link-card">
      <CardHeader>
        <CardTitle className="text-base">Deploy to AWS</CardTitle>
        <CardDescription>
          Publish a public installation link. Anyone with the link can review the
          offer and install the application into their own AWS account.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive" data-testid="public-install-link-error">
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        ) : null}
        {liveLink ? (
          <PublicInstallLinkActive
            link={liveLink}
            snippet={snippets[liveLink.id] ?? publicInstallHtmlSnippet(liveLink.url)}
            pending={pending}
            onToggle={(enabled) => handleToggle(liveLink.id, enabled)}
            onRevoke={() => handleRevoke(liveLink.id)}
            onRegenerate={() => handleRegenerate(liveLink.id)}
          />
        ) : (
          <PublicInstallLinkEmpty
            pending={pending}
            onCreate={handleCreate}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PublicInstallLinkEmpty({
  pending,
  onCreate,
}: {
  pending: Pending;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3" data-testid="public-install-link-empty">
      <p className="text-sm text-muted-foreground">
        Create a public installation link to let customers install this application from a shared URL.
      </p>
      <Button
        size="sm"
        onClick={onCreate}
        loading={pending === 'creating'}
        loadingText="Creating public install link…"
        data-testid="public-install-link-create"
      >
        <Link2 aria-hidden />
        Create public install link
      </Button>
    </div>
  );
}

function PublicInstallLinkActive({
  link,
  snippet,
  pending,
  onToggle,
  onRevoke,
  onRegenerate,
}: {
  link: PublicInstallLinkView;
  snippet: string;
  pending: Pending;
  onToggle: (enabled: boolean) => void;
  onRevoke: () => Promise<void>;
  onRegenerate: () => Promise<void>;
}) {
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const badge = publicInstallLinkStatusBadge(link.status);
  const isPending = pending !== 'idle';

  return (
    <div className="flex flex-col gap-4" data-testid="public-install-link-active">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant} data-testid="public-install-link-status">
          {badge.label}
        </Badge>
        <span className="text-sm text-muted-foreground" data-testid="public-install-link-created-at">
          Created {new Date(link.createdAt).toLocaleDateString()}
        </span>
      </div>

      <code
        className="block truncate rounded-lg border bg-muted px-3 py-2 font-mono text-xs"
        data-testid="public-install-link-url"
      >
        {link.url}
      </code>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void copyText(link.url, 'Public install link copied.')}
          data-testid="public-install-link-copy-url"
        >
          <Copy aria-hidden />
          Copy direct link
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void copyText(snippet, 'HTML snippet copied.')}
          data-testid="public-install-link-copy-snippet"
        >
          <Copy aria-hidden />
          Copy HTML snippet
        </Button>
        <Button
          size="sm"
          variant="outline"
          asChild
          data-testid="public-install-link-preview"
        >
          <a href={link.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            Preview
          </a>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Switch
          id="public-install-link-switch"
          checked={link.status === 'active'}
          onCheckedChange={onToggle}
          disabled={isPending}
          aria-label={link.status === 'active' ? 'Disable public install link' : 'Enable public install link'}
          data-testid="public-install-link-switch"
        >
          <SwitchThumb />
        </Switch>
        <label
          htmlFor="public-install-link-switch"
          className="text-sm text-muted-foreground"
        >
          {link.status === 'active' ? 'Enabled' : 'Disabled'}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => setRegenerateDialogOpen(true)}
          data-testid="public-install-link-regenerate"
        >
          <RotateCcw aria-hidden />
          Regenerate
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={isPending}
          onClick={() => setRevokeDialogOpen(true)}
          data-testid="public-install-link-revoke"
        >
          Revoke
        </Button>
      </div>

      <AlertDialog
        open={regenerateDialogOpen}
        onOpenChange={(open) => !isPending && setRegenerateDialogOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate this public install link?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a new public installation link. The old link stops working immediately.
              Customers using the old link must use the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isPending}
              onClick={() => setRegenerateDialogOpen(false)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              loading={pending === 'regenerating'}
              loadingText="Regenerating public install link…"
              disabled={isPending}
              onClick={(event) => {
                // Keep the dialog open until the request settles so the
                // action's loading state is visible; Radix closes on click
                // by default.
                event.preventDefault();
                void onRegenerate().finally(() => setRegenerateDialogOpen(false));
              }}
              data-testid="public-install-link-regenerate-confirm"
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={revokeDialogOpen}
        onOpenChange={(open) => !isPending && setRevokeDialogOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this public install link?</AlertDialogTitle>
            <AlertDialogDescription>
              This link will stop working. Customers who open it see a message that the link is no longer valid.
              You can create a new link at any time. No AWS resources are destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isPending}
              onClick={() => setRevokeDialogOpen(false)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              loading={pending === 'revoking'}
              loadingText="Revoking public install link…"
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault();
                void onRevoke().finally(() => setRevokeDialogOpen(false));
              }}
              data-testid="public-install-link-revoke-confirm"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

