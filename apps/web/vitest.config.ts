import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Normalised to forward slashes: on Windows fileURLToPath yields backslashes,
// and an alias replacement that mixes separators resolves inconsistently.
const srcDir = fileURLToPath(new URL('./src', import.meta.url))
  .split(path.sep)
  .join('/');

export default defineConfig({
  resolve: {
    // apps/web resolves '@/...' to src/ through tsconfig `paths`, which Next
    // and the TypeScript compiler honour but Vitest does not. Without this,
    // any source file reachable from a test could only use relative imports --
    // a constraint nothing in the app code hints at, and one that surfaces as
    // an ERR_MODULE_NOT_FOUND while collecting rather than as a failed test.
    //
    // The key is '@/' rather than '@' so that scoped package names such as
    // @deployz/copy-map are not rewritten into src/.
    alias: { '@/': `${srcDir}/` },
  },
});
