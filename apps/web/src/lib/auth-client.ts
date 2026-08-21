import { createAuthClient } from 'better-auth/react';

// The browser talks directly to the Fastify-hosted Better Auth instance.
// Cookies are host-scoped (localhost), so credentialed fetch is all the
// wiring the cross-port session needs.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  fetchOptions: { credentials: 'include' },
});
