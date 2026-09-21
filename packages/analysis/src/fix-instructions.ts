/**
 * Fix-instructions generation — turns unresolved readiness findings into ONE
 * consolidated prompt the vendor pastes into their own coding agent (Claude
 * Code, Cursor, Codex, OpenCode, …).
 *
 * Deployz never edits the repository. The generated document is assembled
 * DETERMINISTICALLY from the structured analysis facts and findings, around
 * six sections: repository facts, blocking issues, required outcome,
 * implementation guidance, validation, and the completion report. Everything
 * except the per-blocker AI guidance is templated here, so every generated
 * prompt carries the safety rules and the repo-specific facts. Deterministic
 * guidance per blocker means the document stays useful even when the model
 * returns nothing for a blocker. An AI failure surfaces as a retryable error
 * at the API edge — it never affects the analysis or the readiness state.
 *
 * The prompt targets the vendor's CODING AGENT, not a person: accurate
 * blocker names, evidence over explanation, only facts the included blockers
 * need, and no Deployz product narrative.
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
/** Max tokens the COMPLETION may occupy. Thinking is switched off for this call
 *  (see `reasoning: false` below), so this is headroom over the ~450 tokens
 *  measured live, not a reasoning budget. */
export const FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS = 2500;
/** Total per-request budget: prompt + completion. */
export const FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS =
  FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS + FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS;
/**
 * How long a generation request may run before the caller abandons it. Kept
 * under the API Lambda's 30s timeout and the HTTP API's 30s integration
 * limit: an abort at or above that mark never fires — the platform kills the
 * request first, the vendor gets an opaque gateway error instead of the
 * retryable 503, and the failure is never logged.
 */
export const FIX_INSTRUCTIONS_TIMEOUT_MS = 25_000;

// ── Input shapes ────────────────────────────────────────────────────────────

/** Detected environment-variable requirements, names only — never values. */
export interface FixInstructionsEnvRequirements {
  /** Required while building the image only (for example Dockerfile ARGs). */
  buildTime: string[];
  /** Required by the running application. */
  runtime: string[];
  /** Names the deployment platform itself injects (database, cache, port). */
  platformInjected: string[];
}

/** The structured deterministic facts the generator may reference. */
export interface FixInstructionsFacts {
  /** Runtime family ('node', 'python', …) when detected. */
  runtime: string | null;
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
  /** Split of detected env-var requirements, null when none were modelled. */
  envRequirements: FixInstructionsEnvRequirements | null;
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

// ── Environment-variable requirements ───────────────────────────────────────

const DECLARES_SOURCE = /^(.+?) declares /;
const READ_SOURCE = /^read in /;
const REQUIRES_SOURCE = / requires $/;
const BUILD_CONTEXT_FILE = /(?:^|\/)(?:Dockerfile|[\w.-]*\.dockerfile|docker-compose[\w.-]*|compose\.ya?ml)$/i;

/**
 * Summarise `metadata.envVarModel` into the split the coding agent needs:
 * build-time vs runtime requirements plus the names the platform injects.
 * Names only — the model never carries values, so nothing here can leak one.
 * Returns null when the model carries no requirement at all.
 */
export function summariseEnvRequirements(model: unknown): FixInstructionsEnvRequirements | null {
  if (!Array.isArray(model)) return null;
  const buildTime = new Set<string>();
  const runtime = new Set<string>();
  const platformInjected = new Set<string>();

  for (const raw of model) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['key'] !== 'string' || entry['key'].length === 0) continue;
    const sources = Array.isArray(entry['source'])
      ? entry['source'].filter((s): s is string => typeof s === 'string')
      : [];

    if (entry['classification'] === 'deployz_managed' || entry['classification'] === 'deployz_generated') {
      platformInjected.add(entry['key']);
      continue;
    }
    if (entry['required'] !== true) continue;

