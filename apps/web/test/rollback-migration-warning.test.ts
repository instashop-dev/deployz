import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// §26 required rollback warning (Phase 4C): rollback restores the application
// workloads but NEVER reverses database migrations — every rollback
// affordance must carry the grounded warning, verbatim. This reads the two
// page sources so a removed or reworded warning fails here, not in review.

const WARNING =
  'Application rollback does not automatically reverse database migrations.';

const ROLLBACK_SURFACES = [
  '../src/app/dashboard/deployments/[id]/page.tsx',
  '../src/app/admin/deployments/[id]/page.tsx',
];

describe('rollback migration warning (§26)', () => {
  it('every rollback affordance carries the verbatim migration warning', () => {
    for (const relative of ROLLBACK_SURFACES) {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), relative);
      const source = readFileSync(file, 'utf8');
      expect(source, `${relative} must render the rollback migration warning`).toContain(WARNING);
    }
  });
});
