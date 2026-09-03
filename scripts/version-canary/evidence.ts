/**
 * Per-run evidence: `canary-results/<run-id>/run.json` (identities and
 * state the run accumulates — what cleanup and audit key on), one JSON file
 * per step under `steps/`, and a Markdown summary written at the end.
 * Every AWS/control-plane fact a PASS/FAIL rests on is recorded here, so a
 * result can be re-read without re-running.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type StepStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface StepRecord {
  readonly index: number;
  readonly name: string;
  readonly scenario: string;
  readonly startedAt: string;
  finishedAt?: string;
  status: StepStatus;
  /** Structured facts (deployment/job ids, digests, states, live answers). */
  details: Record<string, unknown>;
  error?: string;
}

/** Everything cleanup and audit need — appended to as the run learns it. */
export interface RunRecord {
  readonly runId: string;
  readonly startedAt: string;
  finishedAt?: string;
  readonly apiUrl: string;
  readonly region: string;
  readonly accountId: string;
  scenario: string;
  result?: 'PASS' | 'FAIL';
  vendor?: { email: string; password: string; organizationId?: string };
  applicationId?: string;
  customerId?: string;
  deploymentId?: string;
  installLinkId?: string;
  installationId?: string;
  bootstrapStackName?: string;
  applicationStackName?: string;
  /** Lambda function names the bootstrap stack created (their log groups outlive the stack). */
  bootstrapLambdaNames?: string[];
  canaryTemplateUrl?: string;
  canaryTemplateKeyPrefix?: string;
  templateBucket?: string;
  releases: Record<string, { id: string; version: string; gitSha: string; imageDigest?: string }>;
  fixtureTags?: Record<string, { sha: string; contentSha: string }>;
  albEndpoint?: string;
  markers: string[];
  jobs: { id: string; type: string; releaseTag?: string; state?: string; failureCode?: string | null }[];
  steps: StepRecord[];
}

export class Evidence {
  readonly dir: string;
  readonly run: RunRecord;
  private stepIndex = 0;

  constructor(resultsDir: string, run: RunRecord) {
    this.dir = join(resultsDir, run.runId);
    mkdirSync(join(this.dir, 'steps'), { recursive: true });
    this.run = run;
    this.save();
  }

  static open(resultsDir: string, runId: string): Evidence {
    const path = join(resultsDir, runId, 'run.json');
    if (!existsSync(path)) throw new Error(`No run record at ${path}`);
    const run = JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
    const evidence = new Evidence(resultsDir, run);
    evidence.stepIndex = run.steps.length;
    return evidence;
  }

  save(): void {
    writeFileSync(join(this.dir, 'run.json'), `${JSON.stringify(this.run, null, 2)}\n`);
  }

  /**
   * Runs one step, recording its facts and outcome. A failing step throws
   * after recording so the caller can stop the scenario; `details` set by
   * the step before the failure are kept.
   */
  async step<T>(
    name: string,
    fn: (details: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const record: StepRecord = {
      index: ++this.stepIndex,
      name,
      scenario: this.run.scenario,
      startedAt: new Date().toISOString(),
      status: 'FAIL',
      details: {},
    };
    this.run.steps.push(record);
    console.log(`\n▶ [${record.index}] ${name}`);
    try {
      const result = await fn(record.details);
      record.status = 'PASS';
      return result;
    } catch (error) {
      record.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`✗ [${record.index}] ${name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      record.finishedAt = new Date().toISOString();
      if (record.status === 'PASS') console.log(`✓ [${record.index}] ${name}`);
      writeFileSync(
        join(this.dir, 'steps', `${String(record.index).padStart(2, '0')}-${slug(name)}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      this.save();
    }
  }

  finish(result: 'PASS' | 'FAIL'): void {
    this.run.result = result;
    this.run.finishedAt = new Date().toISOString();
    this.save();
    writeFileSync(join(this.dir, 'summary.md'), renderSummary(this.run));
    console.log(`\nAWS Canary (${this.run.scenario}): ${result}\n${renderTable(this.run)}`);
    console.log(`Evidence: ${this.dir}`);
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderTable(run: RunRecord): string {
  const width = Math.max(...run.steps.map((s) => s.name.length), 10);
  return run.steps
    .map((s) => `${s.name.padEnd(width)}  ${s.status}${s.error ? `  ${firstLine(s.error)}` : ''}`)
    .join('\n');
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

export function renderSummary(run: RunRecord): string {
  const lines = [
    `# AWS Canary: ${run.result ?? 'INCOMPLETE'}`,
    '',
    `- Run: \`${run.runId}\` (${run.scenario})`,
    `- Control plane: ${run.apiUrl}`,
    `- AWS account/region: ${run.accountId} / ${run.region}`,
    `- Started: ${run.startedAt}${run.finishedAt ? `, finished: ${run.finishedAt}` : ''}`,
    run.deploymentId ? `- Deployment: \`${run.deploymentId}\`` : null,
    run.installationId ? `- Installation: \`${run.installationId}\`` : null,
    run.bootstrapStackName ? `- Bootstrap stack: \`${run.bootstrapStackName}\`` : null,
    run.applicationStackName ? `- Application stack: \`${run.applicationStackName}\`` : null,
    '',
    '| # | Step | Result | Note |',
    '| --- | --- | --- | --- |',
    ...run.steps.map(
      (s) => `| ${s.index} | ${s.name} | ${s.status} | ${s.error ? firstLine(s.error).replace(/\|/g, '\\|') : ''} |`,
    ),
    '',
    '## Releases',
    '',
    ...Object.entries(run.releases).map(
      ([tag, r]) => `- ${tag}: version \`${r.version}\`, gitSha \`${r.gitSha}\`, digest \`${r.imageDigest ?? '?'}\``,
    ),
    '',
    '## Jobs',
    '',
    ...run.jobs.map(
      (j) => `- ${j.type}${j.releaseTag ? ` ${j.releaseTag}` : ''}: \`${j.id}\` → ${j.state ?? '?'}${j.failureCode ? ` (${j.failureCode})` : ''}`,
    ),
    '',
  ];
  return `${lines.filter((line) => line !== null).join('\n')}\n`;
}
