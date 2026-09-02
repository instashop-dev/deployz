import { describe, expect, it } from 'vitest';

import {
  ECR_PULL_ACTIONS,
  buildPullStatement,
  buildRepoPolicyDocument,
  grantPull,
  installationGrantSid,
  revokePull,
  type EcrClient,
  type EcrGrantStatement,
} from './ecr-grants.js';

// ── ECR Grants Tests (moved from @deployz/cdk with the module in Phase 1.1) ─

function createMockEcrClient(
  statements: EcrGrantStatement[] = [],
): EcrClient & {
  _getLog: () => string[];
} {
  const log: string[] = [];
  let current: Record<string, unknown> | null =
    statements.length > 0
      ? (buildRepoPolicyDocument(statements) as unknown as Record<string, unknown>)
      : null;

  return {
    _getLog: () => log,
    async getRepositoryPolicy(): Promise<{ policyText: Record<string, unknown> } | null> {
      log.push('getRepositoryPolicy');
      return current ? { policyText: current } : null;
    },
    async setRepositoryPolicy(
      _repoName: string,
      policyText: Record<string, unknown>,
    ): Promise<void> {
      log.push(`setRepositoryPolicy:${JSON.stringify(policyText)}`);
      current = policyText;
    },
    async deleteRepositoryPolicy(_repoName: string): Promise<void> {
      log.push('deleteRepositoryPolicy');
      current = null;
    },
  };
}

describe('ecr-grants', () => {
  describe('installationGrantSid', () => {
    it('produces a deterministic Sid for an installation', () => {
      expect(installationGrantSid('inst-abc')).toBe('deployz-pull-inst-abc');
    });
  });

  describe('buildPullStatement', () => {
    it('builds a statement with the correct Sid, Effect, and Principal', () => {
      const stmt = buildPullStatement('inst-1', '123456789012');
      expect(stmt.Sid).toBe('deployz-pull-inst-1');
      expect(stmt.Effect).toBe('Allow');
      expect(stmt.Principal.AWS).toBe('arn:aws:iam::123456789012:root');
    });

    it('includes all required ECR pull actions', () => {
      const stmt = buildPullStatement('inst-1', '123456789012');
      expect(stmt.Action.sort()).toEqual([...ECR_PULL_ACTIONS].sort());
    });
  });

  describe('buildRepoPolicyDocument', () => {
    it('returns null for an empty statement list', () => {
      expect(buildRepoPolicyDocument([])).toBeNull();
    });

    it('builds a valid policy document with one statement', () => {
      const stmt = buildPullStatement('inst-1', '123456789012');
      const doc = buildRepoPolicyDocument([stmt]);
      expect(doc).not.toBeNull();
      expect(doc!.Version).toBe('2012-10-17');
      expect(doc!.Statement).toHaveLength(1);
      expect(doc!.Statement[0].Sid).toBe('deployz-pull-inst-1');
    });

    it('builds a policy document with multiple statements', () => {
      const s1 = buildPullStatement('inst-1', '111111111111');
      const s2 = buildPullStatement('inst-2', '222222222222');
      const doc = buildRepoPolicyDocument([s1, s2]);
      expect(doc!.Statement).toHaveLength(2);
    });
  });

  describe('grantPull', () => {
    it('adds a new pull grant when no policy exists', async () => {
      const client = createMockEcrClient();
      const result = await grantPull(client, 'deployz-images', 'inst-1', '123456789012');

      expect(result.added).toBe(true);
      expect(result.statementCount).toBe(1);
      expect(client._getLog()).toEqual([
        'getRepositoryPolicy',
        expect.stringContaining('deployz-pull-inst-1'),
      ]);
    });

    it('adds a second grant alongside an existing one', async () => {
      const existing = buildPullStatement('inst-1', '111111111111');
      const client = createMockEcrClient([existing]);
      const result = await grantPull(client, 'deployz-images', 'inst-2', '222222222222');

      expect(result.added).toBe(true);
      expect(result.statementCount).toBe(2);
    });

    it('replaces an existing grant with the same installation id (idempotent)', async () => {
      const existing = buildPullStatement('inst-1', '111111111111');
      const client = createMockEcrClient([existing]);
      const result = await grantPull(client, 'deployz-images', 'inst-1', '999999999999');

      expect(result.added).toBe(false);
      expect(result.statementCount).toBe(1);
      // The updated statement should have the new account ID
      const log = client._getLog();
      const setLog = log.find((l) => l.startsWith('setRepositoryPolicy:'))!;
      expect(setLog).toContain('999999999999');
    });
  });

  describe('revokePull', () => {
    it('removes a grant and deletes the policy when it was the only statement', async () => {
      const existing = buildPullStatement('inst-1', '123456789012');
      const client = createMockEcrClient([existing]);
      const result = await revokePull(client, 'deployz-images', 'inst-1');

      expect(result.removed).toBe(true);
      expect(result.statementCount).toBe(0);
      expect(result.policyDeleted).toBe(true);
      expect(client._getLog()).toContain('deleteRepositoryPolicy');
    });

    it('removes a grant but retains the policy when other statements exist', async () => {
      const s1 = buildPullStatement('inst-1', '111111111111');
      const s2 = buildPullStatement('inst-2', '222222222222');
      const client = createMockEcrClient([s1, s2]);
      const result = await revokePull(client, 'deployz-images', 'inst-1');

      expect(result.removed).toBe(true);
      expect(result.statementCount).toBe(1);
      expect(result.policyDeleted).toBe(false);
      // Should NOT have called deleteRepositoryPolicy
      expect(client._getLog()).not.toContain('deleteRepositoryPolicy');
    });

    it('is idempotent — revoking a nonexistent grant returns removed: false', async () => {
      const client = createMockEcrClient();
      const result = await revokePull(client, 'deployz-images', 'nonexistent');

      expect(result.removed).toBe(false);
      expect(result.statementCount).toBe(0);
      expect(result.policyDeleted).toBe(false);
    });

    it('is idempotent — revoking from a null policy returns removed: false', async () => {
      const client = createMockEcrClient();
      const result = await revokePull(client, 'deployz-images', 'inst-1');

      expect(result.removed).toBe(false);
      expect(result.statementCount).toBe(0);
      expect(result.policyDeleted).toBe(false);
    });
  });
});