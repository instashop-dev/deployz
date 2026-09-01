/**
 * Fix-instructions generation — turns unresolved readiness findings into ONE
 * consolidated coding-agent prompt the vendor pastes into their own coding
 * agent (Claude Code, Cursor, Codex, OpenCode, …).
 *
 * Deployz never edits the repository. The generated document is assembled
 * DETERMINISTICALLY from the structured analysis facts and findings — the
 * objective, repository context, findings, guardrails, validation steps, and
 * completion-report requirements are all templated here, so every generated
 * prompt is guaranteed to carry the safety guardrails and the repo-specific
 * facts. The AI's only job is the per-finding implementation guidance, which
 * it produces from the SAME structured facts (no repository file contents are
 * sent). An AI failure surfaces as a retryable error at the API edge — it
 * never affects the analysis or the readiness state.
 */

import { z } from 'zod';

import {
  SpendLimitExceededError,
  truncateToTokens,
  type AiGateway,
} from './ai-gateway.js';
import type { ReadinessFinding } from './readiness-report.js';

// ── Tunables ────────────────────────────────────────────────────────────────

/** Max tokens the PROMPT may occupy — structured facts only, no file contents. */
export const FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS = 3000;
/** Max tokens the COMPLETION may occupy — sized for a reasoning model that
 *  spends `reasoning_content` from the same budget (see repository-ai.ts). */
export const FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS = 2500;
/** Total per-request budget: prompt + completion. */
export const FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS =
  FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS + FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS;
/** How long a generation request may run before the caller abandons it. */
export const FIX_INSTRUCTIONS_TIMEOUT_MS = 30_000;

// ── Input shapes ────────────────────────────────────────────────────────────

/** The structured deterministic facts the generator may reference. */
export interface FixInstructionsFacts {
  framework: string | null;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: string | null;
  dockerfilePath: string | null;
  /** 'postgres' when a managed database will be provisioned, else 'none'. */
  database: 'postgres' | 'none';
  migrationCommand: string | null;
  healthPath: string | null;
  redisRequired: boolean;
  /** Non-root app directory in a monorepo, when known. */
  workingDirectory: string | null;
}

/** Everything the generator needs: repo identity, facts, and unresolved findings. */
export interface FixInstructionsContext {
  repoFullName: string;
  /** The commit the analysis ran against, when known. */
  commitSha: string | null;
  facts: FixInstructionsFacts;
  /** The unresolved findings the instructions must cover (required first). */
  findings: ReadinessFinding[];
}

// ── AI output shape ─────────────────────────────────────────────────────────

/**
 * The model's structured output: per-finding implementation guidance plus
 * optional overall notes. `.strict()` rejects anything outside this shape.
 * A finding the model skips simply gets no guidance block — the assembled
 * document is complete either way.
 */
export const fixInstructionsAiSchema = z
  .object({
    perFinding: z.array(z.object({ id: z.string(), guidance: z.string() }).strict()),
    generalNotes: z.array(z.string()),
  })
  .strict();
export type FixInstructionsAiOutput = z.infer<typeof fixInstructionsAiSchema>;

// ── Fact rendering ──────────────────────────────────────────────────────────

function factLine(label: string, value: string | null): string {
  return `- ${label}: ${value ?? 'not detected'}`;
}

function renderFacts(context: FixInstructionsContext): string[] {
  const { facts } = context;
  return [
    factLine('Repository', context.repoFullName),
    ...(context.commitSha ? [factLine('Analysed commit', context.commitSha)] : []),
    factLine('Framework', facts.framework),
    factLine('Package manager', facts.packageManager),
    factLine('Build command', facts.buildCommand),
    factLine('Start command', facts.startCommand),
    factLine('Application port', facts.port),
    factLine('Container build file', facts.dockerfilePath),
    factLine(
      'Database',
      facts.database === 'postgres' ? 'PostgreSQL (Deployz provisions a managed instance)' : 'none detected',
    ),
    factLine('Migration command', facts.migrationCommand),
    factLine('Health check path', facts.healthPath),
    factLine('Redis', facts.redisRequired ? 'required (Deployz provisions a managed instance)' : 'not required'),
    ...(facts.workingDirectory && facts.workingDirectory !== '.'
      ? [factLine('Application directory', facts.workingDirectory)]
      : []),
  ];
}

