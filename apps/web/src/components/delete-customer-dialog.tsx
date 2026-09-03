'use client';

import { useState } from 'react';
import { toast } from 'sonner';

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
import { errorMessage } from '@/lib/api-client';
import { deleteCustomer, type Customer } from '@/lib/customers';

// Delete customer — the record only.
//
// The API refuses any customer that has a deployment, so this can never reach
// a customer's AWS account; the menu only offers it for customers with none.
// The confirmation states that consequence instead of asking "Are you sure?".
export function DeleteCustomerDialog({
  customer,
  open,
  onOpenChange,
  onDeleted,
}: {
  customer: Customer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (customerId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await deleteCustomer(customer.id);
      onDeleted(customer.id);
      toast.success(`${customer.name} removed.`);
      onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-testid="delete-customer-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive">
            Remove {customer.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This removes the customer record from Deployz. Nothing is removed from any AWS
            account, and this cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <p role="alert" data-testid="delete-customer-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              // The action closes the dialog by default; the request needs it
              // open until the API has answered.
              event.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Removing…' : 'Remove customer'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
