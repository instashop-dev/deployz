import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // pgEnum definitions live in enums.ts and must be scanned explicitly —
  // drizzle-kit only emits CREATE TYPE for enums reachable from these globs.
  schema: ['./src/schema/index.ts', './src/enums.ts'],
  out: './drizzle',
});
