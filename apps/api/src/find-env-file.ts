import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

// Side-effect free on purpose: the API's env.ts and the CDK entrypoints both
// import this, and only env.ts should emit the "not configured" warnings.

/**
 * Directory of the module identified by `moduleUrl`, or the working directory
 * when there is no URL to go on.
 *
 * The fallback is load-bearing: esbuild bundles the API Lambda as CJS, where
 * `import.meta` is `{}`, so `fileURLToPath(import.meta.url)` throws
 * ERR_INVALID_ARG_TYPE at module load and takes the whole handler down on
 * cold start. A Lambda carries no .env anyway — CDK injects the env vars —
 * so the search below simply comes up empty there.
 */
export function moduleDirectory(moduleUrl: string | undefined): string {
  return moduleUrl === undefined ? process.cwd() : dirname(fileURLToPath(moduleUrl));
}

/**
 * Nearest .env at or above `startDir`, or null when no ancestor holds one.
 *
 * `dotenv/config` loads from process.cwd(), but turbo runs each package from
 * its own directory, so the repo-root .env (where the README documents it)
 * would never load. Walking up from the calling module finds it from the
 * source tree and from a built dist/ alike, and — the reason this searches
 * rather than counting fixed '..' hops — it also finds it from a git
 * worktree: .env is gitignored, so `git worktree add` never copies it, and
 * every capability would silently read as "not configured" while the main
 * checkout has it set. Real environment variables still win: dotenv never
 * overwrites one that is already present (production / CI rely on that).
 */
export function findEnvFile(startDir: string): string | null {
  const { root } = parse(startDir);
  let directory = startDir;
  for (;;) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) return candidate;
    if (directory === root) return null;
    directory = dirname(directory);
  }
}
