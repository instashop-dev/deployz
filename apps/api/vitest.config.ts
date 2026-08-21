import { defineConfig } from 'vitest/config';

// PGlite boots a real WASM Postgres in-process (~7s on this machine) and each
// test file owns its instance. Parallel files can starve each other past the
// default 10s hook timeout — give the beforeAll bootstrap a real budget.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
  },
});
