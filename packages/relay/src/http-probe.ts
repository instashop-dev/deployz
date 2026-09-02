/**
 * HTTP application probe — the one measurement that asks the running
 * application itself, not the orchestration around it.
 *
 * ECS counts say a task is running, the ALB says its targets registered, and
 * rollout state says the deployment finished — none of them say whether the
 * application answers a real HTTP request on its configured health path. This
 * probe asks exactly that, over HTTP from inside the customer's account, once
 * per poll (§10.2).
 *
 * Only what the check itself measures is ever returned: status code, latency,
 * and the ISO time it was checked. The response BODY is never read — a probe
 * that captured one would be a data-ingestion path for customer application
 * output, which this module exists to avoid. A timeout or unreachable host is
 * a FAILED check (ok: false, no status code), never an UNKNOWN that could sit
 * forever.
 */

export interface HttpProbeRecord {
  /** A 2xx response — the only outcome that counts as healthy. */
  readonly ok: boolean;
  /** The HTTP status code; null when the request failed before one arrived. */
  readonly statusCode: number | null;
  /** Round-trip latency in milliseconds. */
  readonly latencyMs: number | null;
  /** ISO 8601 — when this probe ran. */
  readonly checkedAt: string;
  /** Short reason when the request failed (timeout / unreachable). */
  readonly error?: string;
}

/** How long a probe may take before it is a failed check. */
export const HTTP_PROBE_TIMEOUT_MS = 10_000;

/** The minimal fetch surface the probe needs — never more than status. */
export interface HttpProbeFetch {
  (url: string): Promise<{ status: number }>;
}

/**
 * GET `url` and record the outcome. Never throws: every failure mode — a
 * thrown transport error, a timeout, a non-2xx response — resolves to a
 * record, because the heartbeat must always have an answer to report.
 */
export async function probeHealthUrl(
  fetchFn: HttpProbeFetch,
  url: string,
  now: () => string = () => new Date().toISOString(),
  timeoutMs: number = HTTP_PROBE_TIMEOUT_MS,
): Promise<HttpProbeRecord> {
  const startedAt = Date.now();
  try {
    const response = await Promise.race([
      fetchFn(url),
      // The fetch seam has no abort signal, so the timeout wins the race and
      // the heartbeat moves on even if the underlying request never resolves.
      // The dangling request dies with the Lambda invocation.
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe timed out')), timeoutMs),
      ),
    ]);
    const latencyMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 300;
    return { ok, statusCode: response.status, latencyMs, checkedAt: now() };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      checkedAt: now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
