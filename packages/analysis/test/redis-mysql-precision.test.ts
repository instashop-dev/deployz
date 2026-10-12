import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { assessRedis } from '../src/redis.js';
import { assessMysql, checkMysql } from '../src/rejection.js';

// Phase 4A — Redis and MySQL precision. A managed Redis costs the customer
// money every month, so only strong evidence provisions one; a wrong or missed
// database engine breaks the app.

const bullmq = JSON.stringify({ dependencies: { bullmq: '^5.0.0', ioredis: '^5.0.0' } });

describe('Redis — evidence the integration is optional', () => {
  it('a required BullMQ queue keeps Redis', () => {
    const result = assessRedis({
      'package.json': bullmq,
      '.env.example': 'REDIS_URL=redis://localhost:6379\n',
    });
    expect(result.required).toBe(true);
  });

  it('a queue whose provider defaults to a non-Redis backend does not provision Redis', () => {
    const result = assessRedis({
      'package.json': bullmq,
      '.env.example': [
        '# Available options: local (default) | bullmq',
        'NEXT_PRIVATE_JOBS_PROVIDER="local"',
        'NEXT_PRIVATE_REDIS_URL="redis://localhost:6379"',
      ].join('\n'),
    });
    expect(result.required).toBe(false);
    expect(result.confidence).toBe('medium');
    expect(result.evidence).toContainEqual(expect.stringContaining('looks optional'));
  });

  it('an env sample that calls the connection optional does not provision Redis', () => {
    const result = assessRedis({
      'package.json': bullmq,
      '.env.example': '# OPTIONAL: Redis URL for the BullMQ jobs provider.\nREDIS_URL="redis://localhost:6379"\n',
    });
    expect(result.required).toBe(false);
  });

  it('an env sample that says the connection is required settles it', () => {
    const result = assessRedis({
      'package.json': bullmq,
      '.env.example': [
        'CACHE_PROVIDER=sqlite',
        '# Redis is required by the job queue, even when another cache provider is used.',
        'REDIS_URL=redis://localhost:6379',
      ].join('\n'),
    });
    expect(result.required).toBe(true);
  });

  it('a connection variable tested before use is an optional cache', () => {
    const result = assessRedis({
      'package.json': JSON.stringify({ dependencies: { redis: '^4.0.0' } }),
      'src/lib/redis.ts': [
        "import { createClient } from 'redis';",
        'const enabled = !!process.env.REDIS_URL;',
        'const client = createClient({ url: process.env.REDIS_URL });',
      ].join('\n'),
    });
    expect(result.required).toBe(false);
  });

  it('a Redis switch that is off by default keeps Redis out', () => {
    const result = assessRedis({
      'package.json': bullmq,
      '.env.example': 'REDIS_ENABLED=false\nREDIS_HOST=localhost\n',
    });
    expect(result.required).toBe(false);
  });

  it('a Redis switch that is on by default is not optional', () => {
    const result = assessRedis({
      'package.json': bullmq,
      '.env.example': 'REDIS_ENABLED=true\nREDIS_HOST=localhost\n',
    });
    expect(result.required).toBe(true);
  });

  it('a tracing switch is not a Redis switch', () => {
    const result = assessRedis({
      'Gemfile': "gem 'sidekiq'\n",
      'config/initializers/opentelemetry.rb': "c.use 'OpenTelemetry::Instrumentation::Redis' if ENV['OTEL_RUBY_INSTRUMENTATION_REDIS_ENABLED']\n",
    });
    expect(result.required).toBe(true);
  });

  it('a Laravel app that caches on files by default does not provision Redis', () => {
    const result = assessRedis({
      'composer.json': JSON.stringify({ require: { 'predis/predis': '^2.0' } }),
      '.env.example': 'CACHE_DRIVER=file\nQUEUE_CONNECTION=sync\nREDIS_HOST=127.0.0.1\n',
    });
    expect(result.required).toBe(false);
  });

  it('an image that bundles its own Redis server does not provision Redis', () => {
    const result = assessRedis({
      'Gemfile': "gem 'sidekiq'\n",
      'Dockerfile': 'FROM ruby:3.3\nRUN apt-get update && apt-get install -y redis-server\n',
    });
    expect(result.required).toBe(false);
  });

  it('an app that fills in its own connection when none is set does not provision Redis', () => {
    const result = assessRedis({
      'Gemfile': "gem 'sidekiq'\n",
      'config/dotenv.rb': "if ENV['REDIS_URL'].to_s.empty?\n  ENV['REDIS_URL'] = 'redis://default@0.0.0.0:6379/0'\nend\n",
    });
    expect(result.required).toBe(false);
  });

  it('Sidekiq with no optional evidence keeps Redis', () => {
    expect(assessRedis({ Gemfile: "gem 'sidekiq'\n" }).required).toBe(true);
  });

  it('Celery needs a Redis broker: the redis extra provisions Redis, a bare client does not', () => {
    expect(assessRedis({ 'pyproject.toml': 'dependencies = ["celery[redis]~=5.4"]\n' }).required).toBe(true);
    expect(assessRedis({ 'requirements.txt': 'celery==5.3.0\nredis==5.0.0\n' }).required).toBe(false);
  });

  it('Upstash REST credentials are not a Redis connection', () => {
    const result = assessRedis({
      'package.json': JSON.stringify({ dependencies: { '@upstash/redis': '^1.0.0' } }),
      '.env.example': 'UPSTASH_REDIS_REST_URL=https://example.upstash.io\nUPSTASH_REDIS_REST_TOKEN=token\n',
    });
    expect(result.required).toBe(false);
  });
});

