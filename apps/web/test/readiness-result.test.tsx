import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReadinessResult, findingFixSections } from '../src/components/readiness-result';
import type { ApplicationReadiness, DetectedApplication, ReadinessFinding } from '../src/lib/readiness';

/**
 * Component/DOM tests for the deployment readiness checklist (§19).
 *
 * The card is rendered with react-dom/server and parsed with jsdom so we can
 * assert on visible text and DOM order without a full browser. The checklist
 * must answer, at a glance: can I deploy, how many checks block me, what
 * needs changing, what already passed, and can Deployz help me fix it.
 */

let findingSeq = 0;
function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  findingSeq += 1;
  return {
    id: `finding-${findingSeq}`,
    category: 'container',
    title: 'Finding title',
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: 'Deployz could not determine how to package and start this app.',
    whyItMatters: 'Deployz deploys applications as containers.',
    technicalEvidence: 'No Dockerfile found',
    suggestedOutcome: 'Add a Dockerfile.',
    confidence: 'confirmed',
    ...overrides,
  };
}

function passed(id: string, label: string): ApplicationReadiness['passed'][number] {
  return { id, label };
}

function readiness(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'NEEDS_CHANGES',
    requiredCount: 2,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: '150f9e3abc',
    detected: null,
    ...overrides,
  };
}

function blockingPair(): ReadinessFinding[] {
  return [
    finding({
      id: 'container-setup',
      title: 'Deployz doesn\u2019t know how to start your app',
      plainEnglishExplanation: 'No supported container setup was found.',
      suggestedOutcome: 'Add a supported container setup.',
    }),
    finding({
      id: 'health-check',
      title: 'Give Deployz a way to check your app',
      plainEnglishExplanation: 'Deployz needs a reliable way to confirm your app started.',
      suggestedOutcome: 'Add or configure a health endpoint.',
    }),
  ];
}

function render(input: ApplicationReadiness): Document {
  const html = renderToString(
    <ReadinessResult
      readiness={input}
      applicationId="app-1"
      onReanalyse={() => undefined}
    />,
  );
  const { window } = new JSDOM(html);
  return window.document;
}

/** DOM order of two elements by their [data-testid]. */
function orderOf(doc: Document, testid: string): number {
  const element = doc.querySelector(`[data-testid="${testid}"]`);
  if (!element) return -1;
  return [...doc.querySelectorAll('*')].indexOf(element);
}

describe('ReadinessResult — blocking state', () => {
  const doc = render(
    readiness({
      state: 'NEEDS_CHANGES',
      requiredCount: 2,
      findings: blockingPair(),
      passed: [
        passed('app-detected', 'Application detected'),
        passed('database-detected', 'Database detected'),
        passed('env-config', 'Environment configuration'),
        passed('public-service', 'Public web service'),
      ],
    }),
  );

  it('says how many changes are needed before deployment', () => {
    expect(doc.body.textContent).toContain('2 changes needed before deployment');
  });

  it('counts the checks: 4 of 6 passed', () => {
    expect(doc.body.textContent).toContain('4 of 6 checks passed');
    expect(doc.body.textContent).toContain(
      'Your application passed 4 of 6 deployment checks. Fix the items below before deploying.',
    );
  });

  it('never claims the app is almost ready while blocked', () => {
    expect(doc.body.textContent).not.toMatch(/almost ready/i);
  });

  it('shows blockers before passed checks in DOM order', () => {
    expect(orderOf(doc, 'readiness-required-list')).toBeGreaterThan(-1);
    expect(orderOf(doc, 'readiness-required-list')).toBeLessThan(
      orderOf(doc, 'readiness-passed-list'),
    );
  });

  it('places the fix CTA below the blockers and above the passed checks', () => {
    const cta = orderOf(doc, 'generate-fix-instructions');
    expect(cta).toBeGreaterThan(orderOf(doc, 'readiness-required-list'));
    expect(cta).toBeLessThan(orderOf(doc, 'readiness-passed-list'));
  });

  it('supports the CTA with the issue count and the no-repo-writes promise', () => {
    expect(doc.body.textContent).toContain(
      'Creates one prompt to fix these 2 issues with your coding agent.',
    );
    expect(doc.body.textContent).toContain('Deployz never changes your repository.');
  });

  it('annotates the progress indicator accessibly, never as a percentage', () => {
    const bar = doc.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('4');
    expect(bar?.getAttribute('aria-valuemax')).toBe('6');
    expect(bar?.getAttribute('aria-label')).toBe('4 of 6 checks passed');
    expect(doc.body.textContent).not.toMatch(/%/);
  });

  it('gives every finding an icon-accompanied status text', () => {
    for (const id of ['container-setup', 'health-check']) {
      const item = doc.querySelector(`[data-testid="readiness-finding-${id}"]`);
      expect(item?.textContent).toContain('Action needed');
    }
    expect(doc.body.textContent).not.toContain('✓');
  });

  it('shows the analysed commit last, short form', () => {
    expect(doc.querySelector('[data-testid="readiness-commit"]')?.textContent).toBe(
      'Analysed commit 150f9e3',
    );
    expect(orderOf(doc, 'readiness-commit')).toBeGreaterThan(orderOf(doc, 'readiness-passed-list'));
  });
});

