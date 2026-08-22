/**
 * §47 Notification engine — event→notification mapping, in-app + email dispatch.
 *
 * The notification engine is a read-only consumer of the §62 event stream.
 * It does NOT modify workflow state — it maps events to notifications and
 * dispatches them through injectable seams (NotificationStore + EmailSender).
 *
 * §47's eight ESSENTIAL notifications (docs/project-brief.md §47):
 *   installation completed / installation failed
 *   update completed / update failed
 *   deployment unhealthy
 *   relay disconnected
 *   rollback completed
 *   AWS permission issue
 *
 * `NOTIFICATION_EVENT_TYPES` below is a SUPERSET of those eight — it adds a
 * few more product-useful notifications (destroy lifecycle, health.degraded/
 * recovered, billing) that aren't in the essential list but are reasonable
 * to also support. Item 7 fix: `health.relay.disconnected` and
 * `health.aws_permission_issue` are the two §47 types that previously had NO
 * representation at all (named under the `health.*` §40 family rather than
 * standalone `relay.*`/`aws.*` types — see the inline comments below).
 *
 * Item 7 fix — vocabulary mismatch: the workflows (install/deploy/rollback/
 * destroy-workflow.ts) emit their OWN granular §40/§62 audit vocabulary
 * (`install.state.healthy`, `deploy.state.failed`, `destroy.complete`, ...) —
 * that vocabulary is an audit record (§40/§62) and must NOT be renamed to
 * satisfy notifications. Instead, `mapWorkflowEventToNotification` below is
 * the ONLY place raw workflow events get translated into the canonical §47
 * types. `NotificationEngine.processEvent` runs every event through this
 * mapping before checking whether it's notification-worthy, so a raw
 * workflow event now actually produces a notification (previously it never
 * could — none of the raw event type strings appeared in
 * `NOTIFICATION_EVENT_TYPES` at all). A canonical type given directly (as
 * many unit tests below do) still works unchanged (identity mapping).
 *
 * S8 guardrail: in-app + email only — no Slack, no webhooks, no SMS.
 *
 * §65 jargon-free copy: templates use no raw AWS/ECS/CFN/IAM terms.
 *
 * Idempotency: the same NOTIFICATION (not raw event) + deployment should not
 * generate duplicate notifications — the idempotency key is keyed on the
 * canonical notification type, not the raw §62 event type, since several raw
 * events can map to the same notification (e.g. any of install's preflight
 * sub-checks failing all map to `install.failed`).
 */

import type { EventRecord } from './event-emitter.js';

// ── Notification channel ──────────────────────────────────────────────────

export type NotificationChannel = 'in-app' | 'email';

// ── Event set (§47) ───────────────────────────────────────────────────────

/**
 * The notification-worthy events. Every event in this set triggers both
 * in-app and email notifications (S8: no Slack/webhooks in MVP).
 */
export const NOTIFICATION_EVENT_TYPES = [
  'install.completed',
  'install.failed',
  'deploy.completed',
  'deploy.failed',
  'rollback.completed',
  'rollback.failed',
  'destroy.initiated',
  'destroy.completed',
  'destroy.failed',
  'health.degraded',
  'health.unhealthy',
  'health.recovered',
  /**
   * §47 "relay disconnected" — item 7. Named `health.*` (rather than a
   * standalone `relay.disconnected`) so it stays inside the `health` §40
   * event family — it's the exact string health-monitor.ts's
   * `reconcileDeploymentHealth` (item 10a) already emits, so the mapping
   * below is a plain identity match.
   */
  'health.relay.disconnected',
  /**
   * §47 "AWS permission issue" — item 7. Named `health.*` for the same
   * §40-family reason as above — an AWS permission issue is fundamentally a
   * deployment-health/access-status notification.
   */
  'health.aws_permission_issue',
  'billing.subscription.active',
  'billing.subscription.past_due',
  'billing.subscription.canceled',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

// ── Channel mapping ───────────────────────────────────────────────────────

/**
 * Pure function: maps an event type to its notification channels.
 * All events in the §47 set use both in-app + email (S8).
 */
export function getNotificationChannels(
  eventType: string,
): NotificationChannel[] {
  if (isNotificationEvent(eventType)) {
    return ['in-app', 'email'];
  }
  return [];
}

/**
 * Returns true if the event type is in the §47 notification-worthy set.
 */
export function isNotificationEvent(eventType: string): eventType is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(eventType);
}

