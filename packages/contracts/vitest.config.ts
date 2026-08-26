import { defineConfig } from 'vitest/config';

// Without a package-local config, `vitest run` here falls back to the repo
// root's workspace config (`projects: ['packages/*', 'apps/*']`), which
// resolves those globs relative to cwd and finds nothing — "No projects
// were found". An empty local config makes this package a standalone
// project, matching the precedent in packages/db/vitest.config.ts.
export default defineConfig({});
