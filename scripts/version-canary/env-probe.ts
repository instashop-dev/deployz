/**
 * Runtime environment probe (docs/testing/aws-e2e.md, "env-probe"): proves
 * which environment values a deployed application's container actually
 * receives — not what the database or the UI says it should receive.
 *
 * It starts one Fargate task from the web service's CURRENT task definition
 * (ECS injects the same `environment` and `secrets` as for the application
 * container) with the command replaced by a POSIX shell script that prints,
 * per key, `absent` or `present` with the byte length and a SHA-256 prefix.
 * A value is never printed. The expected side hashes the intended plaintext
 * the same way, so equal prefixes mean the exact intended value arrived.
 */
import { createHash } from 'node:crypto';

import { aws } from './aws.js';
import { CANARY_TAGS } from './config.js';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_PREFIX = 'ENVPROBE';

export type ProbedValue = { readonly present: false } | { readonly present: true; readonly length: number; readonly sha256Prefix: string };

/** The shell script the probe task runs. Keys are validated: nothing else reaches the shell. */
export function buildEnvProbeScript(keys: readonly string[]): string {
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new Error(`not an environment variable name: ${key}`);
  }
  const lines = keys.map(
    (key) =>
      `if printenv ${key} >/dev/null 2>&1; then v="$(printenv ${key})"; ` +
      `printf '${LINE_PREFIX} %s present %s %s\\n' ${key} "$(printf %s "$v" | wc -c | tr -d ' ')" "$(printf %s "$v" | sha256sum | cut -c1-16)"; ` +
      `else printf '${LINE_PREFIX} %s absent\\n' ${key}; fi`,
  );
  return [...lines, `echo '${LINE_PREFIX} done'`].join('; ');
}

/** What the probe printed, keyed by variable. Null when the probe did not finish. */
export function parseEnvProbeLines(lines: readonly string[]): Record<string, ProbedValue> | null {
  if (!lines.some((line) => line.trim() === `${LINE_PREFIX} done`)) return null;
  const result: Record<string, ProbedValue> = {};
  for (const line of lines) {
    const present = new RegExp(`^${LINE_PREFIX} (\\S+) present (\\d+) ([0-9a-f]{16})$`).exec(line.trim());
    if (present) {
      result[present[1]!] = { present: true, length: Number(present[2]), sha256Prefix: present[3]! };
      continue;
    }
    const absent = new RegExp(`^${LINE_PREFIX} (\\S+) absent$`).exec(line.trim());
    if (absent) result[absent[1]!] = { present: false };
  }
  return result;
}

/** The probe output an exact intended value produces (`$(…)` drops trailing newlines, as the script does). */
export function expectedProbe(value: string | null): ProbedValue {
  if (value === null) return { present: false };
  const normalized = value.replace(/\n+$/, '');
  return {
    present: true,
    length: Buffer.byteLength(normalized, 'utf8'),
    sha256Prefix: createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16),
  };
}

/** Keys whose probed value differs from the expectation; `present: true` alone accepts any value. */
export function compareEnvProbe(
  probed: Record<string, ProbedValue>,
  expected: Record<string, ProbedValue | { readonly present: true }>,
): string[] {
  const mismatches: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = probed[key] ?? { present: false };
    if (got.present !== want.present) {
      mismatches.push(`${key}: expected ${want.present ? 'present' : 'absent'}, got ${got.present ? 'present' : 'absent'}`);
    } else if (got.present && 'sha256Prefix' in want && (got.sha256Prefix !== want.sha256Prefix || got.length !== want.length)) {
      mismatches.push(`${key}: value differs (length ${got.length}, expected ${want.length})`);
    }
  }
  return mismatches;
}

/** Runs the probe against the web service of `stackName` and returns what the container saw. */
export async function probeRuntimeEnv(
  region: string,
  stackName: string,
  keys: readonly string[],
  runId: string,
): Promise<{ taskDefinition: string; values: Record<string, ProbedValue> }> {
  const script = buildEnvProbeScript(keys);
  const resources = (
    (await aws(['cloudformation', 'describe-stack-resources', '--stack-name', stackName], region)) as {
      StackResources: { ResourceType: string; PhysicalResourceId?: string; LogicalResourceId: string }[];
    }
  ).StackResources;
  const services = resources.filter((r) => r.ResourceType === 'AWS::ECS::Service' && r.PhysicalResourceId);
  const serviceArn = (services.find((r) => !/worker/i.test(r.LogicalResourceId)) ?? services[0])?.PhysicalResourceId;
  if (!serviceArn) throw new Error(`stack ${stackName} has no ECS service`);
  const cluster = serviceArn.split('/')[1]!;
  const service = (
    (await aws(['ecs', 'describe-services', '--cluster', cluster, '--services', serviceArn], region)) as {
      services: { taskDefinition: string; networkConfiguration: { awsvpcConfiguration: unknown } }[];
    }
  ).services[0]!;
  const definition = (
    (await aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition], region)) as {
      taskDefinition: {
        containerDefinitions: { name: string; environment?: unknown[]; logConfiguration?: { options?: Record<string, string> } }[];
      };
    }
  ).taskDefinition;
  const container =
    definition.containerDefinitions.find((c) => (c.environment ?? []).length > 0) ?? definition.containerDefinitions[0]!;

  const started = (await aws(
    [
      'ecs', 'run-task',
      '--cluster', cluster,
      '--task-definition', service.taskDefinition,
      '--launch-type', 'FARGATE',
      '--network-configuration', JSON.stringify({ awsvpcConfiguration: service.networkConfiguration.awsvpcConfiguration }),
      '--overrides', JSON.stringify({ containerOverrides: [{ name: container.name, command: ['sh', '-c', script] }] }),
      '--started-by', 'deployz-env-probe',
      '--tags', `key=${CANARY_TAGS.run},value=${runId}`,
    ],
    region,
  )) as { tasks: { taskArn: string }[]; failures: unknown[] };
  const taskArn = started.tasks[0]?.taskArn;
  if (!taskArn) throw new Error(`env probe task did not start: ${JSON.stringify(started.failures)}`);
  await aws(['ecs', 'wait', 'tasks-stopped', '--cluster', cluster, '--tasks', taskArn], region);

  const options = container.logConfiguration?.options ?? {};
  const logGroup = options['awslogs-group'];
  const logStream = `${options['awslogs-stream-prefix']}/${container.name}/${taskArn.split('/').pop()}`;
  if (!logGroup) throw new Error(`container ${container.name} has no awslogs group`);
  for (let attempt = 0; attempt < 10; attempt++) {
    const events = (await aws(['logs', 'get-log-events', '--log-group-name', logGroup, '--log-stream-name', logStream], region).catch(
      () => ({ events: [] }),
    )) as { events: { message: string }[] };
    const values = parseEnvProbeLines(events.events.map((event) => event.message));
    if (values) return { taskDefinition: service.taskDefinition, values };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`env probe output never reached ${logGroup}/${logStream}`);
}
