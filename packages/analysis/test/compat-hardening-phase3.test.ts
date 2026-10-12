import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import {
  detectDockerfile,
  detectHealthEndpoint,
  detectPort,
  isDevToolCommand,
  listDockerfileCandidates,
  mainCommandRunsWorker,
} from '../src/detectors.js';

const healthPath = (tree: FileTree): string | undefined => {
  const finding = detectHealthEndpoint(tree);
  return finding.detected ? finding.path : undefined;
};

describe('health route: dedicated routes only', () => {
  it('rejects feature routes that merely end in status or health', () => {
    expect(
      detectHealthEndpoint({
        'server/api.go': 'e.GET("/api/v1/integrations/status", h)\ne.GET("/csv/status", h)\ne.GET("/api/v1/ai/health", h)\n',
      }).detected,
    ).toBe(false);
    expect(
      detectHealthEndpoint({ 'src/app.ts': "app.get('/upgrade_to_enterprise/status', h);\napp.get('/checks/status', h);\n" }).detected,
    ).toBe(false);
  });

  it('keeps the dedicated route when feature routes sit beside it', () => {
    const tree: FileTree = {
      'pkg/routes.go': 'e.GET("/csv/status", h)\ne.GET("/health", h)\n',
    };
    expect(healthPath(tree)).toBe('/health');
  });

  it('still detects a real status route under an API root and a bare one in a JS server', () => {
    expect(healthPath({ 'src/app.ts': "app.get('/status', (_req, res) => res.send('ok'));\n" })).toBe('/status');
    expect(healthPath({ 'server/api.go': 'e.GET("/api/status", h)\n' })).toBe('/api/status');
    expect(healthPath({ 'hc/urls.py': "urlpatterns = [path('api/v3/status/', views.status)]\n" })).toBeUndefined();
    expect(detectHealthEndpoint({ 'server/api.go': 'r.GET("/status", h)\n' }).detected).toBe(false);
  });

  it('reads a probe word grouped under health', () => {
    expect(healthPath({ 'src/app.ts': "app.get('/health/liveness', h);\n" })).toBe('/health/liveness');
    expect(healthPath({ 'server/api.go': 'e.GET("/api/health/status", h)\n' })).toBe('/api/health/status');
  });

  it('ignores a query-parameter lookup written like a route', () => {
    expect(
      detectHealthEndpoint({ 'courier/handler.go': 'if r.URL.Query().Has("status") { x := r.URL.Query().Get("status") }\n' }).detected,
    ).toBe(false);
  });

  it('does not take readyz or livez from source: they are orchestrator probes', () => {
    expect(
      detectHealthEndpoint({ 'pkg/server/health.go': 'router.HandleFunc("/readyz", h)\nrouter.HandleFunc("/livez", h)\n' }).detected,
    ).toBe(false);
  });

  it('ignores a call on a nested router object whose prefix the file does not show', () => {
    expect(detectHealthEndpoint({ 'api4/system.go': 'api.BaseRoutes.System.Handle("/ping", h)\n' }).detected).toBe(false);
  });

  it('ignores an included Django urlconf but keeps a project-level one', () => {
    expect(
      detectHealthEndpoint({ 'hc/api/urls.py': "app_name = 'api'\nurlpatterns = [path('health/', views.health)]\n" }).detected,
    ).toBe(false);
    expect(healthPath({ 'config/urls.py': "urlpatterns = [path('health/', views.health)]\n" })).toBe('/health');
  });
});

