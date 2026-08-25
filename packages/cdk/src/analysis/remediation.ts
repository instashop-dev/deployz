/**
 * Re-export barrel — the §61 remediation engine moved to `@deployz/analysis`
 * so it can be shared with `apps/api` (which serves it as the deterministic
 * fallback when an AI explanation is unavailable). This barrel keeps the
 * existing `./analysis/remediation.js` import path working.
 */

export type { Remediation } from '@deployz/analysis';
export { getRemediation } from '@deployz/analysis';
