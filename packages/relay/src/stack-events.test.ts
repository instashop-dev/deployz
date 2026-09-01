import { describe, expect, it, vi } from 'vitest';

import {
  createStackEventCollector,
  toStackEventsReader,
  type StackEventRecord,
  type StackEventsPage,
  type StackEventsReader,
} from './stack-events.js';

function event(eventId: string, timestamp: string, overrides: Partial<StackEventRecord> = {}): StackEventRecord {
  return {
    eventId,
    timestamp,
    logicalResourceId: 'WebServerService',
    resourceType: 'AWS::ECS::Service',
    resourceStatus: 'CREATE_IN_PROGRESS',
    ...overrides,
  };
}

/**
 * A scripted reader. `pages` is consumed one entry per call, mirroring
 * `scriptedInstaller` in `install.test.ts`.
 */
function scriptedReader(pages: (StackEventsPage | null)[]): StackEventsReader & { calls: (string | undefined)[] } {
  const calls: (string | undefined)[] = [];
  let index = 0;
  return {
    calls,
    describeStackEventsPage: async (_stackName, nextToken) => {
      calls.push(nextToken);
      const page = pages[Math.min(index, pages.length - 1)] ?? null;
      index += 1;
      return page;
    },
  };
}

describe('toStackEventsReader', () => {
  it('maps StackEvents fields and drops ResourceProperties', async () => {
    const send = vi.fn().mockResolvedValue({
      StackEvents: [
        {
          EventId: 'evt-1',
          Timestamp: new Date('2026-08-30T10:00:00.000Z'),
          LogicalResourceId: 'WebServerService',
          ResourceType: 'AWS::ECS::Service',
          ResourceStatus: 'CREATE_IN_PROGRESS',
          ResourceStatusReason: 'in progress',
          ResourceProperties: '{"Secret":"shh"}',
        },
      ],
    });

    const page = await toStackEventsReader({ send }).describeStackEventsPage('deployz-app');

    expect(page).toEqual({
      events: [
        {
          eventId: 'evt-1',
          timestamp: '2026-08-30T10:00:00.000Z',
          logicalResourceId: 'WebServerService',
          resourceType: 'AWS::ECS::Service',
          resourceStatus: 'CREATE_IN_PROGRESS',
          resourceStatusReason: 'in progress',
        },
      ],
    });
  });

  it('passes NextToken through in both directions and skips incomplete records', async () => {
    const send = vi.fn().mockResolvedValue({
      StackEvents: [
        { LogicalResourceId: 'A', ResourceType: 'T', ResourceStatus: 'S', Timestamp: new Date() }, // missing EventId
        { EventId: 'evt-2', LogicalResourceId: 'B', ResourceType: 'T' }, // missing Timestamp/ResourceStatus
      ],
      NextToken: 'next-1',
    });

    const page = await toStackEventsReader({ send }).describeStackEventsPage('deployz-app', 'prev-token');

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ StackName: 'deployz-app', NextToken: 'prev-token' });
    expect(page).toEqual({ events: [], nextToken: 'next-1' });
  });

  it('returns null — never throws — when events cannot be read', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttling'));

    await expect(toStackEventsReader({ send }).describeStackEventsPage('deployz-app')).resolves.toBeNull();
  });
});

const EARLY = '2020-01-01T00:00:00.000Z';