describe('health route: framework prefix and version', () => {
  const controller =
    "import { Controller, Get } from '@nestjs/common';\n@Controller('health')\nexport class HealthController {\n  @Get()\n  check() {}\n}\n";

  it('composes the NestJS global prefix with the URI version', () => {
    const tree: FileTree = {
      'apps/api/src/main.ts':
        "app.enableVersioning({\n  defaultVersion: '1',\n  type: VersioningType.URI\n});\napp.setGlobalPrefix('api', { exclude: ['sitemap.xml'] });\n",
      'apps/api/src/app/health/health.controller.ts': controller,
    };
    expect(healthPath(tree)).toBe('/api/v1/health');
  });

  it('adds no version to a version-neutral controller and none without versioning', () => {
    const main = "app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });\napp.setGlobalPrefix('api');\n";
    expect(
      healthPath({
        'src/main.ts': main,
        'src/health.controller.ts': controller.replace("@Controller('health')", "@Controller({ path: 'health', version: VERSION_NEUTRAL })"),
      }),
    ).toBe('/api/health');
    expect(healthPath({ 'src/main.ts': "app.setGlobalPrefix('api');\n", 'src/health.controller.ts': controller })).toBe('/api/health');
  });

  it('leaves the prefix off a controller the prefix excludes', () => {
    const tree: FileTree = {
      'src/main.ts': "app.setGlobalPrefix('api', { exclude: ['health'] });\n",
      'src/health.controller.ts': controller,
    };
    expect(healthPath(tree)).toBe('/health');
  });

  it('composes an Express mount chain and drops a mount whose router nothing mounts', () => {
    expect(
      healthPath({
        'src/routes/index.js': "apiRouter.use('/health', healthRouter);\napp.use('/api', apiRouter);\n",
      }),
    ).toBe('/api/health');
    expect(
      detectHealthEndpoint({
        'server/routes/routes.js': "const apiRouter = Router();\napiRouter.use('/health', health);\n",
        'server/server.js': 'app.use("/api", routes.api);\n',
      }).detected,
    ).toBe(false);
  });

  it('reads a Fastify route object', () => {
    const tree: FileTree = {
      'backend/routes/index.ts':
        "import { FastifyInstance } from 'fastify';\nserver.route({ method: 'GET', url: '/api/status', handler: h });\n",
    };
    expect(healthPath(tree)).toBe('/api/status');
  });

  it('uses the Spring actuator route when the dependency exists and nothing else is declared', () => {
    const tree: FileTree = {
      'build.gradle': "implementation 'org.springframework.boot:spring-boot-starter-actuator'\n",
      'src/main/java/App.java': 'class App {}\n',
    };
    expect(healthPath(tree)).toBe('/actuator/health');
  });
});

describe('health route: HEALTHCHECK of the selected Dockerfile', () => {
  it('reads a multi-line HEALTHCHECK and ranks it above a route registration', () => {
    const tree: FileTree = {
      Dockerfile:
        'FROM node:22\nCOPY . .\nHEALTHCHECK --interval=30s \\\n  --timeout=5s \\\n  CMD ["/usr/bin/curl", "--fail", "http://127.0.0.1:3000/api/health"]\nCMD ["node", "server.js"]\n',
      'src/app.ts': "app.get('/health', h);\n",
    };
    expect(healthPath(tree)).toBe('/api/health');
  });

  it('reads the root path of a URL without a path, and a scheme-less host and port', () => {
    expect(healthPath({ Dockerfile: 'FROM node:22\nCOPY . .\nHEALTHCHECK CMD wget --spider http://localhost:3000 || exit 1\n' })).toBe('/');
    expect(healthPath({ Dockerfile: 'FROM node:22\nCOPY . .\nHEALTHCHECK CMD wget -q localhost:8080/ping\n' })).toBe('/ping');
  });

  it('ignores a commented HEALTHCHECK and one that names no URL, and never assumes /health', () => {
    expect(detectHealthEndpoint({ Dockerfile: 'FROM node:22\nCOPY . .\n#HEALTHCHECK CMD curl http://localhost/up\n' }).detected).toBe(false);
    expect(detectHealthEndpoint({ Dockerfile: 'FROM node:22\nCOPY . .\nHEALTHCHECK CMD flagsmith healthcheck tcp\n' }).detected).toBe(false);
  });

  it('takes the HEALTHCHECK of the production stage, not of a builder or a trailing dev stage', () => {
    const tree: FileTree = {
      Dockerfile: [
        'FROM node:22 AS builder',
        'HEALTHCHECK CMD curl http://localhost:3000/builder-health',
        'FROM node:22 AS runner',
        'COPY . .',
        'HEALTHCHECK CMD curl http://localhost:3000/healthz',
        'CMD ["node", "server.js"]',
        'FROM runner AS app-dev',
        'HEALTHCHECK CMD curl http://localhost:3000/dev-health',
        'CMD ["npm", "run", "dev"]',
      ].join('\n'),
    };
    expect(healthPath(tree)).toBe('/healthz');
  });

  it('reads the single URL a script probes and refuses a script that checks several services', () => {
    const one: FileTree = {
      Dockerfile: 'FROM python:3\nCOPY . .\nHEALTHCHECK CMD ./fetchstatus.py\nCMD ["uwsgi"]\n',
      'docker/fetchstatus.py': 'url = f"http://localhost:8000{root}/api/v3/status/"\n',
    };
    expect(healthPath(one)).toBe('/api/v3/status/');
    const several: FileTree = {
      Dockerfile: 'FROM node:22\nCOPY . .\nHEALTHCHECK CMD /bin/sh /healthcheck.sh\nCMD ["node", "x.js"]\n',
      'healthcheck.sh': 'curl http://localhost:3000\ncurl http://localhost:3170/ping\n',
    };
    expect(detectHealthEndpoint(several).detected).toBe(false);
  });

  it('reads a package.json healthcheck script that probes a URL', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ scripts: { healthcheck: 'curl -f http://localhost:3000/api/ping' } }),
    };
    expect(healthPath(tree)).toBe('/api/ping');
  });
});

