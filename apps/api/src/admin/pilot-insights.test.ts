import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import { buildServer } from '../server.js';

// ── Shared test helpers (matches admin-overview-vendors.test.ts style) ──

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string; email: string; name: string }> {
  const password = crypto.randomUUID();
  const name = email.split('@')[0]!;
  const signup = await auth.api.signUpEmail({ body: { email, password, name } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error('signup did not provision an organization');
  return { userId: signup.user.id, organizationId, cookie: setCookie, email, name };
}

/** Fresh in-memory Postgres + server with a platform-ADMIN session. */
async function createFixture(): Promise<{
  client: PGlite;
  db: Db;
  app: FastifyInstance;
  adminCookie: string;
  admin: Awaited<ReturnType<typeof signUpAndGetOrg>>;
}> {
  const client = new PGlite();
  await applyMigrations(client);
  const db = createDb(client);
  const auth = createAuth(db);
  const admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
  await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));
  const app = await buildServer({ auth, db, teamAdminEmails: [], teamAdminEnvGrantsEnabled: false });
  return { client, db, app, adminCookie: admin.cookie, admin };
}

const MINUTE_MS = 60_000;

/** One event_logs row, `minutesAgo` before the seed moment. */
function seedEvent(organizationId: string, overrides: Partial<typeof schema.eventLogs.$inferInsert>): typeof schema.eventLogs.$inferInsert {
  return {
    actorType: 'system',
    actorId: 'pilot-test',
    organizationId,
    eventType: 'install.completed',
    result: 'success',
    ...overrides,
  };
}

/** Pinned per-fixture seed moment so duration math stays exact (Date.now()
 *  jitter between events would otherwise leak fractional milliseconds into
 *  median/P90 assertions). */
let seedNow = Date.now();

function minutesAgo(minutes: number): Date {
  return new Date(seedNow - minutes * MINUTE_MS);
}

