import { text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Shared column factories. Each call returns FRESH column builders — drizzle
// column builders bind to a single table and must never be shared by reference.

// uuid pk default gen_random_uuid() — every Deployz-owned table.
// (Better Auth tables are the documented exception: text ids, see auth.ts.)
export const id = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// §62 audit fields on every infra-changing record: who created/last touched
// it (Better Auth text user id; nullable — relay/system actors are not users)
// plus the created_at/updated_at pair. The full who/what/when stream lives in
// event_logs; these columns answer "whose change is this row" at a glance.
export const auditFields = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
});
