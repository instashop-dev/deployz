/**
 * Publishes the version-canary fixture repository — the GitHub repository
 * the real-AWS version/rollback canary builds its releases from.
 *
 * Deployz builds a release from a GitHub commit (worker → CodeBuild), so a
 * deterministic set of releases needs a repository whose tags differ in
 * exactly one thing: `release.json`. This script materialises
 * `packages/fixture` into that repository as one commit chain and tags it:
 *
 *   v1             healthMode ok      known good
 *   v2             healthMode ok      known good (carries the migration command)
 *   v3-bad-health  healthMode broken  /health answers 500 — must never become current
 *   v4             healthMode ok      known good recovery release
 *
 * Every tag is two commits: the content commit (release.json says
 * `commit: pending`) and a stamp commit that writes the content commit's
 * SHA into release.json. The tag points at the stamp commit, so
 * `/version.commit` on a running release equals `git rev-parse <tag>^`.
 * Rerunning rewrites the same content; the commit SHAs (and so the tags)
 * move because commits carry timestamps, which is why the canary resolves
 * each tag's SHA from GitHub at run time instead of pinning it.
 *
 * Usage (needs `gh` authenticated as an account that can create/push the repo):
 *   pnpm canary:fixture-repo [--repo owner/name] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_FIXTURE_REPO = 'instashop-dev/deployz-canary-app';

export interface FixtureRelease {
  readonly tag: string;
  readonly healthMode: 'ok' | 'broken';
  /** The migration command a release created from this tag should carry. */
  readonly migrationCommand: string | null;
}

/** The canonical fixture ladder — the same list the canary scenarios walk. */
export const FIXTURE_RELEASES: readonly FixtureRelease[] = [
  { tag: 'v1', healthMode: 'ok', migrationCommand: null },
  { tag: 'v2', healthMode: 'ok', migrationCommand: 'node dist/migrate.js' },
  { tag: 'v3-bad-health', healthMode: 'broken', migrationCommand: null },
  { tag: 'v4', healthMode: 'ok', migrationCommand: null },
];

const FIXTURE_FILES = ['Dockerfile', 'package.json', 'tsconfig.build.json', 'src'] as const;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = resolve(here, '..', '..', 'packages', 'fixture');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Writes the fixture source for one release into `dir` (wiping stale files first). */
export function materialiseRelease(dir: string, release: FixtureRelease, commit: string): void {
  for (const entry of [...FIXTURE_FILES, 'release.json', '.dockerignore', 'README.md']) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
  for (const entry of FIXTURE_FILES) {
    cpSync(join(FIXTURE_SOURCE, entry), join(dir, entry), {
      recursive: true,
      filter: (source) => !source.endsWith('.test.ts'),
    });
  }
  writeFileSync(join(dir, '.dockerignore'), 'node_modules\ndist\n');
  writeFileSync(
    join(dir, 'README.md'),
    `# deployz-canary-app\n\nGenerated from \`packages/fixture\` in the Deployz repository by ` +
      `\`pnpm canary:fixture-repo\`. Do not edit by hand — every tag is regenerated from source.\n`,
  );
  writeFileSync(
    join(dir, 'release.json'),
    `${JSON.stringify({ version: release.tag, commit, healthMode: release.healthMode }, null, 2)}\n`,
  );
}

function ensureRepository(repo: string, dryRun: boolean): void {
  try {
    gh(['repo', 'view', repo, '--json', 'name']);
    return;
  } catch {
    // Not found — create it below.
  }
  console.log(`Repository ${repo} does not exist; creating it (public).`);
  if (dryRun) return;
  gh([
    'repo',
    'create',
    repo,
    '--public',
    '--description',
    'Deployz version/rollback canary fixture — generated, do not edit',
  ]);
}

export interface PublishedTag {
  readonly tag: string;
  readonly sha: string;
  /** The content commit the stamp commit points back at (`/version.commit`). */
  readonly contentSha: string;
}

export function publishFixtureRepo(options: { repo: string; dryRun: boolean }): PublishedTag[] {
  const { repo, dryRun } = options;
  ensureRepository(repo, dryRun);

  const work = mkdtempSync(join(tmpdir(), 'deployz-canary-fixture-'));
  const dir = join(work, 'repo');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'deployz-canary']);
  git(dir, ['config', 'user.email', 'canary@deployz.dev']);

  const published: PublishedTag[] = [];
  for (const release of FIXTURE_RELEASES) {
    materialiseRelease(dir, release, 'pending');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', `${release.tag}: fixture content`]);
    const contentSha = git(dir, ['rev-parse', 'HEAD']);
    materialiseRelease(dir, release, contentSha);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `${release.tag}: stamp ${contentSha.slice(0, 7)}`]);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['tag', '-f', release.tag, sha]);
    published.push({ tag: release.tag, sha, contentSha });
  }

  console.log(JSON.stringify({ repo, dryRun, tags: published }, null, 2));
  if (!dryRun) {
    git(dir, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
    // Force on purpose: the repository is generated and owns no history of
    // its own. Tags move only when the fixture source changed.
    git(dir, ['push', '-q', '--force', 'origin', 'main']);
    git(dir, ['push', '-q', '--force', 'origin', '--tags']);
    console.log(`Pushed main and ${published.length} tags to ${repo}.`);
  }
  rmSync(work, { recursive: true, force: true });
  return published;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: DEFAULT_FIXTURE_REPO },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  // Sanity: the fixture source must be the workspace package, not a stale copy.
  JSON.parse(readFileSync(join(FIXTURE_SOURCE, 'package.json'), 'utf8'));
  publishFixtureRepo({ repo: values.repo, dryRun: values['dry-run'] });
}
