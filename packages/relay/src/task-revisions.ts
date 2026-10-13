/**
 * Best-effort cleanup of task-definition revisions the relay registered.
 * DEPLOY_RELEASE, ROLLBACK and CONFIG_UPDATE register a revision per update
 * and nothing else removes them. Called only after an update has SETTLED
 * successfully; it never fails or delays the command result.
 *
 * Only families this stack created, and only on a stack whose families are
 * its own: a family without the installation's suffix is shared by every
 * installation in the account and Region, so it is never touched.
 */

import type { EcsDeployClient } from './deploy.js';
import { listAllStackResources } from './stack-resources.js';
import type { CloudFormationReader } from './verify.js';

/** Newest revisions of a family kept as rollback headroom. */
const HEADROOM_REVISIONS = 3;
/** Deregistrations per invocation. */
const MAX_DEREGISTRATIONS = 10;
const SERVICES_PER_DESCRIBE = 10;

const familyOf = (arn: string): string | null => /:task-definition\/([A-Za-z0-9_-]+):\d+$/.exec(arn)?.[1] ?? null;
const revisionOf = (arn: string): number => Number(/:(\d+)$/.exec(arn)?.[1] ?? 0);

export async function pruneSupersededRevisions(
  deps: { readonly cfn: CloudFormationReader; readonly ecs: EcsDeployClient; readonly stackName: string },
  protectedArns: readonly string[] = [],
): Promise<void> {
  const { listTaskDefinitions, deregisterTaskDefinition } = deps.ecs;
  if (listTaskDefinitions === undefined || deregisterTaskDefinition === undefined) return;
  try {
    const lookup = await deps.cfn.describeStack(deps.stackName);
    if (!lookup.found) return;
    const suffix = (lookup.stack.tags['deployz:installation'] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (suffix.length === 0) return;
    const inventory = await listAllStackResources(deps.cfn, deps.stackName);
    if (inventory === null) return;

    const stackCreated = inventory.resources.flatMap((r) =>
      r.type === 'AWS::ECS::TaskDefinition' && r.physicalId !== undefined ? [r.physicalId] : [],
    );
    const families = new Set(
      stackCreated.flatMap((arn) => {
        const family = familyOf(arn);
        return family !== null && family.startsWith('DeployzApp') && family.endsWith(suffix) ? [family] : [];
      }),
    );
    if (families.size === 0) return;

    const serviceArns = inventory.resources.flatMap((r) =>
      r.type === 'AWS::ECS::Service' && r.physicalId !== undefined ? [r.physicalId] : [],
    );
    const keep = new Set([...stackCreated, ...protectedArns]);
    const cluster = serviceArns[0]?.split('/')[1];
    if (cluster !== undefined) {
      for (let i = 0; i < serviceArns.length; i += SERVICES_PER_DESCRIBE) {
        const { services } = await deps.ecs.describeServices({
          cluster,
          services: serviceArns.slice(i, i + SERVICES_PER_DESCRIBE),
        });
        for (const service of services) {
          if (service.taskDefinition !== undefined) keep.add(service.taskDefinition);
          for (const deployment of service.deployments ?? []) {
            if (deployment.taskDefinition !== undefined) keep.add(deployment.taskDefinition);
          }
        }
      }
    }

    let remaining = MAX_DEREGISTRATIONS;
    for (const family of families) {
      if (remaining === 0) return;
      const { taskDefinitionArns } = await listTaskDefinitions({ familyPrefix: family, status: 'ACTIVE' });
      const revisions = taskDefinitionArns
        .filter((arn) => familyOf(arn) === family)
        .sort((a, b) => revisionOf(b) - revisionOf(a));
      for (const arn of revisions.slice(HEADROOM_REVISIONS).reverse()) {
        if (remaining === 0) return;
        if (keep.has(arn)) continue;
        await deregisterTaskDefinition({ taskDefinition: arn });
        remaining -= 1;
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ event: 'relay:revision-prune-skipped', error: String(error) }));
  }
}
