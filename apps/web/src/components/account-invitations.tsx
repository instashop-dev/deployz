'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiRequest, errorMessage } from '@/lib/api-client';
import type { PendingInvitation } from '@/lib/me';

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// The signed-in user's own pending invitations, across every organization —
// shown on the profile page so accepting one doesn't require the email link.
export function AccountInvitations({ invitations }: { invitations: PendingInvitation[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<{ id: string; action: 'accept' | 'reject' } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function respond(id: string, action: 'accept' | 'reject'): Promise<void> {
    setPending({ id, action });
    setErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      await apiRequest(`/api/invitations/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      router.refresh();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [id]: errorMessage(err) }));
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
        <CardDescription>Organizations that have invited you to join.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {invitations.map((invitation) => (
          <div
            key={invitation.id}
            className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{invitation.organizationName}</p>
                <p className="text-xs text-muted-foreground">
                  Invited as {capitalize(invitation.role)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  data-testid="invitation-accept"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => respond(invitation.id, 'accept')}
                >
                  {pending?.id === invitation.id && pending.action === 'accept'
                    ? 'Accepting…'
                    : 'Accept'}
                </Button>
                <Button
                  data-testid="invitation-decline"
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => respond(invitation.id, 'reject')}
                >
                  {pending?.id === invitation.id && pending.action === 'reject'
                    ? 'Declining…'
                    : 'Decline'}
                </Button>
              </div>
            </div>
            {errors[invitation.id] ? (
              <p role="alert" className="text-sm text-destructive">
                {errors[invitation.id]}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
