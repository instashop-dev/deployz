// The one place that says what state an application is in on the vendor's
// application page. The header badge, the primary card, the setup lifecycle,
// the install-link card and the poll loop all read the presentation this
// module derives — no section interprets `analysisStatus`, readiness findings
// or a deployment `state` for itself, so two sections cannot disagree.
//
// Nothing here is persisted and nothing is invented: the inputs are the API's
// own application, readiness, deployment and install-link responses.

import { deploymentDisplayStatus } from '@/lib/deployment-status-groups';
import type { FleetDeployment } from '@/lib/deployments';
import type { PublicInstallLinkView } from '@/lib/public-install-links';
import type { ApplicationReadiness } from '@/lib/readiness';

// ── Canonical states ────────────────────────────────────────────────────────

export const APPLICATION_STATES = [
  'unavailable',
  'analysing',
  'analysis-failed',
  'configuration-required',
  'ready-to-test',
  'test-queued',
  'test-deploying',
  'test-removing',
  'test-failed',
  'ready-to-share',
  'customers-active',
  'unknown',
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

export type ApplicationBadgeVariant = 'success' | 'warning' | 'info' | 'secondary' | 'destructive';

/** How often the page re-fetches while a state can still change on its own. */
export const ANALYSIS_POLL_MS = 2000;
export const TEST_DEPLOYMENT_POLL_MS = 5000;

// ── Actions ─────────────────────────────────────────────────────────────────

/** Every action the primary card can offer. A component maps an `id` to its
 *  handler; `href` is set when the action is plain navigation. */
export type ApplicationActionId =
  | 'retry-load'
  | 'analyse'
  | 'restart-analysis'
  | 'retry-analysis'
  | 'review-configuration'
  | 'start-test'
  | 'continue-test'
  | 'view-progress'
  | 'review-failure'
  | 'open-application'
  | 'view-test-deployment'
  | 'create-install-link'
  | 'copy-install-link'
  | 'preview-install-link'
  | 'view-customer-deployments';

export interface ApplicationAction {
  id: ApplicationActionId;
  label: string;
  href: string | null;
  /** True when `href` leaves Deployz (opens in a new tab). */
  external: boolean;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const SETUP_LIFECYCLE_STEPS = ['Analyse', 'Configure', 'Test', 'Share'] as const;
export type SetupLifecycleStep = (typeof SETUP_LIFECYCLE_STEPS)[number];
export type SetupLifecycleStepState = 'pending' | 'current' | 'done' | 'failed';

export interface SetupLifecycleItem {
  step: SetupLifecycleStep;
  state: SetupLifecycleStepState;
}

// ── Install link ────────────────────────────────────────────────────────────

/** What the page knows about the application's public install links:
 *  `null` while the first fetch is in flight, `'error'` when it failed. */
export type InstallLinksInput = PublicInstallLinkView[] | 'error' | null;

export type InstallLinkStatus = 'active' | 'disabled' | 'unknown';

export type InstallLinkPresentation =
  /** Nothing to say yet (state unknown, or the page could not load). */
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** Not ready to share and no live link: say what has to happen first. */
  | { kind: 'unavailable'; reason: string }
  /** Ready to share, no live link. `note` explains a revoked predecessor. */
  | { kind: 'create'; note: string | null }
  /** A live (not revoked) link. `warning` is set when the link is live but
   *  the application is not ready to share — the link is never hidden or
   *  invalidated, the vendor is told and can disable it. */
  | { kind: 'live'; link: PublicInstallLinkView; status: InstallLinkStatus; warning: string | null };

/** Where the install-link controls render: inside the primary card (they ARE
 *  the next action), as their own compact card, or not at all. */
export type InstallLinkPlacement = 'primary' | 'card' | 'none';

// ── Presentation ────────────────────────────────────────────────────────────

export interface ApplicationNotice {
  tone: 'warning' | 'error';
  text: string;
}

export interface ApplicationBlocker {
  id: string;
  title: string;
}

/** One compact line under the primary card, only when it adds information the
 *  card does not already carry. */
export interface ApplicationRecentEvent {
  label: string;
  status: string;
  at: string;
  href: string;
}

export interface ApplicationPresentation {
  state: ApplicationState;
  badge: { label: string; variant: ApplicationBadgeVariant };
  heading: string;
  message: string;
  /** True while a server-side operation runs: the card shows a spinner. */
  busy: boolean;
  primaryAction: ApplicationAction | null;
  secondaryActions: ApplicationAction[];
  /** Required changes, shown by the configuration-required card. */
  blockers: ApplicationBlocker[];
  /** "Ready to test" / "No blocking issues" / "2 changes required" — never a
   *  passed-check count. Null while no completed analysis exists. */
  readinessSummary: string | null;
  recommendationCount: number;
  /** Null once setup is complete (a verified test or a customer exists). */
  lifecycle: SetupLifecycleItem[] | null;
  /** Null when the state is settled: the poll loop arms no timer. */
  polling: { intervalMs: number } | null;
  /** True only when the application is ready for customers. */
  installLinkAvailable: boolean;
  installLink: InstallLinkPresentation;
  installLinkPlacement: InstallLinkPlacement;
  notices: ApplicationNotice[];
  recentEvent: ApplicationRecentEvent | null;
}

export interface ApplicationStateInput {
  /** Null when the page has never loaded the application successfully. */
  data: {
    application: { id: string; name: string };
    readiness: ApplicationReadiness;
    deployments: FleetDeployment[];
  } | null;
  installLinks: InstallLinksInput;
  /** True after repeated failed refreshes: the data on screen may be old. */
  stale: boolean;
  /** True once an analysis has run past ANALYSIS_TAKING_LONGER_MS. */
  analysisTakingLonger: boolean;
}

// ── Test deployment ─────────────────────────────────────────────────────────

export type TestDeploymentPhase =
  | 'none'
  | 'queued'
  | 'deploying'
  | 'removing'
  | 'failed'
  | 'verified'
  | 'unknown';

/** The newest test deployment that still exists. */
export function latestTestDeployment(deployments: readonly FleetDeployment[]): FleetDeployment | null {
  const candidates = deployments
    .filter((d) => d.deploymentType === 'TEST' && d.deletedAt === null && d.state !== 'DELETED')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return candidates[0] ?? null;
}

export function testDeploymentPhase(deployment: FleetDeployment | null): TestDeploymentPhase {
  if (!deployment) return 'none';
  switch (deployment.state as string) {
    case 'NOT_INSTALLED':
      return 'queued';
    case 'WAITING_FOR_RELAY':
    case 'INSTALLING':
    case 'UPDATING':
      return 'deploying';
    case 'DELETING':
      return 'removing';
    case 'FAILED':
    case 'DISCONNECTED':
      return 'failed';
    case 'HEALTHY':
    case 'UPDATE_AVAILABLE':
      return 'verified';
    default:
      return 'unknown';
  }
}

/** Customer (non-test) deployments that still exist. */
export function customerDeployments(deployments: readonly FleetDeployment[]): FleetDeployment[] {
  return deployments.filter(
    (d) =>
      d.deploymentType === 'PRODUCTION' &&
      d.deletedAt === null &&
      d.state !== 'DELETED' &&
      d.state !== 'DELETING',
  );
}

// ── Copy ────────────────────────────────────────────────────────────────────

const BADGES: Record<ApplicationState, { label: string; variant: ApplicationBadgeVariant }> = {
  unavailable: { label: 'Unavailable', variant: 'secondary' },
  analysing: { label: 'Analysing', variant: 'info' },
  'analysis-failed': { label: 'Analysis failed', variant: 'destructive' },
  'configuration-required': { label: 'Changes required', variant: 'warning' },
  'ready-to-test': { label: 'Ready to test', variant: 'info' },
  'test-queued': { label: 'Test not started', variant: 'secondary' },
  'test-deploying': { label: 'Test deploying', variant: 'info' },
  'test-removing': { label: 'Removing test', variant: 'info' },
  'test-failed': { label: 'Test failed', variant: 'destructive' },
  'ready-to-share': { label: 'Ready to share', variant: 'success' },
  'customers-active': { label: 'Live with customers', variant: 'success' },
  unknown: { label: 'Status unknown', variant: 'warning' },
};

export const STALE_NOTICE = 'Live updates are paused. Deployz keeps trying in the background.';

const INSTALL_LINK_LOAD_ERROR = "We couldn't load the customer install link. Try again in a moment.";
const INSTALL_LINK_EARLY_WARNING =
  'This link is live, but the application is not ready to share. Disable the link until a test deployment passes.';
const INSTALL_LINK_UNKNOWN_WARNING =
  "Deployz doesn't recognise this link's status. Regenerate the link to get a working one.";
const INSTALL_LINK_REVOKED_NOTE = 'The previous link was revoked. Create a new link to share the application.';

function changesRequired(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} required`;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function action(
  id: ApplicationActionId,
  label: string,
  href: string | null = null,
  external = false,
): ApplicationAction {
  return { id, label, href, external };
}

function deploymentHref(deployment: FleetDeployment): string {
  return `/dashboard/deployments/${deployment.id}`;
}

function deploymentUrl(deployment: FleetDeployment): string | null {
  const url = deployment.observedState?.['url'];
  return typeof url === 'string' && url.length > 0 ? url : null;
}

// ── Install link derivation ─────────────────────────────────────────────────

function deriveInstallLink(
  links: InstallLinksInput,
  available: boolean,
  unavailableReason: string | null,
): InstallLinkPresentation {
  if (unavailableReason === null && !available) return { kind: 'hidden' };
  if (links === null) return { kind: 'loading' };
  if (links === 'error') return { kind: 'error', message: INSTALL_LINK_LOAD_ERROR };

  const live = links.find((link) => (link.status as string) !== 'revoked') ?? null;
  if (live) {
    const status: InstallLinkStatus =
      live.status === 'active' || live.status === 'disabled' ? live.status : 'unknown';
    let warning: string | null = null;
    if (status === 'unknown') warning = INSTALL_LINK_UNKNOWN_WARNING;
    else if (!available && status === 'active') warning = INSTALL_LINK_EARLY_WARNING;
    return { kind: 'live', link: live, status, warning };
  }
  if (!available) return { kind: 'unavailable', reason: unavailableReason ?? '' };
  return { kind: 'create', note: links.length > 0 ? INSTALL_LINK_REVOKED_NOTE : null };
}

// ── Lifecycle derivation ────────────────────────────────────────────────────

function lifecycle(
  analyse: SetupLifecycleStepState,
  configure: SetupLifecycleStepState,
  test: SetupLifecycleStepState,
): SetupLifecycleItem[] {
  return [
    { step: 'Analyse', state: analyse },
    { step: 'Configure', state: configure },
    { step: 'Test', state: test },
    { step: 'Share', state: 'pending' },
  ];
}

// ── The mapper ──────────────────────────────────────────────────────────────

type Core = Pick<
  ApplicationPresentation,
  'state' | 'heading' | 'message' | 'busy' | 'primaryAction' | 'secondaryActions' | 'polling'
> & {
  lifecycle: SetupLifecycleItem[] | null;
  /** Why a customer cannot install yet; null when they can, or when the page
   *  has nothing to say about the link at all. */
  linkUnavailableReason: string | null;
  /** True when the primary card already tells the test deployment's story. */
  cardShowsTest: boolean;
};

/**
 * Derive the single presentation of the application page.
 *
 * Precedence, first match wins:
 *  1. no data at all                       → unavailable
 *  2. an analysis is running or not started → analysing
 *  3. a test deployment operation is active → test-queued / -deploying / -removing
 *  4. the analysis failed                  → analysis-failed
 *  5. an analysis status this build does not know → unknown
 *  6. required changes are open            → configuration-required
 *  7. customer deployments exist           → customers-active
 *  8. the test deployment failed           → test-failed
 *  9. the test deployment is verified      → ready-to-share
 * 10. no test deployment                   → ready-to-test
 * 11. a test deployment state this build does not know → unknown
 *
 * Active operations (2, 3) come before readiness (6) on purpose: readiness
 * data is only as new as the last analysis, the operation is happening now.
 */
export function deriveApplicationPresentation(input: ApplicationStateInput): ApplicationPresentation {
  if (input.data === null) {
    return {
      state: 'unavailable',
      badge: BADGES.unavailable,
      heading: 'This application is temporarily unavailable',
      message: "We couldn't load this application. Your deployments are not affected.",
      busy: false,
      primaryAction: action('retry-load', 'Try again'),
      secondaryActions: [],
      blockers: [],
      readinessSummary: null,
      recommendationCount: 0,
      lifecycle: null,
      polling: null,
      installLinkAvailable: false,
      installLink: { kind: 'hidden' },
      installLinkPlacement: 'none',
      notices: [],
      recentEvent: null,
    };
  }

  const { application, readiness, deployments } = input.data;
  const analysisStatus = readiness.analysisStatus as string;
  const analysed = analysisStatus === 'COMPLETE';
  const required = analysed ? readiness.findings.filter((f) => f.severity === 'required') : [];
  const recommended = analysed ? readiness.findings.filter((f) => f.severity === 'recommended') : [];
  const test = latestTestDeployment(deployments);
  const phase = testDeploymentPhase(test);
  const customers = customerDeployments(deployments);
  const setupComplete = phase === 'verified' || customers.length > 0;
  const configurationHref = `/dashboard/applications/${application.id}/config`;
  const startTestHref = `/dashboard/deployments/new?applicationId=${application.id}&test=true`;
  const configureStep: SetupLifecycleStepState = required.length > 0 ? 'current' : 'done';

  const core = ((): Core => {
    if (analysisStatus === 'PENDING' || analysisStatus === 'ANALYZING') {
      const running = analysisStatus === 'ANALYZING';
      const stuck = running && input.analysisTakingLonger;
      return {
        state: 'analysing',
        heading: running ? 'Analysing your application' : 'Analysis has not started',
        message: stuck
          ? 'This is taking longer than usual. You can wait, or restart the analysis.'
          : running
            ? 'Deployz is reading your repository to work out how to deploy it. This usually takes a minute.'
            : 'Analyse the application so Deployz can work out how to deploy it.',
        busy: running,
        primaryAction: stuck
          ? action('restart-analysis', 'Restart analysis')
          : running
            ? null
            : action('analyse', 'Analyse application'),
        secondaryActions: [],
        polling: { intervalMs: ANALYSIS_POLL_MS },
        lifecycle: lifecycle('current', 'pending', 'pending'),
        linkUnavailableReason: 'Available after the analysis and a successful test deployment.',
        cardShowsTest: false,
      };
    }

    if (test && phase === 'queued') {
      return {
        state: 'test-queued',
        heading: 'Your test deployment has not started',
        message: 'The test deployment is created, but the install has not started in your AWS account yet.',
        busy: false,
        primaryAction: action('continue-test', 'Continue test deployment', deploymentHref(test)),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', configureStep, 'current'),
        linkUnavailableReason: 'Available after a successful test deployment.',
        cardShowsTest: true,
      };
    }

    if (test && phase === 'deploying') {
      return {
        state: 'test-deploying',
        heading: 'Test deployment in progress',
        message: `Current step: ${deploymentDisplayStatus(test).label}.`,
        busy: true,
        primaryAction: action('view-progress', 'View progress', deploymentHref(test)),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', configureStep, 'current'),
        linkUnavailableReason: 'Available after a successful test deployment.',
        cardShowsTest: true,
      };
    }

    if (test && phase === 'removing') {
      return {
        state: 'test-removing',
        heading: 'Removing the test deployment',
        message: 'You can start a new test deployment when the removal is complete.',
        busy: true,
        primaryAction: action('view-progress', 'View progress', deploymentHref(test)),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', configureStep, 'pending'),
        linkUnavailableReason: 'Available after a successful test deployment.',
        cardShowsTest: true,
      };
    }

    if (analysisStatus === 'FAILED') {
      return {
        state: 'analysis-failed',
        heading: "We couldn't analyse your application",
        message: readiness.failureReason ?? 'Something went wrong while reading your repository.',
        busy: false,
        primaryAction: action('retry-analysis', 'Try analysis again'),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('failed', 'pending', 'pending'),
        linkUnavailableReason: 'Available after the analysis and a successful test deployment.',
        cardShowsTest: false,
      };
    }

    if (!analysed) {
      return {
        state: 'unknown',
        heading: "We can't show this application's status",
        message: 'Analyse the application again to refresh its status.',
        busy: false,
        primaryAction: action('analyse', 'Analyse application'),
        secondaryActions: [],
        polling: null,
        lifecycle: null,
        linkUnavailableReason: null,
        cardShowsTest: false,
      };
    }

    if (required.length > 0) {
      return {
        state: 'configuration-required',
        heading: changesRequired(required.length),
        message:
          customers.length > 0
            ? 'New deployments are blocked until these are resolved. Existing customer deployments are not affected.'
            : 'Resolve these before you deploy the application.',
        busy: false,
        primaryAction: action('review-configuration', 'Review configuration', configurationHref),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'current', 'pending'),
        linkUnavailableReason: 'Available after the required changes and a successful test deployment.',
        cardShowsTest: false,
      };
    }

    if (customers.length > 0) {
      const attention = customers.filter((d) => deploymentDisplayStatus(d).group === 'attention').length;
      return {
        state: 'customers-active',
        heading: countLabel(customers.length, 'customer deployment', 'customer deployments'),
        message:
          attention > 0
            ? `${countLabel(attention, 'deployment needs', 'deployments need')} attention.`
            : 'Customers are running this application in their AWS accounts.',
        busy: false,
        primaryAction: action(
          'view-customer-deployments',
          'View deployments',
          `/dashboard/deployments?application=${encodeURIComponent(application.name)}`,
        ),
        secondaryActions: [],
        polling: null,
        lifecycle: null,
        linkUnavailableReason: null,
        cardShowsTest: false,
      };
    }

    if (test && phase === 'failed') {
      const disconnected = (test.state as string) === 'DISCONNECTED';
      return {
        state: 'test-failed',
        heading: disconnected ? 'The test deployment is disconnected' : 'Test deployment failed',
        message: disconnected
          ? 'Deployz lost its connection to the test deployment. Review it before you share the application.'
          : 'The test deployment did not complete. Review the failure, then try again.',
        busy: false,
        primaryAction: action('review-failure', 'Review failure', deploymentHref(test)),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'done', 'failed'),
        linkUnavailableReason: 'Available after a successful test deployment.',
        cardShowsTest: true,
      };
    }

    if (test && phase === 'verified') {
      const url = deploymentUrl(test);
      return {
        state: 'ready-to-share',
        heading: 'Ready to share with customers',
        message: 'Your test deployment passed. Send the install link to your customers.',
        busy: false,
        // The install-link controls render in the card itself (placement
        // 'primary'); these actions name them for surfaces without the link.
        primaryAction: null,
        secondaryActions: [
          ...(url ? [action('open-application', 'Open test application', url, true)] : []),
          action('view-test-deployment', 'View test deployment', deploymentHref(test)),
        ],
        polling: null,
        lifecycle: null,
        linkUnavailableReason: null,
        cardShowsTest: true,
      };
    }

    if (!test) {
      return {
        state: 'ready-to-test',
        heading: 'Ready for a test deployment',
        message: 'Deploy the application to your own AWS account to check it before customers install it.',
        busy: false,
        primaryAction: action('start-test', 'Start test deployment', startTestHref),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'done', 'current'),
        linkUnavailableReason: 'Available after a successful test deployment.',
        cardShowsTest: true,
      };
    }

    return {
      state: 'unknown',
      heading: "We can't show this application's status",
      message: 'Open the test deployment to see what it is doing.',
      busy: false,
      primaryAction: action('view-test-deployment', 'View test deployment', deploymentHref(test)),
      secondaryActions: [],
      polling: null,
      lifecycle: null,
      linkUnavailableReason: null,
      cardShowsTest: true,
    };
  })();

  const installLinkAvailable = core.state === 'ready-to-share' || core.state === 'customers-active';
  const installLink = deriveInstallLink(input.installLinks, installLinkAvailable, core.linkUnavailableReason);

  let primaryAction = core.primaryAction;
  let installLinkPlacement: InstallLinkPlacement = installLink.kind === 'hidden' ? 'none' : 'card';
  if (core.state === 'ready-to-share') {
    installLinkPlacement = 'primary';
    if (installLink.kind === 'create') primaryAction = action('create-install-link', 'Create install link');
    if (installLink.kind === 'live') {
      primaryAction = action('copy-install-link', 'Copy install link');
    }
  }
  const secondaryActions =
    core.state === 'ready-to-share' && installLink.kind === 'live'
      ? [action('preview-install-link', 'Preview', installLink.link.url, true), ...core.secondaryActions]
      : core.secondaryActions;

  const notices: ApplicationNotice[] = [];
  if (input.stale) notices.push({ tone: 'warning', text: STALE_NOTICE });
  if (core.state === 'customers-active' && phase === 'failed') {
    notices.push({ tone: 'warning', text: 'The test deployment needs attention.' });
  }

  let readinessSummary: string | null = null;
  if (analysed) {
    if (required.length > 0) readinessSummary = changesRequired(required.length);
    else if (core.state === 'ready-to-test') readinessSummary = 'Ready to test';
    else readinessSummary = 'No blocking issues';
  }

  const recentEvent: ApplicationRecentEvent | null =
    test && !core.cardShowsTest
      ? {
          label: 'Test deployment',
          status: deploymentDisplayStatus(test).label,
          at: test.updatedAt,
          href: deploymentHref(test),
        }
      : null;

  return {
    state: core.state,
    badge: BADGES[core.state],
    heading: core.heading,
    message: core.message,
    busy: core.busy,
    primaryAction,
    secondaryActions,
    blockers: core.state === 'configuration-required' ? required.map((f) => ({ id: f.id, title: f.title })) : [],
    readinessSummary,
    recommendationCount: recommended.length,
    lifecycle: setupComplete ? null : core.lifecycle,
    polling: core.polling,
    installLinkAvailable,
    installLink,
    installLinkPlacement,
    notices,
    recentEvent,
  };
}