describe('Redis — a client or connection alone is not a requirement', () => {
  it('a client library dependency alone does not provision Redis', () => {
    expect(assessRedis({ 'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }) }).required).toBe(false);
  });

  it('a README mention does not provision Redis', () => {
    expect(assessRedis({ 'README.md': 'Optionally uses Redis for caching.\n' }).required).toBe(false);
  });

  it('a Compose Redis service alone does not provision Redis', () => {
    const tree: FileTree = { 'docker-compose.yml': 'services:\n  web:\n    build: .\n  cache:\n    image: redis:7\n' };
    expect(assessRedis(tree).required).toBe(false);
  });

  it('a Redis service only in a dev Compose file does not provision Redis', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'docker/development/compose.yml': 'services:\n  redis:\n    image: redis:7\n',
    };
    expect(assessRedis(tree).required).toBe(false);
  });

  it('a Redis client built from a user-supplied URL (no connection variable) does not provision Redis', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { redis: '^4.0.0' } }),
      'server/monitor-types/redis.js': "const { createClient } = require('redis');\nconst client = createClient({ url: monitor.databaseConnectionString });\n",
    };
    expect(assessRedis(tree).required).toBe(false);
  });

  it('a client library with a configured connection variable provisions Redis', () => {
    const tree: FileTree = {
      'go.mod': 'module example.com/app\n\nrequire github.com/redis/go-redis/v9 v9.5.1\n',
      '.env.example': 'REDIS_URL=redis://localhost:6379\n',
    };
    expect(assessRedis(tree).required).toBe(true);
  });

  it('a Redis client built at boot from a configured connection provisions Redis', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'src/redis.ts': "import Redis from 'ioredis';\nexport const redis = new Redis(process.env.REDIS_URL);\n",
    };
    expect(assessRedis(tree).required).toBe(true);
  });

  it('a client built only when the URL is configured is optional', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { redis: '^4.0.0' } }),
      'src/cache.ts': [
        "import { createClient } from 'redis';",
        'export class Cache {',
        '  constructor(redisUrl?: string) {',
        '    if (redisUrl) {',
        '      this.client = createClient({ url: redisUrl });',
        '    }',
        '  }',
        '}',
        'export const cache = new Cache(config.redisUrl);',
      ].join('\n'),
    };
    expect(assessRedis(tree).required).toBe(false);
  });
});

