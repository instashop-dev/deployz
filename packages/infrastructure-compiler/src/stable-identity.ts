// ---------------------------------------------------------------------------
// Stable resource identity — the P0 backbone of dynamic-compiler-v2.
//
// Every managed AWS resource gets a stable CloudFormation logical id derived
// deterministically from semantic identity. CloudFormation logical ids allow
// only alphanumerics, so a componentId + resourceRole pair is PascalCased
// (the capability is carried in the role token and in the resolved-resource
// metadata, not re-encoded here — see resolved-graph.ts).
//
// A refactor must never silently change these ids: changing a resource's id
// is a CloudFormation replacement. The golden test
// (stable-identity.test.ts) pins every id this module produces.
// ---------------------------------------------------------------------------

/** A stable role token for one logical resource (e.g. 'rds-instance', 'secret'). */
export type ResourceRole = string;

/**
 * PascalCase a dash/slash/space-separated token list. Deterministic and
 * collapsible: 'primary-db' + 'rds-instance' -> 'PrimaryDbRdsInstance'.
 */
export function pascalCase(...tokens: readonly string[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    for (const word of token.split(/[^A-Za-z0-9]+/)) {
      if (word.length === 0) continue;
      parts.push(word.charAt(0).toUpperCase() + word.slice(1));
    }
  }
  return parts.join('');
}

/**
 * The stable logical id for a managed resource: `componentId` + `resourceRole`.
 * `resourceRole` encodes the capability (e.g. 'rds-instance' is the
 * aws.rds-postgres role 'instance'), so the id is stable across compiler
 * refactors that do not change the semantic shape of the resource.
 */
export function logicalResourceId(componentId: string, resourceRole: ResourceRole): string {
  return pascalCase(componentId, resourceRole);
}

/**
 * Validate a compiled graph's logical ids: every id must be unique, non-empty
 * and alphanumeric (CloudFormation's constraint). Returns a list of violations
 * — the compiler fails closed when non-empty.
 */
export function logicalIdViolations(ids: readonly string[]): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
      violations.push(`invalid logical id: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      violations.push(`duplicate logical id: ${id}`);
    }
    seen.add(id);
  }
  return violations;
}