// ── AI prompt ───────────────────────────────────────────────────────────────

/**
 * Build the prompt that asks the model for per-finding implementation
 * guidance. Built exclusively from structured deterministic facts and finding
 * evidence — never repository file contents.
 */
export function buildFixInstructionsAiPrompt(context: FixInstructionsContext): string {
  const lines: string[] = [
    'You are writing implementation guidance for a coding agent that will prepare a repository for',
    'deployment through Deployz. Deployz builds the app into a container, monitors a health endpoint',
    'during deploys, and (when a database is detected) provisions managed PostgreSQL and runs the',
    'migration command automatically on every deploy.',
    '',
    'For each finding below, write concrete, repository-specific implementation guidance: which files',
    'to look at or create, what the change should contain, and how it fits the detected stack.',
    'Ground every suggestion in the detected facts — never contradict them and never invent',
    'requirements the findings do not support. The coding agent will verify each finding against the',
    'real repository before changing anything, so phrase guidance as "verify, then implement".',
    'Never include secrets, credentials, or placeholder secret values.',
    'Respond with only JSON matching the schema — no prose, no markdown outside the JSON.',
    '',
    'Repository facts detected by Deployz:',
    ...renderFacts(context),
    '',
    'Findings to cover:',
  ];

  for (const finding of context.findings) {
    lines.push(
      `- id: ${finding.id}`,
      `  severity: ${finding.severity.toUpperCase()}`,
      `  title: ${finding.title}`,
      `  observed: ${finding.technicalEvidence}`,
      `  desired outcome: ${finding.suggestedOutcome}`,
      `  confidence: ${finding.confidence}`,
    );
  }

  lines.push(
    '',
    'Respond with JSON matching: {"perFinding": [{"id", "guidance"}], "generalNotes": [string]}.',
    'Cover every finding id listed above.',
  );

  return lines.join('\n');
}

// ── Deterministic assembly ──────────────────────────────────────────────────

/**
 * The verbatim guardrail every generated document must carry. Exported so
 * tests can assert its presence without duplicating the wording.
 */
export const FIX_INSTRUCTIONS_GUARDRAIL =
  'Do not assume Deployz findings are correct. Inspect the repository first. If an indicated ' +
  'problem is already handled differently, preserve the existing architecture and explain why no ' +
  'change is required.';

function severityLabel(finding: ReadinessFinding): string {
  return finding.severity === 'required' ? 'REQUIRED' : 'RECOMMENDED';
}

const CONFIDENCE_NOTE: Record<ReadinessFinding['confidence'], string> = {
  confirmed: 'Deployz confirmed this from repository evidence.',
  likely:
    'Deployz is fairly confident, but static analysis can miss an existing solution — verify before changing anything.',
  needs_confirmation:
    'Deployz could not confirm this — verify whether it actually applies before making any change.',
};

/**
 * Assemble the final coding-agent document from the deterministic context and
 * the model's guidance. Every section except the per-finding guidance is
 * templated here, so the guardrails and repo-specific facts are guaranteed
 * regardless of what the model produced.
 */
