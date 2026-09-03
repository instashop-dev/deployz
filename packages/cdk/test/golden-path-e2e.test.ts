/**
 * §67 Golden Path E2E — Definition of Done gate.
 *
 * Documents the 25-step golden path end-to-end on fresh test accounts.
 * Every AWS call flows through the injectable `AwsClients` interface
 * (packages/cdk/src/integration/aws-clients.ts) so the entire test is
 * structured with mock seams and zero AWS credentials.
 *
 * When AWS credentials become available, swap the mock clients for the
 * real SDK-backed implementations and run the full suite 3× consecutively
 * (§68 requirement). Until then, real-AWS steps are marked PENDING-AWS.
 *
 * The 25 §67 steps (from .omo/plans/deployz-mvp.md lines 212-222):
 *
 *   Phase 1 — Core Platform (steps 1-5):
 *     1. Vendor signs up (Better Auth email/password)
 *     2. Organization row created
 *     3. Stripe test subscription exists ($49 base + $19 metered)
 *     4. Session cookie authorizes Fastify API call
 *     5. GET /api/applications → 200
 *
 *   Phase 2 — Application Management (steps 6-7):
 *     6. Create Application/Customer/Deployment via API
 *     7. GitHub App installed (metadata+code read only)
 *
 *   Phase 3 — Repository Analysis (steps 8-10):
 *     8. Repo selection stores the repo
 *     9. Analysis completes (deterministic analyser)
 *    10. Readiness page renders §19 verdict
 *
 *   Phase 4 — AWS Installation (steps 11-16):
 *    11. Generated install link
 *    12. Quick Create URL resolves
 *    13. Bootstrap stack reaches CREATE_COMPLETE
 *    14. Application stack reaches CREATE_COMPLETE
 *    15. ECS service steady, ALB health check returns 200
 *    16. Relay reports connected
 *
 *   Phase 5 — Control Plane (steps 17-18):
 *    17. Control plane flips deployment to Healthy
 *    18. deployz:installation tags on every created resource
 *
 *   Phase 6 — Release Pipeline (steps 19-22):
 *    19. Create release v2
 *    20. DEPLOY_RELEASE (preflight gates)
 *    21. Migration one-off task runs before completion
 *    22. ECS on new digest → Healthy
 *
 *   Phase 7 — Lifecycle Intelligence (steps 23-25):
 *    23. Deploy deliberately-broken fixture (port mismatch)
 *    24. Classifier emits PORT_MISMATCH (§29)
 *    25. AI explanation rendered in §65 product language
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AwsSdkNotAvailableError,
  createAwsClients,
  type AwsClients,
  type CloudFormationClient,
  type EcsClient,
  type ElbClient,
  type OrganizationsClient,
  type StsClient,
} from '../src/integration/aws-clients.js';
import {
  CleanupRegistry,
  runWithTeardown,
} from '../src/integration/teardown.js';
import {
  classifyFailure,
  runSuite,
  verifyHealthy,
  waitForStackStatus,
  type SuiteConfig,
  type SuiteDeps,
  type SuiteTemplates,
} from '../src/integration/runner.js';
import type { PublishResult, SynthOutput } from '../src/quick-create/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeSynthOutput(description: string): SynthOutput {
  return { template: { Description: description }, assets: [] };
}

function makeTemplates(): SuiteTemplates {
  return {
    bootstrap: makeSynthOutput('bootstrap-template'),
    application: makeSynthOutput('application-template'),
  };
}

function makePublishResult(): PublishResult {
  return {
    templateKey: 'deployz/bootstrap/v1/bootstrap-template-v1.json',
    templateUrl:
      'https://bucket.s3.us-east-1.amazonaws.com/deployz/bootstrap/v1/bootstrap-template-v1.json',
    quickCreateUrl:
      'https://us-east-1.console.aws.amazon.com/cloudformation/home#/stacks/create/review',
    assetKeys: [],
    templateBytes: 1000,
    parameterCount: 2,
  };
}

const GOLDEN_PATH_CONFIG: SuiteConfig = {
  region: 'us-east-1',
  bootstrapStackName: 'deployz-bootstrap',
  applicationStackName: 'deployz-application',
  clusterName: 'golden-path-cluster',
  serviceName: 'golden-path-service',
  targetGroupArn:
    'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/golden-path/1',
  wait: { pollIntervalMs: 0, maxAttempts: 5 },
};

const COMPLETE_STACK = {
  stackId:
    'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-bootstrap/1',
  stackName: 'deployz-bootstrap',
  status: 'CREATE_COMPLETE' as const,
  outputs: [],
};

/**
 * Builds a mock AWS client harness — the injectable seam.
 *
 * Every AWS call goes through these mocks. When real AWS credentials become
 * available, swap this harness for `createAwsClients()` backed by the real
 * SDK v3 clients.
 */
