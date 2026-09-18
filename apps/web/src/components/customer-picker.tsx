'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NEW_CUSTOMER_VALUE, type Customer } from '@/lib/customers';
import { cn } from '@/lib/utils';

/**
 * The create-deployment form's customer picker: an existing customer, or the
 * "Create new customer" sentinel that keeps today's flow unchanged. A
 * searchable Combobox (Popover + Command) rather than a plain select — an
 * organization with many customers needs to type to find one.
 */
export function CustomerPicker({
  customers,
  value,
  onChange,
  disabled = false,
  loading = false,
}: {
  customers: Customer[];
  /** A customer id, or NEW_CUSTOMER_VALUE. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** True while the customer list is still loading — shows a loading label
   *  instead of disabling the field with no explanation. */
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = customers.find((customer) => customer.id === value) ?? null;
  const triggerLabel = loading ? 'Loading customers…' : (selected?.name ?? 'Create new customer');

  function select(nextValue: string): void {
    onChange(nextValue);
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="customer-picker-trigger">Customer</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="customer-picker-trigger"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || loading}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
          <Command>
            <CommandInput placeholder="Search customers…" />
            <CommandList>
              <CommandEmpty>No customers found.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="Create new customer" onSelect={() => select(NEW_CUSTOMER_VALUE)}>
                  <Check
                    aria-hidden
                    className={cn('size-4', value === NEW_CUSTOMER_VALUE ? 'opacity-100' : 'opacity-0')}
                  />
                  Create new customer
                </CommandItem>
                {customers.map((customer) => (
                  <CommandItem
                    key={customer.id}
                    value={`${customer.name} ${customer.email}`}
                    onSelect={() => select(customer.id)}
                  >
                    <Check
                      aria-hidden
                      className={cn('size-4', value === customer.id ? 'opacity-100' : 'opacity-0')}
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{customer.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{customer.email}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