function getReq(app: FastifyInstance, url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

function overviewUrl(query = ''): string {
  return `/api/admin/overview${query}`;
}

interface PilotInsightsBody {
  window: { days: number; from: string; to: string };
  funnel: Record<string, number>;
  quality: Record<string, number | null>;
  failures: { code: string; count: number; affectedDeployments: number }[];
  deployLinks: Record<string, number>;
  support: Record<string, number>;
}

describe('GET /api/admin/overview pilotInsights: empty log + window validation + auth', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let adminCookie: string;
  let vendorCookie: string;

  beforeAll(async () => {
    const fixture = await createFixture();
    client = fixture.client;
    db = fixture.db;
    app = fixture.app;
    adminCookie = fixture.adminCookie;
    const vendor = await signUpAndGetOrg(createAuth(db), db, `vendor-${crypto.randomUUID()}@example.com`);
    vendorCookie = vendor.cookie;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('returns all-zero/all-null pilotInsights on an empty event log (default 30)', async () => {
    const response = await getReq(app, overviewUrl(), adminCookie);
    expect(response.statusCode).toBe(200);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    expect(pilotInsights.window).toMatchObject({ days: 30 });
    expect(Number.isNaN(Date.parse(pilotInsights.window.from))).toBe(false);
    expect(Number.isNaN(Date.parse(pilotInsights.window.to))).toBe(false);
    expect(new Date(pilotInsights.window.to).getTime()).toBeGreaterThanOrEqual(
      new Date(pilotInsights.window.from).getTime(),
    );

    expect(pilotInsights.funnel).toEqual({
      applicationsCreated: 0,
      analysisCompleted: 0,
      preflightPassed: 0,
      awsLaunched: 0,
      relayConnected: 0,
      healthy: 0,
    });
    expect(pilotInsights.quality).toEqual({
      installSuccessRate: null,
      retryRate: null,
      medianTimeToHealthyMs: null,
      p90TimeToHealthyMs: null,
      sampleSize: 0,
    });
    expect(pilotInsights.failures).toEqual([]);
    expect(pilotInsights.deployLinks).toEqual({ created: 0, opened: 0, launched: 0, relayConnected: 0, healthy: 0 });
    expect(pilotInsights.support).toEqual({
      healthyWithoutSupport: 0,
      requiredSupportIntervention: 0,
      supportSessions: 0,
    });
  });

  it('accepts days=7 and days=90 and rejects anything else with 400', async () => {
    for (const days of [7, 30, 90]) {
      const response = await getReq(app, overviewUrl(`?days=${days}`), adminCookie);
      expect(response.statusCode, `days=${days}`).toBe(200);
      const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };
      expect(pilotInsights.window.days).toBe(days);
    }

    for (const invalid of ['5', '31', 'abc', '']) {
      const response = await getReq(app, overviewUrl(`?days=${invalid}`), adminCookie);
      expect(response.statusCode, `days=${invalid}`).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('403s a non-team-admin on GET /api/admin/overview?days=30', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), vendorCookie);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_TEAM_ADMIN' } });
  });
});

describe('GET /api/admin/overview pilotInsights: funnel dedupe, duration metrics, failures', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let adminCookie: string;

  const org = crypto.randomUUID();
  const app1 = crypto.randomUUID();
  const m1 = crypto.randomUUID();
  const m2 = crypto.randomUUID();
  const d1 = crypto.randomUUID();

  beforeAll(async () => {
    const fixture = await createFixture();
    client = fixture.client;
    db = fixture.db;
    app = fixture.app;
    adminCookie = fixture.adminCookie;

    seedNow = Date.now();
    await db.insert(schema.eventLogs).values([
      // App-level funnel: repeats must never inflate the distinct counts.
      seedEvent(org, { eventType: 'application.created', payload: { applicationId: app1 }, occurredAt: minutesAgo(300) }),
      seedEvent(org, { eventType: 'application.analysis_completed', payload: { applicationId: app1 }, occurredAt: minutesAgo(295) }),
      seedEvent(org, { eventType: 'application.analysis_completed', payload: { applicationId: app1 }, occurredAt: minutesAgo(290) }),
      seedEvent(org, { eventType: 'application.analysis_completed', payload: { applicationId: app1 }, occurredAt: minutesAgo(285) }),
      seedEvent(org, {
        eventType: 'application.preflight_evaluated',
        payload: { applicationId: app1, result: 'pass' },
        occurredAt: minutesAgo(200),
      }),
      seedEvent(org, {
        eventType: 'application.preflight_evaluated',
        payload: { applicationId: app1, result: 'pass' },
        occurredAt: minutesAgo(190),
      }),
      // m1: manual deployment, healthy. Repeated launch/relay/completed rows.
      seedEvent(org, { eventType: 'install.launched', deploymentId: m1, occurredAt: minutesAgo(120) }),
      seedEvent(org, { eventType: 'install.launched', deploymentId: m1, occurredAt: minutesAgo(90) }),
      seedEvent(org, { eventType: 'relay.connected', deploymentId: m1, occurredAt: minutesAgo(80) }),
      seedEvent(org, { eventType: 'relay.connected', deploymentId: m1, occurredAt: minutesAgo(75) }),
      seedEvent(org, { eventType: 'relay.connected', deploymentId: m1, occurredAt: minutesAgo(70) }),
      seedEvent(org, { eventType: 'install.completed', deploymentId: m1, result: 'success', occurredAt: minutesAgo(60) }),
      seedEvent(org, { eventType: 'install.completed', deploymentId: m1, result: 'success', occurredAt: minutesAgo(50) }),
      // m2: launched but never relayed nor healthy — excluded downstream.
      seedEvent(org, { eventType: 'install.launched', deploymentId: m2, occurredAt: minutesAgo(240) }),
      seedEvent(org, {
        eventType: 'install.failed',
        deploymentId: m2,
        result: 'failure',
        payload: { failureCode: 'BOOTSTRAP_TIMEOUT' },
        occurredAt: minutesAgo(210),
      }),
      // d1: reached every milestone, then admin force-completed its destroy.
      seedEvent(org, { eventType: 'install.launched', deploymentId: d1, occurredAt: minutesAgo(390) }),
      seedEvent(org, { eventType: 'relay.connected', deploymentId: d1, occurredAt: minutesAgo(360) }),
      seedEvent(org, { eventType: 'install.completed', deploymentId: d1, result: 'success', occurredAt: minutesAgo(30) }),
      seedEvent(org, {
        eventType: 'admin.destroy.force_completed',
        payload: { targetType: 'deployment', targetId: d1 },
        occurredAt: minutesAgo(5),
      }),
      // release.build_failed: no deployment_id — counts, never affectedDeployments.
      seedEvent(org, {
        eventType: 'release.build_failed',
        result: 'failure',
        payload: { failureCode: 'BUILD_TIMEOUT' },
        occurredAt: minutesAgo(180),
      }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('dedupes repeated telemetry, keeps a destroyed deployment at its milestones, and drops never-healthy deployments downstream', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), adminCookie);
    expect(response.statusCode).toBe(200);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    expect(pilotInsights.funnel).toEqual({
      applicationsCreated: 1,
      analysisCompleted: 1,
      preflightPassed: 1,
      awsLaunched: 3,
      relayConnected: 2,
      healthy: 2,
    });

    // m2 (no relay/healthy) is counted in awsLaunched only; d1 (destroyed) is
    // still counted at every milestone it reached.
    expect(pilotInsights.deployLinks).toEqual({ created: 0, opened: 0, launched: 0, relayConnected: 0, healthy: 0 });
  });

  it('computes installSuccessRate, median time-to-healthy and null P90 below 10 samples', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), adminCookie);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    // 2 healthy of 3 outcome-attempting deployments (m1 completed, m2 failed, d1 completed).
    expect(pilotInsights.quality.installSuccessRate).toBe(0.67);
    // No retries but 3 launches: a 0, not a null.
    expect(pilotInsights.quality.retryRate).toBe(0);
    // Durations: m1 = 60 min, d1 = 360 min → median 210 min.
    expect(pilotInsights.quality.sampleSize).toBe(2);
    expect(pilotInsights.quality.medianTimeToHealthyMs).toBe(210 * MINUTE_MS);
    expect(pilotInsights.quality.p90TimeToHealthyMs).toBeNull();
  });

  it('aggregates failures top 5 by count with affectedDeployments from the deployment_id column only', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), adminCookie);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    expect(pilotInsights.failures).toEqual([
      { code: 'BOOTSTRAP_TIMEOUT', count: 1, affectedDeployments: 1 },
      // release.build_failed carries release_id — count but no affectedDeployments.
      { code: 'BUILD_TIMEOUT', count: 1, affectedDeployments: 0 },
    ]);
  });
});