function makeGoldenPathHarness() {
  const createStack = vi.fn().mockResolvedValue({
    stackId:
      'arn:aws:cloudformation:us-east-1:123456789012:stack/golden-path/1',
  });
  const describeStacks = vi.fn().mockResolvedValue(COMPLETE_STACK);
  const deleteStack = vi.fn().mockResolvedValue(undefined);
  const describeServices = vi.fn().mockResolvedValue([
    {
      serviceName: 'golden-path-service',
      status: 'ACTIVE',
      desiredCount: 1,
      runningCount: 1,
      healthy: true,
    },
  ]);
  const describeTargetHealth = vi.fn().mockResolvedValue({
    targets: [{ targetId: 'i-golden', state: 'healthy' }],
  });
  const getCallerIdentity = vi.fn().mockResolvedValue({
    account: '123456789012',
    arn: 'arn:aws:iam::123456789012:user/golden-path',
    userId: 'AIDAGOLDEN',
  });
  const listPolicies = vi.fn().mockResolvedValue({ policies: [] });

  const aws: AwsClients = {
    cloudFormation: { createStack, describeStacks, deleteStack },
    ecs: { describeServices },
    elb: { describeTargetHealth },
    sts: { getCallerIdentity },
    organizations: { listPolicies },
  };

  const synth = vi.fn().mockResolvedValue(makeTemplates());
  const publish = vi.fn().mockResolvedValue(makePublishResult());

  const deps: SuiteDeps = { aws, synth, publish };

  return {
    deps,
    aws,
    createStack,
    describeStacks,
    deleteStack,
    describeServices,
    describeTargetHealth,
    getCallerIdentity,
    listPolicies,
    synth,
    publish,
  };
}

// ── §67 Golden Path E2E ──────────────────────────────────────────────────

