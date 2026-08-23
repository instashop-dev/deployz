'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiRequest, errorMessage } from '@/lib/api-client';
import { ROLE_LABELS, type InvitationInfo } from '@/lib/organization-vocabulary';

function expiryLabel(invitation: InvitationInfo): string {
  if (invitation.expired) return 'Expired';
  const days = Math.max(
    0,
    Math.ceil((new Date(invitation.expiresAt).getTime() - Date.now()) / 86_400_000),
  );
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

// §41 screen 18 team management — pending invitations. Resend/revoke are
// owner/admin only; everyone else sees a read-only list.
export function PendingInvitations({
  invitations,
  canManage,
}: {
  invitations: InvitationInfo[];
  canManage: boolean;
}) {
  if (invitations.length === 0) {
    return <p className="text-sm text-muted-foreground">No pending invitations.</p>;
  }

  return (
    <div className="flex flex-col divide-y divide-border">
      {invitations.map((invitation) => (
        <InvitationRow key={invitation.id} invitation={invitation} canManage={canManage} />
      ))}
    </div>
  );
}

function InvitationRow({
  invitation,
  canManage,
}: {
  invitation: InvitationInfo;
  canManage: boolean;
}) {
  const router = useRouter();
  const [resendPending, setResendPending] = useState(false);
  const [revokeStep, setRevokeStep] = useState<'idle' | 'confirm'>('idle');
  const [revokePending, setRevokePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend(): Promise<void> {
    setResendPending(true);
    setError(null);
    try {
      await apiRequest(`/api/organization/invitations/${invitation.id}/resend`, { method: 'POST' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResendPending(false);
    }
  }

  async function handleRevoke(): Promise<void> {
    setRevokePending(true);
    setError(null);
    try {
      await apiRequest(`/api/organization/invitations/${invitation.id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setRevokePending(false);
      setRevokeStep('idle');
    }
  }

  return (
    <div data-testid="invitation-row" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{invitation.email}</span>
          <span className="text-xs text-muted-foreground">
            Invited by {invitation.invitedByName} · {expiryLabel(invitation)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{ROLE_LABELS[invitation.role]}</Badge>
          {canManage ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resendPending}
                onClick={handleResend}
                data-testid="invitation-resend"
              >
                {resendPending ? 'Resending…' : 'Resend'}
              </Button>
              {revokeStep === 'idle' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRevokeStep('confirm')}
                  data-testid="invitation-revoke"
                >
                  Revoke
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={revokePending}
                    onClick={handleRevoke}
                    data-testid="invitation-revoke-confirm"
                  >
                    {revokePending ? 'Revoking…' : 'Confirm'}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRevokeStep('idle')}>
                    Cancel
                  </Button>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