// ── Raw §62 workflow event → canonical §47 notification (item 7) ──────────

const FAILED_PREFIX = 'failed:';

/** Extract the §61 failure code from a §62 `result` string like `failed:MIGRATION_FAILED`. */
function extractFailureCode(result: string | null): string | undefined {
  if (!result || !result.startsWith(FAILED_PREFIX)) return undefined;
  return result.slice(FAILED_PREFIX.length);
}

/**
 * True for any failure result — either `failed:CODE` (install/deploy/
 * rollback-workflow.ts) or the bare `failed` destroy-workflow.ts uses for
 * its resource/database/storage/ecr-grant/billing steps (they don't carry a
 * §61 failure code on the event itself).
 */
function isFailedResult(result: string | null): boolean {
  return result === 'failed' || extractFailureCode(result) !== undefined;
}

/** §61 failure codes that mean "AWS permission issue" (§47) rather than a generic failure. */
const PERMISSION_FAILURE_CODES = new Set(['AWS_PERMISSION_DENIED', 'AWS_SCP_BLOCKED']);

/** A raw event type maps to a fixed notification, or conditionally based on its `result`. */
type WorkflowEventMapping =
  | NotificationEventType
  | ((result: string | null) => NotificationEventType | undefined);

/**
 * Maps the workflows' own raw §40/§62 event vocabulary to the canonical §47
 * notification it represents. This table — NOT a rename of the workflow
 * events — is what item 7 fixes: previously none of these raw event type
 * strings appeared anywhere in `NOTIFICATION_EVENT_TYPES`, so no notification
 * could ever fire from a real workflow run.
 */
const WORKFLOW_EVENT_MAP: Record<string, WorkflowEventMapping> = {
  // install-workflow.ts
  'install.state.healthy': 'install.completed',
  'install.preflight.region': (r) => (extractFailureCode(r) ? 'install.failed' : undefined),
  'install.preflight.scp': (r) => (extractFailureCode(r) ? 'install.failed' : undefined),
  'install.preflight.full': (r) => (extractFailureCode(r) ? 'install.failed' : undefined),
  'install.relay.contact': (r) => (extractFailureCode(r) ? 'install.failed' : undefined),
  'install.relay.health': (r) => (extractFailureCode(r) ? 'install.failed' : undefined),

  // deploy-release-workflow.ts
  'deploy.state.healthy': 'deploy.completed',
  'deploy.state.update-available': 'deploy.completed',
  'deploy.state.failed': 'deploy.failed',
  'deploy.preflight': (r) => (extractFailureCode(r) ? 'deploy.failed' : undefined),

  // rollback-workflow.ts
  'rollback.state.healthy': 'rollback.completed',
  'rollback.restore': (r) => (extractFailureCode(r) ? 'rollback.failed' : undefined),
  'rollback.health': (r) => (extractFailureCode(r) ? 'rollback.failed' : undefined),

  // destroy-workflow.ts
  'destroy.state.deleting': 'destroy.initiated',
  'destroy.complete': 'destroy.completed',
  'destroy.complete.degraded': 'destroy.completed',
  'destroy.resources': (r) => (isFailedResult(r) ? 'destroy.failed' : undefined),
  'destroy.database': (r) => (isFailedResult(r) ? 'destroy.failed' : undefined),
  'destroy.storage': (r) => (isFailedResult(r) ? 'destroy.failed' : undefined),
  'destroy.ecr-grant': (r) => (isFailedResult(r) ? 'destroy.failed' : undefined),
  'destroy.billing': (r) => (isFailedResult(r) ? 'destroy.failed' : undefined),

  // health-monitor.ts's `reconcileDeploymentHealth` (item 10a) already emits
  // `health.relay.disconnected` as its raw event, which IS the canonical
  // notification type — no separate WORKFLOW_EVENT_MAP entry needed, the
  // identity branch below handles it.
};

/**
 * Translate a §62 event record into the canonical §47 notification type it
 * represents, or `undefined` if it isn't notification-worthy.
 *
 * Priority order:
 *  1. An `AWS_PERMISSION_DENIED` / `AWS_SCP_BLOCKED` failure code ALWAYS maps
 *     to `health.aws_permission_issue` (§47), regardless of which workflow
 *     emitted it — this is a distinct, more actionable notification than a
 *     generic "X failed".
 *  2. An event type that IS ALREADY a canonical `NotificationEventType`
 *     passes through unchanged (identity) — callers (and existing tests)
 *     that construct events with canonical names keep working.
 *  3. Otherwise, `WORKFLOW_EVENT_MAP` translates the workflow's raw §40/§62
 *     vocabulary.
 */