    const isRead = sources.some((s) => READ_SOURCE.test(s) || REQUIRES_SOURCE.test(s));
    if (isRead) {
      runtime.add(entry['key']);
      continue;
    }
    // Declared but never read in code: a requirement only when the declaring
    // files are build-context files (a Dockerfile ARG the build consumes).
    const declaredFiles = sources
      .map((s) => DECLARES_SOURCE.exec(s)?.[1])
      .filter((file): file is string => typeof file === 'string');
    if (declaredFiles.length > 0 && declaredFiles.some((file) => BUILD_CONTEXT_FILE.test(file))) {
      buildTime.add(entry['key']);
    } else {
      runtime.add(entry['key']);
    }
  }

  if (buildTime.size === 0 && runtime.size === 0 && platformInjected.size === 0) return null;
  return {
    buildTime: [...buildTime].sort(),
    runtime: [...runtime].sort(),
    platformInjected: [...platformInjected].sort(),
  };
}

// ── Blocker naming and filtering ────────────────────────────────────────────

/**
 * Finding id → the accurate technical name the coding agent sees. The
 * readiness-report titles are plain-English UI copy for vendors; the prompt
 * names the concrete defect instead ("Container packaging missing", never
 * "Deployz doesn't know how to start your app").
 */
const BLOCKER_NAMES: Record<string, string> = {
  'container-setup': 'Container packaging missing',
  'port-unresolved': 'Application port undeclared',
  'start-command-missing': 'Container start command missing',
  'health-check': 'Readiness endpoint missing',
  'localhost-binding': 'Server binds to localhost only',
  'database-migrations': 'Database migration command missing',
  'worker-command': 'Background jobs run outside the web process',
  'background-worker-unsupported': 'Separate background worker process not supported',
  'local-file-storage': 'Persistent data written to local disk',
  'build-context-git-metadata': 'Dockerfile copies .git metadata',
  'unsupported-database-mysql': 'Unsupported database engine: MySQL',
  'unsupported-database-mongo': 'Unsupported database engine: MongoDB',
  'unsupported-database-elasticsearch': 'Unsupported search engine: Elasticsearch/OpenSearch',
  'unsupported-database-other': 'Unsupported database engine',
  'unsupported-database-sqlite': 'Unsupported database engine: SQLite on ephemeral disk',
  'unsupported-redis-setup': 'Unsupported Redis features (Stack modules or cluster mode)',
  'unsupported-architecture': 'Self-managed infrastructure not supported',
  'unsupported-message-queue': 'External message queue not supported',
  'unsupported-multi-service': 'Multi-service container setup not supported',
  'unsupported-persistent-volume': 'Persistent volume not supported',
  'unsupported-gpu': 'GPU requirement not supported',
};

function blockerName(finding: ReadinessFinding): string {
  return BLOCKER_NAMES[finding.id] ?? finding.title;
}

/**
 * Informational findings whose outcome explicitly requires no change (the
 * startup-migrations variant of database-migrations) never reach the prompt:
 * they are not blockers and only add noise.
 */
const NO_ACTION_OUTCOME = /^no action needed/i;

function promptFindings(findings: ReadinessFinding[]): ReadinessFinding[] {
  return findings.filter((f) => !NO_ACTION_OUTCOME.test(f.suggestedOutcome.trim()));
}

// ── Fact relevance ──────────────────────────────────────────────────────────

type FactKey = keyof FixInstructionsFacts;

/**
 * Which facts each blocker justifies. Only findings-relevant, DETECTED facts
 * are rendered — an absent fact adds noise, and the finding evidence already
 * states the absence. Unsupported-* findings fall back to the ecosystem facts.
 */
const FACT_RELEVANCE: Record<string, readonly FactKey[]> = {
  'container-setup': [
    'runtime', 'framework', 'packageManager', 'buildCommand', 'startCommand', 'port',
    'workingDirectory', 'envRequirements',
  ],
  'start-command-missing': [
    'startCommand', 'dockerfilePath', 'packageManager', 'framework', 'workingDirectory',
    'envRequirements',
  ],
  'port-unresolved': ['port', 'dockerfilePath', 'framework'],
  'health-check': ['healthPath', 'framework', 'port'],
  'localhost-binding': ['port', 'framework'],
  'database-migrations': ['database', 'migrationCommand'],
  'worker-command': ['workingDirectory', 'startCommand'],
  'background-worker-unsupported': ['workingDirectory', 'startCommand'],
  'build-context-git-metadata': ['dockerfilePath'],
  'local-file-storage': ['framework'],
  'unsupported-redis-setup': ['runtime', 'redisRequired'],
};
const FALLBACK_FACT_KEYS: readonly FactKey[] = ['runtime', 'packageManager'];