describe('createStackEventCollector', () => {
  it('reports events oldest-first even though the reader returns newest-first', async () => {
    const reader = scriptedReader([
      {
        events: [
          event('e3', '2026-08-30T10:00:03.000Z'),
          event('e2', '2026-08-30T10:00:02.000Z'),
          event('e1', '2026-08-30T10:00:01.000Z'),
        ],
      },
    ]);
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader,
      report: async (events) => {
        reports.push([...events]);
        return true;
      },
      operationStartedAt: EARLY,
    });

    await collector.poll('deployz-app');

    expect(reports).toEqual([
      [
        event('e1', '2026-08-30T10:00:01.000Z'),
        event('e2', '2026-08-30T10:00:02.000Z'),
        event('e3', '2026-08-30T10:00:03.000Z'),
      ],
    ]);
    expect(collector.lastEventAt()).toBe('2026-08-30T10:00:03.000Z');
  });

  it('excludes events timestamped before operationStartedAt', async () => {
    const reader = scriptedReader([
      {
        events: [
          event('e2', '2026-08-30T10:05:00.000Z'),
          event('e1', '2026-08-30T09:55:00.000Z'),
        ],
      },
    ]);
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader,
      report: async (events) => {
        reports.push([...events]);
        return true;
      },
      operationStartedAt: '2026-08-30T10:00:00.000Z',
    });

    await collector.poll('deployz-app');

    expect(reports).toEqual([[event('e2', '2026-08-30T10:05:00.000Z')]]);
  });

  it('paginates up to the page cap when every page is still in scope', async () => {
    const pages: StackEventsPage[] = Array.from({ length: 7 }, (_, i) => ({
      events: [event(`e${i}`, `2026-08-30T10:00:${String(10 + i).padStart(2, '0')}.000Z`)],
      nextToken: `tok-${i + 1}`,
    }));
    const reader = scriptedReader(pages);
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader,
      report: async (events) => {
        reports.push([...events]);
        return true;
      },
      operationStartedAt: EARLY,
      maxPages: 5,
    });

    await collector.poll('deployz-app');

    expect(reader.calls).toHaveLength(5);
    expect(reports.flat()).toHaveLength(5);
  });

  it('stops paging as soon as a page yields an event before the boundary', async () => {
    const reader = scriptedReader([
      { events: [event('e2', '2026-08-30T10:05:00.000Z')], nextToken: 'tok-1' },
      { events: [event('e1', '2026-08-30T09:00:00.000Z')], nextToken: 'tok-2' },
      { events: [event('e0', '2026-08-30T08:00:00.000Z')] },
    ]);
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader,
      report: async (events) => {
        reports.push([...events]);
        return true;
      },
      operationStartedAt: '2026-08-30T10:00:00.000Z',
    });

    await collector.poll('deployz-app');

    expect(reader.calls).toHaveLength(2);
    expect(reports).toEqual([[event('e2', '2026-08-30T10:05:00.000Z')]]);
  });

  it('dedupes: a second poll with overlapping pages reports only the new event', async () => {
    const describeStackEventsPage = vi
      .fn<StackEventsReader['describeStackEventsPage']>()
      .mockResolvedValueOnce({
        events: [
          event('e3', '2026-08-30T10:00:03.000Z'),
          event('e2', '2026-08-30T10:00:02.000Z'),
          event('e1', '2026-08-30T10:00:01.000Z'),
        ],
      })
      .mockResolvedValueOnce({
        events: [
          event('e4', '2026-08-30T10:00:04.000Z'),
          event('e3', '2026-08-30T10:00:03.000Z'),
          event('e2', '2026-08-30T10:00:02.000Z'),
        ],
      });
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader: { describeStackEventsPage },
      report: async (events) => {
        reports.push([...events]);
        return true;
      },
      operationStartedAt: EARLY,
    });

    await collector.poll('deployz-app');
    await collector.poll('deployz-app');

    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual([event('e4', '2026-08-30T10:00:04.000Z')]);
  });

  it('resume: resumeAfter narrows the boundary with one inclusive overlap', async () => {
    const reader = scriptedReader([
      {
        events: [
          event('e3', '2026-08-30T10:05:00.000Z'),
          event('e2', '2026-08-30T10:00:00.000Z'),
          event('e1', '2026-08-30T09:30:00.000Z'),
        ],
      },
    ]);
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader,
      report: async (events) => {
        reports.push([...events]);
        return true;
      },
      operationStartedAt: '2026-08-30T09:00:00.000Z',
      resumeAfter: '2026-08-30T10:00:00.000Z',
    });

    await collector.poll('deployz-app');

    expect(reports).toEqual([
      [event('e2', '2026-08-30T10:00:00.000Z'), event('e3', '2026-08-30T10:05:00.000Z')],
    ]);
  });

  it('retries events on the next poll when report fails, without advancing lastEventAt', async () => {
    const reader = scriptedReader([{ events: [event('e1', '2026-08-30T10:00:01.000Z')] }]);
    const report = vi.fn().mockResolvedValue(false);
    const collector = createStackEventCollector({
      reader,
      report,
      operationStartedAt: EARLY,
    });

    await collector.poll('deployz-app');
    await collector.poll('deployz-app');

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, [event('e1', '2026-08-30T10:00:01.000Z')]);
    expect(report).toHaveBeenNthCalledWith(2, [event('e1', '2026-08-30T10:00:01.000Z')]);
    expect(collector.lastEventAt()).toBeNull();
  });

  it('completes silently, reporting nothing, when the reader returns null', async () => {
    const reader = scriptedReader([null]);
    const report = vi.fn().mockResolvedValue(true);
    const collector = createStackEventCollector({
      reader,
      report,
      operationStartedAt: EARLY,
    });

    await expect(collector.poll('deployz-app')).resolves.toBeUndefined();
    expect(report).not.toHaveBeenCalled();
    expect(collector.lastEventAt()).toBeNull();
  });

  it('chunks more than 50 new events into multiple oldest-first report calls', async () => {
    const total = 120;
    const events = Array.from({ length: total }, (_, i) =>
      event(`e${i}`, `2026-08-30T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`),
    );
    // Reader returns newest-first.
    const reader = scriptedReader([{ events: [...events].reverse() }]);
    const reports: StackEventRecord[][] = [];
    const collector = createStackEventCollector({
      reader,
      report: async (batch) => {
        reports.push([...batch]);
        return true;
      },
      operationStartedAt: EARLY,
    });

    await collector.poll('deployz-app');

    expect(reports).toHaveLength(3);
    expect(reports[0]).toHaveLength(50);
    expect(reports[1]).toHaveLength(50);
    expect(reports[2]).toHaveLength(20);
    expect(reports.flat()).toEqual(events);
    expect(collector.lastEventAt()).toBe(events[events.length - 1]!.timestamp);
  });
});
