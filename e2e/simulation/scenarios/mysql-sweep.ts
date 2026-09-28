import type { ScenarioDefinition } from '../types.js';
import { retainedResources } from './retained-resources.js';

/**
 * Phase 4B RDS MySQL lifecycle: the SAME timeline shape as
 * retained-resources — install reaches HEALTHY with the managed database
 * (the RDS events are engine-blind: `AWS::RDS::DBInstance`), DESTROY
 * completes cleanly while the database stays retained, and PURGE then
 * sweeps the tag-owned MySQL instance + its subnet group
 * (`purge.retainedDbInstance`). The simulated account and verification are
 * already engine-agnostic — they key on CloudFormation resource types, so
 * no account change was needed; the engine truth lives in the analysed
 * fixture repo (deployz-demo/mysql-api) and its manifest's
 * `database.engine: 'mysql'`.
 */
export const mysqlSweep: ScenarioDefinition = {
  ...retainedResources,
  id: 'mysql-sweep',
  description:
    'Install reaches HEALTHY with a managed MySQL database (AWS::RDS::DBInstance); deploy; DESTROY retains the database; PURGE deletes the retained instance and subnet group.',
  updateRollouts: ['succeed', 'succeed'],
  purge: {
    retainedDbInstance: {
      identifier: 'deployz-primary-db-mysql',
      subnetGroup: 'deployz-primary-db-subnet-group',
    },
  },
};
