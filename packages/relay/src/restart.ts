/**
 * RESTART executor and resumer — force a new deployment of every workload
 * and report only after each restarted service settled on that rollout.
 *
 * The rollouts ride the pending marker (the same `configRollouts` shape a
 * CONFIG_UPDATE records), so a later invocation resumes the wait and a
 * re-offered command with its own marker never forces a second deployment.
 * The settle gates are the CONFIG_UPDATE gates (`settleConfigRollouts`).
 */

import type { CommandExecutor, RelayCommandResult } from './commands.js';
import {
  readConfigRollouts,
  settleConfigRollouts,
  type ConfigRollout,
  type ConfigRolloutDeps,
  type RolloutVerdict,
} from './config-update.js';
import { findServiceViews, type EcsDeployDeps } from './deploy.js';

function verdictResult(commandId: string, idempotencyKey: string, verdict: RolloutVerdict): RelayCommandResult | null {
  if (verdict.state === 'in-progress') return null;
  if (verdict.state === 'failed') {
    return { commandId, idempotencyKey, success: false, error: verdict.reason, failureCode: verdict.failureCode };
  }
  return { commandId, idempotencyKey, success: true, output: { executed: true, type: 'RESTART' } };
}

/** The RESTART executor: force a new deployment of EVERY workload's current definition. */
export function createRestartExecutor(deps: EcsDeployDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );
    const base = { commandId: command.id, idempotencyKey: command.idempotencyKey };

    try {
      // A re-offered command whose rollouts are already on its own marker
      // only waits for them; it never forces a second deployment.
      const existing = await deps.pending.read();
      if (existing?.commandId === command.id && existing.type === 'RESTART') {
        const rollouts = readConfigRollouts(existing.payload);
        if (rollouts === null) {
          await deps.pending.clear();
          return { ...base, success: false, error: 'Pending restart lost its rollouts' };
        }
        const settled = verdictResult(
          command.id,
          command.idempotencyKey,
          await settleConfigRollouts(deps, rollouts, 'restart'),
        );
        if (settled === null) return { ...base, success: false, deferred: true };
        await deps.pending.clear();
        return settled;
      }

      const views = await findServiceViews(deps);
      if (views === null) {
        // Nothing is mutated yet and nothing is known: not a failure. The
        // control plane re-offers the command (uncertain-result rule).
        return { ...base, success: false, deferred: true };
      }
      if (views.length === 0) {
        return { ...base, success: false, error: `No ECS service found in stack "${deps.stackName}"` };
      }
      const cluster = views[0]!.arn.split('/')[1] ?? null;
      if (!cluster) {
        return { ...base, success: false, error: `Malformed service ARN "${views[0]!.arn}"` };
      }

      // The services' rolling replacement makes forceNewDeployment safe: it
      // never leaves a service with zero tasks. Every workload restarts — a
      // worker has no HTTP surface, so its service replacement is the
      // restart. A service at zero tasks has nothing to replace.
      const { services } = await deps.ecs.describeServices({ cluster, services: views.map((view) => view.arn) });
      const rollouts: Record<string, ConfigRollout> = {};
      for (let i = 0; i < views.length; i++) {
        const live = services[i];
        if ((live?.desiredCount ?? 0) === 0 || live?.taskDefinition === undefined) continue;
        await deps.ecs.updateService({ cluster, service: views[i]!.arn, forceNewDeployment: true });
        rollouts[views[i]!.arn] = { taskDefinition: live.taskDefinition, newRevision: false };
      }
      const rolloutArns = Object.keys(rollouts);
      if (rolloutArns.length === 0) {
        return { ...base, success: true, output: { executed: true, type: command.type } };
      }

      // The PRIMARY deployment right after the update is the rollout this
      // restart started — its id is what a later poll waits for.
      const { services: started } = await deps.ecs.describeServices({ cluster, services: rolloutArns });
      for (let i = 0; i < rolloutArns.length; i++) {
        const id = started[i]?.deployments?.find((deployment) => deployment.status === 'PRIMARY')?.id;
        if (id !== undefined) rollouts[rolloutArns[i]!] = { ...rollouts[rolloutArns[i]!]!, deploymentId: id };
      }
      const recorded = await deps.pending.write({
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        type: command.type,
        stackName: deps.stackName,
        startedAt: (deps.now ?? (() => new Date().toISOString()))(),
        payload: { configRollouts: rollouts },
      });
      if (!recorded) {
        return {
          ...base,
          success: false,
          error: 'Restart started, but the relay could not record that it must report back',
        };
      }
      return { ...base, success: false, deferred: true };
    } catch (err) {
      return { ...base, success: false, error: String(err), failureCode: 'AWS_PERMISSION_DENIED' };
    }
  };
}

/** Finishes a RESTART rollout an earlier invocation started. */
export function createRestartResumer(deps: ConfigRolloutDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null || pending.type !== 'RESTART') return [];
    const rollouts = readConfigRollouts(pending.payload);
    if (rollouts === null) {
      await deps.pending.clear();
      return [
        {
          commandId: pending.commandId,
          idempotencyKey: pending.idempotencyKey,
          success: false,
          error: 'Pending restart lost its rollouts',
        },
      ];
    }
    const settled = verdictResult(
      pending.commandId,
      pending.idempotencyKey,
      await settleConfigRollouts(deps, rollouts, 'restart'),
    );
    if (settled === null) return [];
    await deps.pending.clear();
    return [settled];
  };
}
