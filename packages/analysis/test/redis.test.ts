import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/detectors.js';
import { assessRedis, resolveRedisEnvBindings } from '../src/redis.js';

// ==========================================================================
// §6-10 Redis assessment — inline FileTree fixtures, no real files on disk.
// ==========================================================================

describe('assessRedis', () => {
  describe('confidence: high (very-high or high-bucket signal alone)', () => {
    it('bullmq direct dependency → high confidence, queue purpose, required', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { bullmq: '^5.0.0' } }),
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.purposes).toEqual(['queue']);
      expect(result.required).toBe(true);
      expect(result.evidence.length).toBeGreaterThan(0);
    });

    it('docker-compose service using a redis image → high confidence', () => {
      const tree: FileTree = {
        'docker-compose.yml': 'services:\n  cache:\n    image: redis:7\n',
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.required).toBe(true);
    });

    it('source-code `new Redis(` client initialization → high confidence (very-high signal)', () => {
      const tree: FileTree = {
        'src/cache.ts': "import Redis from 'ioredis';\nconst client = new Redis(process.env.REDIS_URL);\n",
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.required).toBe(true);
    });

    it('ioredis + REDIS_URL in .env.example → high confidence, required, connectionEnvVars', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { ioredis: '^5.4.0' } }),
        '.env.example': 'REDIS_URL=redis://localhost:6379\n',
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.required).toBe(true);
      expect(result.connectionEnvVars).toEqual(['REDIS_URL']);
    });

    it('celery + CELERY_BROKER_URL=redis://... → high confidence, broker purpose', () => {
      const tree: FileTree = {
        'requirements.txt': 'celery==5.3.0\n',
        '.env.example': 'CELERY_BROKER_URL=redis://localhost:6379/0\n',
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.purposes).toEqual(['broker']);
      expect(result.required).toBe(true);
      expect(result.connectionEnvVars).toEqual(['CELERY_BROKER_URL']);
    });

    it('django-redis dependency → cache purpose', () => {
      const tree: FileTree = { 'requirements.txt': 'django-redis==5.4.0\n' };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.purposes).toEqual(['cache']);
      expect(result.required).toBe(true);
    });

    it("Gemfile gem 'sidekiq' → background_jobs purpose", () => {
      const tree: FileTree = { 'Gemfile': "gem 'sidekiq'\ngem 'rails'\n" };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.purposes).toEqual(['background_jobs']);
      expect(result.required).toBe(true);
    });

    it('rq dependency (Python) → background_jobs purpose', () => {
      const tree: FileTree = { 'requirements.txt': 'rq==1.16.0\n' };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.purposes).toEqual(['background_jobs']);
    });
  });

  describe('confidence: medium (single medium-bucket signal)', () => {
    it('ioredis alone → medium confidence, not required', () => {
      const tree: FileTree = { 'package.json': JSON.stringify({ dependencies: { ioredis: '^5.4.0' } }) };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('medium');
      expect(result.required).toBe(false);
    });

    it('go.mod go-redis dependency → medium confidence', () => {
      const tree: FileTree = {
        'go.mod': 'module example.com/app\n\nrequire github.com/redis/go-redis/v9 v9.5.1\n',
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('medium');
      expect(result.required).toBe(false);
    });

    it('redis gem in Gemfile alone → medium confidence', () => {
      const tree: FileTree = { 'Gemfile': "gem 'redis'\n" };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('medium');
      expect(result.required).toBe(false);
    });

    it('connect-redis direct dependency → medium confidence, sessions purpose', () => {
      const tree: FileTree = { 'package.json': JSON.stringify({ dependencies: { 'connect-redis': '^7.1.0' } }) };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('medium');
      expect(result.purposes).toEqual(['sessions']);
      expect(result.required).toBe(false);
    });

    it('predis/predis in composer.json require → medium confidence', () => {
      const tree: FileTree = {
        'composer.json': JSON.stringify({ require: { 'predis/predis': '^2.0' } }),
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('medium');
      expect(result.required).toBe(false);
    });

    it('two distinct medium-bucket signals escalate to high confidence', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { ioredis: '^5.4.0' } }),
        'go.mod': 'module example.com/app\n\nrequire github.com/redis/go-redis/v9 v9.5.1\n',
      };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('high');
      expect(result.required).toBe(true);
    });
  });

  describe('confidence: low (dev-only, docs-only, or nothing)', () => {
    it('ioredis only in devDependencies → low confidence, not required', () => {
      const tree: FileTree = { 'package.json': JSON.stringify({ devDependencies: { ioredis: '^5.4.0' } }) };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('low');
      expect(result.required).toBe(false);
    });

    it('README-only mention → low confidence', () => {
      const tree: FileTree = { 'README.md': 'This project uses Redis for caching.\n' };
      const result = assessRedis(tree);
      expect(result.confidence).toBe('low');
      expect(result.required).toBe(false);
    });

    it('empty repo → low confidence, unknown purpose, no evidence', () => {
      const result = assessRedis({});
      expect(result.confidence).toBe('low');
      expect(result.required).toBe(false);
      expect(result.purposes).toEqual(['unknown']);
      expect(result.evidence).toEqual([]);
      expect(result.connectionEnvVars).toEqual([]);
      expect(result.compatibility).toEqual({ supported: true });
    });
  });

  describe('compatibility: unsupported Redis features', () => {
    it('@redis/json dependency → unsupported (Redis Stack module), required forced false', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { bullmq: '^5.0.0', '@redis/json': '^1.0.0' } }),
      };
      const result = assessRedis(tree);
      // Confidence is still high (bullmq), but compatibility gates `required`.
      expect(result.confidence).toBe('high');
      expect(result.compatibility.supported).toBe(false);
      expect(result.compatibility.reason).toMatch(/Redis Stack/);
      expect(result.required).toBe(false);
    });

    it('python redisearch dependency → unsupported (Redis Stack module)', () => {
      const tree: FileTree = { 'requirements.txt': 'redisearch==2.1.0\n' };
      const result = assessRedis(tree);
      expect(result.compatibility.supported).toBe(false);
      expect(result.compatibility.reason).toMatch(/Redis Stack/);
    });

    it('docker-compose redis-stack image → unsupported', () => {
      const tree: FileTree = {
        'docker-compose.yml': 'services:\n  cache:\n    image: redis/redis-stack:latest\n',
      };
      const result = assessRedis(tree);
      expect(result.compatibility.supported).toBe(false);
      expect(result.compatibility.reason).toMatch(/Redis Stack/);
      expect(result.required).toBe(false);
    });

    it('new Redis.Cluster( usage → unsupported (cluster mode)', () => {
      const tree: FileTree = {
        'src/redis.ts': "import Redis from 'ioredis';\nconst client = new Redis.Cluster([{ host: 'a' }]);\n",
      };
      const result = assessRedis(tree);
      expect(result.compatibility.supported).toBe(false);
      expect(result.compatibility.reason).toMatch(/Cluster/);
      expect(result.required).toBe(false);
    });

    it('createCluster( in a source file → unsupported (cluster mode)', () => {
      const tree: FileTree = {
        'src/redis.ts': "import { createCluster } from 'redis';\nconst client = createCluster({ rootNodes: [] });\n",
      };
      const result = assessRedis(tree);
      expect(result.compatibility.supported).toBe(false);
      expect(result.compatibility.reason).toMatch(/Cluster/);
      expect(result.required).toBe(false);
    });

    it('createCluster( mentioned only in README prose → still supported (not scanned)', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { ioredis: '^5.4.0' } }),
        'README.md': 'We evaluated `createCluster()` but chose standalone mode for this service.\n',
      };
      const result = assessRedis(tree);
      expect(result.compatibility.supported).toBe(true);
      expect(result.compatibility.reason).toBeUndefined();
    });

    it('rediss:// in .env.example → unsupported (TLS)', () => {
      const tree: FileTree = { '.env.example': 'REDIS_URL=rediss://user:pass@host:6380\n' };
      const result = assessRedis(tree);
      expect(result.compatibility.supported).toBe(false);
      expect(result.compatibility.reason).toMatch(/TLS/);
      expect(result.required).toBe(false);
    });
  });
});

