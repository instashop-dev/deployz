import { boolean, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { analysisStatusEnum, buildStatusEnum, compatibilityStatusEnum, releaseStatusEnum } from '../enums.js';
import { organization } from './auth.js';
import { auditFields, createdAt, id, updatedAt } from './common.js';

// §15/§17 GitHub App installations, keyed by GitHub's own installation id.
// Durable because the control plane runs as a Lambda: an in-memory map is
// empty on the next cold start, which loses the vendor's repo access. The
// row is written when the vendor returns from the App's setup redirect
// (apps/api/src/server.ts), and deleted on the installation.deleted webhook.
export const githubInstallations = pgTable('github_installations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const applications = pgTable('applications', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  name: text('name').notNull(),
  githubInstallationId: text('github_installation_id'),
  repoFullName: text('repo_full_name').notNull(),
  repoUrl: text('repo_url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  containerPort: integer('container_port'),
  healthPath: text('health_path'),
  // §35 application-level migration command. Releases may override it via
  // releases.migration_command; this is the vendor default (§31).
  migrationCommand: text('migration_command'),
  workerCommand: text('worker_command'),
  databaseRequired: boolean('database_required').notNull().default(false),
  storageRequired: boolean('storage_required').notNull().default(false),
  redisRequired: boolean('redis_required').notNull().default(false),
  analysisStatus: analysisStatusEnum('analysis_status').notNull().default('PENDING'),
  compatibilityStatus: compatibilityStatusEnum('compatibility_status'),
  compatibilityReason: text('compatibility_reason'),
  detectedMetadata: jsonb('detected_metadata').$type<Record<string, unknown>>(),
  ...auditFields(),
}, (t) => [
  // One application per repository per organization. Choosing the same repo
  // twice used to create a second application with its own releases and
  // deployments, which makes "deploy this app" ambiguous.
  unique('applications_org_repo_uidx').on(t.organizationId, t.repoFullName),
]);

export const releases = pgTable('releases', {
  id: id(),
  applicationId: uuid('application_id')
    .notNull()
    .references(() => applications.id),
  version: text('version').notNull(),
  gitSha: text('git_sha').notNull(),
  imageDigest: text('image_digest'),
  migrationCommand: text('migration_command'),
  buildStatus: buildStatusEnum('build_status').notNull().default('PENDING'),
  // §36 a release is an immutable version record, and now a built one: the
  // §21 pipeline builds the image and the worker moves the release to READY
  // (or FAILED) when CodeBuild reports the digest. It starts BUILDING again
  // because READY before an image exists is a claim nothing has checked.
  releaseStatus: releaseStatusEnum('release_status').notNull().default('BUILDING'),
  ...auditFields(),
}, (t) => [
  // §36 one release per version per application — "deploy 1.0.0" must name
  // exactly one immutable record.
  unique('releases_application_version_uidx').on(t.applicationId, t.version),
]);

export const customers = pgTable('customers', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  company: text('company'),
  externalReference: text('external_reference'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// §31 application configuration: customer_id NULL = vendor default,
// set = customer-specific override. Secret masking is enforced at the API
// layer (todo 26) — the schema only carries the flag.
export const applicationConfigs = pgTable(
  'application_configs',
  {
    id: id(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    customerId: uuid('customer_id').references(() => customers.id),
    key: text('key').notNull(),
    value: text('value').notNull(),
    isSecret: boolean('is_secret').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT: vendor-default rows (customer_id NULL) must dedupe
    // too — stock UNIQUE treats NULLs as distinct and would allow duplicates.
    unique('application_configs_app_customer_key_uidx')
      .on(t.applicationId, t.customerId, t.key)
      .nullsNotDistinct(),
  ],
);
