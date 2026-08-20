import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { UnauthorizedError } from './errors.js';

type SessionResult = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
export type SessionUser = SessionResult['user'];
export type OrganizationRow = typeof schema.organization.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser | undefined;
    organization?: OrganizationRow | undefined;
  }
}

export interface RequireAuthDeps {
  auth: Auth;
  db: RuntimeDb;
}

// Fastify preHandler factory: resolves the Better Auth session from the
// request cookie, attaches request.user + request.organization (the session's
// active tenant), and throws UnauthorizedError otherwise — the error handler
// renders the structured envelope.
export function createRequireAuth({ auth, db }: RequireAuthDeps) {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!result) {
      throw new UnauthorizedError();
    }
    request.user = result.user;
    const { activeOrganizationId } = result.session;
    if (activeOrganizationId) {
      const organizations = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, activeOrganizationId))
        .limit(1);
      const organization = organizations[0];
      if (organization) {
        request.organization = organization;
      }
    }
  };
}
