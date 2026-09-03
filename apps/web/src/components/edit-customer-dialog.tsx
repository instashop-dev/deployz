'use client';

import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api-client';
import { updateCustomer, type Customer } from '@/lib/customers';

// Edit customer — contact metadata only.
//
// Name, email and company are the whole form on purpose. The customer id is
// what the customer's install link, deployment and configuration are anchored
// to, so saving here changes three text fields and nothing else: no install
// link is reissued, no deployment changes hands, nothing in the customer's
// AWS account is touched. The dialog says so, because "will this break their
// install?" is the first thing a vendor wonders before renaming a customer.
export function EditCustomerDialog({
  customer,
  open,
  onOpenChange,
  onSaved,
}: {
  customer: Customer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (customer: Customer) => void;
}) {
  const nameId = useId();
  const emailId = useId();
  const companyId = useId();
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.email);
  const [company, setCompany] = useState(customer.company ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening always shows what is stored now, not an abandoned edit.
  useEffect(() => {
    if (!open) return;
    setName(customer.name);
    setEmail(customer.email);
    setCompany(customer.company ?? '');
    setError(null);
  }, [open, customer]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await updateCustomer(customer.id, {
        name: name.trim(),
        email: email.trim(),
        company: company.trim() || null,
      });
      onSaved(saved);
      toast.success('Customer updated.');
      onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="edit-customer-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
          <DialogDescription>
            Contact details only. Their install link and deployment stay exactly as they are.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={companyId}>Company (optional)</Label>
            <Input
              id={companyId}
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              autoComplete="off"
            />
          </div>

          {error ? (
            <p role="alert" data-testid="edit-customer-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || name.trim() === '' || email.trim() === ''}>
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