describe('health route: only the image the Dockerfile builds', () => {
  it('drops a route in another language than the image starts', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nCOPY . .\nCOPY standalone-entrypoint.sh .\nENTRYPOINT ["./standalone-entrypoint.sh"]\n',
      'standalone-entrypoint.sh': '#!/bin/sh\nexec node dist/main.mjs\n',
      'backend-go/internal/routes.go': 'r.GET("/health", h)\n',
    };
    expect(detectHealthEndpoint(tree).detected).toBe(false);
    expect(healthPath({ ...tree, 'backend/src/routes.ts': "server.route({ url: '/api/status' }); // fastify\n" })).toBe('/api/status');
  });

  it('asks when two apps of the repository both register a health route', () => {
    const tree: FileTree = {
      'frontend/package.json': '{}',
      'frontend/api/index.js': "app.get('/health', h);\n",
      'mcp/pyproject.toml': '',
      'mcp/server.py': '@server.custom_route("/health", methods=["GET"])\n',
    };
    expect(detectHealthEndpoint(tree).detected).toBe(false);
  });

  it('keeps the app the start command names', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node", "./apps/server/dist/index.js"]\n',
      'apps/server/package.json': '{}',
      'apps/server/src/health.controller.ts': "@Controller('health')\nclass C { @Get() get() {} }\n",
      'apps/web/package.json': '{}',
      'apps/web/src/pages/api/healthcheck.ts': 'export default function handler() {}\n',
    };
    expect(healthPath(tree)).toBe('/health');
  });

  it('does not trust a backend route behind an all-in-one front web server', () => {
    const tree: FileTree = {
      Dockerfile:
        'FROM alpine AS caddy\nFROM node:22 AS aio\nCOPY --from=caddy /usr/bin/caddy /usr/bin/caddy\nEXPOSE 3000\nEXPOSE 80\nCMD ["node", "aio.mjs"]\n',
      'backend/src/health.controller.ts': "@Controller('health')\nclass C { @Get() get() {} }\n",
    };
    expect(detectHealthEndpoint(tree).detected).toBe(false);
  });
});

describe('port: the production stage of the selected Dockerfile', () => {
  it('reads EXPOSE of the production stage, not of a builder or a trailing dev stage', () => {
    const tree: FileTree = {
      Dockerfile: [
        'FROM node:22 AS builder',
        'EXPOSE 9999',
        'FROM node:22 AS twenty',
        'COPY . .',
        'EXPOSE 3000',
        'CMD ["node", "dist/main"]',
        'FROM twenty AS twenty-app-dev',
        'EXPOSE 2020',
        'ENTRYPOINT ["/init"]',
      ].join('\n'),
    };
    expect(detectPort(tree)).toMatchObject({ detected: true, value: '3000' });
  });

  it('reads the ENV PORT the production stage inherits from its base stage', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22 AS base\nENV PORT=4100\nFROM base AS runner\nCOPY . .\nCMD ["node", "x.js"]\n',
    };
    expect(detectPort(tree)).toMatchObject({ detected: true, value: '4100' });
  });

  it('prefers the public port 80 of an all-in-one image over the backend ENV PORT', () => {
    const tree: FileTree = {
      Dockerfile:
        'FROM alpine AS caddy\nFROM node:22 AS aio\nCOPY --from=caddy /usr/bin/caddy /usr/bin/caddy\nENV PORT=8080\nEXPOSE 3170\nEXPOSE 80\nCMD ["node", "aio.mjs"]\n',
    };
    expect(detectPort(tree)).toMatchObject({ detected: true, value: '80' });
  });

  it('uses port 80 for a web-server base image that exposes nothing', () => {
    expect(detectPort({ Dockerfile: 'FROM php:8.3-apache\nCOPY . /var/www/html\n' })).toMatchObject({ detected: true, value: '80' });
  });
});