function relevantFactKeys(findings: ReadinessFinding[]): Set<FactKey> {
  const keys = new Set<FactKey>();
  for (const finding of findings) {
    const list = FACT_RELEVANCE[finding.id] ?? FALLBACK_FACT_KEYS;
    for (const key of list) keys.add(key);
  }
  return keys;
}

function factLines(label: string, names: string[]): string[] {
  return names.length > 0 ? [`- ${label} (names only): ${names.join(', ')}`] : [];
}

function renderFacts(context: FixInstructionsContext, findings: ReadinessFinding[]): string[] {
  const { facts } = context;
  const relevant = relevantFactKeys(findings);
  const lines: string[] = [
    '- Deployment target: one container per deployment; the platform probes an HTTP readiness path' +
      (facts.database === 'postgres' ? '; managed PostgreSQL injected through environment variables' : '') +
      (facts.redisRequired ? '; managed Redis injected through environment variables' : ''),
    `- Repository: ${context.repoFullName}`,
    ...(context.commitSha ? [`- Analysed commit: ${context.commitSha}`] : []),
  ];

  const push = (key: FactKey, line: string | null) => {
    if (relevant.has(key) && line !== null) lines.push(line);
  };

  push('runtime', facts.runtime ? `- Runtime: ${facts.runtime}` : null);
  push('framework', facts.framework ? `- Framework: ${facts.framework}` : null);
  push('packageManager', facts.packageManager ? `- Package manager: ${facts.packageManager}` : null);
  push('buildCommand', facts.buildCommand ? `- Build command: \`${facts.buildCommand}\`` : null);
  push('startCommand', facts.startCommand ? `- Detected start command: \`${facts.startCommand}\`` : null);
  push('port', facts.port ? `- Application port: ${facts.port}` : null);
  push('dockerfilePath', facts.dockerfilePath ? `- Container build file: ${facts.dockerfilePath}` : null);
  push('database', facts.database === 'postgres' ? '- Database: PostgreSQL (platform-provisioned)' : null);
  push('migrationCommand', facts.migrationCommand ? `- Migration command: \`${facts.migrationCommand}\`` : null);
  push('healthPath', facts.healthPath ? `- Configured health path: ${facts.healthPath}` : null);
  push('redisRequired', facts.redisRequired ? '- Redis: required (platform-provisioned)' : null);
  push(
    'workingDirectory',
    facts.workingDirectory && facts.workingDirectory !== '.'
      ? `- Application directory (workspace): ${facts.workingDirectory}`
      : null,
  );
  if (relevant.has('envRequirements') && facts.envRequirements) {
    lines.push(
      ...factLines('Required at build time', facts.envRequirements.buildTime),
      ...factLines('Required at runtime', facts.envRequirements.runtime),
      ...factLines('Provided by the platform at runtime', facts.envRequirements.platformInjected),
    );
  }

  return lines;
}

// ── Deterministic per-blocker guidance ──────────────────────────────────────

const UNSUPPORTED_DATABASE_GUIDANCE = [
  'Inspect actual usage first. Move the data layer to PostgreSQL reusing the existing schema and migration approach, or remove the dependency when it is unused.',
];

/**
 * Concise, repo-adapted guidance every blocker carries regardless of what the
 * model returns. Phrased as verify-then-implement; existing valid
 * implementations are preserved, never replaced.
 */
