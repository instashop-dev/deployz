// Failed release builds: the evidence the API reads from the build log
// (apps/api/src/release-build-failure.ts), and the text a vendor copies from
// it. Everything copied here is assembled from that verified, redacted data —
// never from the AI reading, which is labelled as unverified when included.

import { apiUrl } from '@/lib/api-url';

export type BuildFailureOwner = 'repository' | 'transient' | 'deployz' | 'undetermined';
export type BuildLogStatus = 'available' | 'no_build' | 'unavailable';

export interface ExcerptLine {
  number: number;
  text: string;
  error: boolean;
}

export interface BuildFailureDetails {
  releaseId: string;
  version: string;
  gitSha: string;
  repository: string;
  branch: string;
  stage: 'source' | 'start' | 'prepare' | 'build' | 'store' | 'unknown';
  stageLabel: string;
  summary: string;
  failureReason: string | null;
  finalCheckOnly: boolean;
  buildReference: string | null;
  logs: { status: BuildLogStatus; lineCount: number; truncated: boolean };
  /** The earliest meaningful error: from the build log, else the stored reason
   *  when it names one. Never the final check. */
  observedError: string | null;
  evidence: {
    observedError: string | null;
    failedStep: string | null;
    dockerfilePath: string | null;
    buildContext: string | null;
    excerpt: ExcerptLine[];
  } | null;
  cause: { owner: BuildFailureOwner; basis: string; nextStep: string };
}

export interface BuildLogLines {
  status: BuildLogStatus;
  lines: string[];
  truncated: boolean;
}

export type BuildExplanation =
  | {
      status: 'explained';
      likelyCause: string;
      supportingLines: Array<{ number: number; text: string }>;
      nextStep: string;
      confidence: 'high' | 'medium' | 'low';
      uncertainty: string;
    }
  | { status: 'inconclusive'; uncertainty: string }
  | { status: 'no_evidence' };

export const BUILD_FAILURE_OWNER_LABEL: Record<BuildFailureOwner, string> = {
  repository: 'Likely a repository issue',
  transient: 'Likely temporary',
  deployz: 'Likely a Deployz build issue',
  undetermined: 'Cause not determined',
};

export const BUILD_LOG_STATUS_COPY: Record<Exclude<BuildLogStatus, 'available'>, string> = {
  no_build:
    'No build log exists for this release. It failed before the image build started, so the reason above is the only evidence.',
  unavailable:
    'Deployz could not read the build log for this release. The log may have expired, or reading it failed. The reason above is the only evidence.',
};

function releasePath(applicationId: string, releaseId: string): string {
  return `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/releases/${encodeURIComponent(releaseId)}`;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? fallback);
  }
  return (await response.json()) as T;
}

export async function fetchBuildFailure(applicationId: string, releaseId: string): Promise<BuildFailureDetails> {
  const response = await fetch(`${releasePath(applicationId, releaseId)}/build-failure`, {
    credentials: 'include',
    cache: 'no-store',
  });
  return readJson(response, "We couldn't load the failure details. Try again in a moment.");
}

export async function fetchBuildLog(applicationId: string, releaseId: string): Promise<BuildLogLines> {
  const response = await fetch(`${releasePath(applicationId, releaseId)}/build-log`, {
    credentials: 'include',
    cache: 'no-store',
  });
  return readJson(response, "We couldn't load the build log. Try again in a moment.");
}

export async function explainBuildFailure(applicationId: string, releaseId: string): Promise<BuildExplanation> {
  const response = await fetch(`${releasePath(applicationId, releaseId)}/build-failure/explain`, {
    method: 'POST',
    credentials: 'include',
  });
  return readJson(response, 'The AI explanation is not available right now. The failure details and build logs are not affected.');
}

// ── Copied text ─────────────────────────────────────────────────────────────

function excerptBlock(details: BuildFailureDetails): string[] {
  const excerpt = details.evidence?.excerpt ?? [];
  if (excerpt.length === 0) return [];
  return ['```text', ...excerpt.map((line) => `${line.number}: ${line.text}`), '```'];
}

function evidenceLines(details: BuildFailureDetails): string[] {
  return [
    `- Failed stage: ${details.stageLabel}`,
    ...(details.evidence?.failedStep ? [`- Failed Dockerfile command: ${details.evidence.failedStep}`] : []),
    ...(details.failureReason ? [`- Final build message: ${details.failureReason}`] : []),
    ...(details.finalCheckOnly
      ? ['  (This message is a final check that runs after the image build. It is not the cause.)']
      : []),
    `- Earliest error found: ${details.observedError ?? 'none found in the available evidence'}`,
    `- Deployz reading: ${BUILD_FAILURE_OWNER_LABEL[details.cause.owner]}. ${details.cause.basis}`,
  ];
}