describe('ReadinessResult — all checks pass', () => {
  const doc = render(
    readiness({
      state: 'READY',
      requiredCount: 0,
      findings: [],
      passed: [
        passed('app-detected', 'Application detected'),
        passed('database-detected', 'Database detected'),
        passed('env-config', 'Environment configuration'),
        passed('public-service', 'Public web service'),
        passed('container', 'Container setup'),
        passed('health', 'Health check'),
      ],
    }),
  );

  it('says the app is ready to deploy', () => {
    expect(doc.body.textContent).toContain('Ready to deploy');
    expect(doc.body.textContent).toContain(
      'Your application passed all required deployment checks.',
    );
  });

  it('counts 6 of 6 checks passed', () => {
    expect(doc.body.textContent).toContain('6 of 6 checks passed');
  });

  it('offers no fix CTA when nothing needs changing', () => {
    expect(doc.querySelector('[data-testid="generate-fix-instructions"]')).toBeNull();
  });

  it('labels each passed check in a compact list', () => {
    expect(doc.body.textContent).toContain('Application detected');
    const rows = doc.querySelectorAll('[data-testid="readiness-passed-list"] > li');
    expect(rows).toHaveLength(6);
    expect(rows[0]?.textContent).toContain('Passed');
  });
});

describe('ReadinessResult — recommended findings', () => {
  const doc = render(
    readiness({
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 1,
      findings: [
        finding({ id: 'health-check', title: 'Give Deployz a way to check your app' }),
        finding({
          id: 'migrations',
          severity: 'recommended',
          blocking: false,
          title: 'Run database migrations on deploy',
        }),
      ],
      passed: [passed('a', 'A'), passed('b', 'B'), passed('c', 'C'), passed('d', 'D'), passed('e', 'E')],
    }),
  );

  it('blocks on the one remaining required change', () => {
    expect(doc.body.textContent).toContain('1 change needed before deployment');
    expect(doc.body.textContent).toContain(
      'Your application passed 5 of 7 deployment checks. Fix the item below before deploying.',
    );
  });

  it('distinguishes recommended from action-needed without blocking language', () => {
    expect(doc.querySelector('[data-testid="readiness-finding-migrations"]')?.textContent).toContain(
      'Recommended',
    );
    expect(doc.querySelector('[data-testid="readiness-finding-health-check"]')?.textContent).toContain(
      'Action needed',
    );
  });

  it('uses the singular CTA support copy for one issue', () => {
    expect(doc.body.textContent).toContain(
      'Creates one prompt to fix this 1 issue with your coding agent.',
    );
  });

  it('orders action-needed before recommended before passed', () => {
    const required = orderOf(doc, 'readiness-required-list');
    const recommended = orderOf(doc, 'readiness-recommended-list');
    const passedList = orderOf(doc, 'readiness-passed-list');
    expect(required).toBeLessThan(recommended);
    expect(recommended).toBeLessThan(passedList);
  });
});

describe('ReadinessResult — analysis running', () => {
  const doc = render(readiness({ analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }));

  it('shows the checking state, not a stale verdict', () => {
    expect(doc.body.textContent).toContain('Checking deployment readiness…');
    expect(doc.querySelector('[data-testid="readiness-summary"]')).toBeNull();
    expect(doc.querySelector('[data-testid="readiness-progress"]')).toBeNull();
    expect(doc.querySelector('[data-testid="generate-fix-instructions"]')).toBeNull();
  });
});

describe('ReadinessResult — analysis failed', () => {
  const doc = render(
    readiness({
      analysisStatus: 'FAILED',
      state: 'ANALYSIS_INCOMPLETE',
      failureReason: 'Failed to read the repository.',
    }),
  );

  it('says the check could not run and why', () => {
    expect(doc.body.textContent).toContain("We couldn't check deployment readiness");
    expect(doc.querySelector('[data-testid="readiness-failure"]')?.textContent).toContain(
      'Failed to read the repository.',
    );
  });

  it('offers a retry as the primary action', () => {
    const retry = doc.querySelector('button[data-testid="readiness-retry"]');
    expect(retry?.textContent).toBe('Try analysis again');
  });
});

