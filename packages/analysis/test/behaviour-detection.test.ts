import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { detectBindAddress, detectHealthEndpoint, detectStartupMigrationEvidence } from '../src/detectors.js';

const NODE_DOCKERFILE = 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n';

const healthPath = (tree: FileTree): string | null => {
  const finding = detectHealthEndpoint(tree);
  return finding.detected ? (finding.path ?? null) : null;
};
const isLoopback = (tree: FileTree): boolean => detectBindAddress(tree).detected;
const migrationPatterns = (tree: FileTree): string[] => detectStartupMigrationEvidence(tree).map((entry) => entry.pattern);

const EXPORTED_ROUTES = {
  'routes/index.js':
    'const { Router } = require("express");\nconst health = require("./health.routes");\nconst apiRouter = Router();\napiRouter.use("/health", health);\nmodule.exports = {\n  api: apiRouter,\n};\n',
  'routes/health.routes.js': 'const router = require("express").Router();\nrouter.get("/", (_, res) => res.send("OK"));\nmodule.exports = router;\n',
};

describe('REM-101 health route', () => {
  it('follows a router mounted through an exported object and takes the shortest prefix', () => {
    expect(
      healthPath({
        Dockerfile: NODE_DOCKERFILE,
        'server.js': 'const routes = require("./routes");\nconst app = require("express")();\napp.use("/api/v2", routes.api);\napp.use("/api", routes.api);\napp.listen(3000);\n',
        ...EXPORTED_ROUTES,
      }),
    ).toBe('/api/health');
  });

  it('ignores an exported router that no app mounts', () => {
    expect(healthPath({ Dockerfile: NODE_DOCKERFILE, 'server.js': 'const app = require("express")();\napp.listen(3000);\n', ...EXPORTED_ROUTES })).toBeNull();
  });

  it('ignores a health router under a feature prefix', () => {
    expect(
      healthPath({
        Dockerfile: NODE_DOCKERFILE,
        'server.js': 'const app = require("express")();\nconst routes = require("./routes");\napp.use("/billing", routes.billing);\napp.listen(3000);\n',
        'routes/index.js':
          'const { Router } = require("express");\nconst h = require("./h");\nconst billingRouter = Router();\nbillingRouter.use("/health", h);\nmodule.exports = { billing: billingRouter };\n',
        'routes/h.js': 'const r = require("express").Router();\nr.get("/", (_, res) => res.send("OK"));\nmodule.exports = r;\n',
      }),
    ).toBeNull();
  });

  const goTree = (source: string): FileTree => ({
    Dockerfile: 'FROM alpine\nEXPOSE 7080\nENTRYPOINT ["/opt/app", "server"]\n',
    'go.mod': 'module example.com/app\ngo 1.22\n',
    'cli/server.go': source,
  });

  it('reads a Go path comparison on a health path', () => {
    expect(
      healthPath(goTree('package cli\nfunc redirect(h http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tif r.URL.Path == "/healthz" {\n\t\t\th.ServeHTTP(w, r)\n\t\t}\n\t})\n}\n')),
    ).toBe('/healthz');
  });

  it('ignores a Go path comparison on a feature path', () => {
    expect(healthPath(goTree('package cli\nfunc f(r *http.Request) bool {\n\treturn r.URL.Path == "/api/v2/users"\n}\n'))).toBeNull();
  });

  it('uses the HEALTHCHECK of a sibling target when every HEALTHCHECK probes one path', () => {
    expect(
      healthPath({
        Dockerfile:
          'FROM node:22 AS web\nEXPOSE 3000\nHEALTHCHECK CMD wget -q --spider "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1\nCMD ["node","web.js"]\nFROM node:22 AS cli\nENTRYPOINT ["node","cli.js"]\n',
      }),
    ).toBe('/api/health');
  });

  it('keeps the production stage HEALTHCHECK when sibling targets disagree', () => {
    expect(
      healthPath({
        Dockerfile:
          'FROM node:22 AS web\nEXPOSE 3000\nHEALTHCHECK CMD wget -q --spider http://127.0.0.1:3000/api/health\nCMD ["node","web.js"]\nFROM node:22 AS worker\nHEALTHCHECK CMD wget -q --spider http://127.0.0.1:3000/ready\nENTRYPOINT ["node","worker.js"]\n',
      }),
    ).toBe('/ready');
  });

  const nestTree = (controller: string): FileTree => ({
    Dockerfile: NODE_DOCKERFILE,
    'package.json': '{"name":"x","dependencies":{"@nestjs/core":"^10"}}',
    'src/main.ts': "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api');\nawait app.listen(3000);\n",
    'src/server.controller.ts': controller,
  });

  it('reads a NestJS controller whose sub-path ends in a health word, under the global prefix', () => {
    expect(
      healthPath(
        nestTree("import { Controller, Get } from '@nestjs/common';\n@Controller('server')\nexport class ServerController {\n  @Get('ping')\n  ping() {}\n  @Get('storage')\n  storage() {}\n}\n"),
      ),
    ).toBe('/api/server/ping');
  });

  it('joins a NestJS sub-path with a leading slash to its controller', () => {
    expect(
      healthPath(nestTree("import { Controller, Get } from '@nestjs/common';\n@Controller('health')\nexport class HealthController {\n  @Get('/status')\n  status() {}\n}\n")),
    ).toBe('/api/health/status');
  });

  it('ignores a NestJS controller sub-path that is not a health word', () => {
    expect(
      healthPath(nestTree("import { Controller, Get } from '@nestjs/common';\n@Controller('server')\nexport class ServerController {\n  @Get('storage')\n  storage() {}\n}\n")),
    ).toBeNull();
  });
});

