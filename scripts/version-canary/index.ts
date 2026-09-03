/**
 * Version/rollback AWS canary — entry point.
 *
 *   pnpm e2e:canary:versions preflight             identity, region, control plane, fixture tags (no mutation)
 *   pnpm e2e:canary:versions core [--keep]         the golden path (docs/testing/version-rollback-canary.md)
 *   pnpm e2e:canary:versions resilience [--keep]   duplicate/concurrent requests and relay interruption
 *   pnpm e2e:canary:versions cleanup --run-id <id> product destroy/purge + canary leftovers for a recorded run
 *   pnpm e2e:canary:versions audit --run-id <id>   leak audit for a recorded run (read-only)
 *
 * Always through scripts/e2e.mjs, which enforces DEPLOYZ_E2E_ALLOW_REAL_AWS=1
 * before anything runs; this file checks it again.
 */
import { parseArgs } from 'node:util';

import { loadConfig, requireRealAwsOptIn } from './config.js';
import { ControlPlane } from './control-plane.js';
import { Evidence, type RunRecord } from './evidence.js';
import { runResilience } from './resilience.js';
import { runCore } from './scenarios.js';
import { preflight, type Canary } from './steps.js';
import { destroyThroughProduct, leakAudit, removeCanaryLeftovers } from './teardown.js';

function usage(): void {
  console.error(
    'Usage: e2e:canary:versions <preflight|core [--keep]|resilience [--keep]|cleanup --run-id <id>|audit --run-id <id>>',
  );
}

function newRun(config: ReturnType<typeof loadConfig>, scenario: string): RunRecord {
  return {
    runId: config.runId,
    startedAt: new Date().toISOString(),
    apiUrl: config.apiUrl,
    region: config.region,
    accountId: config.expectedAccountId,
    scenario,
    releases: {},
    markers: [],
    jobs: [],
    steps: [],
  };
}

async function main(): Promise<void> {
  requireRealAwsOptIn(process.env);
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'run-id': { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const [command] = positionals;
  const config = loadConfig(process.env, {
    ...(values['run-id'] ? { runId: values['run-id'] } : {}),
    keep: values.keep,
  });

  switch (command) {
    case 'preflight': {
      const evidence = new Evidence(config.resultsDir, newRun(config, 'preflight'));
      const canary: Canary = { config, evidence, api: new ControlPlane(config.apiUrl, config.webUrl) };
      await preflight(canary);
      evidence.finish('PASS');
      return;
    }
    case 'core':
    case 'resilience': {
      const evidence = new Evidence(config.resultsDir, newRun(config, command));
      const canary: Canary = { config, evidence, api: new ControlPlane(config.apiUrl, config.webUrl) };
      console.log(`Run ${config.runId} (${command}) — evidence in ${evidence.dir}`);
      try {
        await (command === 'core' ? runCore(canary) : runResilience(canary));
        evidence.finish('PASS');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        evidence.finish('FAIL');
        process.exitCode = 1;
      }
      return;
    }
    case 'cleanup': {
      if (!values['run-id']) throw new Error('cleanup needs --run-id');
      const evidence = Evidence.open(config.resultsDir, values['run-id']);
      evidence.run.scenario = 'cleanup';
      const api = new ControlPlane(config.apiUrl, config.webUrl);
      if (evidence.run.vendor) await api.signIn(evidence.run.vendor);
      const canary: Canary = { config, evidence, api };
      try {
        if (evidence.run.vendor) await destroyThroughProduct(canary);
        await removeCanaryLeftovers(canary);
        await leakAudit(canary);
        evidence.finish('PASS');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        evidence.finish('FAIL');
        process.exitCode = 1;
      }
      return;
    }
    case 'audit': {
      if (!values['run-id']) throw new Error('audit needs --run-id');
      const evidence = Evidence.open(config.resultsDir, values['run-id']);
      evidence.run.scenario = 'audit';
      const canary: Canary = { config, evidence, api: new ControlPlane(config.apiUrl, config.webUrl) };
      try {
        await leakAudit(canary);
        evidence.finish('PASS');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        evidence.finish('FAIL');
        process.exitCode = 1;
      }
      return;
    }
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