describe('ReadinessResult — finding fix sections', () => {
  it('returns the action, the reason, and the technical details in order', () => {
    const sections = findingFixSections(finding());
    expect(sections.map((s) => s.heading)).toEqual([
      'What you need to do',
      'Why Deployz needs this',
      'Technical details',
    ]);
    expect(sections[0]?.body).toBe('Add a Dockerfile.');
    expect(sections[2]?.code).toBe(true);
  });

  it('omits empty fields (legacy findings carry empty whyItMatters)', () => {
    const sections = findingFixSections(
      finding({ whyItMatters: '', technicalEvidence: '', suggestedOutcome: 'Add a Dockerfile.' }),
    );
    expect(sections.map((s) => s.heading)).toEqual(['What you need to do']);
  });
});

describe('ReadinessResult — long passed list collapses', () => {
  const doc = render(
    readiness({
      state: 'READY',
      findings: [],
      passed: Array.from({ length: 7 }, (_, index) => passed(`check-${index}`, `Check ${index + 1}`)),
    }),
  );

  it('keeps the count visible and the list collapsed behind it', () => {
    const details = doc.querySelector('details[data-testid="readiness-passed"]');
    expect(details?.querySelector('summary')?.textContent).toContain('Passed checks (7)');
    const list = details?.querySelector('[data-testid="readiness-passed-list"]');
    expect(list).not.toBeNull();
  });
});


describe('ReadinessResult — what Deployz detected', () => {
  const detected: DetectedApplication = {
    analysisVersion: 13,
    runtime: { value: 'node', source: 'dockerfile', confidence: 'confirmed', evidence: [{ file: 'Dockerfile', reason: 'Base image node:20-alpine in Dockerfile' }] },
    framework: { value: 'express', source: 'package-manifest', confidence: 'confirmed', evidence: [{ reason: 'Framework detected: express' }] },
    build: { value: null, source: 'none', confidence: 'needs_confirmation', evidence: [] },
    start: { value: 'node dist/index.js', source: 'dockerfile', confidence: 'confirmed', evidence: [{ reason: 'CMD' }] },
    network: {
      port: { value: 3000, source: 'dockerfile', confidence: 'confirmed', evidence: [{ reason: 'Port 3000 detected in Dockerfile (EXPOSE)' }] },
      bindAddress: { value: null, source: 'none', confidence: 'needs_confirmation', evidence: [] },
    },
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [{ reason: 'pg' }] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: true, path: '/health', confidence: 'confirmed', evidence: [{ reason: 'route' }] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };

  const doc = render(
    readiness({
      state: 'READY',
      requiredCount: 0,
      passed: [passed('dockerfile', 'Container setup found')],
      detected,
    }),
  );

  it('renders the detected facts after the checks with the values in plain words', () => {
    const section = doc.querySelector('[data-testid="readiness-detected"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('What Deployz detected');
    expect(orderOf(doc, 'readiness-detected')).toBeGreaterThan(orderOf(doc, 'readiness-passed-list'));
    expect(orderOf(doc, 'readiness-detected')).toBeLessThan(orderOf(doc, 'readiness-commit'));
    expect(doc.querySelector('[data-testid="readiness-detected-runtime"]')?.textContent).toContain('Node.js');
    expect(doc.querySelector('[data-testid="readiness-detected-port"]')?.textContent).toContain('3000');
    expect(doc.querySelector('[data-testid="readiness-detected-database"]')?.textContent).toContain(
      'PostgreSQL — Deployz provides a managed database',
    );
    expect(doc.querySelector('[data-testid="readiness-detected-build"]')?.textContent).toContain('Not found');
  });

  it('keeps the evidence behind a disclosure and the top level jargon-free', () => {
    const runtime = doc.querySelector('[data-testid="readiness-detected-runtime"]');
    expect(runtime?.querySelector('details summary')?.textContent).toContain('Evidence');
    expect(runtime?.querySelector('details')?.textContent).toContain('Base image node:20-alpine');
    expect(doc.body.textContent).not.toMatch(/\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i);
    expect(doc.querySelector('[data-testid="readiness-detected-build"] details')).toBeNull();
  });

  it('is omitted when the analysis predates the projection', () => {
    const legacy = render(readiness({ state: 'READY', requiredCount: 0, detected: null }));
    expect(legacy.querySelector('[data-testid="readiness-detected"]')).toBeNull();
  });
});
