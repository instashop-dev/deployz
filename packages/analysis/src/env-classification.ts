/**
 * Environment-variable classification (AI MVP Phase 4) — who supplies each
 * variable's value. Deterministic: names, detected requirements and the
 * external-service catalog decide; nothing here reads a value, and the LLM
 * never takes part.
 *
 *   - deployz_managed   — Deployz injects it at install (database, cache,
 *                         storage bindings, the port).
 *   - deployz_generated — an application-internal secret (session/JWT/
 *                         encryption keys) Deployz generates with
 *                         cryptographic randomness inside the customer's
 *                         account. Never a third-party credential.
 *   - customer_required — the vendor must supply a value before deployment.
 *   - optional          — the app reads it with a default, or the repository
 *                         supplies one.
 *   - unknown           — declared only in a sample file, never read: the
 *                         analysis cannot say whether it matters.
 */

import type { EnvVariableClassification, ManifestEnvVariable } from '@deployz/contracts';

import { EXTERNAL_SERVICE_CATALOG } from './detectors.js';

export interface EnvClassificationContext {
  postgresRequired: boolean;
  redisRequired: boolean;
  /** The Redis env names Deployz injects when Redis is required. */
  redisBindingNames: string[];
  storageRequired: boolean;
  /** External services the repository evidences (ids from the catalog). */
  externalServices: string[];
}

/** Env names the application stack injects for a managed PostgreSQL database. */
export const MANAGED_DATABASE_ENV_VARS = [
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
] as const;

/** Env names the application stack injects for managed object storage. */
export const MANAGED_STORAGE_ENV_VARS = ['STORAGE_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET', 'AWS_REGION'] as const;

/** Env names the container platform always provides. */
const MANAGED_PLATFORM_ENV_VARS = ['PORT', 'HOSTNAME'] as const;

/** Application-internal secrets Deployz can mint: the name ends in one of these. */
const GENERATED_SECRET_SUFFIX_REGEX =
  /(?:^|_)(?:SECRET|SECRET_KEY|SECRET_KEY_BASE|ENCRYPTION_KEY|ENCRYPTION_SECRET|SIGNING_KEY|SIGNING_SECRET|APP_KEY|SESSION_KEY|JWT_KEY|COOKIE_KEY|HASH_SALT|SALT|PEPPER)$/;

/** A third-party product's prefix — its secret belongs to the vendor, never generated. */
const THIRD_PARTY_PREFIX_REGEX =
  /^(?:STRIPE|SMTP|MAIL|MAILGUN|POSTMARK|SES|SENDGRID|RESEND|AWS|S3|GITHUB|GITLAB|GOOGLE|GCP|AZURE|SLACK|DISCORD|TWILIO|OPENAI|ANTHROPIC|CLERK|AUTH0|OKTA|SUPABASE|FIREBASE|SHOPIFY|PAYPAL|SENTRY|DATADOG|CLOUDFLARE|VERCEL|OAUTH|OIDC|SAML|LDAP|TURNSTILE|RECAPTCHA|HCAPTCHA|FACEBOOK|APPLE|MICROSOFT|LINKEDIN|X|TWITTER)_/;

/** A key that names a connection to something outside the app is never minted. */
const CONNECTION_KEY_REGEX = /(?:_URL|_URI|_DSN|_HOST|_ENDPOINT|_USER|_USERNAME|_PASSWORD|_TOKEN|_API_KEY|_ACCESS_KEY|_CLIENT_SECRET|_WEBHOOK_SECRET)$/;

function externalServiceKeys(services: string[]): Set<string> {
  const keys = new Set<string>();
  for (const def of EXTERNAL_SERVICE_CATALOG) {
    if (services.includes(def.id)) for (const key of def.keys) keys.add(key);
  }
  return keys;
}

/** True when Deployz can safely mint this variable's value. */
export function isGeneratableSecretName(key: string): boolean {
  return (
    GENERATED_SECRET_SUFFIX_REGEX.test(key) && !THIRD_PARTY_PREFIX_REGEX.test(key) && !CONNECTION_KEY_REGEX.test(key)
  );
}

function classifyOne(
  variable: ManifestEnvVariable,
  managed: Set<string>,
  serviceKeys: Set<string>,
): EnvVariableClassification {
  if (managed.has(variable.key)) return 'deployz_managed';
  if (variable.required) {
    if (variable.secret && !serviceKeys.has(variable.key) && isGeneratableSecretName(variable.key)) {
      return 'deployz_generated';
    }
    return 'customer_required';
  }
  const isRead = variable.source.some((entry) => entry.startsWith('read in '));
  return isRead ? 'optional' : 'unknown';
}

/**
 * Classify every variable in the model. Pure; the input entries are copied,
 * never mutated. Only the names Deployz actually injects for THIS app count
 * as managed — a `REDIS_URL` in an app without a required cache is the
 * vendor's to provide.
 */
export function classifyEnvVariables(
  model: ManifestEnvVariable[],
  context: EnvClassificationContext,
): ManifestEnvVariable[] {
  const managed = new Set<string>(MANAGED_PLATFORM_ENV_VARS);
  if (context.postgresRequired) for (const name of MANAGED_DATABASE_ENV_VARS) managed.add(name);
  if (context.redisRequired) for (const name of context.redisBindingNames) managed.add(name);
  if (context.storageRequired) for (const name of MANAGED_STORAGE_ENV_VARS) managed.add(name);
  const serviceKeys = externalServiceKeys(context.externalServices);

  return model.map((variable) => ({ ...variable, classification: classifyOne(variable, managed, serviceKeys) }));
}
