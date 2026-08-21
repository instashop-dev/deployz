import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

// Monorepo: pin tracing to the repo root so Next doesn't pick a stray
// lockfile higher up the tree as the workspace root.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'),
};

export default nextConfig;
