import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findEnvFile, moduleDirectory } from './find-env-file.js';

// Locks the .env lookup against a real directory tree. The load-bearing case
// is the git worktree one: .env is gitignored, so a worktree never gets a
// copy, and counting fixed '..' hops from this file lands on a worktree root
// that has none — every capability then reads as "not configured" while the
// main checkout has it set.

describe('moduleDirectory', () => {
  it('resolves the directory of a file: module URL', () => {
    expect(moduleDirectory(import.meta.url)).toBe(dirname(fileURLToPath(import.meta.url)));
  });

  // esbuild bundles the API Lambda as CJS, where `import.meta` is `{}`. Before
  // this fallback, fileURLToPath(undefined) threw at module load and took the
  // handler down on cold start.
  it('falls back to the working directory when there is no module URL', () => {
    expect(moduleDirectory(undefined)).toBe(process.cwd());
  });
});

describe('findEnvFile', () => {
  let base: string;
  // A main checkout holding the .env, with a worktree nested under it the way
  // `git worktree add .claude/worktrees/<name>` lays one out.
  let mainRoot: string;
  let worktreePackage: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'deployz-env-'));
    mainRoot = join(base, 'deployz');
    worktreePackage = join(mainRoot, '.claude', 'worktrees', 'feature-x', 'apps', 'api', 'src');
    mkdirSync(join(mainRoot, 'apps', 'api', 'src'), { recursive: true });
    mkdirSync(worktreePackage, { recursive: true });
    writeFileSync(join(mainRoot, '.env'), 'GITHUB_APP_INSTALL_URL=https://example.test/install\n');
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('finds the repo-root .env from the package source directory', () => {
    expect(findEnvFile(join(mainRoot, 'apps', 'api', 'src'))).toBe(join(mainRoot, '.env'));
  });

  it('finds the main checkout .env from inside a worktree that has none', () => {
    expect(findEnvFile(worktreePackage)).toBe(join(mainRoot, '.env'));
  });

  it("prefers the worktree's own .env once it has one", () => {
    const worktreeRoot = join(mainRoot, '.claude', 'worktrees', 'feature-x');
    writeFileSync(join(worktreeRoot, '.env'), 'GITHUB_APP_INSTALL_URL=https://example.test/other\n');
    try {
      expect(findEnvFile(worktreePackage)).toBe(join(worktreeRoot, '.env'));
    } finally {
      rmSync(join(worktreeRoot, '.env'), { force: true });
    }
  });

  // Assumes no .env sits above the temp directory — true of any sane machine,
  // and dotenv would be skipped rather than misled if one somehow did.
  it('returns null when no ancestor holds a .env (production reads real env vars)', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'deployz-env-none-'));
    try {
      expect(findEnvFile(orphan)).toBeNull();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