describe('GET /api/admin/overview pilotInsights: failed install then successful retry', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let adminCookie: string;

  const org = crypto.randomUUID();
  const r1 = crypto.randomUUID();

  beforeAll(async () => {
    const fixture = await createFixture();
    client = fixture.client;
    db = fixture.db;
    app = fixture.app;
    adminCookie = fixture.adminCookie;

    seedNow = Date.now();
    await db.insert(schema.eventLogs).values([
      seedEvent(org, { eventType: 'install.launched', deploymentId: r1, occurredAt: minutesAgo(300) }),
      seedEvent(org, {
        eventType: 'install.failed',
        deploymentId: r1,
        result: 'failure',
        payload: { failureCode: 'PORT_MISMATCH' },
        occurredAt: minutesAgo(288),
      }),
      seedEvent(org, { eventType: 'install.retry.requested', deploymentId: r1, occurredAt: minutesAgo(282) }),
      seedEvent(org, { eventType: 'install.launched', deploymentId: r1, occurredAt: minutesAgo(240) }),
      seedEvent(org, { eventType: 'install.completed', deploymentId: r1, result: 'success', occurredAt: minutesAgo(60) }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('counts the deployment once in healthy and once in the installSuccessRate denominator', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), adminCookie);
    expect(response.statusCode).toBe(200);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    expect(pilotInsights.funnel.awsLaunched).toBe(1);
    expect(pilotInsights.funnel.healthy).toBe(1);
    // One distinct attempt despite one failure + one success row.
    expect(pilotInsights.quality.installSuccessRate).toBe(1);
    expect(pilotInsights.quality.retryRate).toBe(1);
    // Earliest launch → earliest success: 240 min.
    expect(pilotInsights.quality.sampleSize).toBe(1);
    expect(pilotInsights.quality.medianTimeToHealthyMs).toBe(240 * MINUTE_MS);
    expect(pilotInsights.quality.p90TimeToHealthyMs).toBeNull();
    expect(pilotInsights.failures).toEqual([{ code: 'PORT_MISMATCH', count: 1, affectedDeployments: 1 }]);
  });
});

describe('GET /api/admin/overview pilotInsights: manual vs deploy-link origin', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let adminCookie: string;

  const org = crypto.randomUUID();
  const manual = crypto.randomUUID();
  const linked = crypto.randomUUID();

  beforeAll(async () => {
    const fixture = await createFixture();
    client = fixture.client;
    db = fixture.db;
    app = fixture.app;
    adminCookie = fixture.adminCookie;

    seedNow = Date.now();
    await db.insert(schema.eventLogs).values([
      // Manual deployment: only install.* / relay events — no deploy_link.* rows.
      seedEvent(org, { eventType: 'deployment.created', deploymentId: manual, payload: { source: 'manual' }, occurredAt: minutesAgo(200) }),
      seedEvent(org, { eventType: 'install.launched', deploymentId: manual, occurredAt: minutesAgo(180) }),
      seedEvent(org, { eventType: 'relay.connected', deploymentId: manual, occurredAt: minutesAgo(170) }),
      seedEvent(org, { eventType: 'install.completed', deploymentId: manual, result: 'success', occurredAt: minutesAgo(30) }),
      // Deploy-link deployment: deployment.created(source=deploy_link) + link lifecycle.
      seedEvent(org, { eventType: 'deployment.created', deploymentId: linked, payload: { source: 'deploy_link' }, occurredAt: minutesAgo(200) }),
      seedEvent(org, { eventType: 'deploy_link.created', deploymentId: linked, occurredAt: minutesAgo(160) }),
      seedEvent(org, { eventType: 'deploy_link.opened', deploymentId: linked, occurredAt: minutesAgo(155) }),
      seedEvent(org, { eventType: 'deploy_link.opened', deploymentId: linked, occurredAt: minutesAgo(150) }),
      seedEvent(org, { eventType: 'deploy_link.launched', deploymentId: linked, occurredAt: minutesAgo(145) }),
      seedEvent(org, { eventType: 'relay.connected', deploymentId: linked, occurredAt: minutesAgo(140) }),
      seedEvent(org, { eventType: 'install.completed', deploymentId: linked, result: 'success', occurredAt: minutesAgo(20) }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('attributes deploy-link deployments to the deployLinks block and keeps manual ones funnel-only', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), adminCookie);
    expect(response.statusCode).toBe(200);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    // Both origins reach the funnel…
    expect(pilotInsights.funnel.awsLaunched).toBe(2);
    expect(pilotInsights.funnel.relayConnected).toBe(2);
    expect(pilotInsights.funnel.healthy).toBe(2);
    // …but only the deploy-link deployment is a deploy_link.created entity.
    expect(pilotInsights.deployLinks).toEqual({ created: 1, opened: 1, launched: 1, relayConnected: 1, healthy: 1 });

    expect(pilotInsights.quality.installSuccessRate).toBe(1);
    expect(pilotInsights.quality.sampleSize).toBe(2);
    // Durations: manual = 150 min, linked = 125 min → median 137.5 min.
    expect(pilotInsights.quality.medianTimeToHealthyMs).toBe(137.5 * MINUTE_MS);
    expect(pilotInsights.quality.p90TimeToHealthyMs).toBeNull();
  });
});

describe('GET /api/admin/overview pilotInsights: support derivation', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let adminCookie: string;

  const orgS = crypto.randomUUID();
  const org2 = crypto.randomUUID();
  const h1 = crypto.randomUUID();
  const i1 = crypto.randomUUID();
  const h2 = crypto.randomUUID();

  const healthyDeployment = (deploymentId: string, org: string, minutes: number): typeof schema.eventLogs.$inferInsert[] => [
    seedEvent(org, { eventType: 'install.launched', deploymentId, occurredAt: minutesAgo(minutes + 60) }),
    seedEvent(org, { eventType: 'relay.connected', deploymentId, occurredAt: minutesAgo(minutes + 55) }),
    seedEvent(org, { eventType: 'install.completed', deploymentId, result: 'success', occurredAt: minutesAgo(minutes) }),
  ];

  beforeAll(async () => {
    const fixture = await createFixture();
    client = fixture.client;
    db = fixture.db;
    app = fixture.app;
    adminCookie = fixture.adminCookie;

    seedNow = Date.now();
    await db.insert(schema.eventLogs).values([
      // h1: healthy in an org that also ran a support session → supported.
      ...healthyDeployment(h1, orgS, 60),
      // i1: healthy AND the target of an admin recovery action → supported.
      ...healthyDeployment(i1, orgS, 55),
      seedEvent(orgS, {
        eventType: 'admin.install.retry_requested',
        payload: { targetType: 'deployment', targetId: i1 },
        occurredAt: minutesAgo(50),
      }),
      // h2: healthy in an org without a session and without recovery → no intervention.
      ...healthyDeployment(h2, org2, 45),
      seedEvent(orgS, {
        eventType: 'admin.support_session.started',
        payload: { targetType: 'organization', targetId: orgS },
        occurredAt: minutesAgo(30),
      }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('counts org support sessions and derives intervention from recovery targets and supported orgs', async () => {
    const response = await getReq(app, overviewUrl('?days=30'), adminCookie);
    expect(response.statusCode).toBe(200);
    const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };

    expect(pilotInsights.funnel.healthy).toBe(3);
    expect(pilotInsights.support.supportSessions).toBe(1);
    // i1 (recovery target) + h1 & i1 (healthy in a session org) → 2 distinct.
    expect(pilotInsights.support.requiredSupportIntervention).toBe(2);
    // Only h2 (org2, no session) is healthy without support.
    expect(pilotInsights.support.healthyWithoutSupport).toBe(1);
  });
});

describe('GET /api/admin/overview pilotInsights: time-window filtering across days values', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let adminCookie: string;

  const org = crypto.randomUUID();
  const oldApp = crypto.randomUUID();
  const recentApp = crypto.randomUUID();

  beforeAll(async () => {
    const fixture = await createFixture();
    client = fixture.client;
    db = fixture.db;
    app = fixture.app;
    adminCookie = fixture.adminCookie;

    seedNow = Date.now();
    const dayMs = 86_400_000;
    await db.insert(schema.eventLogs).values([
      seedEvent(org, {
        eventType: 'application.created',
        payload: { applicationId: oldApp },
        occurredAt: new Date(seedNow - 40 * dayMs),
      }),
      seedEvent(org, {
        eventType: 'application.created',
        payload: { applicationId: recentApp },
        occurredAt: new Date(seedNow - 10 * dayMs),
      }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('ignores events older than the window and honors days=7/30/90', async () => {
    const byDays = async (days: number): Promise<number> => {
      const response = await getReq(app, overviewUrl(`?days=${days}`), adminCookie);
      expect(response.statusCode).toBe(200);
      const { pilotInsights } = response.json() as { pilotInsights: PilotInsightsBody };
      expect(pilotInsights.window.days).toBe(days);
      return pilotInsights.funnel.applicationsCreated;
    };

    expect(await byDays(7)).toBe(0); // only the 10-day-old event exists in the window
    expect(await byDays(30)).toBe(1); // 40-day-old event is outside
    expect(await byDays(90)).toBe(2); // both inside
  });
});