describe('REM-104 loopback binding', () => {
  it('ignores an Electron desktop entry point', () => {
    expect(
      isLoopback({
        Dockerfile: 'FROM alpine\nEXPOSE 3456\nENTRYPOINT ["/app/server"]\n',
        'desktop/main.js': "const { app } = require('electron');\nserver.listen(port, '127.0.0.1');\n",
        'tools/shell.js': "import { app } from 'electron';\nserver.listen(port, '127.0.0.1');\n",
      }),
    ).toBe(false);
  });

  it('still flags a production listen on 127.0.0.1', () => {
    expect(isLoopback({ Dockerfile: NODE_DOCKERFILE, 'server.js': "require('http').createServer(h).listen(3000, '127.0.0.1');\n" })).toBe(true);
  });

  it('lets an entrypoint script bind of 0.0.0.0 override a dev entry point on loopback', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM python:3.11\nEXPOSE 8000\nENTRYPOINT ["/opt/app/docker-entrypoint.sh"]\n',
      'docker-entrypoint.sh': "#!/bin/bash\nexec gunicorn 'app:create_app()' --bind '0.0.0.0:8000'\n",
      'serve.py': 'from app import create_app\napp = create_app()\napp.run(debug=True, host="127.0.0.1", port=4000)\n',
    };
    expect(isLoopback(tree)).toBe(false);
    expect(detectBindAddress(tree).value).toBe('all-interfaces');
  });

  it('lets ENV HOST=0.0.0.0 override a loopback literal in source', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nENV HOST=0.0.0.0\nEXPOSE 3000\nCMD ["node","server.js"]\n',
      'server.js': "require('http').createServer(h).listen(3000, '127.0.0.1');\n",
    };
    expect(isLoopback(tree)).toBe(false);
    expect(detectBindAddress(tree).value).toBe('all-interfaces');
  });

  it('keeps a loopback server when only another source file listens on 0.0.0.0', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nEXPOSE 3000\nCMD ["node","server.js"]\n',
      'server.js': "require('http').createServer(h).listen(3000, '127.0.0.1');\n",
      'metrics.js': "require('http').createServer(m).listen(9100, '0.0.0.0');\n",
    };
    expect(isLoopback(tree)).toBe(true);
  });

  it('counts a Python app.run(host=loopback) in the module the image runs', () => {
    expect(
      isLoopback({
        Dockerfile: 'FROM python:3.11\nEXPOSE 8000\nCMD ["python", "serve.py"]\n',
        'serve.py': 'from app import app\napp.run(host="127.0.0.1", port=8000)\n',
      }),
    ).toBe(true);
  });

  it('ignores a Python app.run(host=loopback) in a module the image does not run', () => {
    expect(
      isLoopback({
        Dockerfile: 'FROM python:3.11\nEXPOSE 8000\nCMD ["gunicorn", "app:app"]\n',
        'serve.py': 'from app import app\napp.run(host="127.0.0.1", port=8000)\n',
      }),
    ).toBe(false);
  });

  it('still flags ENV HOST=127.0.0.1', () => {
    expect(isLoopback({ Dockerfile: 'FROM node:22\nENV HOST=127.0.0.1\nEXPOSE 3000\nCMD ["node","server.js"]\n', 'server.js': 'require("http").createServer(h).listen(3000);\n' })).toBe(true);
  });
});

