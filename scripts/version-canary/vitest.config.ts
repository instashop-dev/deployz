import { defineConfig } from 'vitest/config';

// The harness's pure helpers (guard, run ids, Quick Create parsing, evidence
// rendering, waiting) — everything that can be proven without AWS. The
// live scenarios themselves only ever run through `pnpm e2e:canary:versions`.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
  },
});
