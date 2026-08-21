import { beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryEventStore,
  type EventActor,
  type EventRecord,
} from '../src/jobs/event-emitter.js';

import {
  createInAppNotification,
  getNotificationChannels,
  getNotificationTemplate,
  InMemoryNotificationStore,
  isNotificationEvent,
  NOTIFICATION_EVENT_TYPES,
  NotificationEngine,
  StubEmailSender,
  type InAppNotification,
  type NotificationChannel,
} from '../src/jobs/notifications.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');

function fixedClock(): Date {
  return FIXED_NOW;
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    occurredAt: FIXED_NOW.toISOString(),
    actorType: 'system',
    actorId: 'system',
    organizationId: 'org-1',
    customerId: 'customer-1',
    deploymentId: 'deployment-1',
    jobId: 'job-1',
    releaseId: 'release-1',
    eventType: 'install.completed',
    previousState: 'INSTALLING',
    requestedState: 'HEALTHY',
    result: 'completed',
    payload: {},
    ...overrides,
  };
}

interface EngineHarness {
  engine: NotificationEngine;
  notificationStore: InMemoryNotificationStore;
  emailSender: StubEmailSender;
}

function makeHarness(): EngineHarness {
  const notificationStore = new InMemoryNotificationStore();
  const emailSender = new StubEmailSender();
  const engine = new NotificationEngine(notificationStore, emailSender, fixedClock);
  return { engine, notificationStore, emailSender };
}

// ── Event set tests (§47) ────────────────────────────────────────────────

describe('§47 notification event set', () => {
  it('contains exactly 15 notification-worthy events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toHaveLength(15);
  });

  it('includes install events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('install.completed');
    expect(NOTIFICATION_EVENT_TYPES).toContain('install.failed');
  });

  it('includes deploy events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('deploy.completed');
    expect(NOTIFICATION_EVENT_TYPES).toContain('deploy.failed');
  });

  it('includes rollback events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('rollback.completed');
    expect(NOTIFICATION_EVENT_TYPES).toContain('rollback.failed');
  });

  it('includes destroy events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('destroy.initiated');
    expect(NOTIFICATION_EVENT_TYPES).toContain('destroy.completed');
    expect(NOTIFICATION_EVENT_TYPES).toContain('destroy.failed');
  });

  it('includes health events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('health.degraded');
    expect(NOTIFICATION_EVENT_TYPES).toContain('health.unhealthy');
    expect(NOTIFICATION_EVENT_TYPES).toContain('health.recovered');
  });

  it('includes billing events', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('billing.subscription.active');
    expect(NOTIFICATION_EVENT_TYPES).toContain('billing.subscription.past_due');
    expect(NOTIFICATION_EVENT_TYPES).toContain('billing.subscription.canceled');
  });

  it('isNotificationEvent returns true for known events', () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      expect(isNotificationEvent(eventType)).toBe(true);
    }
  });

  it('isNotificationEvent returns false for unknown events', () => {
    expect(isNotificationEvent('install.starting')).toBe(false);
    expect(isNotificationEvent('deploy.preflight')).toBe(false);
    expect(isNotificationEvent('config.updated')).toBe(false);
    expect(isNotificationEvent('arbitrary.event')).toBe(false);
  });
});

// ── Channel mapping ──────────────────────────────────────────────────────

describe('getNotificationChannels', () => {
  it('returns both channels for all notification events', () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      const channels = getNotificationChannels(eventType);
      expect(channels).toEqual(['in-app', 'email']);
    }
  });

  it('returns empty array for non-notification events', () => {
    expect(getNotificationChannels('install.starting')).toEqual([]);
    expect(getNotificationChannels('deploy.preflight')).toEqual([]);
    expect(getNotificationChannels('config.updated')).toEqual([]);
  });

  it('channels are readonly-safe (S8: no Slack/webhooks)', () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      const channels = getNotificationChannels(eventType);
      for (const channel of channels) {
        expect(['in-app', 'email'] as NotificationChannel[]).toContain(channel);
      }
    }
  });
});

// ── Template generation (§65 jargon-free) ────────────────────────────────