function logStatusLine(details: BuildFailureDetails): string {
  if (details.logs.status === 'available') {
    return `Build log: ${details.logs.lineCount} lines read${details.logs.truncated ? ' (the end of the log only; earlier lines were not read)' : ''}. Secrets were redacted.`;
  }
  return `Build log: ${BUILD_LOG_STATUS_COPY[details.logs.status]}`;
}

/** Plain technical details for a ticket or a teammate. */
export function buildTechnicalDetails(details: BuildFailureDetails): string {
  return [
    'Deployz release build failure',
    `- Repository: ${details.repository}`,
    `- Branch: ${details.branch}`,
    `- Commit: ${details.gitSha}`,
    `- Release: ${details.version}`,
    ...(details.buildReference ? [`- Build reference: ${details.buildReference}`] : []),
    ...(details.evidence?.dockerfilePath
      ? [`- Dockerfile: ${details.evidence.dockerfilePath} (build context: ${details.evidence.buildContext ?? '.'})`]
      : []),
    ...evidenceLines(details),
    '',
    logStatusLine(details),
    ...excerptBlock(details),
  ].join('\n');
}

/** A report to send to Deployz support when the evidence points at Deployz. */
export function buildSupportReport(details: BuildFailureDetails): string {
  return [
    'Possible Deployz build issue',
    '',
    'The release build below failed in a step that Deployz runs. Please investigate.',
    '',
    buildTechnicalDetails(details),
  ].join('\n');
}

/**
 * The investigation prompt for the vendor's coding agent. It states only what
 * Deployz verified, and asks the agent to find the cause before any change.
 * Copying it starts nothing and grants no access.
 */
export function buildInvestigationPrompt(
  details: BuildFailureDetails,
  explanation: BuildExplanation | null = null,
): string {
  const dockerfile = details.evidence?.dockerfilePath ?? null;
  const context = details.evidence?.buildContext ?? null;
  const lines = [
    '# Investigation prompt: failed Deployz release build',
    '',
    details.cause.owner === 'repository'
      ? 'Deployz found the evidence below. Verify it against the repository before you change anything.'
      : 'The cause of this failure is NOT confirmed. Investigate first. Do not assume a fix.',
    '',
    '## Release',
    `- Repository: ${details.repository}`,
    `- Branch: ${details.branch}`,
    `- Commit: ${details.gitSha}`,
    `- Release version in Deployz: ${details.version}`,
    '',
    '## What Deployz observed',
    ...evidenceLines(details),
    '',
    '## How Deployz builds the image',
    `- Deployz downloads commit ${details.gitSha} and runs \`docker build -f ${dockerfile ?? '<the Dockerfile Deployz detected>'} ${context ?? '<its build context>'}\` on a linux/amd64 builder.`,
    '- The image must build with no manual steps and no secrets at build time.',
    '',
    '## Relevant build log excerpt (redacted by Deployz)',
    ...(excerptBlock(details).length > 0
      ? excerptBlock(details)
      : [
          'No build log lines are available.',
          details.logs.status === 'no_build'
            ? 'The release failed before the image build started.'
            : 'Ask me to open Releases → Review failure details → View build logs in Deployz and paste the log.',
        ]),
    ...(details.logs.truncated ? ['Only the end of the log was read. Earlier lines may hold more errors.'] : []),
    '',
    ...(explanation?.status === 'explained'
      ? [
          '## Unverified AI reading (from the same excerpt)',
          `- Possible cause: ${explanation.likelyCause}`,
          `- Uncertainty: ${explanation.uncertainty || 'not stated'}`,
          'Treat this as a lead, not a fact.',
          '',
        ]
      : []),
    '## What to do',
    `1. Check out commit ${details.gitSha}. Do not change code yet.`,
    '2. Read the Dockerfile and the files the failing step uses. Look for errors earlier than the final build message.',
    '3. If you can, reproduce the build locally with the same docker build command.',
    "4. Decide whether the failure comes from this repository or from Deployz's build pipeline. If it comes from Deployz, stop and report the evidence. Do not change application code to work around it.",
    '5. If the evidence is not enough to decide, say which logs or details you need and ask me for them. Do not guess.',
    '6. If a repository change is justified, make the smallest change that fixes it. Run the relevant checks (build, tests, and docker build if possible).',
    '7. Report: the cause and the evidence for it, what you changed, the checks you ran and their results, and what is still uncertain.',
  ];
  return lines.join('\n');
}