describe('resolveRedisEnvBindings', () => {
  it('returns the three defaults for an empty array', () => {
    expect(resolveRedisEnvBindings([])).toEqual([
      { name: 'REDIS_URL', kind: 'url' },
      { name: 'REDIS_HOST', kind: 'host' },
      { name: 'REDIS_PORT', kind: 'port' },
    ]);
  });

  it('returns the three defaults when input has only unrecognized names', () => {
    expect(resolveRedisEnvBindings(['FOO', 'BAR'])).toEqual([
      { name: 'REDIS_URL', kind: 'url' },
      { name: 'REDIS_HOST', kind: 'host' },
      { name: 'REDIS_PORT', kind: 'port' },
    ]);
  });

  it('drops REDIS_PASSWORD and preserves canonical order', () => {
    expect(
      resolveRedisEnvBindings(['CELERY_BROKER_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']),
    ).toEqual([
      { name: 'REDIS_HOST', kind: 'host' },
      { name: 'REDIS_PORT', kind: 'port' },
      { name: 'CELERY_BROKER_URL', kind: 'url' },
    ]);
  });

  it('dedupes repeated names', () => {
    expect(resolveRedisEnvBindings(['REDIS_URL', 'REDIS_URL'])).toEqual([{ name: 'REDIS_URL', kind: 'url' }]);
  });
});
