import { defineConfig } from 'vitest/config';

// The harness's pure and in-process parts: manifest parsing, the snapshot
// fetch, normalization, comparison, classification, deterministic output,
// and the production analysis path over an in-memory tree — never GitHub.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
