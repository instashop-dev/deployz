import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AWS_RESOURCES,
  awsResourceMatches,
  classifyResource,
  INFRASTRUCTURE_COMPONENTS,
  requiredInfrastructureComponents,
  type InfrastructureProfile,
} from '@deployz/contracts';

/**
 * Guards the parity this catalog depends on: `classifyResource`'s lifecycle
 * for every resource in the four committed application templates must agree
 * with CloudFormation's own DeletionPolicy, and the catalog's five
 * components must appear (by primary resource type) exactly where each
 * template's infrastructure profile predicts. No CDK synth here — a plain
 * read of the committed JSON, kept in sync with a fresh synth by
 * `artifacts.test.ts`. Reads `@deployz/contracts` from its dist: run
 * `pnpm --filter @deployz/contracts run build` after editing the catalog or
 * the classifier, or this test checks stale code.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface CfnResource {
  readonly Type: string;
  readonly DeletionPolicy?: string;
}

interface CfnTemplate {
  readonly Resources: Readonly<Record<string, CfnResource>>;
}

function readTemplate(name: string): CfnTemplate {
  return JSON.parse(readFileSync(join(here, '..', 'artifacts', name), 'utf8')) as CfnTemplate;
}

const TEMPLATES: ReadonlyArray<{
  readonly file: string;
  readonly profile: InfrastructureProfile;
}> = [
  { file: 'application-template-v1.json', profile: { postgres: true, redis: false } },
  { file: 'application-template-redis-v1.json', profile: { postgres: true, redis: true } },
  { file: 'application-template-stateless-v1.json', profile: { postgres: false, redis: false } },
  { file: 'application-template-stateless-redis-v1.json', profile: { postgres: false, redis: true } },
];

function templateLifecycle(resource: CfnResource): 'retain' | 'delete' {
  return resource.DeletionPolicy === 'Retain' ? 'retain' : 'delete';
}

describe('lifecycle parity between classifyResource and the committed templates', () => {
  for (const { file } of TEMPLATES) {
    it(`${file}: every resource's classifyResource lifecycle agrees with its DeletionPolicy`, () => {
      const template = readTemplate(file);
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        const classification = classifyResource(resource.Type, logicalId);
        expect(classification.lifecycle, `${logicalId} (${resource.Type})`).not.toBe('conditional');
        expect(classification.lifecycle, `${logicalId} (${resource.Type})`).toBe(
          templateLifecycle(resource),
        );
      }
    });
  }

  it('the catalog lifecycle for each primary resource type agrees with the templates wherever it appears', () => {
    for (const component of INFRASTRUCTURE_COMPONENTS) {
      for (const { file } of TEMPLATES) {
        const template = readTemplate(file);
        for (const resource of Object.values(template.Resources)) {
          if (resource.Type !== component.primaryResourceType) continue;
          expect(templateLifecycle(resource), `${file}: ${component.primaryResourceType}`).toBe(
            component.lifecycle,
          );
        }
      }
    }
  });

  for (const { file, profile } of TEMPLATES) {
    it(`${file}: has exactly the catalog components its profile predicts`, () => {
      const template = readTemplate(file);
      const actualTypes = new Set(Object.values(template.Resources).map((r) => r.Type));
      const primaryTypes = new Set(INFRASTRUCTURE_COMPONENTS.map((c) => c.primaryResourceType));
      const presentComponentTypes = [...actualTypes].filter((type) => primaryTypes.has(type));

      const expectedTypes = requiredInfrastructureComponents(profile).map((c) => c.primaryResourceType);

      expect(new Set(presentComponentTypes)).toEqual(new Set(expectedTypes));
    });
  }
});

/**
 * Guards the customer-facing AWS resource catalog (`aws-resources.ts`)
 * against the same four templates: each row must be present exactly where
 * its `requiredBy` predicts, its `lifecycle` must agree with the template's
 * DeletionPolicy wherever it matches, and `classifyResource`'s componentKind
 * for every matching resource must agree with the row's `componentKind`
 * (except the security-groups row, which spans several components).
 */
describe('AWS_RESOURCES catalog parity with the committed templates', () => {
  for (const { file, profile } of TEMPLATES) {
    it(`${file}: each catalog row is present exactly when required, with matching lifecycle and componentKind`, () => {
      const template = readTemplate(file);
      const entries = Object.entries(template.Resources);
      for (const resource of AWS_RESOURCES) {
        const matches = entries.filter(([logicalId, r]) => awsResourceMatches(resource, r.Type, logicalId));
        if (resource.requiredBy(profile)) {
          expect(matches.length, `${file}: ${resource.id} should be present`).toBeGreaterThan(0);
        } else {
          expect(matches.length, `${file}: ${resource.id} should be absent`).toBe(0);
        }
        for (const [logicalId, r] of matches) {
          expect(templateLifecycle(r), `${file}: ${resource.id} (${logicalId})`).toBe(resource.lifecycle);
          // The one 'security_groups' row spans every security group, which
          // classifyResource binds per component by logical id.
          if (resource.id === 'security_groups') continue;
          expect(
            classifyResource(r.Type, logicalId).componentKind,
            `${file}: ${resource.id} (${logicalId})`,
          ).toBe(resource.componentKind);
        }
      }
    });
  }

  it('the two SecretsManager::Secret rows together account for every Secret in each template', () => {
    const secretRows = AWS_RESOURCES.filter((resource) => resource.resourceType === 'AWS::SecretsManager::Secret');
    expect(secretRows.map((resource) => resource.id).sort()).toEqual(['app_config_secret', 'database_secrets']);

    for (const { file } of TEMPLATES) {
      const template = readTemplate(file);
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== 'AWS::SecretsManager::Secret') continue;
        const matchingRows = secretRows.filter((row) => awsResourceMatches(row, resource.Type, logicalId));
        expect(matchingRows.length, `${file}: ${logicalId} should match exactly one Secret row`).toBe(1);
      }
    }
  });
});
