import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    // CDK synth tests are CPU-heavy: each `Template.fromStack()` runs esbuild
    // bundling that blocks the worker's event loop for seconds at a time.
    // Running these files in parallel starves vitest's worker RPC
    // (`onTaskUpdate`) and produces "Timeout calling onTaskUpdate" unhandled
    // errors plus a non-zero exit code. Serialize the files so only one heavy
    // synth runs at a time (same class of fix as the PGlite hookTimeout
    // learning from todo 3, line 47).
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        // One worker at a time keeps the esbuild-bundling synth from
        // contending across files and blocking inter-process RPC.
        singleFork: true,
      },
    },
  },
});
