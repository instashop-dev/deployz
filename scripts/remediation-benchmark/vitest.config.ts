import { defineConfig } from 'vitest/config';

// The benchmark's deterministic gate: plan classes, safety, structure and
// expected content over the pinned snapshots — never a model call.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
