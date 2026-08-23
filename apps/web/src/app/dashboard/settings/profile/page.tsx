import { redirect } from 'next/navigation';

import { AccountInvitations } from '@/components/account-invitations';
import { DeleteAccount } from '@/components/delete-account';
import { PasswordForm } from '@/components/password-form';
import { ProfileForm } from '@/components/profile-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchMe, fetchMyInvitations } from '@/lib/me';

// Account screen: display name (editable), sign-in email (read-only),
// password change, pending invitations addressed to this user, and account
// deletion. The dashboard layout already gates this route, but this page
// still needs `me` narrowed to non-null to read the user fields.
export default async function ProfilePage() {
  const me = await fetchMe();
  if (!me) {
    redirect('/sign-in');
  }
  const invitations = await fetchMyInvitations();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your account details.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your name and sign-in email.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Email</p>
            <p className="text-sm text-muted-foreground">{me.user.email}</p>
            <p className="text-xs text-muted-foreground">
              This is the address you sign in with. It cannot be changed here.
            </p>
          </div>
          <ProfileForm name={me.user.name} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Change your password. This signs you out of every other session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm />
        </CardContent>
      </Card>

      {invitations.length > 0 ? <AccountInvitations invitations={invitations} /> : null}

      <DeleteAccount email={me.user.email} />
    </div>
  );
}