describe('REM-102 startup migrations', () => {
  it('reads a binary migrate subcommand chained before the server', () => {
    expect(migrationPatterns({ Dockerfile: 'FROM alpine\nEXPOSE 3000\nCMD ./fider migrate && ./fider\n' })).toEqual(['binary migrate subcommand']);
  });

  it('ignores a binary migrate subcommand in a build stage', () => {
    expect(migrationPatterns({ Dockerfile: 'FROM golang AS b\nRUN ./fider migrate\nFROM alpine\nEXPOSE 3000\nCMD ["./fider"]\n' })).toEqual([]);
  });

  it('reads a Procfile web line and never a release line', () => {
    expect(migrationPatterns({ Procfile: 'web: ./bin/fider migrate && ./bin/fider\n' })).toEqual(['binary migrate subcommand']);
    expect(migrationPatterns({ Procfile: 'release: python manage.py migrate\nweb: gunicorn app:app\n' })).toEqual([]);
  });

  it('reads a migrate deploy wrapper reached from the ENTRYPOINT script chain', () => {
    expect(
      migrationPatterns({
        Dockerfile: 'FROM node:22\nCOPY scripts scripts\nEXPOSE 3000\nENTRYPOINT ["scripts/start.sh"]\n',
        'scripts/start.sh': '#!/bin/bash\nnode scripts/db-migrate.mjs\nnode ./dist/index.js\n',
        'scripts/db-migrate.mjs': 'await $`node ./scripts/run-prisma-command.mjs migrate deploy --schema ./schema.prisma`;\n',
      }),
    ).toContain('migrate deploy');
  });

  const s6Run = {
    'docker/rootfs/etc/s6-overlay/s6-rc.d/init-migrations/run': '#!/command/with-contenv bash\nexec python3 manage.py migrate --skip-checks --no-input\n',
  };

  it('reads s6 service scripts when the ENTRYPOINT is /init', () => {
    expect(migrationPatterns({ Dockerfile: 'FROM ghcr.io/linuxserver/baseimage\nEXPOSE 8000\nENTRYPOINT ["/init"]\n', ...s6Run })).toEqual(['python manage.py migrate']);
  });

  it('ignores s6 service scripts when the image does not start /init', () => {
    expect(migrationPatterns({ Dockerfile: 'FROM python:3.11\nEXPOSE 8000\nCMD ["python","app.py"]\n', ...s6Run })).toEqual([]);
  });

  it('counts a migration runner call and not its declaration', () => {
    expect(migrationPatterns({ Dockerfile: NODE_DOCKERFILE, 'src/server/index.ts': 'async function main() {\n  await runMigrations();\n  listen();\n}\n' })).toEqual(['migration runner call']);
    expect(
      migrationPatterns({
        Dockerfile: NODE_DOCKERFILE,
        'src/repositories/database.repository.ts': 'export class DatabaseRepository {\n  async runMigrations(): Promise<void> {\n    await this.db.migrate();\n  }\n}\n',
      }),
    ).toEqual([]);
  });

  it('ignores a migration runner call in browser, CLI and test-setup files', () => {
    const call = 'export function f() { return runMigrations(); }\n';
    expect(
      migrationPatterns({
        Dockerfile: NODE_DOCKERFILE,
        'server/command-line/storage.ts': call,
        'src/client/boot.ts': call,
        'src/test-setup.ts': call,
        'packages/ui/src/persistence.ts': `${call}localStorage.setItem('v', '2');\n`,
      }),
    ).toEqual([]);
  });

  const goTree = (webCmd: string, extra: FileTree): FileTree => ({
    Dockerfile: 'FROM scratch\nEXPOSE 3456\nENTRYPOINT ["/app/vikunja"]\n',
    'pkg/cmd/web.go': webCmd,
    ...extra,
  });

  it('follows a Go start command into the package function that migrates', () => {
    expect(
      migrationPatterns(
        goTree('package cmd\nimport "example.com/pkg/initialize"\nvar webCmd = &cobra.Command{PreRun: func(*cobra.Command, []string) {\n\tinitialize.FullInit()\n}}\n', {
          'pkg/initialize/init.go': 'package initialize\nfunc FullInit() {\n\tmigration.Migrate(nil)\n}\n',
        }),
      ),
    ).toEqual(['go migrator call on the start path']);
  });

  it('reads a Go migrator call inside the server command file', () => {
    expect(
      migrationPatterns({
        Dockerfile: 'FROM alpine\nEXPOSE 3000\nENTRYPOINT ["/opt/coder", "server"]\n',
        'cli/server.go': 'package cli\nfunc run() {\n\tConnectToPostgres(ctx, migrations.Up)\n}\n',
      }),
    ).toEqual(['go migrator call on the start path']);
  });

  it('ignores a Go migrate subcommand file that the server command does not call', () => {
    expect(
      migrationPatterns(
        goTree('package cmd\nfunc run() { serve() }\n', {
          'pkg/cmd/migrate.go': 'package cmd\nvar migrateCmd = &cobra.Command{Run: func(*cobra.Command, []string) {\n\tmigration.Migrate(nil)\n}}\n',
        }),
      ),
    ).toEqual([]);
  });

  it('ignores a Go code generator that calls a migrator', () => {
    expect(
      migrationPatterns({
        Dockerfile: 'FROM alpine\nEXPOSE 3000\nENTRYPOINT ["/opt/coder", "server"]\n',
        'coderd/database/gen/dump/main.go': 'package main\nfunc main() {\n\tmigrations.Up(db)\n}\n',
      }),
    ).toEqual([]);
  });

  it('never takes CREATE TABLE IF NOT EXISTS as a schema upgrade', () => {
    expect(
      migrationPatterns({
        Dockerfile: NODE_DOCKERFILE,
        'package.json': '{"name":"x","dependencies":{"pg":"^8"}}',
        'src/db.js': 'await pool.query("CREATE TABLE IF NOT EXISTS users (id serial primary key)");\n',
      }),
    ).toEqual([]);
  });
});
