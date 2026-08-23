import { fromNodeHeaders } from 'better-auth/node';
import { asc, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { UnauthorizedError } from './errors.js';
import type { OrganizationRole } from './organizations.js';

type SessionResult = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
export type SessionUser = SessionResult['user'];
export type OrganizationRow = typeof schema.organization.$inferSelect;
export type MemberRow = typeof schema.member.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser | undefined;
    organization?: OrganizationRow | undefined;
    /** The caller's membership in `organization` — the source of their role. */
    member?: MemberRow | undefined;
    sessionId?: string | undefined;
  }
}

export interface RequireAuthDeps {
  auth: Auth;
  db: RuntimeDb;
}

/** The caller's role in the active organization, or 401 when they have none. */
export function requireRole(request: FastifyRequest): OrganizationRole {
  const role = request.member?.role;
  if (!role) {
    throw new UnauthorizedError('An organization is required');
  }
  return role as OrganizationRole;
}

// Fastify preHandler factory: resolves the Better Auth session from the
// request cookie, attaches request.user plus the active tenant
// (request.organization + request.member), and throws UnauthorizedError
// otherwise — the error handler renders the structured envelope.
//
// The tenant is attached ONLY through a membership row. A session pointing at
// an organization the user is no longer in resolves to a tenant they still
// belong to (and the pointer is repaired), never to the one they lost — so
// removing a member takes effect on their very next request.
export function createRequireAuth({ auth, db }: RequireAuthDeps) {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!result) {
      throw new UnauthorizedError();
    }
    request.user = result.user;
    request.sessionId = result.session.id;

    const memberships = await db
      .select({ member: schema.member, organization: schema.organization })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, result.user.id))
      .orderBy(asc(schema.organization.name));

    const { activeOrganizationId } = result.session;
    const active =
      memberships.find((row) => row.organization.id === activeOrganizationId) ?? memberships[0];
    if (!active) {
      return;
    }

    request.organization = active.organization;
    request.member = active.member;
    if (active.organization.id !== activeOrganizationId) {
      await db
        .update(schema.session)
        .set({ activeOrganizationId: active.organization.id })
        .where(eq(schema.session.id, result.session.id));
    }
  };
}
