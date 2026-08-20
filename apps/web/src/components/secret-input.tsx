'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// Write-only secret field (§31): never pre-populated with an existing secret
// — the user types a NEW value, never sees the old one. Password-type with a
// show/hide toggle so the vendor can verify what they just typed.
export function SecretInput({ className, ...props }: ComponentProps<'input'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={cn('relative', className)}>
      <Input
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        className="pr-9"
        {...props}
      />
      <button
        type="button"
        aria-label={visible ? 'Hide value' : 'Show value'}
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? (
          <EyeOff aria-hidden className="size-4" />
        ) : (
          <Eye aria-hidden className="size-4" />
        )}
      </button>
    </div>
  );
}