describe('getNotificationTemplate (§65 jargon-free copy)', () => {
  const ctx = {
    deploymentId: 'my-deployment',
    releaseId: 'release-1',
    organizationId: 'org-1',
  };

  it('generates templates for all notification events without error', () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      const template = getNotificationTemplate(eventType, ctx);
      expect(template.subject).toBeTruthy();
      expect(template.body).toBeTruthy();
    }
  });

  it('falls back to a generic template for unknown event types', () => {
    const template = getNotificationTemplate('custom.event', ctx);
    expect(template.subject).toBe('Notification');
    expect(template.body).toContain('custom.event');
  });

  describe('§65 no raw AWS/ECS/CFN/IAM terms', () => {
    const forbiddenTerms = ['AWS', 'ECS', 'CFN', 'CloudFormation', 'IAM', 'Fargate', 'ECR', 'S3', 'RDS'];

    it('no forbidden terms in templates', () => {
      for (const eventType of NOTIFICATION_EVENT_TYPES) {
        const template = getNotificationTemplate(eventType, ctx);
        const fullText = `${template.subject} ${template.body}`;
        for (const term of forbiddenTerms) {
          expect(fullText).not.toContain(term);
        }
      }
    });
  });

  it('deploymentId appears in body when provided', () => {
    const template = getNotificationTemplate('install.completed', {
      deploymentId: 'my-deployment',
    });
    expect(template.body).toContain('my-deployment');
  });

  it('handles missing context gracefully', () => {
    const template = getNotificationTemplate('deploy.completed', {});
    expect(template.subject).toBeTruthy();
    expect(template.body).toBeTruthy();
  });
});

// ── In-app notification creation ─────────────────────────────────────────

