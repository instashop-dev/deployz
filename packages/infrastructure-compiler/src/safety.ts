import type { DeployzIR } from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Destructive-change safety — fail closed on unsupported infrastructure
// changes.
//
// The MVP has no update path: a release may change the image or the config,
// but never the topology. Any change that would replace or delete a managed
// resource — especially a stateful one (lifecycle `retain`) — is rejected
// before CloudFormation is invoked. This is the deliberate stop-gap before
// semantic diffing, Change Sets and migration workflows (post-MVP).
//
// This is a pure function: no AWS, no clock, no randomness.
// ---------------------------------------------------------------------------

export interface IrSafetyResult {
  /** True when the proposed IR is safe against the frozen IR. */
  readonly safe: boolean;
  /** Human-readable reasons the change is unsafe (empty when safe). */
  readonly reasons: string[];
}

/**
 * Compare a proposed IR against the frozen IR and reject any change that
 * would replace or delete a managed stateful resource.
 *
 * Additive resources and non-stateful (lifecycle `delete`) resource changes
 * are allowed — those cannot destroy retained customer data.
 */
export function assertNoDestructiveStatefulChanges(
  previous: DeployzIR,
  next: DeployzIR,
): IrSafetyResult {
  const reasons: string[] = [];

  const nextByComponent = new Map(next.resources.map((r) => [r.componentId, r]));

  for (const prev of previous.resources) {
    if (prev.lifecycle !== 'retain') continue;

    const nextResource = nextByComponent.get(prev.componentId);
    if (nextResource === undefined) {
      reasons.push(`stateful resource "${prev.componentId}" would be removed`);
      continue;
    }
    if (nextResource.capabilityKey !== prev.capabilityKey) {
      reasons.push(
        `stateful resource "${prev.componentId}" would change capability ` +
          `from "${prev.capabilityKey}" to "${nextResource.capabilityKey}" (replacement)`,
      );
    }
  }

  return { safe: reasons.length === 0, reasons };
}
