import { defineConfig } from 'vitest/config';

// The offline Jev evaluation harness: corpus requirements-shadow runs and
// Stage B failure replays over synthetic in-memory snapshots — never GitHub,
// never a live model.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
