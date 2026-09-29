import type { ApplicationGraph } from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Relationship validation (Phase 5B) — the planner's fail-closed check that
// the graph's explicit edges form a deployable composition before any
// capability is resolved. Pure: returns the violations, never throws.
//
//   produce / consume : workload → queue
//   dead-letter       : queue → queue (redrive) or schedule → queue
//   invoke            : schedule → scheduled-job workload
//
// A queue must be reachable (a producer AND a consumer, or a dead-letter
// target); a schedule invokes exactly one scheduled job and every scheduled
// job is invoked by exactly one schedule. Removing one side of a
// relationship therefore fails the plan instead of provisioning an orphan.
// ---------------------------------------------------------------------------

export function relationshipViolations(graph: ApplicationGraph): string[] {
  const violations: string[] = [];
  const schedules = graph.schedules ?? [];
  const workloads = new Map(graph.workloads.map((w) => [w.id, w] as const));
  const resources = new Map(graph.resources.map((r) => [r.id, r] as const));
  const scheduleIds = new Set(schedules.map((s) => s.id));

  const seen = new Set<string>();
  for (const id of [...workloads.keys(), ...resources.keys(), ...scheduleIds]) {
    if (seen.has(id)) violations.push(`duplicate component id "${id}"`);
    seen.add(id);
  }

  const isQueue = (id: string): boolean => resources.get(id)?.kind === 'queue';
  const deadLetterSources = new Map<string, number>();

  for (const binding of graph.bindings) {
    const { access, sourceId, targetId } = binding;
    if (!seen.has(sourceId) || !seen.has(targetId)) {
      violations.push(`binding ${binding.id} references an unknown component (${sourceId} → ${targetId})`);
      continue;
    }
    if (access === 'produce' || access === 'consume') {
      if (!workloads.has(sourceId) || !isQueue(targetId)) {
        violations.push(`binding ${binding.id}: ${access} must connect a workload to a queue`);
      }
    } else if (access === 'dead-letter') {
      const fromQueue = isQueue(sourceId);
      if ((!fromQueue && !scheduleIds.has(sourceId)) || !isQueue(targetId) || sourceId === targetId) {
        violations.push(`binding ${binding.id}: dead-letter must connect a queue or schedule to another queue`);
      }
      if (fromQueue !== (binding.maxReceiveCount !== undefined)) {
        violations.push(`binding ${binding.id}: maxReceiveCount belongs on queue redrive edges only`);
      }
      deadLetterSources.set(sourceId, (deadLetterSources.get(sourceId) ?? 0) + 1);
    } else if (access === 'invoke') {
      if (!scheduleIds.has(sourceId) || workloads.get(targetId)?.kind !== 'scheduled-job') {
        violations.push(`binding ${binding.id}: invoke must connect a schedule to a scheduled job`);
      }
    } else if (binding.maxReceiveCount !== undefined) {
      violations.push(`binding ${binding.id}: maxReceiveCount without a dead-letter access`);
    }
  }

  for (const [sourceId, count] of deadLetterSources) {
    if (count > 1) violations.push(`${sourceId} has more than one dead-letter queue`);
  }
  const deadLetterTargets = new Set(
    graph.bindings.filter((b) => b.access === 'dead-letter').map((b) => b.targetId),
  );
  for (const target of deadLetterTargets) {
    if (deadLetterSources.has(target)) violations.push(`dead-letter queue ${target} may not itself redrive`);
  }

  for (const resource of graph.resources) {
    if (resource.kind !== 'queue' || resource.ownership !== 'DEPLOYZ_MANAGED') continue;
    if (deadLetterTargets.has(resource.id)) continue;
    const edges = graph.bindings.filter((b) => b.targetId === resource.id);
    if (!edges.some((b) => b.access === 'produce') || !edges.some((b) => b.access === 'consume')) {
      violations.push(`queue ${resource.id} needs at least one producer and one consumer`);
    }
  }

  for (const schedule of schedules) {
    const invokes = graph.bindings.filter((b) => b.sourceId === schedule.id && b.access === 'invoke');
    if (invokes.length !== 1) violations.push(`schedule ${schedule.id} must invoke exactly one scheduled job`);
  }
  for (const workload of graph.workloads) {
    if (workload.kind !== 'scheduled-job') continue;
    if (workload.command === null) violations.push(`scheduled job ${workload.id} has no command`);
    const invokedBy = graph.bindings.filter((b) => b.targetId === workload.id && b.access === 'invoke');
    if (invokedBy.length !== 1) violations.push(`scheduled job ${workload.id} must be invoked by exactly one schedule`);
  }

  return violations;
}
