/**
 * Full stack resource inventory — ListStackResources paged to completion.
 *
 * This is the raw-observation half of the inventory pipeline: the verify
 * module answers the health question, this answers the "what exists" question,
 * from the SAME stack the relay already polls. No account-wide sweep — the
 * read is scoped to one stack, the one the installation tag ties to this
 * relay.
 *
 * Fail-closed: a partial read is NOT an incomplete snapshot, it is NO
 * snapshot. Any page failure, any stack lookup failure, resolves the whole
 * call to `null`, and the caller keeps whatever it had before. A finished
 * stack with no resources is a legitimate empty inventory, not a failure —
 * distinguishing the two is why the stack lookup happens first.
 */

import type { CloudFormationReader, StackResource } from './verify.js';

export interface StackInventory {
  readonly stackId: string;
  readonly resources: readonly StackResource[];
}

export async function listAllStackResources(
  reader: CloudFormationReader,
  stackName: string,
): Promise<StackInventory | null> {
  try {
    const lookup = await reader.describeStack(stackName);
    if (!lookup.found || lookup.stack.stackId === undefined) return null;

    const resources: StackResource[] = [];
    let nextToken: string | undefined;
    do {
      const page = await reader.listStackResources?.(stackName, nextToken);
      if (!page) {
        console.log(
          JSON.stringify({ event: 'relay:inventory-page-failed', stackName, nextToken }),
        );
        return null;
      }
      resources.push(...page.resources);
      nextToken = page.nextToken;
    } while (nextToken !== undefined);

    return { stackId: lookup.stack.stackId, resources };
  } catch (error) {
    // A reader that broke its no-throw contract must not take the inventory
    // down with it — same fail-closed rule as the page null check above.
    console.log(
      JSON.stringify({
        event: 'relay:inventory-failed',
        stackName,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}