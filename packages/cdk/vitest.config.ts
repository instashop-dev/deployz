import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    env: {
      // `Template.fromStack()` on a stack with a NodejsFunction runs esbuild
      // synchronously for every synth. The bundle is never asserted on (the
      // asset hash is normalised by test/stable-template.ts), it costs ~100 s
      // per full run, and the blocked event loop starves vitest's worker RPC
      // ("Timeout calling onTaskUpdate", the flake that failed pushes to
      // main). An empty bundling-stacks list makes the CDK stage a
      // placeholder asset instead. The synth scripts and the publisher run
      // outside vitest, so committed artifacts still bundle for real.
      CDK_CONTEXT_JSON: JSON.stringify({ 'aws:cdk:bundling-stacks': [] }),
    },
    // Template synthesis is still CPU-heavy (hundreds of synths per file)
    // and three files boot PGlite. Running the files in parallel starves the
    // worker RPC and the PGlite hooks on a small machine; one file at a time
    // keeps the run predictable.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
