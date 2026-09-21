'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * The URL as a list's view state. Search, filters and sort are client-side
 * over rows the page already holds, so a change rewrites the address with
 * `history.replaceState` — Next's app router observes it and updates
 * `useSearchParams` — rather than navigating, which would re-request the
 * server layout on every keystroke. Replacing the current history entry means
 * changes never pile up Back steps, and returning from a detail page lands on
 * the same view.
 *
 * The next URL is built from the address bar as it is at that moment, not from
 * the last render, so two changes in quick succession (a filter, then a sort)
 * both survive. A patch value of `null` or an empty string removes that
 * parameter.
 */
export function useListParams(): {
  params: URLSearchParams;
  setParams: (patch: Record<string, string | null>) => void;
} {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const paramString = searchParams.toString();
  const params = useMemo(() => new URLSearchParams(paramString), [paramString]);

  const setParams = useCallback(
    (patch: Record<string, string | null>): void => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      window.history.replaceState(null, '', query ? `${pathname}?${query}` : pathname);
    },
    [pathname],
  );

  return { params, setParams };
}
