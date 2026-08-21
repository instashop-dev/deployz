import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { env } from './env.js';

// Better Auth instance for the control plane. email/password + GitHub OAuth
// (env-driven), organization plugin for the vendor tenant record. S1
// guardrail: the org plugin models the tenant ONLY — no member/role/invite UI
// is exposed anywhere; member rows exist because the plugin requires them.
export function createAuth(db: RuntimeDb) {
  return betterAuth({
    appName: 'Deployz',
    baseURL: env.apiUrl,
    basePath: '/api/auth',
    ...(env.betterAuthSecret ? { secret: env.betterAuthSecret } : {}),
    trustedOrigins: [env.webUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
    socialProviders: {
      github: {
        clientId: env.githubClientId,
        clientSecret: env.githubClientSecret,
      },
    },
    plugins: [organization()],
    databaseHooks: {
      session: {
        create: {
          // Vendor tenant provisioning, single code path: every session gets
          // an active organization — the user's own tenant, created inline on
          // first session (signup) and reused on later sign-ins. Doing this in
          // session.create.before (not user.create.after) matters: user
          // after-hooks are queued post-transaction, so a signup session
          // created there would race ahead with activeOrganizationId = null.
          before: async (session) => {
            const memberships = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .limit(1);

            let organizationId = memberships[0]?.organizationId;
            if (!organizationId) {
              organizationId = crypto.randomUUID();
              const localPart =
                (await db
                  .select({ email: schema.user.email })
                  .from(schema.user)
                  .where(eq(schema.user.id, session.userId))
                  .limit(1))[0]
                  ?.email.split('@')[0] ?? 'tenant';
              await db.insert(schema.organization).values({
                id: organizationId,
                name: localPart,
                slug: `${localPart}-${session.userId.slice(0, 8)}`,
              });
              await db.insert(schema.member).values({
                id: crypto.randomUUID(),
                organizationId,
                userId: session.userId,
                role: 'owner',
              });
            }

            return { data: { ...session, activeOrganizationId: organizationId } };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
