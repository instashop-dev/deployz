import type { FastifyRequest } from 'fastify';

import { ApiError } from '../errors.js';
import type { SessionUser } from '../require-auth.js';

/**
 * Parses `TEAM_ADMIN_EMAILS` (comma-separated exact emails or `*@domain`
 * wildcards) into a normalized (trimmed, lower-cased) list. See
 * docs/admin/team-admin.md's Authorization model.
 */
export function parseTeamAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Platform-admin check: `platformRole === 'ADMIN'` always grants access; the
 * env allowlist additionally grants it, but ONLY while `envGrantsEnabled` is
 * true — false in the deployed Lambda, so an env grant can never take effect
 * in production and an unverified sign-up can never self-escalate there.
 */
export function isTeamAdmin(
  user: { email: string; platformRole?: string | null | undefined },
  teamAdminEmails: string[],
  envGrantsEnabled: boolean,
): boolean {
  if (user.platformRole === 'ADMIN') return true;
  if (!envGrantsEnabled) return false;
  const email = user.email.trim().toLowerCase();
  return teamAdminEmails.some((entry) =>
    entry.startsWith('*@') ? email.endsWith(entry.slice(1)) : entry === email,
  );
}

export interface RequireTeamAdminDeps {
  requireAuth: (request: FastifyRequest) => Promise<void>;
  teamAdminEmails: string[];
  envGrantsEnabled: boolean;
}

/**
 * Fastify preHandler factory: runs the existing `requireAuth` (session +
 * tenant resolution) first, then the platform-admin check. Non-admins get
 * 403 NOT_TEAM_ADMIN. Admin read models are cross-tenant by design, so every
 * `/api/admin/*` route must use this, never `requireAuth` alone.
 */
export function createRequireTeamAdmin({ requireAuth, teamAdminEmails, envGrantsEnabled }: RequireTeamAdminDeps) {
  return async function requireTeamAdmin(request: FastifyRequest): Promise<void> {
    await requireAuth(request);
    const user: SessionUser | undefined = request.user;
    if (!user || !isTeamAdmin(user, teamAdminEmails, envGrantsEnabled)) {
      throw new ApiError(403, 'NOT_TEAM_ADMIN', 'Team Admin access required');
    }
    request.isTeamAdmin = true;
  };
}
