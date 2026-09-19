import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The canonical table container for non-Card contexts (public install/deploy
 * pages and any surface where a full Card wrapper does not fit). Provides the
 * same rounded border and horizontal scrolling the compact Card recipe gives
 * dashboard tables — a wrapper, not a data-grid. Render the shadcn `Table`
 * primitives inside.
 */
export function TablePanel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('overflow-x-auto rounded-md border', className)} {...props} />;
}
