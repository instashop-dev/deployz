import { defineConfig } from 'vitest/config';

// The harness's pure and in-process parts: configuration parsing, the result
// schema and vocabularies, selection, resume, dry-run, the real-AWS opt-in,
// cleanup-on-failure, failure classification and the summary — with fakes
// for the control plane and AWS, never the network.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
