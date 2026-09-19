import type { BadgeVariant } from '@/components/ui/badge';

/**
 * Semantic tone system for status badges and dots.
 *
 * This is the single source of truth for mapping product-language status
 * categories to a consistent visual treatment. Status text is always shown
 * alongside the tone so state is never communicated by color alone.
 */
export type Tone = 'positive' | 'attention' | 'negative' | 'progress' | 'neutral';

/** Maps each tone to the shadcn/ui Badge variant that renders it. */
export const TONE_BADGE: Record<Tone, BadgeVariant> = {
  positive: 'success',
  attention: 'warning',
  negative: 'destructive',
  progress: 'info',
  neutral: 'secondary',
};

/** Status dot background class for each tone. */
export const TONE_DOT: Record<Tone, string> = {
  positive: 'bg-emerald-500',
  attention: 'bg-amber-500',
  negative: 'bg-destructive',
  progress: 'bg-blue-500',
  neutral: 'bg-muted-foreground',
};

/** Status icon text color class for each tone. */
export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-emerald-600 dark:text-emerald-400',
  attention: 'text-amber-600 dark:text-amber-400',
  negative: 'text-destructive',
  progress: 'text-blue-600 dark:text-blue-400',
  neutral: 'text-muted-foreground',
};
