import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ReadinessResult,
  automaticHighlights,
  findingFixSections,
} from '../src/components/readiness-result';
import type { ApplicationReadiness, ReadinessFinding } from '../src/lib/readiness';

/**
 * Component/DOM tests for the deployment readiness cards (§19).
 *
 * The result is rendered with react-dom/server and parsed with jsdom so we
 * can assert on visible text and DOM order without a full browser. The cards
 * must answer, at a glance: can I deploy, what did Deployz already find for
 * me, what configuration does the vendor still need to provide, which
 * findings need code changes, and can Deployz draft a fix prompt.
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

function render(
  input: ApplicationReadiness,
  application?: { databaseRequired: boolean; redisRequired: boolean },
): Document {
  const html = renderToString(
    <ReadinessResult
      readiness={input}
      application={application}
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

describe('automaticHighlights — derived positives', () => {
  it('claims a provisioned PostgreSQL connection when a database is required', () => {
    expect(automaticHighlights({ databaseRequired: true, redisRequired: false })).toContain(
      'PostgreSQL connection provisioned',
    );
  });

  it('says Redis is not required when it is not, and stays silent about a worker', () => {
    expect(automaticHighlights({ databaseRequired: false, redisRequired: false })).toContain(
      'Redis not required',
    );
    expect(automaticHighlights({ databaseRequired: false, redisRequired: false })).toHaveLength(1);
    expect(automaticHighlights({ databaseRequired: false, redisRequired: true })).toHaveLength(0);
  });

  it('omits highlights when no application is supplied', () => {
    expect(automaticHighlights(undefined)).toEqual([]);
  });
});

describe('ReadinessResult — blocking state', () => {
  const application = { databaseRequired: false, redisRequired: false };
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
    application,
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

  it('renders the automatic positives in the What Deployz found card', () => {
    const card = doc.querySelector('[data-testid="readiness-found"]');
    expect(card?.textContent).toContain('What Deployz found');
    const list = card?.querySelector('[data-testid="readiness-found-list"]');
    expect(list?.textContent).toContain('Application detected');
    expect(list?.textContent).toContain('Database detected');
    expect(list?.textContent).toContain('Passed');
    expect(list?.textContent).toContain('Redis not required');
    expect(card?.querySelector('svg.lucide-circle')).toBeNull();
    expect(card?.querySelector('svg.lucide-check')).not.toBeNull();
  });

  it('keeps blocking incompatibilities in their own card, not as config rows', () => {
    const incompatible = doc.querySelector('[data-testid="readiness-incompatible"]');
    expect(incompatible?.textContent).toContain('Changes needed');
    const finding = doc.querySelector('[data-testid="readiness-finding-container-setup"]');
    expect(finding?.textContent).toContain('Action needed');
    expect(finding?.textContent).toContain('No supported container setup was found.');
    expect(doc.querySelector('[data-testid^="readiness-config-link-"]')).toBeNull();
  });

  it('orders the verdict, found, incompatible cards then the fix CTA, with the commit last', () => {
    expect(orderOf(doc, 'readiness-verdict')).toBeGreaterThan(-1);
    expect(orderOf(doc, 'readiness-found')).toBeLessThan(orderOf(doc, 'readiness-incompatible'));
    expect(orderOf(doc, 'readiness-incompatible')).toBeLessThan(
      orderOf(doc, 'generate-fix-instructions'),
    );
    expect(orderOf(doc, 'readiness-commit')).toBeGreaterThan(
      orderOf(doc, 'generate-fix-instructions'),
    );
  });

  it('renders the fix CTA as a secondary action below the cards', () => {
    const cta = doc.querySelector('[data-testid="generate-fix-instructions"]');
    expect(cta).not.toBeNull();
    expect(cta?.getAttribute('data-variant')).toBe('secondary');
    expect(doc.body.textContent).toContain(
      'Creates one prompt to fix these 2 issues with your coding agent.',
    );
    expect(doc.body.textContent).toContain('Deployz never changes your repository.');
  });

  it('shows the analysed commit last, short form', () => {
    expect(doc.querySelector('[data-testid="readiness-commit"]')?.textContent).toBe(
      'Analysed commit 150f9e3',
    );
  });
});

describe('ReadinessResult — needs input', () => {
  const application = { databaseRequired: true, redisRequired: true };
  const doc = render(
    readiness({
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 1,
      findings: [
        finding({
          id: 'health-check',
          blocking: false,
          title: 'Give Deployz a way to check your app',
          plainEnglishExplanation: 'Deployz needs a reliable way to confirm your app started.',
        }),
        finding({
          id: 'migrations',
          severity: 'recommended',
          blocking: false,
          title: 'Run database migrations on deploy',
          plainEnglishExplanation: 'A migration command would keep every database in sync.',
        }),
      ],
      passed: [passed('a', 'A'), passed('b', 'B')],
    }),
    application,
  );

  it('blocks on the one remaining required change', () => {
    expect(doc.body.textContent).toContain('1 change needed before deployment');
  });

  it('renders the What Deployz found card with the derived positives and checks', () => {
    const card = doc.querySelector('[data-testid="readiness-found"]');
    expect(card?.querySelector('[data-testid="readiness-found-list"]')?.textContent).toContain(
      'PostgreSQL connection provisioned',
    );
    expect(card?.textContent).not.toContain('Redis not required');
    const check = card?.querySelector('[data-testid="readiness-found-list"] svg.lucide-check');
    expect(check?.classList.contains('text-emerald-600')).toBe(true);
  });

  it('lists the required finding in the Needs your input card with a config link', () => {
    const card = doc.querySelector('[data-testid="needs-input"]');
    expect(card?.textContent).toContain('Needs your input');
    const row = card?.querySelector('[data-testid="readiness-finding-health-check"]');
    expect(row?.textContent).toContain('Give Deployz a way to check your app');
    expect(row?.textContent).toContain('Deployz needs a reliable way to confirm your app started.');
    const dot = row?.querySelector('svg.lucide-circle');
    expect(dot?.classList.contains('text-amber-500')).toBe(true);
    const link = row?.querySelector('[data-testid="readiness-config-link-health-check"]');
    expect(link?.getAttribute('href')).toBe('/dashboard/applications/app-1/config');
    expect(link?.textContent).toBe('Review configuration');
  });

  it('nests the recommended findings inside the Needs your input card', () => {
    const card = doc.querySelector('[data-testid="needs-input"]');
    const recommended = card?.querySelector('[data-testid="readiness-recommended-list"]');
    expect(recommended).not.toBeNull();
    expect(recommended?.textContent).toContain('Run database migrations on deploy');
  });

  it('summarises the card with the required-value count', () => {
    expect(doc.querySelector('[data-testid="needs-input-summary"]')?.textContent).toBe(
      'Ready after 1 required value is provided.',
    );
  });

  it('keeps the fix CTA available but secondary for code adaptation', () => {
    const cta = doc.querySelector('[data-testid="generate-fix-instructions"]');
    expect(cta).not.toBeNull();
    expect(cta?.getAttribute('data-variant')).toBe('secondary');
    expect(doc.body.textContent).toContain(
      'Creates one prompt to fix this 1 issue with your coding agent.',
    );
  });
});

describe('ReadinessResult — all required checks pass', () => {
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
    { databaseRequired: false, redisRequired: false },
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

  it('shows the compact Ready to deploy card instead of the found/needs-input cards', () => {
    expect(doc.querySelector('[data-testid="readiness-ready"]')).not.toBeNull();
    const ready = doc.querySelector('[data-testid="readiness-ready"]');
    expect(ready?.querySelector('svg.lucide-check')).not.toBeNull();
    expect(doc.querySelector('[data-testid="readiness-found"]')).toBeNull();
    expect(doc.querySelector('[data-testid="needs-input"]')).toBeNull();
  });

  it('offers no fix CTA when nothing needs changing', () => {
    expect(doc.querySelector('[data-testid="generate-fix-instructions"]')).toBeNull();
  });
});

describe('ReadinessResult — READY with recommended findings', () => {
  const doc = render(
    readiness({
      state: 'READY',
      requiredCount: 0,
      recommendedCount: 1,
      findings: [
        finding({
          id: 'worker-command',
          severity: 'recommended',
          blocking: false,
          title: 'Background job runner',
        }),
      ],
      passed: [passed('a', 'A')],
    }),
    { databaseRequired: false, redisRequired: true },
  );

  it('still reads as ready, with the recommendation nested in the ready card', () => {
    expect(doc.body.textContent).toContain('Ready to deploy');
    const ready = doc.querySelector('[data-testid="readiness-ready"]');
    expect(ready?.textContent).toContain('Recommended');
    const recommended = ready?.querySelector('[data-testid="readiness-recommended-list"]');
    expect(recommended?.textContent).toContain('Background job runner');
    expect(doc.querySelector('[data-testid="generate-fix-instructions"]')).toBeNull();
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

describe('ReadinessResult — long automatic list collapses', () => {
  const doc = render(
    readiness({
      state: 'ALMOST_READY',
      requiredCount: 1,
      findings: [
        finding({
          id: 'health-check',
          blocking: false,
          title: 'Give Deployz a way to check your app',
        }),
      ],
      passed: Array.from({ length: 7 }, (_, index) => passed(`check-${index}`, `Check ${index + 1}`)),
    }),
    { databaseRequired: false, redisRequired: false },
  );

  it('keeps the count visible and the list collapsed behind it', () => {
    const card = doc.querySelector('[data-testid="readiness-found"]');
    const details = card?.querySelector('details[data-testid="readiness-found-collapse"]');
    expect(details?.querySelector('summary')?.textContent).toContain('What Deployz found (8)');
    const list = card?.querySelector('[data-testid="readiness-found-list"]');
    expect(list).not.toBeNull();
  });
});