export function assembleFixInstructions(
  context: FixInstructionsContext,
  ai: FixInstructionsAiOutput,
): string {
  const guidanceById = new Map(ai.perFinding.map((entry) => [entry.id, entry.guidance]));
  const lines: string[] = [];

  lines.push(
    `# Deployment readiness changes for ${context.repoFullName}`,
    '',
    '## Objective',
    '',
    'Prepare this repository for deployment through Deployz. Deployz packages the app into a',
    'container, deploys it for each customer, waits on a health endpoint during every deploy, and' +
      (context.facts.database === 'postgres'
        ? ' provisions a managed PostgreSQL database, running the migration command automatically on every deploy.'
        : ' monitors it while it runs.'),
    '',
    '## Repository context detected by Deployz',
    '',
    ...renderFacts(context),
    '',
    '## Findings to address',
    '',
  );

  context.findings.forEach((finding, index) => {
    const guidance = guidanceById.get(finding.id);
    lines.push(
      `### ${index + 1}. ${finding.title} (${severityLabel(finding)})`,
      '',
      `- Observed: ${finding.technicalEvidence}`,
      `- Desired deployment outcome: ${finding.suggestedOutcome}`,
      `- Confidence: ${CONFIDENCE_NOTE[finding.confidence]}`,
      ...(guidance ? ['', `Implementation guidance: ${guidance}`] : []),
      '',
    );
  });

  if (ai.generalNotes.length > 0) {
    lines.push('Additional notes:', ...ai.generalNotes.map((note) => `- ${note}`), '');
  }

  lines.push(
    '## Instructions for the coding agent',
    '',
    `- ${FIX_INSTRUCTIONS_GUARDRAIL}`,
    '- Inspect the repository before changing anything, and verify each finding against the actual code.',
    '- Preserve the existing architecture, conventions, and code style.',
    '- Make the smallest safe change that resolves each finding; avoid unrelated refactors.',
    '- Do not add new dependencies unless clearly justified by a finding.',
    '- Never commit, print, or expose secrets, credentials, or API keys.',
    '- If a finding is ambiguous or cannot be resolved safely, stop and report the ambiguity instead of guessing.',
    '',
    '## Validation',
    '',
    'Run every step that applies to this repository, and skip the rest:',
    '',
    '- Run the existing test suite.',
    '- Run lint and typecheck commands if the repository has them.',
    `- Build the app${context.facts.buildCommand ? ` (\`${context.facts.buildCommand}\`)` : ''}.`,
    '- Build the container image if the repository has (or now has) container build instructions.',
    `- Start the app locally and request the health endpoint${
      context.facts.healthPath ? ` (\`${context.facts.healthPath}\`)` : ' (for example `/health`)'
    } to confirm it returns success.`,
    ...(context.facts.database === 'postgres'
      ? [
          '- Validate the migration command against a disposable local database only — never against production data.',
        ]
      : []),
    '',
    '## Completion report',
    '',
    'When finished, report:',
    '',
    '- Every file changed, with a short summary of the implementation.',
    '- The validation commands actually run and their results.',
    '- Any assumptions made and any unresolved risks or ambiguities.',
    '- Do not claim success for tests or validations that were not actually run.',
    '',
    'After these changes are pushed, re-run the Deployz analysis to verify the findings are resolved.',
  );

  return lines.join('\n');
}

// ── The AI call ─────────────────────────────────────────────────────────────

/**
 * Generate the consolidated fix-instructions document. Mirrors the
 * repository-AI pipeline: truncate the prompt to budget, call the injectable
 * gateway, enforce the total-usage budget, validate against the strict
 * schema, then assemble the deterministic document around the guidance.
 *
 * Throws on any AI failure (unconfigured gateway, network error, timeout,
 * schema violation, spend limit) — the API edge maps that to a retryable
 * generation error. Analysis and readiness state are unaffected either way.
 */
export async function generateFixInstructions(
  context: FixInstructionsContext,
  gateway: AiGateway,
  options: { abortSignal?: AbortSignal } = {},
): Promise<string> {
  const prompt = truncateToTokens(
    buildFixInstructionsAiPrompt(context),
    FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS,
  );

  const response = await gateway.generate(prompt, fixInstructionsAiSchema, {
    abortSignal: options.abortSignal,
    label: 'fix-instructions',
    maxOutputTokens: FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS,
  });

  const usedTokens = response.usage.promptTokens + response.usage.completionTokens;
  if (usedTokens > FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS) {
    throw new SpendLimitExceededError(usedTokens, FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS);
  }

  return assembleFixInstructions(context, fixInstructionsAiSchema.parse(response.object));
}
