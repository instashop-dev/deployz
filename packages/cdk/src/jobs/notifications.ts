/**
 * §47 Notification engine — event→notification mapping, in-app + email dispatch.
 *
 * The notification engine is a read-only consumer of the §62 event stream.
 * It does NOT modify workflow state — it maps events to notifications and
 * dispatches them through injectable seams (NotificationStore + EmailSender).
 *
 * Event set (§47):
 *   install.completed / install.failed
 *   deploy.completed / deploy.failed
 *   rollback.completed / rollback.failed
 *   destroy.initiated / destroy.completed / destroy.failed
 *   health.degraded / health.unhealthy / health.recovered
 *   billing.subscription.active / billing.subscription.past_due / billing.subscription.canceled
 *
 * S8 guardrail: in-app + email only — no Slack, no webhooks, no SMS.
 *
 * §65 jargon-free copy: templates use no raw AWS/ECS/CFN/IAM terms.
 *
 * Idempotency: the same event+deployment should not generate duplicate notifications.
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

// ── Notification engine ───────────────────────────────────────────────────

/**
 * §47 notification engine.
 *
 * Listens to the §62 event stream and dispatches in-app + email notifications
 * through injectable seams. Does NOT modify workflow state.
 *
 * Idempotency: tracks (eventType, deploymentId) pairs to prevent duplicates.
 * The same event+deployment combination processed twice only generates
 * notifications once.
 */
export class NotificationEngine {
  private readonly _processed = new Set<string>();

  constructor(
    private readonly notificationStore: NotificationStore,
    private readonly emailSender: EmailSender,
    /** Optional clock for deterministic tests. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Process an event from the §62 stream. If the event is notification-worthy,
   * generates in-app + email notifications. Idempotent: the same event+deployment
   * only generates notifications once.
   */
  async processEvent(event: EventRecord): Promise<void> {
    if (!isNotificationEvent(event.eventType)) {
      return;
    }

    // Idempotency key: eventType + deploymentId
    const key = `${event.eventType}:${event.deploymentId ?? 'none'}`;
    if (this._processed.has(key)) {
      return;
    }
    this._processed.add(key);

    const channels = getNotificationChannels(event.eventType);
    const context = buildTemplateContext(event);
    const template = getNotificationTemplate(event.eventType, context);

    const promises: Promise<void>[] = [];

    if (channels.includes('in-app')) {
      const notification = createInAppNotification(
        event,
        template,
        this.clock,
      );
      promises.push(this.notificationStore.create(notification));
    }

    if (channels.includes('email')) {
      // Email recipient: in production this would be resolved from the
      // organization's contact email; for now we use a placeholder that
      // the real resolver will replace.
      const to = `org-${event.organizationId}@notifications.deployz.dev`;
      promises.push(
        sendEmailNotification(to, template, this.emailSender),
      );
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
 */
export function createInAppNotification(
  event: EventRecord,
  template: NotificationTemplate,
  clock: () => Date = () => new Date(),
): InAppNotification {
  const id = `notif-${event.occurredAt}-${event.eventType}-${event.deploymentId ?? 'none'}`;
  return {
    id,
    organizationId: event.organizationId,
    deploymentId: event.deploymentId,
    eventType: event.eventType,
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