export function mapWorkflowEventToNotification(
  event: EventRecord,
): NotificationEventType | undefined {
  const failureCode = extractFailureCode(event.result);
  if (failureCode && PERMISSION_FAILURE_CODES.has(failureCode)) {
    return 'health.aws_permission_issue';
  }

  if (isNotificationEvent(event.eventType)) {
    return event.eventType;
  }

  const mapped = WORKFLOW_EVENT_MAP[event.eventType];
  if (typeof mapped === 'function') {
    return mapped(event.result);
  }
  return mapped;
}

// ── Notification template ─────────────────────────────────────────────────

export interface NotificationTemplate {
  readonly subject: string;
  readonly body: string;
}

/**
 * Jargon-free copy for each event type (§65).
 * Templates are pure — they use the context to fill in details but never
 * expose raw AWS/ECS/CFN/IAM service names.
 */
const TEMPLATES: Record<NotificationEventType, (ctx: Record<string, unknown>) => NotificationTemplate> = {
  'install.completed': (ctx) => ({
    subject: 'Installation complete',
    body: `Your deployment ${ctx['deploymentId'] ?? 'unknown'} has been installed successfully.`,
  }),
  'install.failed': (ctx) => ({
    subject: 'Installation failed',
    body: `Installation for deployment ${ctx['deploymentId'] ?? 'unknown'} could not be completed.`,
  }),
  'deploy.completed': (ctx) => ({
    subject: 'Deployment complete',
    body: `Release ${ctx['releaseId'] ?? 'unknown'} has been deployed to ${ctx['deploymentId'] ?? 'your deployment'} successfully.`,
  }),
  'deploy.failed': (ctx) => ({
    subject: 'Deployment failed',
    body: `Deployment to ${ctx['deploymentId'] ?? 'your deployment'} could not be completed.`,
  }),
  'rollback.completed': (ctx) => ({
    subject: 'Rollback complete',
    body: `Your deployment ${ctx['deploymentId'] ?? 'unknown'} has been rolled back successfully.`,
  }),
  'rollback.failed': (ctx) => ({
    subject: 'Rollback failed',
    body: `Rollback for deployment ${ctx['deploymentId'] ?? 'unknown'} could not be completed.`,
  }),
  'destroy.initiated': (ctx) => ({
    subject: 'Resource cleanup started',
    body: `Resource cleanup has been initiated for deployment ${ctx['deploymentId'] ?? 'unknown'}.`,
  }),
  'destroy.completed': (ctx) => ({
    subject: 'Resource cleanup complete',
    body: `All resources for deployment ${ctx['deploymentId'] ?? 'unknown'} have been cleaned up.`,
  }),
  'destroy.failed': (ctx) => ({
    subject: 'Resource cleanup failed',
    body: `Resource cleanup for deployment ${ctx['deploymentId'] ?? 'unknown'} could not be completed.`,
  }),
  'health.degraded': (ctx) => ({
    subject: 'Deployment health degraded',
    body: `Deployment ${ctx['deploymentId'] ?? 'unknown'} is experiencing degraded performance.`,
  }),
  'health.unhealthy': (ctx) => ({
    subject: 'Deployment unhealthy',
    body: `Deployment ${ctx['deploymentId'] ?? 'unknown'} is currently unhealthy.`,
  }),
  'health.recovered': (ctx) => ({
    subject: 'Deployment health recovered',
    body: `Deployment ${ctx['deploymentId'] ?? 'unknown'} has recovered and is healthy again.`,
  }),
  'health.relay.disconnected': (ctx) => ({
    subject: 'Connection lost',
    body: `We haven't heard from the helper for deployment ${ctx['deploymentId'] ?? 'unknown'} in a while. We'll keep trying to reconnect.`,
  }),
  'health.aws_permission_issue': (ctx) => ({
    subject: 'Account permission issue',
    body: `We're missing a permission needed to manage deployment ${ctx['deploymentId'] ?? 'unknown'}. Please check your account's access settings.`,
  }),
  'billing.subscription.active': (ctx) => ({
    subject: 'Subscription active',
    body: `Your subscription for deployment ${ctx['deploymentId'] ?? 'unknown'} is now active.`,
  }),
  'billing.subscription.past_due': (ctx) => ({
    subject: 'Payment required',
    body: `Payment for your subscription (deployment ${ctx['deploymentId'] ?? 'unknown'}) is past due. Please update your payment method to avoid interruption.`,
  }),
  'billing.subscription.canceled': (ctx) => ({
    subject: 'Subscription canceled',
    body: `Your subscription for deployment ${ctx['deploymentId'] ?? 'unknown'} has been canceled.`,
  }),
};