const DETERMINISTIC_GUIDANCE: Record<string, (facts: FixInstructionsFacts) => string[]> = {
  'container-setup': (facts) => [
    'Check existing deployment files first (Dockerfile, compose, CI build); when one already packages this app correctly, keep it and report that instead of adding a new file.',
    `Add a Dockerfile${facts.workingDirectory && facts.workingDirectory !== '.' ? ` with \`${facts.workingDirectory}\` as the build context` : ''} that installs dependencies with the repository's pinned package manager${facts.packageManager ? ` (\`${facts.packageManager}\`, via Corepack when package.json declares \`packageManager\`)` : ''}, runs the production build${facts.buildCommand ? ` (\`${facts.buildCommand}\`)` : ''}, and starts the app${facts.startCommand ? ` with \`${facts.startCommand}\`` : ''}.`,
    `${facts.framework ? `Use the \`${facts.framework}\` production mode, not the development server; serve a static export when the framework is configured that way. ` : ''}Include build tooling only when native dependencies require it; reuse the repository's private-registry mechanism when present.`,
  ],
  'port-unresolved': (facts) => [
    `Declare the port the app already listens on: an EXPOSE or ENV PORT instruction in ${facts.dockerfilePath ?? 'the Dockerfile'}.`,
  ],
  'start-command-missing': (facts) => [
    `Add a CMD or ENTRYPOINT to ${facts.dockerfilePath ?? 'the Dockerfile'} that starts the production server${facts.startCommand ? ` (\`${facts.startCommand}\`)` : ''}, or a package.json \`start\` script the container can run.`,
  ],
  'health-check': () => [
    'Search the code first for an existing lightweight endpoint (health, ping, status, ready); reuse a suitable one instead of adding a new route.',
    'Otherwise add the smallest unauthenticated HTTP route (for example GET /health) that returns 2xx once the server accepts requests — no redirect, no auth, no expensive work, no external dependency checks.',
    'A Dockerfile HEALTHCHECK instruction is not required; the platform probes the HTTP path directly.',
  ],
  'localhost-binding': () => [
    'Bind the production server to all interfaces (0.0.0.0), not 127.0.0.1; keep any loopback binding behind a development-only flag.',
  ],
  'database-migrations': () => [
    'Add a non-interactive migration script (for example `db:migrate`) that uses the migration tooling already in the repository; migrations run as a deploy step, not on request paths.',
  ],
  'worker-command': () => [
    'Process background jobs inside the web process (an in-process scheduler or queue worker), or remove the job-runner code when it is unused.',
  ],
  'background-worker-unsupported': () => [
    'Move the worker processing into the web process, or remove the separate worker entrypoint; the platform starts one process per deployment.',
  ],
  'local-file-storage': () => [
    'Move persistent file writes to object storage; keep local disk only for temporary files.',
  ],
  'build-context-git-metadata': (facts) => [
    `Remove COPY/ADD of the \`.git\` directory from ${facts.dockerfilePath ?? 'the Dockerfile'}; make any git-derived build argument optional.`,
  ],
  'unsupported-database-mysql': () => UNSUPPORTED_DATABASE_GUIDANCE,
  'unsupported-database-mongo': () => UNSUPPORTED_DATABASE_GUIDANCE,
  'unsupported-database-elasticsearch': () => UNSUPPORTED_DATABASE_GUIDANCE,
  'unsupported-database-other': () => UNSUPPORTED_DATABASE_GUIDANCE,
  'unsupported-database-sqlite': () => [
    ...UNSUPPORTED_DATABASE_GUIDANCE,
    'SQLite stores data on the container disk, which is wiped on every deploy.',
  ],
  'unsupported-redis-setup': () => [
    'Restrict Redis usage to what a standard single-node Redis supports; remove Stack modules and cluster-mode clients.',
  ],
  'unsupported-architecture': () => [
    'Remove the self-managed infrastructure files and dependencies; the platform provides hosting, database, cache, and storage.',
  ],
  'unsupported-message-queue': () => [
    'Replace the queue with jobs that run inside the web process, or remove the queue dependency when it is unused.',
  ],
  'unsupported-multi-service': () => [
    'Run the app as one container; move sidecar services out of the deployment.',
  ],
  'unsupported-persistent-volume': () => [
    'Replace the attached volume with object storage; container disks are wiped on every deploy.',
  ],
  'unsupported-gpu': () => [
    'Remove the GPU requirement or move that processing to an external service that provides it.',
  ],
};

function guidanceFor(finding: ReadinessFinding, facts: FixInstructionsFacts): string[] {
  const builder = DETERMINISTIC_GUIDANCE[finding.id];
  if (builder) return builder(facts);
  return [finding.suggestedOutcome];
}

