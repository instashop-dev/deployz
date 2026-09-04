import { describe, expect, it } from 'vitest';

import {
  analysisStatusSchema,
  cleanupStateSchema,
  compatibilityStatusSchema,
  deploymentSourceSchema,
  deploymentStateSchema,
  failureCodeSchema,
  infrastructureComponentKindSchema,
  infrastructureComponentStatusSchema,
  infrastructureLifecycleSchema,
  infrastructureResourceRoleSchema,
  jobStateSchema,
  jobTypeSchema,
  regionSchema,
  releaseStatusSchema,
  subscriptionStatusSchema,
} from '@deployz/contracts';

import {
  analysisStatusEnum,
  cleanupStateEnum,
  compatibilityStatusEnum,
  deploymentSourceEnum,
  deploymentStateEnum,
  failureCodeEnum,
  infrastructureComponentKindEnum,
  infrastructureComponentStatusEnum,
  infrastructureLifecycleEnum,
  infrastructureResourceRoleEnum,
  jobStateEnum,
  jobTypeEnum,
  regionEnum,
  releaseStatusEnum,
  subscriptionStatusEnum,
} from './enums.js';

// Parity law: every contracts enum is EXACTLY the live db pgEnum vocabulary.
// The test lives HERE (db -> contracts, one direction) instead of in
// packages/contracts so the two packages never form a dependency cycle —
// turborepo rejects cyclic package graphs outright.
describe('enum parity with @deployz/contracts zod schemas', () => {
  const pairs = [
    ['analysisStatus', analysisStatusEnum, analysisStatusSchema.options],
    ['compatibilityStatus', compatibilityStatusEnum, compatibilityStatusSchema.options],
    ['releaseStatus', releaseStatusEnum, releaseStatusSchema.options],
    ['region', regionEnum, regionSchema.options],
    ['deploymentState', deploymentStateEnum, deploymentStateSchema.options],
    ['deploymentSource', deploymentSourceEnum, deploymentSourceSchema.options],
    ['jobType', jobTypeEnum, jobTypeSchema.options],
    ['jobState', jobStateEnum, jobStateSchema.options],
    ['failureCode', failureCodeEnum, failureCodeSchema.options],
    ['cleanupState', cleanupStateEnum, cleanupStateSchema.options],
    ['subscriptionStatus', subscriptionStatusEnum, subscriptionStatusSchema.options],
    ['infrastructureComponentKind', infrastructureComponentKindEnum, infrastructureComponentKindSchema.options],
    ['infrastructureComponentStatus', infrastructureComponentStatusEnum, infrastructureComponentStatusSchema.options],
    ['infrastructureLifecycle', infrastructureLifecycleEnum, infrastructureLifecycleSchema.options],
    ['infrastructureResourceRole', infrastructureResourceRoleEnum, infrastructureResourceRoleSchema.options],
  ] as const;

  for (const [name, dbEnum, contractsOptions] of pairs) {
    it(`${name}: db enumValues === contracts options (sorted)`, () => {
      expect([...dbEnum.enumValues].sort()).toEqual([...contractsOptions].sort());
    });
  }
});