const LARAVEL_COMPOSER = JSON.stringify({ require: { 'laravel/framework': '^10.0' } });
const laravelDefaultingTo = (connection: string): string =>
  `<?php\nreturn [\n    'default' => env('DB_CONNECTION', '${connection}'),\n    'connections' => [\n        'mysql' => ['driver' => 'mysql'],\n    ],\n];\n`;

describe('MySQL — detection across languages', () => {
  it('Laravel whose default connection is MySQL resolves MySQL', () => {
    const tree: FileTree = {
      'composer.json': LARAVEL_COMPOSER,
      'config/database.php': laravelDefaultingTo('mysql'),
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('Laravel that also lists a pgsql connection keeps PostgreSQL the engine', () => {
    const tree: FileTree = {
      'composer.json': LARAVEL_COMPOSER,
      'config/database.php':
        "<?php\nreturn [\n    'default' => env('DB_CONNECTION', 'mysql'),\n    'connections' => [\n        'mysql' => ['driver' => 'mysql'],\n        'pgsql' => ['driver' => 'pgsql'],\n    ],\n];\n",
    };
    const analysis = analyseRepo(tree);
    expect((analysis.metadata.postgres as { required: boolean }).required).toBe(true);
    expect((analysis.metadata.mysql as { required: boolean }).required).toBe(false);
  });

  it('a Laravel default of sqlite is not MySQL', () => {
    const tree: FileTree = {
      'composer.json': LARAVEL_COMPOSER,
      'config/database.php': laravelDefaultingTo('sqlite'),
    };
    expect(assessMysql(tree).required).toBe(false);
  });

  it('a Dockerfile that installs pdo_mysql resolves MySQL', () => {
    const tree: FileTree = {
      'composer.json': JSON.stringify({ require: { php: '^8.2' } }),
      Dockerfile: 'FROM php:8.2-apache\nRUN docker-php-ext-install pdo_mysql mbstring\n',
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('a runtime PyMySQL dependency with a SQLAlchemy mysql+pymysql URL resolves MySQL', () => {
    const tree: FileTree = {
      'requirements.txt': 'flask==3.0.0\npymysql==1.1.1\n',
      'app/config.py': "DATABASE_URL = os.getenv('DATABASE_URL', 'mysql+pymysql://app:app@db/app')\n",
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('a PostgreSQL driver declared only in the Python dev group does not hide MySQL', () => {
    const tree: FileTree = {
      'pyproject.toml': [
        '[project]',
        'dependencies = [',
        '  "PyMySQL[rsa]==1.1.1",',
        ']',
        '',
        '[dependency-groups]',
        'dev = [',
        '  "psycopg2-binary==2.9.6",',
        ']',
      ].join('\n'),
      'app/config.py': "URL = 'mysql+pymysql://app:app@db/app'\n",
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('a PostgreSQL driver in a runtime Python dependency group keeps PostgreSQL', () => {
    const tree: FileTree = {
      'pyproject.toml': [
        '[dependency-groups]',
        'prod = [',
        '  "psycopg2",',
        '  "PyMySQL",',
        ']',
      ].join('\n'),
      'app/config.py': "URL = 'mysql+pymysql://app:app@db/app'\n",
    };
    expect(assessMysql(tree).required).toBe(false);
  });

  it('a Django ENGINE of mysql with mysqlclient resolves MySQL', () => {
    const tree: FileTree = {
      'requirements.txt': 'Django==5.0\nmysqlclient==2.2.0\n',
      'site/settings.py': "DATABASES = {'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': 'site'}}\n",
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('mysql-connector-j with a Spring jdbc:mysql datasource resolves MySQL', () => {
    const tree: FileTree = {
      'pom.xml': '<dependencies><dependency><artifactId>mysql-connector-j</artifactId></dependency></dependencies>',
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://localhost:3306/app\n',
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('an H2 test database next to a MySQL datasource does not reject the app', () => {
    const tree: FileTree = {
      'pom.xml':
        '<dependencies><dependency><artifactId>mysql-connector-j</artifactId></dependency><dependency><groupId>com.h2database</groupId></dependency></dependencies>',
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://localhost:3306/app\n',
    };
    expect(analyseRepo(tree).rejections.some((r) => r.detected && r.dependency === 'h2')).toBe(false);
  });

  it('go-sql-driver/mysql with no PostgreSQL driver resolves MySQL', () => {
    const tree: FileTree = {
      'go.mod': 'module example.com/app\n\nrequire github.com/go-sql-driver/mysql v1.8.1\n',
      'main.go': 'package main\n\nconst dsn = "mysql://app:app@db/app"\n',
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('a Go MySQL driver next to pgx keeps PostgreSQL', () => {
    const tree: FileTree = {
      'go.mod': 'module example.com/app\n\nrequire (\n  github.com/go-sql-driver/mysql v1.8.1\n  github.com/jackc/pgx/v5 v5.5.0\n)\n',
      'main.go': 'package main\n\nconst dsn = "mysql://app:app@db/app"\n',
    };
    expect(assessMysql(tree).required).toBe(false);
  });

  it('Sequelize with a mysql dialect resolves MySQL', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { sequelize: '^6.0.0', mysql2: '^3.0.0' } }),
      'src/db.js': "module.exports = new Sequelize(process.env.DB_NAME, 'root', '', { dialect: 'mysql' });\n",
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('Knex with a mysql2 client resolves MySQL', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { knex: '^3.0.0', mysql2: '^3.0.0' } }),
      'src/knexfile.js': "module.exports = { client: 'mysql2', connection: process.env.DATABASE_URL };\n",
    };
    expect(assessMysql(tree).required).toBe(true);
  });

  it('a MariaDB Compose image next to a MySQL driver is still MySQL', () => {
    const tree: FileTree = {
      'requirements.txt': 'mysqlclient==2.2.0\n',
      'docker-compose.yml': 'services:\n  app:\n    build: .\n  db:\n    image: mariadb:10.11\n',
    };
    const mysql = assessMysql(tree);
    expect(mysql.required).toBe(true);
    expect(checkMysql(tree).detected).toBe(false);
  });

  it('a MySQL driver next to the MariaDB Java client is not rejected', () => {
    const tree: FileTree = {
      'pom.xml':
        '<dependencies><dependency><artifactId>mysql-connector-j</artifactId></dependency><dependency><artifactId>mariadb-java-client</artifactId></dependency></dependencies>',
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://localhost:3306/app\n',
    };
    expect(checkMysql(tree).detected).toBe(false);
  });

  it('a MariaDB-only Java client stays unsupported', () => {
    const tree: FileTree = {
      'pom.xml': '<dependencies><dependency><artifactId>mariadb-java-client</artifactId></dependency></dependencies>',
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mariadb://localhost:3306/app\n',
    };
    expect(checkMysql(tree).detected).toBe(true);
    expect(assessMysql(tree).required).toBe(false);
  });

  it('a Laravel default connection of mariadb stays unsupported', () => {
    const tree: FileTree = {
      'composer.json': LARAVEL_COMPOSER,
      'config/database.php': laravelDefaultingTo('mariadb'),
    };
    expect(checkMysql(tree).detected).toBe(true);
    expect(assessMysql(tree).required).toBe(false);
  });
});

describe('MySQL — an app with both engines keeps PostgreSQL', () => {
  it('pg and mysql2 drivers together resolve PostgreSQL', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { pg: '^8.0.0', mysql2: '^3.0.0' } }),
      '.env.example': 'DATABASE_URL=postgres://localhost:5432/app\nMYSQL_HOST=localhost\n',
    };
    const analysis = analyseRepo(tree);
    expect((analysis.metadata.postgres as { required: boolean }).required).toBe(true);
    expect((analysis.metadata.mysql as { required: boolean }).required).toBe(false);
  });
});
