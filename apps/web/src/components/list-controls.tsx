'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { SortDirection } from '@/lib/list-view';

// Controls the Customers and Deployments lists share. Each is a thin
// composition of shadcn primitives; what they add is behaviour both lists need
// to get identical (debounced URL-backed search, accessible sortable headers,
// the "filters matched nothing" state).

const SEARCH_DEBOUNCE_MS = 250;

/**
 * A search box whose value lives in the URL. Typing updates the field at once
 * and writes to the URL after a short pause, so the list filters as you type
 * without a router round trip per keystroke. A change that did not come from
 * typing here (Clear filters, browser Back) replaces the text.
 */
export function ListSearchInput({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const latestCommit = useRef(onCommit);

  useEffect(() => {
    latestCommit.current = onCommit;
  });

  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      latestCommit.current(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-full pl-8 sm:w-64"
      />
    </div>
  );
}

/** A column header that sorts its table. `direction` is null when another
 *  column is the sort, so the header announces only the active one. */
export function SortableHead({
  label,
  direction,
  onSort,
  className,
}: {
  label: string;
  direction: SortDirection | null;
  onSort: () => void;
  className?: string;
}) {
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <TableHead
      className={className}
      aria-sort={
        direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined
      }
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onSort}
        className={cn('-ml-2.5 text-sm font-medium', direction !== null && 'text-foreground')}
      >
        {label}
        <Icon
          aria-hidden
          className={direction === null ? 'text-muted-foreground/60' : undefined}
        />
      </Button>
    </TableHead>
  );
}

/** Shown when filters or search leave nothing — never for a list that is
 *  genuinely empty, which each page words for itself. */
export function NoMatchesState({
  heading,
  onClear,
}: {
  heading: string;
  onClear: () => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-sm font-medium">
          {heading}
        </h2>
        <p className="text-sm text-muted-foreground">
          Try changing your search or clearing the filters.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </section>
  );
}

/** The list's first load: a toolbar and table the size of the real ones, so
 *  the page does not jump when data arrives. */
export function ListLoadingState({ testId }: { testId: string }) {
  return (
    <div className="flex flex-col gap-3" data-testid={testId} aria-busy="true">
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-full rounded-lg sm:w-64" />
        <Skeleton className="h-8 w-full rounded-lg sm:w-40" />
        <Skeleton className="h-8 w-full rounded-lg sm:w-40" />
      </div>
      <Card className="py-0">
        <CardContent className="flex flex-col divide-y p-0">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="hidden h-4 w-28 sm:block" />
              <Skeleton className="ml-auto h-5 w-24 rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