describe('createInAppNotification', () => {
  const event = makeEvent({ eventType: 'install.completed' });
  const template = getNotificationTemplate('install.completed', {
    deploymentId: 'deployment-1',
  });

  it('creates a notification with the correct shape', () => {
    const notif = createInAppNotification(event, template, fixedClock);

    expect(notif.id).toBeTruthy();
    expect(notif.organizationId).toBe('org-1');
    expect(notif.deploymentId).toBe('deployment-1');
    expect(notif.eventType).toBe('install.completed');
    expect(notif.title).toBe(template.subject);
    expect(notif.body).toBe(template.body);
    expect(notif.read).toBe(false);
    expect(notif.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('generates a unique id from event details', () => {
    const notif = createInAppNotification(event, template, fixedClock);
    expect(notif.id).toContain('notif-');
    expect(notif.id).toContain('install.completed');
    expect(notif.id).toContain('deployment-1');
  });

  it('handles null deploymentId in notification id', () => {
    const eventNoDeployment = makeEvent({
      eventType: 'health.unhealthy',
      deploymentId: null,
    });
    const notif = createInAppNotification(eventNoDeployment, { subject: 'x', body: 'y' }, fixedClock);
    expect(notif.id).toContain('none');
    expect(notif.deploymentId).toBeNull();
  });
});

// ── Email sender stub ────────────────────────────────────────────────────

describe('StubEmailSender', () => {
  let sender: StubEmailSender;

  beforeEach(() => {
    sender = new StubEmailSender();
  });

  it('records sent emails', async () => {
    await sender.send('user@test.com', 'Subject', 'Body text');

    expect(sender.count).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual({
      to: 'user@test.com',
      subject: 'Subject',
      body: 'Body text',
    });
  });

  it('records multiple emails in order', async () => {
    await sender.send('a@test.com', 'First', 'Body 1');
    await sender.send('b@test.com', 'Second', 'Body 2');

    expect(sender.count).toBe(2);
    expect(sender.sent[0]?.to).toBe('a@test.com');
    expect(sender.sent[1]?.to).toBe('b@test.com');
  });

  it('sends with empty body', async () => {
    await sender.send('user@test.com', 'No body', '');

    expect(sender.sent[0]?.body).toBe('');
  });

  it('clear resets the sent list', async () => {
    await sender.send('user@test.com', 'X', 'Y');
    sender.clear();

    expect(sender.count).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

// ── Notification engine integration ──────────────────────────────────────

describe('NotificationEngine', () => {
  let harness: EngineHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  // ── In-app notification dispatch ─

  describe('in-app notifications', () => {
    it('creates in-app notification for install.completed', async () => {
      const event = makeEvent({ eventType: 'install.completed' });
      await harness.engine.processEvent(event);

      expect(harness.notificationStore.count).toBe(1);

      const notif = harness.notificationStore.notifications[0]!;
      expect(notif.eventType).toBe('install.completed');
      expect(notif.organizationId).toBe('org-1');
      expect(notif.deploymentId).toBe('deployment-1');
      expect(notif.title).toBe('Installation complete');
      expect(notif.read).toBe(false);
    });

    it('creates in-app notification for health.unhealthy', async () => {
      const event = makeEvent({
        eventType: 'health.unhealthy',
        previousState: 'HEALTHY',
        requestedState: 'UNHEALTHY',
      });
      await harness.engine.processEvent(event);

      expect(harness.notificationStore.count).toBe(1);
      expect(harness.notificationStore.notifications[0]?.title).toBe('Deployment unhealthy');
    });

    it('creates in-app notification for billing.subscription.past_due', async () => {
      const event = makeEvent({
        eventType: 'billing.subscription.past_due',
        deploymentId: null,
      });
      await harness.engine.processEvent(event);

      expect(harness.notificationStore.count).toBe(1);
      expect(harness.notificationStore.notifications[0]?.title).toBe('Payment required');
    });

    it('does not create notifications for non-notification events', async () => {
      const event = makeEvent({ eventType: 'install.starting' });
      await harness.engine.processEvent(event);

      expect(harness.notificationStore.count).toBe(0);
    });
  });

  // ── Email dispatch ─

  describe('email notifications', () => {
    it('sends email for install.completed', async () => {
      const event = makeEvent({ eventType: 'install.completed' });
      await harness.engine.processEvent(event);

      expect(harness.emailSender.count).toBe(1);

      const email = harness.emailSender.sent[0]!;
      expect(email.subject).toBe('Installation complete');
      expect(email.body).toContain('deployment-1');
      expect(email.to).toContain('org-1');
    });

    it('sends email for deploy.failed', async () => {
      const event = makeEvent({ eventType: 'deploy.failed' });
      await harness.engine.processEvent(event);

      expect(harness.emailSender.count).toBe(1);
      expect(harness.emailSender.sent[0]?.subject).toBe('Deployment failed');
    });

    it('does not send email for non-notification events', async () => {
      const event = makeEvent({ eventType: 'deploy.preflight' });
      await harness.engine.processEvent(event);

      expect(harness.emailSender.count).toBe(0);
    });
  });

  // ── Both channels dispatched ─

  describe('dual-channel dispatch', () => {
    it('sends both in-app and email for all notification events', async () => {
      for (const eventType of NOTIFICATION_EVENT_TYPES) {
        const h = makeHarness();
        const event = makeEvent({ eventType });
        await h.engine.processEvent(event);

        expect(
          h.notificationStore.count,
          `in-app missing for ${eventType}`,
        ).toBeGreaterThanOrEqual(1);
        expect(
          h.emailSender.count,
          `email missing for ${eventType}`,
        ).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ── Idempotency ─

  describe('idempotency', () => {
    it('processes the same event only once', async () => {
      const event = makeEvent({ eventType: 'install.completed' });

      await harness.engine.processEvent(event);
      await harness.engine.processEvent(event);
      await harness.engine.processEvent(event);

      // Only one set of notifications generated
      expect(harness.notificationStore.count).toBe(1);
      expect(harness.emailSender.count).toBe(1);
      expect(harness.engine.processedCount).toBe(1);
    });

    it('processes different events for the same deployment', async () => {
      const event1 = makeEvent({ eventType: 'install.completed' });
      const event2 = makeEvent({ eventType: 'deploy.completed' });

      await harness.engine.processEvent(event1);
      await harness.engine.processEvent(event2);

      // Two different event types → two notifications each
      expect(harness.notificationStore.count).toBe(2);
      expect(harness.emailSender.count).toBe(2);
      expect(harness.engine.processedCount).toBe(2);
    });

    it('processes the same event type for different deployments', async () => {
      const event1 = makeEvent({
        eventType: 'install.completed',
        deploymentId: 'deployment-1',
      });
      const event2 = makeEvent({
        eventType: 'install.completed',
        deploymentId: 'deployment-2',
      });

      await harness.engine.processEvent(event1);
      await harness.engine.processEvent(event2);

      // Same event type, different deployments → two notifications each
      expect(harness.notificationStore.count).toBe(2);
      expect(harness.emailSender.count).toBe(2);
      expect(harness.engine.processedCount).toBe(2);
    });

    it('processes same event type with null deployment once', async () => {
      const event = makeEvent({
        eventType: 'billing.subscription.active',
        deploymentId: null,
      });

      await harness.engine.processEvent(event);
      await harness.engine.processEvent(event);

      expect(harness.notificationStore.count).toBe(1);
      expect(harness.engine.processedCount).toBe(1);
    });
  });

  // ── Notification structure assertions ─

  describe('notification structure', () => {
    it('in-app notification has all required fields', async () => {
      const event = makeEvent({ eventType: 'rollback.completed' });
      await harness.engine.processEvent(event);

      const notif: InAppNotification | undefined = harness.notificationStore.notifications[0];
      expect(notif).toBeDefined();
      if (!notif) return;

      expect(typeof notif.id).toBe('string');
      expect(typeof notif.organizationId).toBe('string');
      expect(typeof notif.eventType).toBe('string');
      expect(typeof notif.title).toBe('string');
      expect(typeof notif.body).toBe('string');
      expect(typeof notif.read).toBe('boolean');
      expect(typeof notif.createdAt).toBe('string');
    });

    it('email has all required fields', async () => {
      const event = makeEvent({ eventType: 'destroy.completed' });
      await harness.engine.processEvent(event);

      const email = harness.emailSender.sent[0];
      expect(email).toBeDefined();
      if (!email) return;

      expect(typeof email.to).toBe('string');
      expect(typeof email.subject).toBe('string');
      expect(typeof email.body).toBe('string');
    });
  });
});

// ── InMemoryNotificationStore ────────────────────────────────────────────

describe('InMemoryNotificationStore', () => {
  let store: InMemoryNotificationStore;

  beforeEach(() => {
    store = new InMemoryNotificationStore();
  });

  it('starts empty', () => {
    expect(store.count).toBe(0);
    expect(store.notifications).toHaveLength(0);
  });

  it('stores a notification', async () => {
    const notif: InAppNotification = {
      id: 'notif-1',
      organizationId: 'org-1',
      deploymentId: 'deployment-1',
      eventType: 'install.completed',
      title: 'Test',
      body: 'Test body',
      read: false,
      createdAt: FIXED_NOW.toISOString(),
    };

    await store.create(notif);

    expect(store.count).toBe(1);
    expect(store.notifications[0]).toEqual(notif);
  });

  it('stores multiple notifications', async () => {
    await store.create({
      id: 'notif-1',
      organizationId: 'org-1',
      deploymentId: 'deployment-1',
      eventType: 'install.completed',
      title: 'A',
      body: 'a',
      read: false,
      createdAt: FIXED_NOW.toISOString(),
    });
    await store.create({
      id: 'notif-2',
      organizationId: 'org-1',
      deploymentId: 'deployment-1',
      eventType: 'deploy.completed',
      title: 'B',
      body: 'b',
      read: false,
      createdAt: FIXED_NOW.toISOString(),
    });

    expect(store.count).toBe(2);
    expect(store.notifications[0]?.id).toBe('notif-1');
    expect(store.notifications[1]?.id).toBe('notif-2');
  });

  it('clear resets the store', async () => {
    await store.create({
      id: 'notif-1',
      organizationId: 'org-1',
      deploymentId: 'deployment-1',
      eventType: 'install.completed',
      title: 'x',
      body: 'x',
      read: false,
      createdAt: FIXED_NOW.toISOString(),
    });
    store.clear();

    expect(store.count).toBe(0);
    expect(store.notifications).toHaveLength(0);
  });
});