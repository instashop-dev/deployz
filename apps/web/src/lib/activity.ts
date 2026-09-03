import { eventFailureReason } from './deployment-vocabulary';
import type { ActivityEvent } from './deployments';
import { FAILURE_CODE_COPY, type FailureCode } from './diagnostic-vocabulary';

// Helpers for the detail page's Recent activity feed. The API returns the
// event log oldest-first (server.ts orders by occurredAt ascending); the
// feed is a history, so it reads newest-first — the opposite of the install
// step list, which is a process and reads first → last.

/** Events newest-first. Stable for equal timestamps, so two events written
 *  in the same millisecond keep the order the API returned them in. */
export function newestFirst(events: ActivityEvent[]): ActivityEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const diff = Date.parse(b.event.occurredAt) - Date.parse(a.event.occurredAt);
      return diff !== 0 ? diff : b.index - a.index;
    })
    .map(({ event }) => event);
}

/** How many events the feed shows before "View full activity". */
export const ACTIVITY_PREVIEW_COUNT = 5;

/**
 * The jargon-free reason to show at the top level of a failed event: the
 * §65 description for its classified failure code. The relay's raw error
 * string stays behind the row's disclosure — it routinely embeds AWS
 * resource types and CloudFormation vocabulary.
 */
export function activityFailureSummary(event: ActivityEvent): string | null {
  const code = event.payload['failureCode'];
  if (typeof code === 'string' && code in FAILURE_CODE_COPY) {
    return FAILURE_CODE_COPY[code as FailureCode].description;
  }
  return null;
}

/** The raw error text a failed event carries, for the technical disclosure. */
export function activityRawError(event: ActivityEvent): string | null {
  return eventFailureReason(event.result, event.payload);
}
