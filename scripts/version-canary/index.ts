/**
 * Version/rollback AWS canary — entry point.
 *
 *   pnpm e2e:canary:versions preflight             identity, region, control plane, fixture tags (no mutation)
 *   pnpm e2e:canary:versions core [--keep]         the golden path (docs/testing/version-rollback-canary.md)
 *   pnpm e2e:canary:versions resilience [--keep]   duplicate/concurrent requests and relay interruption
 *   pnpm e2e:canary:versions profile --profile <pg|stateless|redis> [--run-id <id>]
 *                                                  one infrastructure profile: install + teardown, no version ladder
 *   pnpm e2e:canary:versions cleanup --run-id <id> product destroy/purge + canary leftovers for a recorded run
 *   pnpm e2e:canary:versions audit --run-id <id> [--expect-regional-cert-removed]
 *                                                  leak audit for a recorded run (read-only)
 *
 * Regional HTTPS certificates (docs/https-regional-certificates.md
 * Verification plan) add:
 *
 *   --customer-id <uuid> | --reuse-customer-from <runId>   (core, profile)
 *       deploy for an EXISTING customer instead of minting a throwaway one —
 *       scenario B (same customer+region, certificate reused) and C (a new
 *       region for that customer). --customer-id alone only reuses the
 *       customer id. --reuse-customer-from implies the fuller reuse
 *       scenario B/C actually needs: it reads the customer id AND signs in
 *       as that run's vendor AND copies its applicationId/v1 release/
 *       template instead of building them again — a second deployment for
 *       the same customer must be the same vendor org (a customer belongs
 *       to one org) and, for B/C's purpose, the same image + template.
 *   pnpm e2e:canary:versions wait-https --run-id <id> [--timeout <min>]
 *       waits for an existing deployment's default HTTPS to reach ACTIVE and
 *       records installSucceededAt/httpsActiveAt/httpsSetupSeconds plus the
 *       regional certificate facts — the same step core/profile already run
 *       after install, reusable standalone (e.g. after scenario D's recovery).
 *   pnpm e2e:canary:versions delete-regional-certificate --run-id <id> [--region <r>] | --scope <scope> --region <r>
 *       scenario D: deletes the run's regional certificate(s) out of band so
 *       the next reconcile cycle requests a replacement. Refuses (reports,
 *       never retries) a certificate ACM still reports in use.
 *
 * Always through scripts/e2e.mjs, which enforces DEPLOYZ_E2E_ALLOW_REAL_AWS=1
 * before anything runs; this file checks it again.
 */
import { parseArgs } from 'node:util';

import { loadConfig, requireRealAwsOptIn } from './config.js';
import { ControlPlane } from './control-plane.js';
import { Evidence, type RunRecord } from './evidence.js';
import { runResilience } from './resilience.js';
import { runCore, runProfile } from './scenarios.js';
import { preflight, waitForHttpsActive, type Canary } from './steps.js';
import { deleteRegionalCertificate, destroyThroughProduct, leakAudit, removeCanaryLeftovers } from './teardown.js';

function usage(): void {
  console.error(
    'Usage: e2e:canary:versions <preflight' +
      '|core [--keep] [--existing-image=<digest>] [--reuse-stack] [--customer-id <uuid>|--reuse-customer-from <runId>]' +
      '|resilience [--keep]' +
      '|profile --profile <pg|stateless|redis> [--run-id <id>] [--customer-id <uuid>|--reuse-customer-from <runId>]' +
      '|cleanup --run-id <id>' +
      '|audit --run-id <id> [--expect-regional-cert-removed]' +
      '|wait-https --run-id <id> [--timeout <min>]' +
      '|delete-regional-certificate --run-id <id> [--region <r>] | --scope <scope> --region <r>>',
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
      'existing-image': { type: 'string' },
      'reuse-stack': { type: 'boolean', default: false },
      profile: { type: 'string' },
      'customer-id': { type: 'string' },
      'reuse-customer-from': { type: 'string' },
      'expect-regional-cert-removed': { type: 'boolean', default: false },
      scope: { type: 'string' },
      region: { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  const [command] = positionals;
  let config = loadConfig(process.env, {
    ...(values['run-id'] ? { runId: values['run-id'] } : {}),
    keep: values.keep,
    ...(values['existing-image'] ? { existingImageDigest: values['existing-image'] } : {}),
    reuseStack: values['reuse-stack'],
    ...(values['profile'] ? { profileName: values['profile'] } : {}),
    ...(values['customer-id'] ? { customerId: values['customer-id'] } : {}),
    expectRegionalCertRemoved: values['expect-regional-cert-removed'],
  });
  // --reuse-customer-from resolves against a prior run's evidence, so it
  // needs config.resultsDir first; --customer-id (above) always wins and
  // does NOT imply the fuller reuse below (reuseRunId stays null) — a
  // deliberate simplification: reuse-customer-from is the one flag for
  // "make this run scenario B/C", customer-id alone stays the lighter,
  // customer-only override it always was.
  if (!config.customerId && values['reuse-customer-from']) {
    const priorRunId = values['reuse-customer-from'];
    const priorCustomerId = Evidence.open(config.resultsDir, priorRunId).run.customerId;
    if (!priorCustomerId) throw new Error(`Run ${priorRunId} recorded no customerId in its evidence`);
    config = { ...config, customerId: priorCustomerId, reuseRunId: priorRunId };
  }

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
    case 'profile': {
      if (!values['profile']) throw new Error('profile needs --profile <pg|stateless|redis>');
      if (!config.profile) throw new Error(`--profile "${values['profile']}" did not resolve to a profile`);
      const evidence = new Evidence(config.resultsDir, newRun(config, `profile-${config.profile.name}`));
      const canary: Canary = { config, evidence, api: new ControlPlane(config.apiUrl, config.webUrl) };
      console.log(`Run ${config.runId} (profile ${config.profile.name}) — evidence in ${evidence.dir}`);
      try {
        await runProfile(canary);
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
    case 'wait-https': {
      if (!values['run-id']) throw new Error('wait-https needs --run-id');
      const evidence = Evidence.open(config.resultsDir, values['run-id']);
      evidence.run.scenario = 'wait-https';
      const canary: Canary = { config, evidence, api: new ControlPlane(config.apiUrl, config.webUrl) };
      if (evidence.run.vendor) await canary.api.signIn(evidence.run.vendor);
      const timeoutMs = values.timeout ? Number(values.timeout) * 60_000 : undefined;
      try {
        await (timeoutMs ? waitForHttpsActive(canary, timeoutMs) : waitForHttpsActive(canary));
        evidence.finish('PASS');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        evidence.finish('FAIL');
        process.exitCode = 1;
      }
      return;
    }
    case 'delete-regional-certificate': {
      let evidence: Evidence;
      let scope = values.scope;
      let region = values.region ?? config.region;
      if (values['run-id']) {
        evidence = Evidence.open(config.resultsDir, values['run-id']);
        scope = scope ?? evidence.run.customerDnsScope;
        region = values.region ?? evidence.run.region ?? region;
      } else {
        if (!scope) throw new Error('delete-regional-certificate needs --run-id <id>, or --scope <scope> --region <r>');
        evidence = new Evidence(config.resultsDir, newRun(config, 'delete-regional-certificate'));
      }
      if (!scope) throw new Error(`run ${values['run-id']} recorded no customerDnsScope — pass --scope explicitly`);
      evidence.run.scenario = 'delete-regional-certificate';
      const canary: Canary = { config, evidence, api: new ControlPlane(config.apiUrl, config.webUrl) };
      try {
        await deleteRegionalCertificate(canary, scope, region);
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
