/**
 * Stack-event collector — pages CloudFormation stack events during an
 * install's wait loop and reports them to the control plane in order.
 *
 * "Readers never throw" (repo convention, see `./install.ts`):
 * `describeStackEventsPage` maps every failure to `null`, and `poll()`
 * itself never throws — a broken reader or reporter just means no events
 * were collected this tick, not a crash of the wait loop that calls it.
 *
 * AWS returns `DescribeStackEvents` newest-first. The collector pages
 * backward through history until it passes the operation boundary or hits
 * an event it has already reported, then reverses what it kept so `report`
 * always sees a coherent oldest-first timeline.
 */

import { CloudFormationClient, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation';

export interface StackEventRecord {
  readonly eventId: string;
  readonly timestamp: string; // ISO 8601
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
}

export interface StackEventsPage {
  readonly events: readonly StackEventRecord[];
  readonly nextToken?: string;
}

export interface StackEventsReader {
  // null on any error — readers never throw (repo convention).
  describeStackEventsPage(stackName: string, nextToken?: string): Promise<StackEventsPage | null>;
}

export interface StackEventCollector {
  // Fetch new events since the boundary/cursor and report them. Never throws.
  poll(stackName: string): Promise<void>;
  // Cursor for cross-invocation resume; null until something was reported.
  lastEventAt(): string | null;
}

export interface StackEventCollectorOptions {
  readonly reader: StackEventsReader;
  // POSTs a batch (<= 50, oldest-first) to the control plane; false on failure. Never throws.
  readonly report: (events: readonly StackEventRecord[]) => Promise<boolean>;
  readonly operationStartedAt: string; // ISO — events strictly before this are out of scope
  readonly resumeAfter?: string; // prior invocation's lastEventAt (inclusive boundary; server dedupes overlap)
  readonly maxPages?: number; // default 5
  readonly log?: (entry: Record<string, unknown>) => void; // default JSON console.log
}

/** Cap on `DescribeStackEvents` pages per poll. */
const DEFAULT_MAX_PAGES = 5;

/** Max events per `report` call. */
const BATCH_SIZE = 50;

export function createStackEventCollector(options: StackEventCollectorOptions): StackEventCollector {
  const { reader, report, operationStartedAt, maxPages = DEFAULT_MAX_PAGES, log = defaultLog } = options;
  const resumeAfter = options.resumeAfter;
  const boundary = resumeAfter !== undefined && resumeAfter > operationStartedAt ? resumeAfter : operationStartedAt;
  const seen = new Set<string>();
  let cursor: string | null = null;

  return {
    async poll(stackName: string): Promise<void> {
      try {
        const collected = await collectSince(reader, stackName, boundary, seen, maxPages);
        if (collected.length === 0) return;

        const ordered = [...collected].reverse();
        let reportedCount = 0;
        for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
          const batch = ordered.slice(i, i + BATCH_SIZE);
          const accepted = await report(batch);
          if (!accepted) break;
          for (const batchEvent of batch) seen.add(batchEvent.eventId);
          cursor = batch.reduce(
            (max, batchEvent) => (batchEvent.timestamp > max ? batchEvent.timestamp : max),
            batch[0]!.timestamp,
          );
          reportedCount += batch.length;
        }

        if (reportedCount > 0) {
          log({ event: 'relay:stack-events-collected', stackName, count: reportedCount, lastEventAt: cursor });
        }
      } catch {
        log({ event: 'relay:stack-events-poll-failed', stackName });
      }
    },

    lastEventAt(): string | null {
      return cursor;
    },
  };
}

/**
 * Pages newest-first through `describeStackEventsPage`, stopping as soon as
 * a page yields an event before the boundary or already in `seen` — that
 * event, and everything after it, was covered by a previous poll.
 */
async function collectSince(
  reader: StackEventsReader,
  stackName: string,
  boundary: string,
  seen: ReadonlySet<string>,
  maxPages: number,
): Promise<StackEventRecord[]> {
  const collected: StackEventRecord[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const page = await reader.describeStackEventsPage(stackName, nextToken);
    if (page === null) break;
    pages += 1;

    for (const stackEvent of page.events) {
      if (stackEvent.timestamp < boundary || seen.has(stackEvent.eventId)) {
        return collected;
      }
      collected.push(stackEvent);
    }

    if (page.nextToken === undefined) break;
    nextToken = page.nextToken;
  }

  return collected;
}

function defaultLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

// ── Real reader ──────────────────────────────────────────────────────────

/**
 * Wrap a CloudFormation client as a reader. `ResourceProperties` and every
 * other field CloudFormation sends is dropped — only what `StackEventRecord`
 * declares is kept, so a customer's stack parameters never end up in a log
 * or over the wire to the control plane.
 */
export function toStackEventsReader(client: { send(command: unknown): Promise<unknown> }): StackEventsReader {
  return {
    async describeStackEventsPage(stackName: string, nextToken?: string): Promise<StackEventsPage | null> {
      try {
        const response = (await client.send(
          new DescribeStackEventsCommand({
            StackName: stackName,
            ...(nextToken !== undefined ? { NextToken: nextToken } : {}),
          }),
        )) as {
          StackEvents?: {
            EventId?: string;
            Timestamp?: Date;
            LogicalResourceId?: string;
            ResourceType?: string;
            ResourceStatus?: string;
            ResourceStatusReason?: string;
          }[];
          NextToken?: string;
        };

        const events: StackEventRecord[] = [];
        for (const stackEvent of response.StackEvents ?? []) {
          if (
            stackEvent.EventId === undefined ||
            stackEvent.Timestamp === undefined ||
            stackEvent.ResourceStatus === undefined
          ) {
            continue;
          }
          events.push({
            eventId: stackEvent.EventId,
            timestamp: stackEvent.Timestamp.toISOString(),
            logicalResourceId: stackEvent.LogicalResourceId ?? '',
            resourceType: stackEvent.ResourceType ?? '',
            resourceStatus: stackEvent.ResourceStatus,
            ...(stackEvent.ResourceStatusReason !== undefined
              ? { resourceStatusReason: stackEvent.ResourceStatusReason }
              : {}),
          });
        }

        return {
          events,
          ...(response.NextToken !== undefined ? { nextToken: response.NextToken } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}

/** Production reader — credentials come from the standard SDK chain. */
export function createStackEventsReader(region?: string): StackEventsReader {
  return toStackEventsReader(new CloudFormationClient(region === undefined ? {} : { region }));
}