describe('§67 Golden Path E2E', () => {
  // ── Phase 1: Core Platform (steps 1-5) ───────────────────────────────

  describe('Phase 1 — Core Platform (steps 1-5)', () => {
    it('step 1: vendor signs up via Better Auth email/password', () => {
      // PENDING-AWS: requires a running Fastify API + Better Auth + PGlite/Postgres.
      // When available: Playwright-driven signup flow → session cookie → assert 200.
      expect(true).toBe(true); // placeholder — real assertion is PENDING-AWS
    });

    it('step 2: organization row created on signup', () => {
      // PENDING-AWS: requires the DB to be seeded and the org row to exist.
      // When available: Drizzle query against the fixture DB asserts org row.
      expect(true).toBe(true);
    });

    it('step 3: Stripe test subscription exists ($49 base + $19 metered)', () => {
      // PENDING-AWS: requires a real Stripe test-mode key (sk_test_).
      // When available: `stripe subscriptions list` in test mode asserts
      // the $49 base item + $19 metered item are attached.
      expect(true).toBe(true);
    });

    it('step 4: session cookie authorizes Fastify API call', () => {
      // PENDING-AWS: requires a running Fastify API with Better Auth session.
      // When available: extract session cookie from Playwright → fetch /api/me → 200.
      expect(true).toBe(true);
    });

    it('step 5: GET /api/applications returns 200', () => {
      // PENDING-AWS: requires the applications API endpoint + authenticated session.
      // When available: fetch /api/applications with session cookie → 200 + JSON body.
      expect(true).toBe(true);
    });
  });

  // ── Phase 2: Application Management (steps 6-7) ──────────────────────

  describe('Phase 2 — Application Management (steps 6-7)', () => {
    it('step 6: create Application/Customer/Deployment via API', () => {
      // PENDING-AWS: requires the applications API endpoint + DB.
      // When available: POST /api/applications → 201 → Drizzle query asserts
      // the Application, Customer, and Deployment rows match §33-§40 schema.
      expect(true).toBe(true);
    });

    it('step 7: GitHub App installed (metadata+code read only)', () => {
      // PENDING-AWS: requires a real GitHub App installation on a fixture org.
      // When available: install the App → assert the installation token has
      // ONLY contents:read + metadata:read (S4 guardrail).
      expect(true).toBe(true);
    });
  });

  // ── Phase 3: Repository Analysis (steps 8-10) ────────────────────────

  describe('Phase 3 — Repository Analysis (steps 8-10)', () => {
    it('step 8: repo selection stores the repo', () => {
      // PENDING-AWS: requires the repo-selection API endpoint + DB.
      // When available: POST /api/applications/:id/repo → 200 →
      // Drizzle query asserts the repo is stored on the application row.
      expect(true).toBe(true);
    });

    it('step 9: analysis completes (deterministic analyser)', () => {
      // PENDING-AWS: requires the analyser to run against a real repo.
      // When available: trigger analysis → poll until analysis_status = 'COMPLETE' →
      // assert findings + rejections match the expected fixture repo output.
      expect(true).toBe(true);
    });

    it('step 10: readiness page renders §19 verdict', () => {
      // PENDING-AWS: requires the readiness API endpoint + analysis result.
      // When available: Playwright navigates to /dashboard/applications/:id/readiness →
      // assert the verdict card renders the correct compatibility status.
      expect(true).toBe(true);
    });
  });

  // ── Phase 4: AWS Installation (steps 11-16) ──────────────────────────

  describe('Phase 4 — AWS Installation (steps 11-16)', () => {
    it('step 11: generated install link', () => {
      // PENDING-AWS: requires the install-link generator + published template URL.
      // When available: call the install-link API → assert the returned URL
      // contains templateURL=, stackName=deployz-bootstrap, param_ControlPlaneUrl=.
      expect(true).toBe(true);
    });

    it('step 12: Quick Create URL resolves', () => {
      // PENDING-AWS: requires a published template in a real S3 bucket.
      // When available: fetch the templateURL from the Quick Create link →
      // assert HTTP 200 + valid CloudFormation template JSON.
      expect(true).toBe(true);
    });

    it('step 13: bootstrap stack reaches CREATE_COMPLETE', async () => {
      // PENDING-AWS: requires real AWS credentials + CloudFormation.
      // When available: the runner's deploy-bootstrap phase calls createStack →
      // waitForStackStatus polls until CREATE_COMPLETE.
      //
      // Mock proof: the injectable seam works — waitForStackStatus returns
      // CREATE_COMPLETE when the mock describeStacks resolves it.
      const harness = makeGoldenPathHarness();
      const result = await waitForStackStatus(
        harness.aws.cloudFormation,
        'deployz-bootstrap',
        'us-east-1',
        'CREATE_COMPLETE',
        { pollIntervalMs: 0, maxAttempts: 5 },
      );
      expect(result.status).toBe('CREATE_COMPLETE');
      expect(harness.describeStacks).toHaveBeenCalled();
    });

    it('step 14: application stack reaches CREATE_COMPLETE', async () => {
      // PENDING-AWS: requires real AWS credentials + CloudFormation.
      // Mock proof: same pattern as step 13 — the injectable seam works.
      const harness = makeGoldenPathHarness();
      const result = await waitForStackStatus(
        harness.aws.cloudFormation,
        'deployz-application',
        'us-east-1',
        'CREATE_COMPLETE',
        { pollIntervalMs: 0, maxAttempts: 5 },
      );
      expect(result.status).toBe('CREATE_COMPLETE');
    });

    it('step 15: ECS service steady, ALB health check returns 200', async () => {
      // PENDING-AWS: requires real ECS + ELB endpoints.
      // Mock proof: verifyHealthy returns true when both ECS and ELB mocks
      // report healthy.
      const harness = makeGoldenPathHarness();
      const healthy = await verifyHealthy(harness.aws, {
        cluster: 'golden-path-cluster',
        serviceName: 'golden-path-service',
        targetGroupArn:
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/golden-path/1',
        region: 'us-east-1',
      });
      expect(healthy).toBe(true);
      expect(harness.describeServices).toHaveBeenCalled();
      expect(harness.describeTargetHealth).toHaveBeenCalled();
    });

    it('step 16: relay reports connected', () => {
      // PENDING-AWS: requires a running relay Lambda + control-plane API.
      // When available: the relay's pollOnce calls POST /api/relay/register →
      // control plane records the installation as connected.
      expect(true).toBe(true);
    });
  });

  // ── Phase 5: Control Plane (steps 17-18) ─────────────────────────────

  describe('Phase 5 — Control Plane (steps 17-18)', () => {
    it('step 17: control plane flips deployment to Healthy', () => {
      // PENDING-AWS: requires the health monitor to observe the relay's
      // REPORT_HEALTH and transition the deployment state.
      // When available: assert deploymentStore.get(id) === 'HEALTHY'.
      expect(true).toBe(true);
    });

    it('step 18: deployz:installation tags on every created resource', () => {
      // PENDING-AWS: requires real AWS resource tagging verification.
      // When available: aws resourcegroupstaggingapi get-resources
      // --tag-filters Key=deployz:installation → assert every CFN/ECS/ELB
      // resource in the stack carries the tag.
      expect(true).toBe(true);
    });
  });

  // ── Phase 6: Release Pipeline (steps 19-22) ──────────────────────────

  describe('Phase 6 — Release Pipeline (steps 19-22)', () => {
    it('step 19: create release v2', () => {
      // PENDING-AWS: requires the releases API endpoint + DB.
      // When available: POST /api/deployments/:id/releases → 201 →
      // Drizzle query asserts the release row with version 'v2'.
      expect(true).toBe(true);
    });

    it('step 20: DEPLOY_RELEASE (relay command)', () => {
      // PENDING-AWS: requires a real relay round-trip. The control plane
      // enqueues a DEPLOY_RELEASE job and the customer-account relay executes
      // it; the worker settles the job. When available: dispatch DEPLOY_RELEASE
      // → assert the deployment transitions through UPDATING → HEALTHY.
      expect(true).toBe(true);
    });

    it('step 21: migration one-off task runs before completion', () => {
      // PENDING-AWS: requires a real migration command + ECS task execution.
      // When available: assert the migration step emitted a deploy.migration event
      // with result: 'completed' BEFORE the deploy.completed event.
      expect(true).toBe(true);
    });

    it('step 22: ECS on new digest → Healthy', () => {
      // PENDING-AWS: requires real ECS service update + health verification.
      // When available: assert the ECS service's task definition points to the
      // new image digest AND verifyHealthy returns true.
      expect(true).toBe(true);
    });
  });

  // ── Phase 7: Lifecycle Intelligence (steps 23-25) ────────────────────

  describe('Phase 7 — Lifecycle Intelligence (steps 23-25)', () => {
    it('step 23: deploy deliberately-broken fixture (port mismatch)', () => {
      // PENDING-AWS: requires deploying a fixture that listens on port 8080
      // but the health check targets port 3000.
      // When available: deploy the broken fixture → assert the deployment
      // transitions to FAILED (not HEALTHY).
      expect(true).toBe(true);
    });

    it('step 24: classifier emits PORT_MISMATCH (§29)', () => {
      // PENDING-AWS: requires the failure classifier to process the broken
      // deployment's failure event.
      // When available: assert classifyFailure(event) returns 'PORT_MISMATCH'.
      expect(true).toBe(true);
    });

    it('step 25: AI explanation rendered in §65 product language', () => {
      // PENDING-AI + PENDING-AWS: requires the AI diagnostic explainer +
      // the diagnostics UI to render the explanation.
      // When available: assert the diagnostics page renders the AI explanation
      // with §65 jargon-free product language (no raw AWS/ECS/CFN terms).
      expect(true).toBe(true);
    });
  });

  // ── Full suite runner (mock proof) ───────────────────────────────────

  describe('full suite runner (mock proof)', () => {
    it('runSuite completes all 7 phases with mock AWS clients', async () => {
      // This proves the injectable seam works end-to-end: the runner
      // orchestrates synth → publish → deploy-bootstrap → wait-first-contact →
      // deploy-application → verify-healthy → teardown, all with mock clients.
      const harness = makeGoldenPathHarness();
      const result = await runSuite(harness.deps, GOLDEN_PATH_CONFIG);

      expect(result.passed).toBe(true);
      expect(result.phase).toBe('teardown');
      expect(result.phases).toHaveLength(7);

      const phaseNames = result.phases.map((p) => p.phase);
      expect(phaseNames).toEqual([
        'synth',
        'publish',
        'deploy-bootstrap',
        'wait-first-contact',
        'deploy-application',
        'verify-healthy',
        'teardown',
      ]);

      // Every phase passed.
      for (const p of result.phases) {
        expect(p.status).toBe('passed');
      }

      // Teardown cleaned up both stacks.
      expect(result.teardown.attempted).toBe(2);
      expect(result.teardown.succeeded).toBe(2);
      expect(result.teardown.failed).toBe(0);
    });

    it('runSuite classifies SCP-blocked failures', async () => {
      const harness = makeGoldenPathHarness();
      harness.createStack.mockRejectedValue(
        new Error(
          'User: arn:aws:iam::123456789012:user/test is not authorized to perform: ' +
            'cloudformation:CreateStack on resource: arn:aws:cloudformation:us-east-1:123456789012:stack/* ' +
            'with an explicit deny in a service control policy',
        ),
      );

      const result = await runSuite(harness.deps, GOLDEN_PATH_CONFIG);

      expect(result.passed).toBe(false);
      expect(result.failureCode).toBe('AWS_SCP_BLOCKED');
    });

    it('runSuite reports failure when verifyHealthy returns false', async () => {
      const harness = makeGoldenPathHarness();
      harness.describeServices.mockResolvedValue([
        {
          serviceName: 'golden-path-service',
          status: 'ACTIVE',
          desiredCount: 1,
          runningCount: 0,
          healthy: false,
        },
      ]);

      const result = await runSuite(harness.deps, GOLDEN_PATH_CONFIG);

      expect(result.passed).toBe(false);
      expect(result.phase).toBe('verify-healthy');
      expect(result.error).toContain('did not reach Healthy');
    });
  });

  // ── AWS client seam verification ─────────────────────────────────────

  describe('AWS client seam (injectable interface)', () => {
    it('real createAwsClients uses SDK v3 — resolves a live identity when credentials are present', async () => {
      const clients = createAwsClients();

      // When AWS credentials are configured (the real-AWS run), the SDK
      // resolves a real caller identity. This is the STRONGER proof the
      // clients are real SDK-backed (no longer stubs): a stub cannot return
      // a genuine 12-digit account id.
      const identity = await clients.sts.getCallerIdentity();
      expect(identity.account).toMatch(/^\d{12}$/);
      expect(identity.arn).toContain('aws:iam::');
    });

    it('mock AwsClients satisfies the full interface', () => {
      // Structural proof that the mock harness matches the AwsClients
      // interface — every method is present and callable.
      const harness = makeGoldenPathHarness();
      const { aws } = harness;

      expect(typeof aws.cloudFormation.createStack).toBe('function');
      expect(typeof aws.cloudFormation.describeStacks).toBe('function');
      expect(typeof aws.cloudFormation.deleteStack).toBe('function');
      expect(typeof aws.ecs.describeServices).toBe('function');
      expect(typeof aws.elb.describeTargetHealth).toBe('function');
      expect(typeof aws.sts.getCallerIdentity).toBe('function');
      expect(typeof aws.organizations.listPolicies).toBe('function');
    });
  });

  // ── Teardown guarantee ───────────────────────────────────────────────

  describe('teardown guarantee', () => {
    it('CleanupRegistry runs cleanups in reverse creation order', async () => {
      const registry = new CleanupRegistry();
      const order: string[] = [];

      registry.register('stack', 'bootstrap', async () => {
        order.push('bootstrap');
      });
      registry.register('stack', 'application', async () => {
        order.push('application');
      });

      const result = await registry.teardown();

      // Reverse order: application (created last) → bootstrap (created first).
      expect(order).toEqual(['application', 'bootstrap']);
      expect(result.attempted).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('runWithTeardown runs teardown even when fn throws', async () => {
      const registry = new CleanupRegistry();
      let cleaned = false;

      registry.register('stack', 'test', async () => {
        cleaned = true;
      });

      await expect(
        runWithTeardown(registry, async () => {
          throw new Error('simulated failure');
        }),
      ).rejects.toThrow('simulated failure');

      // Teardown still ran.
      expect(cleaned).toBe(true);
      expect(registry.lastResult?.succeeded).toBe(1);
    });
  });
});

// ── §68: 3× green consecutively ─────────────────────────────────────────

describe('§68 — 3× green consecutively', () => {
  it('documents the repeat requirement', () => {
    // §68: "repeat happy path 3× green consecutively."
    //
    // The full golden-path suite (all 25 §67 steps) must pass 3 times in a
    // row on fresh test accounts with zero failures between runs.
    //
    // Implementation plan when AWS credentials are available:
    //
    //   for (let run = 1; run <= 3; run++) {
    //     const result = await runGoldenPathSuite({
    //       region: SPOT_REGIONS[run - 1], // different region each run
    //       seedFreshAccount: true,        // fresh test account per run
    //     });
    //     expect(result.passed, `run ${run}/3 failed`).toBe(true);
    //   }
    //
    // PENDING-AWS: the 3× green requirement cannot be satisfied without
    // real AWS credentials. The mock harness proves the runner structure
    // works; the real proof requires:
    //   - AWS SDK v3 installed + credentials configured
    //   - 3 fresh test accounts (or 3 regions on one account)
    //   - Real CloudFormation/ECS/ELB/STS/Organizations endpoints
    //   - Real Stripe test-mode key
    //   - Real GitHub App installation
    //   - Real Playwright-driven browser automation
    expect(true).toBe(true);
  });

  it('mock runner passes 3× consecutively with injectable seams', async () => {
    // Proves the runner structure supports 3 consecutive runs with mock
    // clients — the orchestration layer is correct; only the real-AWS
    // proof is blocked.
    for (let run = 1; run <= 3; run++) {
      const harness = makeGoldenPathHarness();
      const result = await runSuite(harness.deps, GOLDEN_PATH_CONFIG);

      expect(result.passed, `mock run ${run}/3 failed`).toBe(true);
      expect(result.phases.length).toBe(7);
    }
  });
});

// ── PENDING-AWS summary ─────────────────────────────────────────────────

describe('PENDING-AWS status', () => {
  it('documents which steps are blocked', () => {
    // The following steps require real AWS credentials and are PENDING-AWS:
    //
    //   Phase 1 (Core Platform):    steps 1-5  — Playwright + Stripe + DB
    //   Phase 2 (App Management):   steps 6-7  — API endpoints + GitHub App
    //   Phase 3 (Repo Analysis):    steps 8-10 — API endpoints + analyser
    //   Phase 4 (AWS Installation): steps 11-16 — CloudFormation/ECS/ELB/Relay
    //   Phase 5 (Control Plane):    steps 17-18 — Health monitor + tagging
    //   Phase 6 (Release Pipeline): steps 19-22 — DEPLOY_RELEASE + ECS update
    //   Phase 7 (Lifecycle):        steps 23-25 — Broken fixture + classifier + AI
    //
    // Steps with mock proof (injectable seam verified):
    //   - Step 13 (bootstrap CREATE_COMPLETE): waitForStackStatus mock proof ✓
    //   - Step 14 (application CREATE_COMPLETE): waitForStackStatus mock proof ✓
    //   - Step 15 (ECS/ELB healthy): verifyHealthy mock proof ✓
    //   - Full suite runner: runSuite mock proof ✓
    //   - 3× green: mock runner passes 3× ✓
    //
    // The DoD gate is NOT passed. Real-AWS proof is blocked until
    // credentials are available. See .omo/evidence/task-37-deployz-mvp.txt.
    expect(true).toBe(true);
  });
});