// Environment variables setup (docs/environment-variables.md) — data access for the
// Configuration page's "Environment variables" section. The vendor's saved
// decisions (`EnvironmentSetting[]`) plus the detected variables and the
// keys Deployz/vendor can already deliver a value for come from one GET;
// `evaluateEnvironmentSetup` (from @deployz/contracts) turns that into the
// rows the table renders. Saving never re-runs analysis.

import type { EnvironmentSetting } from '@deployz/contracts';

import { apiUrl } from '@/lib/api-url';
import type { DetectedApplication } from '@/lib/readiness';

export interface EnvironmentSettingsResponse {
  settings: EnvironmentSetting[] | null;
  /** The application's effective manifest environment variables. */
  variables: DetectedApplication['environmentVariables'];
  /** Keys a vendor may set `provider: 'deployz'` for. */
  deployzKeys: string[];
  /** Vendor-default keys with a deliverable value today. */
  vendorValueKeys: string[];
}

/** Thrown on a failed save — carries the server's per-setting problems, when it sent any. */
export class EnvironmentSettingsError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = 'EnvironmentSettingsError';
    this.problems = problems;
  }
}

async function parseErrorMessage(response: Response): Promise<EnvironmentSettingsError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; details?: { problems?: string[] } };
  } | null;
  const problems = body?.error?.details?.problems ?? [];
  return new EnvironmentSettingsError(
    body?.error?.message ?? "We couldn't save these settings. Try again in a moment.",
    problems,
  );
}

/** Fetch the application's environment-settings state. */
export async function fetchEnvironmentSettings(applicationId: string): Promise<EnvironmentSettingsResponse> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/environment-settings`,
    { credentials: 'include', cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Environment settings request failed (${response.status})`);
  }
  return (await response.json()) as EnvironmentSettingsResponse;
}

/**
 * Save the vendor's settings. Never triggers re-analysis. A validation
 * failure (400/422) throws `EnvironmentSettingsError`, which may carry
 * per-setting problem strings to show inline.
 */
export async function saveEnvironmentSettings(
  applicationId: string,
  settings: readonly EnvironmentSetting[],
): Promise<EnvironmentSettingsResponse> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/environment-settings`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    },
  );
  if (!response.ok) {
    throw await parseErrorMessage(response);
  }
  return (await response.json()) as EnvironmentSettingsResponse;
}
