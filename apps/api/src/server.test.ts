import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';

import { createAuth, type Auth } from './auth.js';
import { ApiError } from './errors.js';
import { createRequireAuth } from './require-auth.js';
import { buildServer } from './server.js';

// Fastify base over a fresh in-memory PGlite (real Postgres semantics, full
// migrations). One signup in beforeAll; every assertion goes through
// app.inject against the real server with probe routes exercising the todo-4
// surface: auth middleware, ApiError envelope mapping, unknown-error
// containment.
describe('server (Fastify base over PGlite)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'grace@example.com';
    const password = 'super-secret-1';
    const signup = await auth.api.signUpEmail({
      body: { email, password, name: 'Grace' },
    });
    userId = signup.user.id;
    const signin = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error('sign-in did not set a session cookie');
    }
    cookie = setCookie;

    app = await buildServer({ auth, db });

    const requireAuth = createRequireAuth({ auth, db });
    app.get('/api/probe-auth', { preHandler: requireAuth }, async (request) => ({
      userId: request.user?.id ?? null,
      organizationId: request.organization?.id ?? null,
    }));
    app.get('/api/probe-api-error', async () => {
      throw new ApiError(422, 'PORT_MISMATCH', 'Port 8080 is not exposed by the image', {
        port: 8080,
      });
    });
    app.get('/api/probe-unknown-error', async () => {
      throw new Error('hunter2-internal-db-password');
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /health returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('GET /api/me without a session returns 401 as a structured envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/me with a session cookie returns 200 with the user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { email: string } };
    expect(body.user.email).toBe('grace@example.com');
  });

  it('protected probe resolves user + organization from the session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/probe-auth',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { userId: string; organizationId: string };
    expect(body.userId).toBe(userId);
    expect(body.organizationId).toBeTruthy();
  });

  it('ApiError renders as its code/message/details envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe-api-error' });
    expect(response.statusCode).toBe(422);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('PORT_MISMATCH');
    expect(envelope.error.message).toBe('Port 8080 is not exposed by the image');
    expect(envelope.error.details).toStrictEqual({ port: 8080 });
  });

  it('unknown errors render 500 INTERNAL_ERROR without leaking internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe-unknown-error' });
    expect(response.statusCode).toBe(500);
    const body = response.json() as unknown;
    const envelope = errorEnvelopeSchema.parse(body);
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hunter2-internal-db-password');
    expect(serialized).not.toContain('at '); // no stack frames
  });
});
