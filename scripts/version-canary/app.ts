/**
 * The live application the canary talks to directly — the fixture's own
 * `/health`, `/version` and `/canary/markers` endpoints, reached through
 * the deployment's ALB. "Which version is actually serving" is answered
 * here, never by a database pointer.
 */
import { sleep } from './control-plane.js';

export interface LiveVersion {
  readonly version: string;
  readonly commit: string;
  readonly healthMode: string;
}

export interface LiveProbe {
  readonly healthStatus: number | null;
  readonly version: LiveVersion | null;
  readonly error?: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One observation of the live app; never throws (the caller decides what a failure means). */
export async function probeLiveApp(baseUrl: string): Promise<LiveProbe> {
  try {
    const health = await fetchWithTimeout(`${baseUrl}/health`);
    const versionResponse = await fetchWithTimeout(`${baseUrl}/version`);
    const version = versionResponse.status === 200 ? ((await versionResponse.json()) as LiveVersion) : null;
    return { healthStatus: health.status, version };
  } catch (error) {
    return { healthStatus: null, version: null, error: String(error) };
  }
}

/**
 * Samples the live app several times: a rollout in flight can answer from
 * both the old and the new task, so a single read is not "which version is
 * serving". Returns the distinct versions and health statuses seen.
 */
export async function sampleLiveApp(
  baseUrl: string,
  samples = 5,
  intervalMs = 2_000,
): Promise<{ versions: string[]; healthStatuses: (number | null)[]; probes: LiveProbe[] }> {
  const probes: LiveProbe[] = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await sleep(intervalMs);
    probes.push(await probeLiveApp(baseUrl));
  }
  return {
    versions: [...new Set(probes.flatMap((p) => (p.version ? [p.version.version] : [])))],
    healthStatuses: [...new Set(probes.map((p) => p.healthStatus))],
    probes,
  };
}

export async function writeMarker(baseUrl: string, key: string, value: string): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(`${baseUrl}/canary/markers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 201) {
    throw new Error(`write marker ${key} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function readMarker(baseUrl: string, key: string): Promise<Record<string, unknown> | null> {
  const response = await fetchWithTimeout(`${baseUrl}/canary/markers/${encodeURIComponent(key)}`);
  if (response.status === 404) return null;
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) {
    throw new Error(`read marker ${key} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
