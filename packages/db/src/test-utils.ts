import { PGlite } from '@electric-sql/pglite';

import { createDb, type Db } from './client.js';
import { applyMigrations } from './migrate.js';
import { applications, customers, organization } from './schema/index.js';

export interface TestContext {
  client: PGlite;
  db: Db;
}

// Fresh in-memory Postgres (WASM) with all drizzle/*.sql migrations applied.
// One instance per test FILE — PGlite startup is cheap and isolation is total.
export async function createTestDb(): Promise<TestContext> {
  const client = new PGlite();
  await applyMigrations(client);
  return { client, db: createDb(client) };
}

export interface BaseIds {
  organizationId: string;
  applicationId: string;
  customerId: string;
}

// Minimal seed graph most constraint tests need: org -> application -> customer.
export async function seedBase(db: Db): Promise<BaseIds> {
  const organizationId = 'org_test';
  const applicationId = crypto.randomUUID();
  const customerId = crypto.randomUUID();

  await db
    .insert(organization)
    .values({ id: organizationId, name: 'Acme Corp', slug: 'acme' });
  await db.insert(applications).values({
    id: applicationId,
    organizationId,
    name: 'shop',
    repoFullName: 'acme/shop',
    repoUrl: 'https://github.com/acme/shop',
  });
  await db
    .insert(customers)
    .values({ id: customerId, organizationId, name: 'Buyer', email: 'buyer@example.com' });

  return { organizationId, applicationId, customerId };
}