/**
 * Pure function: returns a populated notification template for an event.
 */
export function getNotificationTemplate(
  eventType: string,
  context: Record<string, unknown>,
): NotificationTemplate {
  if (isNotificationEvent(eventType)) {
    return TEMPLATES[eventType](context);
  }
  return {
    subject: 'Notification',
    body: `Event: ${eventType}`,
  };
}

// ── In-app notification ───────────────────────────────────────────────────

export interface InAppNotification {
  readonly id: string;
  readonly organizationId: string;
  readonly deploymentId: string | null;
  readonly eventType: string;
  readonly title: string;
  readonly body: string;
  readonly read: boolean;
  readonly createdAt: string;
}

/** Injectable store for persisting in-app notifications. */
export interface NotificationStore {
  create(notification: InAppNotification): Promise<void>;
}

/** In-memory notification store for tests. */
export class InMemoryNotificationStore implements NotificationStore {
  private readonly _notifications: InAppNotification[] = [];

  async create(notification: InAppNotification): Promise<void> {
    this._notifications.push(notification);
  }

  /** All stored notifications (readonly snapshot). */
  get notifications(): readonly InAppNotification[] {
    return this._notifications;
  }

  /** Number of stored notifications. */
  get count(): number {
    return this._notifications.length;
  }

  /** Clear all notifications (test isolation only — not on the NotificationStore interface). */
  clear(): void {
    this._notifications.length = 0;
  }
}

// ── Email sender seam ─────────────────────────────────────────────────────

/** Stored email record for test assertions. */
export interface StoredEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Injectable email sender seam. */
export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

/** Stub email sender — records sent emails for test assertions. */
export class StubEmailSender implements EmailSender {
  private readonly _sent: StoredEmail[] = [];

  async send(to: string, subject: string, body: string): Promise<void> {
    this._sent.push({ to, subject, body });
  }

  /** All sent emails (readonly snapshot). */
  get sent(): readonly StoredEmail[] {
    return this._sent;
  }

  /** Number of sent emails. */
  get count(): number {
    return this._sent.length;
  }

  /** Clear all sent emails (test isolation only). */
  clear(): void {
    this._sent.length = 0;
  }
}

// ── SES email sender ──────────────────────────────────────────────────────

import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';

export interface SesEmailSenderConfig {
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly region?: string;
  readonly fromAddress?: string;
}

/**
 * Real email sender backed by AWS SES. Sends from the verified
 * `notifications@e.deployz.dev` address by default. Credentials come from
 * AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY env vars (or the
 * ambient AWS SDK credential chain when those are absent).
 */
export class SesEmailSender implements EmailSender {
  private readonly client: SESClient;
  private readonly from: string;

  constructor(config: SesEmailSenderConfig = {}) {
    this.client = new SESClient({
      region: config.region ?? process.env.AWS_REGION ?? 'us-east-1',
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
    this.from = config.fromAddress ?? 'notifications@e.deployz.dev';
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
      }),
    );
  }
}

// ── Organization contact resolution (item 8) ───────────────────────────────

/**
 * Injectable seam: resolves the organization's notification contact email.
 *
 * PENDING-DB: the real resolver reads the organization's contact email from
 * the `organizations` table. Item 8: the notification engine used to
 * synthesize `org-${organizationId}@notifications.deployz.dev`, an address
 * that resolves nowhere. There is no safe default that invents a real-looking
 * address, so the default resolver (`NoOrganizationContactStore`) returns
 * `null` — "no recipient" — rather than guessing; the notification is simply
 * not emailed (the in-app notification still is) until a real resolver is
 * injected.
 */
export interface OrganizationContactStore {
  /** Resolves the organization's contact email, or null if unset/unknown. */
  getContactEmail(organizationId: string): Promise<string | null>;
}

/** Default seam — no lookup configured. Never synthesizes an address. */
export class NoOrganizationContactStore implements OrganizationContactStore {
  async getContactEmail(): Promise<string | null> {
    return null;
  }
}