describe('Dockerfile selection', () => {
  const app = 'FROM node:22\nCOPY . .\nCMD ["node", "server.js"]\n';
  const base = 'FROM debian\nRUN apt-get update && apt-get install -y php\n';

  it('prefers a production-named Dockerfile', () => {
    expect(detectDockerfile({ 'docker/Dockerfile': app, 'docker/Dockerfile.production': app }).value).toBe('docker/Dockerfile.production');
    expect(
      detectDockerfile({ 'extras/docker/development/Dockerfile': app, 'extras/docker/production/Dockerfile': app }).value,
    ).toBe('extras/docker/production/Dockerfile');
  });

  it('ranks a base image, an engine sidecar, a hardware variant and a multi-process layout last', () => {
    expect(detectDockerfile({ 'extras/docker/base/Dockerfile': base, 'extras/docker/demo/Dockerfile': app }).value).toBe(
      'extras/docker/demo/Dockerfile',
    );
    expect(detectDockerfile({ 'docker/images/engine/Dockerfile': app, 'docker/images/n8n/Dockerfile': app }).value).toBe(
      'docker/images/n8n/Dockerfile',
    );
    expect(detectDockerfile({ 'dev/build-arm/Dockerfile': app, 'dev/build/Dockerfile': app }).value).toBe('dev/build/Dockerfile');
    expect(detectDockerfile({ 'docker/multi-process/Dockerfile': app, 'docker/single-process/Dockerfile': app }).value).toBe(
      'docker/single-process/Dockerfile',
    );
  });

  it('detects no Dockerfile when every candidate is a base image, a dev server or a test image', () => {
    expect(detectDockerfile({ 'dev/docker/Dockerfile': base }).detected).toBe(false);
    expect(
      detectDockerfile({
        'docker/php/Dockerfile':
          'FROM php:8.2\nCOPY . .\nENTRYPOINT ["/entrypoint.sh"]\nCMD ["php", "bin/console", "--env=dev", "server:run"]\n',
      }).detected,
    ).toBe(false);
    expect(detectDockerfile({ 'dev/docker/db-testing/Dockerfile': 'FROM php\nENTRYPOINT ["/bin/php"]\n' }).detected).toBe(false);
  });

  it('keeps a build directory under dev as the only candidate', () => {
    expect(detectDockerfile({ 'dev/build/Dockerfile': app }).value).toBe('dev/build/Dockerfile');
  });

  it('still lists every candidate, unusable ones last', () => {
    expect(listDockerfileCandidates({ 'dev/docker/Dockerfile': base, Dockerfile: app })).toEqual(['Dockerfile', 'dev/docker/Dockerfile']);
  });
});

describe('worker', () => {
  it('recognises dev and watch commands', () => {
    for (const command of ['nodemon src/worker.js', 'tsx watch index.ts', 'vite', 'ts-node-dev worker.ts', 'node --watch worker.js', 'jest', 'yarn dev']) {
      expect(isDevToolCommand(command)).toBe(true);
    }
    expect(isDevToolCommand('node dist/worker.js')).toBe(false);
  });

  it('knows when the start command already runs the worker', () => {
    const concurrently: FileTree = {
      Dockerfile:
        'FROM node:22\nCOPY . .\nCMD ["sh", "-c", "exec concurrently -k \\"cd apps/web && next start\\" \\"cd apps/worker && tsx worker.ts\\""]\n',
    };
    expect(mainCommandRunsWorker(concurrently)).toBe(true);
    const viaScript: FileTree = {
      Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["yarn", "start"]\n',
      'package.json': JSON.stringify({ scripts: { start: 'concurrently "next start" "node worker.js"' } }),
    };
    expect(mainCommandRunsWorker(viaScript)).toBe(true);
    expect(mainCommandRunsWorker({ Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node", "server.js"]\n' })).toBe(false);
  });
});
