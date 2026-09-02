/**
 * Hard safety invariants for the customer-reset admin tool.
 *
 * This module is the last line of defense before anything destructive runs:
 * the hardcoded control-plane inventory nothing may ever match
 * (`buildProtectedInventory` / `assertNoOverlap`), the explicit confirmation
 * gate for `execute` (`requireConfirmToken` — no bypass flag), and the single
 * ownership rule every deletion in this tool must satisfy
 * (`isOwnedByInstallation`): a `deployz:installation` tag, membership in a
 * stack whose name AND tag/InstallationId match a manifest deployment, or a
 * DB-mapped `physical_resource_id`. A resource's name or prefix alone is
 * NEVER sufficient proof of ownership.
 */

// ── Protected control-plane inventory ───────────────────────────────────────

export interface ProtectedInventory {
  readonly stackNames: ReadonlySet<string>;
  readonly bucketNamePatterns: readonly RegExp[];
  readonly ecrRepositoryNames: ReadonlySet<string>;
}

const PROTECTED_STACK_NAMES = ['Deployz', 'CDKToolkit'] as const;

/** Bucket-name prefixes the control-plane stack provisions — see deployz-stack.ts. */
const PROTECTED_BUCKET_PATTERNS = [
  /^deployz-buildsourcebucket/i,
  /^deployz-templatebucket/i,
  /^cdk-/i,
] as const;

const PROTECTED_ECR_REPOSITORIES = ['deployz-images'] as const;

export function buildProtectedInventory(): ProtectedInventory {
  return {
    stackNames: new Set(PROTECTED_STACK_NAMES),
    bucketNamePatterns: PROTECTED_BUCKET_PATTERNS,
    ecrRepositoryNames: new Set(PROTECTED_ECR_REPOSITORIES),
  };
}

export interface DeletionCandidate {
  readonly kind: 'stack' | 'bucket' | 'ecr-repository' | 'other';
  readonly name: string;
  /** The `aws:cloudformation:stack-name` tag value, when the resource carries one. */
  readonly cloudformationStackName?: string;
}

/**
 * Throws the moment any deletion candidate matches the hardcoded
 * control-plane invariants — 'Deployz'/'CDKToolkit' stacks, anything tagged
 * as belonging to one of them, the build-source/template buckets, the `cdk-*`
 * bootstrap buckets, or the `deployz-images` ECR repository.
 */
export function assertNoOverlap(
  candidates: readonly DeletionCandidate[],
  protectedInventory: ProtectedInventory,
): void {
  for (const candidate of candidates) {
    if (candidate.kind === 'stack' && protectedInventory.stackNames.has(candidate.name)) {
      throw new Error(
        `Refusing to proceed: "${candidate.name}" is a protected control-plane stack`,
      );
    }
    if (
      candidate.cloudformationStackName !== undefined &&
      protectedInventory.stackNames.has(candidate.cloudformationStackName)
    ) {
      throw new Error(
        `Refusing to proceed: "${candidate.name}" belongs to protected stack "${candidate.cloudformationStackName}"`,
      );
    }
    if (
      candidate.kind === 'bucket' &&
      protectedInventory.bucketNamePatterns.some((pattern) => pattern.test(candidate.name))
    ) {
      throw new Error(
        `Refusing to proceed: "${candidate.name}" matches a protected bucket name pattern`,
      );
    }
    if (
      candidate.kind === 'ecr-repository' &&
      protectedInventory.ecrRepositoryNames.has(candidate.name)
    ) {
      throw new Error(`Refusing to proceed: "${candidate.name}" is the protected ECR repository`);
    }
  }
}

// ── Confirmation gate ────────────────────────────────────────────────────────

export const CONFIRM_TOKEN = 'FULL-CUSTOMER-RESET';

/**
 * Hard-fails unless `--confirm FULL-CUSTOMER-RESET` is present in argv.
 * There is deliberately no bypass/force flag — the token must be typed.
 */
export function requireConfirmToken(argv: readonly string[]): void {
  const flagIndex = argv.indexOf('--confirm');
  const token = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (token !== CONFIRM_TOKEN) {
    throw new Error(
      `Refusing to execute: pass --confirm ${CONFIRM_TOKEN} to run the destructive customer reset`,
    );
  }
}

// ── Ownership gate ───────────────────────────────────────────────────────────

export interface OwnershipEvidence {
  /** The resource/stack's own `deployz:installation` tag value, if readable. */
  readonly taggedInstallationId?: string | undefined;
  /** True when the resource's stack name AND tag/InstallationId both match a manifest deployment. */
  readonly stackMatchesManifest?: boolean | undefined;
  /** True when a `deployment_resources` row maps this exact `physical_resource_id`. */
  readonly dbMappedPhysicalId?: boolean | undefined;
}

/**
 * The single ownership gate every deletion in this tool passes through
 * before it touches AWS. A resource's name or prefix (e.g. "it starts with
 * deployz-app-") is NEVER, on its own, sufficient — one of the three
 * positive proofs below must hold.
 */
export function isOwnedByInstallation(evidence: OwnershipEvidence, installationId: string): boolean {
  if (evidence.taggedInstallationId !== undefined) {
    return evidence.taggedInstallationId === installationId;
  }
  if (evidence.dbMappedPhysicalId === true) return true;
  if (evidence.stackMatchesManifest === true) return true;
  return false;
}
