// Single source of truth for the control-plane API origin.
//
// The two exports are not interchangeable, and the difference is *when* they
// resolve, not just which variable they read:
//
//  - `apiUrl` is BUILD-time. `process.env.NEXT_PUBLIC_API_URL` has to stay a
//    literal member expression here, because the bundler substitutes it
//    textually while building the client bundle. A container environment
//    variable CANNOT change it — a new value needs a new image.
//
//  - `serverApiUrl()` is RUN-time, and is a function on purpose: a top-level
//    const would be read during `next build`, where API_URL is unset, and
//    baked into any statically prerendered output.

const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** The API origin the BROWSER uses. Safe in client components. */
export const apiUrl = PUBLIC_API_URL;

/**
 * The API origin a server component or route handler uses. Server only.
 * Falls back to the browser origin, which is the right answer whenever the
 * two are the same host.
 */
export function serverApiUrl(): string {
  return process.env.API_URL ?? PUBLIC_API_URL;
}
