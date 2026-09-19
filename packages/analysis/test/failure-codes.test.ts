import { describe, expect, it } from 'vitest';

import { failureCodeSchema } from '@deployz/contracts';

import { FAILURE_CODES } from '../src/failure-codes.js';

// The analysis-side §61 mirror must track the contracts enum exactly: the
// widened AI-explanation gate passes the full contracts union into
// @deployz/analysis, so a missing member is a build break (Record
// exhaustiveness) or a silently narrower classifier — never a quiet drift.

describe('§61 failure-code parity (analysis ↔ contracts)', () => {
  it('the analysis FAILURE_CODES set equals the contracts failureCodeSchema options', () => {
    expect([...FAILURE_CODES].sort()).toEqual([...failureCodeSchema.options].sort());
  });
});