// ── AI prompt ───────────────────────────────────────────────────────────────

/**
 * Build the prompt that asks the model for per-blocker implementation
 * guidance. Built exclusively from structured deterministic facts and finding
 * evidence — never repository file contents.
 */
export function buildFixInstructionsAiPrompt(context: FixInstructionsContext): string {
  const blockers = promptFindings(context.findings);
  const lines: string[] = [
    'You write implementation guidance for a coding agent that will fix the deployment blockers',
    'below in one repository. The guidance is inserted into a deterministic prompt, so keep it',
    'short, concrete, and specific to the detected stack. Phrase everything as verify, then',
    'implement — the agent checks each blocker against the real repository before changing code.',
    '',
    'Rules:',
    '- Respect the detected runtime, framework, package manager, workspace layout, versions, and',
    '  existing deployment configuration; never contradict the facts, and never replace a valid',
    '  existing implementation.',
    '- Prefer package-manager versions the repository itself declares (packageManager field,',
    '  lockfiles, Corepack) over installing new ones.',
    '- Account for monorepo build contexts, custom servers, static exports, framework-specific',
    '  production modes, native dependencies, and private registries when the facts imply them.',
    '- Readiness endpoints: reuse a suitable existing route first; otherwise add the smallest',
    '  unauthenticated route. No redirects, no auth, no expensive work, no external dependency',
    '  checks. Do not require a Dockerfile HEALTHCHECK.',
    '- Distinguish build-time from runtime environment-variable requirements; never invent',
    '  values or mention secret values.',
    '- Do not prescribe AWS, DNS, TLS, load balancer, Terraform, Kubernetes, or Deployz-side',
    '  infrastructure unless a blocker requires it.',
    '- When repository evidence cannot resolve a blocker safely, instruct the agent to report',
    '  the ambiguity instead of guessing.',
    '',
    'Repository facts:',
    ...renderFacts(context, blockers),
    '',
    'Blockers to cover:',
  ];

  for (const finding of blockers) {
    lines.push(
      `- id: ${finding.id}`,
      `  name: ${blockerName(finding)}`,
      `  severity: ${finding.severity.toUpperCase()}`,
      `  evidence: ${finding.technicalEvidence}`,
      `  required outcome: ${finding.suggestedOutcome}`,
      `  confidence: ${finding.confidence}`,
    );
  }

  lines.push(
    '',
    'Respond with JSON matching: {"perFinding": [{"id", "guidance"}], "generalNotes": [string]}.',
    'Cover every blocker id listed above. Keep each guidance to at most three sentences',
    '(about 60 words) with no code blocks. Keep generalNotes to at most three short items, or',
    'an empty array. Do not pretty-print the JSON. Respond with only JSON — no prose, no',
    'markdown outside the JSON.',
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

const CONFIDENCE_NOTE: Record<ReadinessFinding['confidence'], string | null> = {
  confirmed: null,
  likely: 'verify first: static analysis can miss an existing solution',
  needs_confirmation: 'confirm this applies before changing anything',
};

/** Validation steps that apply to the included blockers and facts. */
function validationLines(facts: FixInstructionsFacts, ids: Set<string>): string[] {
  const lines = ['- Run the repository\'s tests, lint, and typecheck when they exist.'];
  if (facts.buildCommand !== null || ids.has('container-setup')) {
    lines.push(`- Build for production${facts.buildCommand ? ` (\`${facts.buildCommand}\`)` : ''}.`);
  }
  if (
    facts.dockerfilePath !== null ||
    ids.has('container-setup') ||
    ids.has('start-command-missing') ||
    ids.has('build-context-git-metadata')
  ) {
    lines.push('- Build the container image when Docker is available.');
  }
  if (
    facts.port !== null ||
    ids.has('container-setup') ||
    ids.has('start-command-missing') ||
    ids.has('port-unresolved') ||
    ids.has('localhost-binding')
  ) {
    lines.push(
      `- Start the app (or the built container) and confirm it listens on ${facts.port ? `port ${facts.port}` : 'the declared port'} on all interfaces.`,
    );
  }
  if (ids.has('health-check') || ids.has('localhost-binding')) {
    lines.push(
      `- Request the readiness endpoint${facts.healthPath ? ` (\`${facts.healthPath}\`)` : ' (for example `/health`)'} and confirm a direct HTTP 2xx response with no redirect.`,
    );
  }
  if (facts.database === 'postgres' && ids.has('database-migrations')) {
    lines.push('- Run the migration command against a disposable local database only — never production data.');
  }
  return lines;
}

/**
 * Assemble the final coding-agent document from the deterministic context and
 * the model's guidance. Sections: repository facts, blocking issues, required
 * outcome, implementation guidance, validation, completion report. The
 * deterministic per-blocker guidance and all safety rules are templated here,
 * so the document is complete and guarded regardless of what the model
 * produced.
 */
export function assembleFixInstructions(
  context: FixInstructionsContext,
  ai: FixInstructionsAiOutput,
): string {
  const blockers = promptFindings(context.findings);
  const guidanceById = new Map(ai.perFinding.map((entry) => [entry.id, entry.guidance]));
  const shortSha = context.commitSha ? context.commitSha.slice(0, 7) : null;
  const ids = new Set(blockers.map((f) => f.id));
  const lines: string[] = [
    `# Fix deployment blockers — ${context.repoFullName}${shortSha ? ` (@${shortSha})` : ''}`,
    '',
    'Prompt for an AI coding agent working in this repository. Resolve the blockers below.',
    FIX_INSTRUCTIONS_GUARDRAIL,
    '',
    '## Repository facts',
    '',
    ...renderFacts(context, blockers),
    '',
    '## Blocking issues',
    '',
    ...blockers.map((finding, index) => {
      const note = CONFIDENCE_NOTE[finding.confidence];
      const tag = finding.severity === 'recommended' ? ' (recommended)' : '';
      return `${index + 1}. **${blockerName(finding)}**${tag} — Evidence: ${finding.technicalEvidence}` +
        (note ? ` (${note})` : '');
    }),
    '',
    '## Required outcome',
    '',
    ...blockers.map((finding, index) => `${index + 1}. ${blockerName(finding)}: ${finding.suggestedOutcome}`),
    '',
    '## Implementation guidance',
    '',
  ];

  blockers.forEach((finding, index) => {
    lines.push(`${index + 1}. ${blockerName(finding)}:`);
    for (const step of guidanceFor(finding, context.facts)) lines.push(`   - ${step}`);
    const aiGuidance = guidanceById.get(finding.id);
    if (aiGuidance) lines.push(`   ${aiGuidance}`);
  });

  if (ai.generalNotes.length > 0) {
    lines.push('', 'Notes:', ...ai.generalNotes.map((note) => `- ${note}`));
  }

  lines.push(
    '',
    'Rules for every change:',
    '- Preserve the existing architecture, conventions, and valid deployment configuration; make the smallest change that resolves each blocker.',
    '- Use the package manager and versions the repository already declares; do not install arbitrary newer versions.',
    '- Never invent or commit secret values; reference environment variables instead.',
    '- Do not add AWS, DNS, TLS, load balancer, Terraform, Kubernetes, or other infrastructure unless a blocker requires it.',
    '- When a blocker cannot be resolved safely from repository evidence, report the ambiguity instead of guessing.',
    '',
    '## Validation',
    '',
    'Run only the checks that apply, and report the results:',
    '',
    ...validationLines(context.facts, ids),
    '',
    '## Completion report',
    '',
    'When finished, report:',
    '',
    '- Every file changed, with a one-line summary per file.',
    '- The validation steps actually run and their results; do not claim success for steps not run.',
    '- Assumptions made, unresolved risks, and any blocker left ambiguous.',
    '',
    'After pushing, re-run the Deployz analysis to confirm the blockers are resolved.',
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
    reasoning: false,
  });

  const usedTokens = response.usage.promptTokens + response.usage.completionTokens;
  if (usedTokens > FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS) {
    throw new SpendLimitExceededError(usedTokens, FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS);
  }

  return assembleFixInstructions(context, fixInstructionsAiSchema.parse(response.object));
}