// ── Notification engine ───────────────────────────────────────────────────

/**
 * §47 notification engine.
 *
 * Listens to the §62 event stream and dispatches in-app + email notifications
 * through injectable seams. Does NOT modify workflow state.
 *
 * Idempotency: tracks (notificationType, deploymentId) pairs to prevent
 * duplicates — keyed on the CANONICAL §47 notification type (item 7), not
 * the raw §62 event type, since multiple raw events can map to the same
 * notification.
 */
export class NotificationEngine {
  private readonly _processed = new Set<string>();

  constructor(
    private readonly notificationStore: NotificationStore,
    private readonly emailSender: EmailSender,
    /** Optional clock for deterministic tests. */
    private readonly clock: () => Date = () => new Date(),
    /** Item 8: organization contact-email lookup. Defaults to "no recipient". */
    private readonly contactStore: OrganizationContactStore = new NoOrganizationContactStore(),
  ) {}

  /**
   * Process an event from the §62 stream. If the event maps to a §47
   * notification (item 7: either directly, or via the raw-workflow-event
   * mapping table), generates in-app + email notifications. Idempotent: the
   * same notification+deployment only generates notifications once.
   */
  async processEvent(event: EventRecord): Promise<void> {
    const notificationType = mapWorkflowEventToNotification(event);
    if (!notificationType) {
      return;
    }

    // Idempotency key: canonical notification type + deploymentId
    const key = `${notificationType}:${event.deploymentId ?? 'none'}`;
    if (this._processed.has(key)) {
      return;
    }
    this._processed.add(key);

    const channels = getNotificationChannels(notificationType);
    const context = buildTemplateContext(event);
    const template = getNotificationTemplate(notificationType, context);

    const promises: Promise<void>[] = [];

    if (channels.includes('in-app')) {
      const notification = createInAppNotification(
        event,
        template,
        this.clock,
        notificationType,
      );
      promises.push(this.notificationStore.create(notification));
    }

    if (channels.includes('email')) {
      const to = await this.contactStore.getContactEmail(event.organizationId);
      if (to) {
        promises.push(sendEmailNotification(to, template, this.emailSender));
      }
      // else: no resolvable recipient — skip the email rather than invent
      // an address (item 8). The in-app notification above still fires.
    }

    await Promise.all(promises);
  }

  /** Number of idempotency-tracked events (test visibility). */
  get processedCount(): number {
    return this._processed.size;
  }

  /** Clear idempotency cache (test isolation only — not on the interface). */
  clearProcessed(): void {
    this._processed.clear();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build the template context from an event record.
 * Maps §62 fields to template-friendly names at the copy layer (§65).
 */
function buildTemplateContext(event: EventRecord): Record<string, unknown> {
  return {
    deploymentId: event.deploymentId,
    organizationId: event.organizationId,
    releaseId: event.releaseId,
    jobId: event.jobId,
    eventType: event.eventType,
    result: event.result,
    previousState: event.previousState,
    requestedState: event.requestedState,
    ...event.payload,
  };
}

/**
 * Create an in-app notification from an event and template.
 *
 * `notificationType` — when supplied, overrides `event.eventType` for the
 * stored `eventType`/`id` fields. The notification engine passes the
 * CANONICAL §47 type here (see `mapWorkflowEventToNotification`, item 7) so
 * stored/queryable notifications always use product vocabulary
 * (`install.completed`) rather than a workflow's raw internal event name
 * (`install.state.healthy`). Defaults to `event.eventType` for direct callers
 * that already pass a canonical type.
 */
export function createInAppNotification(
  event: EventRecord,
  template: NotificationTemplate,
  clock: () => Date = () => new Date(),
  notificationType: string = event.eventType,
): InAppNotification {
  const id = `notif-${event.occurredAt}-${notificationType}-${event.deploymentId ?? 'none'}`;
  return {
    id,
    organizationId: event.organizationId,
    deploymentId: event.deploymentId,
    eventType: notificationType,
    title: template.subject,
    body: template.body,
    read: false,
    createdAt: clock().toISOString(),
  };
}

/**
 * Send an email notification through the injectable sender seam.
 * Real email sending is PENDING-AWS/CREDENTIALS.
 */
export async function sendEmailNotification(
  to: string,
  template: NotificationTemplate,
  sender: EmailSender,
): Promise<void> {
  await sender.send(to, template.subject, template.body);
}