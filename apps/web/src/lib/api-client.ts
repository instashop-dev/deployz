// Browser-side calls to the control-plane API. Every mutation in the
// dashboard goes through here so the session cookie, the JSON headers and the
// error envelope ({ error: { code, message } }) are handled once.

import { apiUrl } from '@/lib/api-url';

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The envelope's structured `details` (readiness findings, validation issues), when the server sent any. */
    readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    ...(init.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiRequestError(
      envelope?.error?.code ?? 'REQUEST_FAILED',
      envelope?.error?.message ?? 'Something went wrong. Try again in a moment.',
      envelope?.error?.details,
    );
  }
  return payload as T;
}

/** The message to show a person. Server messages are already jargon-free
 *  (§65), so they are used as-is; anything else falls back to plain copy. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : 'Something went wrong. Try again in a moment.';
}
