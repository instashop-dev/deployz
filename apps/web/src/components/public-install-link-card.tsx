'use client';

import { Copy, ExternalLink, Link2, MoreHorizontal, RotateCcw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import type { InstallLinkPresentation, InstallLinkStatus } from '@/lib/application-state';
import {
  createPublicInstallLink,
  publicInstallHtmlSnippet,
  regeneratePublicInstallLink,
  revokePublicInstallLink,
  setPublicInstallLinkEnabled,
  type PublicInstallLinkView,
} from '@/lib/public-install-links';

type Pending = 'idle' | 'creating' | 'enabling' | 'disabling' | 'regenerating' | 'revoking';

const STATUS_BADGE: Record<InstallLinkStatus, { label: string; variant: 'success' | 'secondary' | 'warning' }> = {
  active: { label: 'Active', variant: 'success' },
  disabled: { label: 'Disabled', variant: 'secondary' },
  unknown: { label: 'Needs review', variant: 'warning' },
};

async function copyText(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch {
    toast.error('We could not copy the text. Copy it by hand.');
  }
}

interface InstallLinkControlsProps {
  applicationId: string;
  installLink: InstallLinkPresentation;
  /** Re-fetch the application page so the caller's `installLink` prop reflects
   *  the mutation. This component never fetches on its own. */
  onChanged: () => Promise<void>;
  /** True when the controls are the primary action of their card. */
  primary?: boolean;
}

/**
 * The inline install-link control row. Renders purely from `installLink` —
 * no link is ever created, disabled, regenerated or revoked without an
 * explicit click here.
 */
export function InstallLinkControls({ applicationId, installLink, onChanged, primary = false }: InstallLinkControlsProps) {
  const [pending, setPending] = useState<Pending>('idle');
  const [error, setError] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const isPending = pending !== 'idle';

  async function handleCreate(): Promise<void> {
    setPending('creating');
    setError(null);
    try {
      const created = await createPublicInstallLink(applicationId);
      setSnippets((prev) => ({ ...prev, [created.id]: created.htmlSnippet }));
      await onChanged();
      toast.success('Public install link created.');
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.code === 'PUBLIC_INSTALL_LINK_EXISTS') {
          setError('A live public install link already exists for this application.');
          await onChanged();
        } else if (cause.code === 'UNAUTHORIZED') {
          setError('You are signed out. Sign in again to continue.');
        } else {
          setError(errorMessage(cause));
        }
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setPending('idle');
    }
  }

  async function handleToggle(link: PublicInstallLinkView, enabled: boolean): Promise<void> {
    setPending(enabled ? 'enabling' : 'disabling');
    setError(null);
    try {
      await setPublicInstallLinkEnabled(link.id, enabled);
      await onChanged();
      toast.success(enabled ? 'Public install link enabled.' : 'Public install link disabled.');
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.code === 'PUBLIC_INSTALL_LINK_REVOKED') {
          setError('This installation link has been revoked and cannot be enabled again.');
        } else if (cause.code === 'UNAUTHORIZED') {
          setError('You are signed out. Sign in again to continue.');
        } else {
          setError(errorMessage(cause));
        }
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setPending('idle');
    }
  }

  async function handleRegenerate(link: PublicInstallLinkView): Promise<void> {
    setPending('regenerating');
    setError(null);
    try {
      const created = await regeneratePublicInstallLink(link.id);
      setSnippets((prev) => ({ ...prev, [created.id]: created.htmlSnippet }));
      await onChanged();
      toast.success('Public install link regenerated.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending('idle');
      setRegenerateOpen(false);
    }
  }

  async function handleRevoke(link: PublicInstallLinkView): Promise<void> {
    setPending('revoking');
    setError(null);
    try {
      await revokePublicInstallLink(link.id);
      await onChanged();
      toast.success('Public install link revoked.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending('idle');
      setRevokeOpen(false);
    }
  }

  if (installLink.kind === 'hidden') {
    // The caller only renders these controls when there is something to say
    // (`installLinkPlacement !== 'none'`); this case exists for type safety.
    return null;
  }

  if (installLink.kind === 'loading') {
    return <Skeleton className="h-8 w-full max-w-64" data-testid="public-install-link-loading" />;
  }

  if (installLink.kind === 'error') {
    return (
      <Alert variant="destructive" data-testid="public-install-link-error" className="w-full">
        <AlertDescription role="alert">{installLink.message}</AlertDescription>
      </Alert>
    );
  }

  if (installLink.kind === 'unavailable') {
    return <p className="text-sm text-muted-foreground">{installLink.reason}</p>;
  }

  if (installLink.kind === 'create') {
    return (
      <div className="flex flex-col items-start gap-2">
        {error ? (
          <Alert variant="destructive" data-testid="public-install-link-error">
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        ) : null}
        {installLink.note ? <p className="text-sm text-muted-foreground">{installLink.note}</p> : null}
        <Button
          size="sm"
          onClick={() => void handleCreate()}
          loading={pending === 'creating'}
          loadingText="Creating install link…"
          data-testid="public-install-link-create"
        >
          <Link2 aria-hidden />
          Create install link
        </Button>
      </div>
    );
  }

  const { link, status, warning } = installLink;
  const badge = STATUS_BADGE[status];
  const snippet = snippets[link.id] ?? publicInstallHtmlSnippet(link.url);

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <Alert variant="destructive" data-testid="public-install-link-error">
          <AlertDescription role="alert">{error}</AlertDescription>
        </Alert>
      ) : null}
      {warning ? (
        <Alert data-testid="public-install-link-warning">
          <TriangleAlert aria-hidden />
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant} data-testid="public-install-link-status">
          {badge.label}
        </Badge>
        <Button
          size="sm"
          variant={primary ? 'default' : 'outline'}
          disabled={status === 'disabled'}
          onClick={() => void copyText(link.url, 'Public install link copied.')}
          data-testid="public-install-link-copy-url"
        >
          <Copy aria-hidden />
          Copy link
        </Button>
        <Button size="sm" variant="outline" asChild data-testid="public-install-link-preview">
          <a href={link.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            Preview
          </a>
        </Button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="More install link actions"
              data-testid="public-install-link-menu"
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => void copyText(snippet, 'HTML snippet copied.')}
              data-testid="public-install-link-copy-snippet"
            >
              Copy HTML
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isPending}
              onClick={() => void handleToggle(link, status !== 'active')}
              data-testid="public-install-link-toggle"
            >
              {status === 'active' ? 'Disable' : 'Enable'}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isPending}
              onClick={() => {
                setMenuOpen(false);
                setRegenerateOpen(true);
              }}
              data-testid="public-install-link-regenerate"
            >
              <RotateCcw aria-hidden />
              Regenerate
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={isPending}
              onClick={() => {
                setMenuOpen(false);
                setRevokeOpen(true);
              }}
              data-testid="public-install-link-revoke"
            >
              Revoke
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={regenerateOpen} onOpenChange={(open) => !isPending && setRegenerateOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate this public install link?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a new public installation link. The old link stops working immediately.
              Customers using the old link must use the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending} onClick={() => setRegenerateOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              loading={pending === 'regenerating'}
              loadingText="Regenerating public install link…"
              disabled={isPending}
              onClick={(event) => {
                // Keep the dialog open until the request settles so the
                // action's loading state is visible; Radix closes on click
                // by default.
                event.preventDefault();
                void handleRegenerate(link);
              }}
              data-testid="public-install-link-regenerate-confirm"
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={(open) => !isPending && setRevokeOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this public install link?</AlertDialogTitle>
            <AlertDialogDescription>
              This link will stop working. Customers who open it see a message that the link is no longer valid.
              You can create a new link at any time. No AWS resources are destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending} onClick={() => setRevokeOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              loading={pending === 'revoking'}
              loadingText="Revoking public install link…"
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleRevoke(link);
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

interface PublicInstallLinkCardProps {
  applicationId: string;
  installLink: InstallLinkPresentation;
  onChanged: () => Promise<void>;
}

/** Compact card wrapping `InstallLinkControls`, for the surfaces where the
 *  link is not the page's next action (placement `'card'`). */
export function PublicInstallLinkCard({ applicationId, installLink, onChanged }: PublicInstallLinkCardProps) {
  return (
    <Card data-testid="public-install-link-card">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="shrink-0 text-sm font-medium">Customer install link</p>
        <InstallLinkControls applicationId={applicationId} installLink={installLink} onChanged={onChanged} />
      </CardContent>
    </Card>
  );
}
