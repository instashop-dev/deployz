import { defineConfig } from 'vitest/config';

// PGlite boots a real WASM Postgres in-process (~7s on this machine) and each
// test file owns its instance. Parallel files can starve each other past the
// default timeouts — give the beforeAll bootstrap and each test a real budget.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
