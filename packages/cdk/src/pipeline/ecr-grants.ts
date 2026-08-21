/**
 * ECR cross-account pull grant lifecycle.
 *
 * The control plane owns a private ECR repository. Customer accounts need
 * cross-account pull access to deploy images. This module provides pure
 * functions for building ECR repository policy statements that grant pull
 * access per installation, plus an injectable client interface for applying
 * and revoking those grants at runtime.
 *
 * Grant lifecycle:
 *   INSTALL time  → grantPull(installationId, customerAccountId)
 *   DESTROY time   → revokePull(installationId)
 *
 * The grant is per-installation, not per-customer. Each installation gets its
 * own policy statement scoped to the customer's AWS account ID (verified via
 * STS getCallerIdentity during relay registration).
 *
 * AWS-BLOCKED: the real ECR `setRepositoryPolicy` / `getRepositoryPolicy` /
 * `deleteRepositoryPolicy` calls require AWS credentials. The `EcrClient`
 * interface follows the same injectable-seam pattern as `S3Client` (quick-create)
 * and `AwsClients` (integration).
 */

// ---------------------------------------------------------------------------
// ECR pull actions
// ---------------------------------------------------------------------------

/** Actions required for a customer account to pull an image from ECR. */
export const ECR_PULL_ACTIONS = [
  'ecr:BatchGetImage',
  'ecr:GetDownloadUrlForLayer',
  'ecr:BatchCheckLayerAvailability',
] as const;

// ---------------------------------------------------------------------------
// ECR client interface (injectable seam — real impl PENDING-AWS)
// ---------------------------------------------------------------------------

export interface EcrPolicy {
  /** The JSON policy document as a parsed object. */
  readonly policyText: Record<string, unknown>;
  /** S3-style ETag for optimistic locking (used by setRepositoryPolicy). */
  readonly policyRevision?: string | undefined;
}

export interface EcrClient {
  /** Gets the current repository policy (returns null if no policy exists). */
  getRepositoryPolicy(repositoryName: string): Promise<EcrPolicy | null>;
  /** Sets the repository policy (overwrites existing). */
  setRepositoryPolicy(
    repositoryName: string,
    policyText: Record<string, unknown>,
  ): Promise<void>;
  /** Deletes the repository policy entirely. */
  deleteRepositoryPolicy(repositoryName: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure functions — policy construction
// ---------------------------------------------------------------------------

export interface EcrGrantStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Principal: { readonly AWS: string };
  readonly Action: readonly string[];
  readonly Condition?: Record<string, Record<string, string>> | undefined;
}

type AwsPolicyDocument = {
  readonly Version: string;
  readonly Statement: readonly EcrGrantStatement[];
};

/** Builds the Sid (statement ID) for a given installation grant. */
export function installationGrantSid(installationId: string): string {
  return `deployz-pull-${installationId}`;
}

/**
 * Builds a single ECR repository policy statement granting cross-account
 * pull access for a specific installation.
 */
export function buildPullStatement(
  installationId: string,
  customerAccountId: string,
): EcrGrantStatement {
  return {
    Sid: installationGrantSid(installationId),
    Effect: 'Allow',
    Principal: { AWS: `arn:aws:iam::${customerAccountId}:root` },
    Action: [...ECR_PULL_ACTIONS],
  };
}

/**
 * Builds a full ECR repository policy document from a list of statements.
 * Returns null if the statement list is empty (no policy needed).
 */
export function buildRepoPolicyDocument(
  statements: readonly EcrGrantStatement[],
): AwsPolicyDocument | null {
  if (statements.length === 0) {
    return null;
  }
  return {
    Version: '2012-10-17',
    Statement: statements,
  };
}

// ---------------------------------------------------------------------------
// Grant lifecycle — pure orchestration (read-modify-write with the client)
// ---------------------------------------------------------------------------

export interface GrantResult {
  readonly added: boolean;
  readonly statementCount: number;
}

/**
 * Adds a pull grant for an installation to the ECR repository policy.
 *
 * Reads the current policy, adds the statement (idempotent — replaces an
 * existing statement with the same Sid), and writes the updated policy.
 * If no policy exists, creates one with the single statement.
 */
export async function grantPull(
  client: EcrClient,
  repositoryName: string,
  installationId: string,
  customerAccountId: string,
): Promise<GrantResult> {
  const sid = installationGrantSid(installationId);
  const newStmt = buildPullStatement(installationId, customerAccountId);

  const current = await client.getRepositoryPolicy(repositoryName);
  const currentStatements: readonly EcrGrantStatement[] = current
    ? ((current.policyText as AwsPolicyDocument).Statement ?? [])
    : [];

  // Replace existing statement with the same Sid, or append.
  const idx = currentStatements.findIndex((s) => s.Sid === sid);
  let updated: EcrGrantStatement[];
  if (idx >= 0) {
    updated = [...currentStatements];
    updated[idx] = newStmt;
  } else {
    updated = [...currentStatements, newStmt];
  }

  const doc = buildRepoPolicyDocument(updated);
  if (!doc) {
    // Should not happen — we just added a statement.
    throw new Error('BUG: empty policy after adding grant');
  }

  await client.setRepositoryPolicy(repositoryName, doc);

  return {
    added: idx < 0,
    statementCount: updated.length,
  };
}

export interface RevokeResult {
  readonly removed: boolean;
  readonly statementCount: number;
  readonly policyDeleted: boolean;
}

/**
 * Revokes a pull grant for an installation from the ECR repository policy.
 *
 * Reads the current policy, removes the statement with the matching Sid,
 * and writes the updated policy. If the statement list becomes empty, the
 * entire policy is deleted (clean slate).
 *
 * Idempotent: if the grant doesn't exist, reports `removed: false` with
 * no error.
 */
export async function revokePull(
  client: EcrClient,
  repositoryName: string,
  installationId: string,
): Promise<RevokeResult> {
  const sid = installationGrantSid(installationId);

  const current = await client.getRepositoryPolicy(repositoryName);
  if (!current) {
    return { removed: false, statementCount: 0, policyDeleted: false };
  }

  const currentStatements: readonly EcrGrantStatement[] =
    (current.policyText as AwsPolicyDocument).Statement ?? [];

  const idx = currentStatements.findIndex((s) => s.Sid === sid);
  if (idx < 0) {
    return {
      removed: false,
      statementCount: currentStatements.length,
      policyDeleted: false,
    };
  }

  const updated = [
    ...currentStatements.slice(0, idx),
    ...currentStatements.slice(idx + 1),
  ];

  if (updated.length === 0) {
    await client.deleteRepositoryPolicy(repositoryName);
    return { removed: true, statementCount: 0, policyDeleted: true };
  }

  const doc = buildRepoPolicyDocument(updated);
  if (!doc) {
    // Should not happen — we checked length > 0.
    throw new Error('BUG: null policy for non-empty statement list');
  }

  await client.setRepositoryPolicy(repositoryName, doc);

  return {
    removed: true,
    statementCount: updated.length,
    policyDeleted: false,
  };
}