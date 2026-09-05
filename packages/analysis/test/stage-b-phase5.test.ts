import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { detectHealthEndpoint } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function healthPath(tree: FileTree): string | undefined {
  return detectHealthEndpoint(tree).path;
}

function analyseHealth(tree: FileTree) {
  const analysis = analyseRepo(tree);
  const finding = analysis.findings.find((f) => f.detector === 'health-endpoint');
  return {
    finding,
    metaMode: analysis.metadata['healthMode'],
    metaPath: analysis.metadata['healthPath'],
  };
}

const NODE_APP: FileTree = {
  'package.json': JSON.stringify({
    name: 'app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0' },
  }),
  'src/index.ts': "import express from 'express';\nconst app = express();\napp.get('/health', (_q, r) => r.json({}));\napp.listen(3000);\n",
  'Dockerfile': 'FROM node:20\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
};

// ==========================================================================
// Framework route declarations (COMP-005)
// ==========================================================================

describe('health-path detection across frameworks (COMP-005)', () => {
  it('Java/Spring: @GetMapping literal + actuator with context path', () => {
    const tree: FileTree = {
      'pom.xml': '  <artifactId>spring-boot-starter-web</artifactId>\n  <artifactId>spring-boot-starter-actuator</artifactId>\n',
      'src/main/java/com/app/HealthController.java': [
        'package com.app;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        'public class HealthController {',
        '  @GetMapping("/api/v1/health")',
        '  public String health() { return "ok"; }',
        '}',
        '',
      ].join('\n'),
      'src/main/resources/application.properties': 'server.servlet.context-path=/app\n',
    };
    expect(healthPath(tree)).toBe('/api/v1/health');
  });

  it('Java/Spring: actuator health is used when no exclusion is configured, prefixed by context-path', () => {
    const tree: FileTree = {
      'pom.xml': '<artifactId>spring-boot-starter-actuator</artifactId>\n',
      'src/main/java/com/app/App.java': 'public class App {}\n',
      'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /svc\n',
    };
    expect(healthPath(tree)).toBe('/svc/actuator/health');
  });

  it('Java/Spring: actuator is not used when exposure excludes health', () => {
    const tree: FileTree = {
      'pom.xml': '<artifactId>spring-boot-starter-actuator</artifactId>\n',
      'src/main/resources/application.properties': 'management.endpoints.web.exposure.include=info,metrics\n',
      'src/main/java/com/app/App.java': 'public class App {}\n',
    };
    expect(analyseHealth(tree).metaMode).toBe('vendor_required');
  });

  it('Rails: get "/up" in config/routes.rb', () => {
    const tree: FileTree = { 'config/routes.rb': "Rails.application.routes.draw do\n  get '/up', to: 'rails/health#show'\nend\n" };
    expect(healthPath(tree)).toBe('/up');
  });

  it('Python Django: urls.py path("health/", ...)', () => {
    const tree: FileTree = { 'config/urls.py': "urlpatterns = [ path('api/v1/health/', include('health.urls')), ]\n" };
    expect(healthPath(tree)).toBe('/api/v1/health');
  });

  it('Python Flask: @app.route("/healthz")', () => {
    const tree: FileTree = { 'app.py': "@app.route('/healthz')\ndef health(): return 'ok'\n" };
    expect(healthPath(tree)).toBe('/healthz');
  });

  it('Go: http.HandleFunc("GET /healthz") and gin GET /api/ping', () => {
    const tree: FileTree = {
      'main.go': 'http.HandleFunc("GET /healthz", h)\n',
      'api/server.go': 'r.GET("/api/ping", h)\n',
    };
    expect(healthPath(tree)).toBe('/api/ping');
  });

  it('PHP Laravel: routes/api.php health route is served under /api', () => {
    const tree: FileTree = { 'routes/api.php': "Route::get('/up', fn () => 'ok');\n" };
    expect(healthPath(tree)).toBe('/api/up');
  });

  it('.NET: MapGet("/health", ...)', () => {
    const tree: FileTree = { 'Program.cs': 'app.MapGet("/health", () => "ok");\n' };
    expect(healthPath(tree)).toBe('/health');
  });

  it('Phoenix: get "/health" inside scope "/api"', () => {
    const tree: FileTree = {
      'lib/app_web/router.ex': [
        'scope "/api", AppWeb do',
        '  get "/health", HealthController, :show',
        'end',
        '',
      ].join('\n'),
    };
    expect(healthPath(tree)).toBe('/api/health');
  });
});

// ==========================================================================
// Health modes + manifest/gate behaviour
// ==========================================================================

describe('health modes (Stage B phase 5)', () => {
  it('a HEALTHCHECK URL becomes the path (explicit)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20\nHEALTHCHECK CMD curl -f http://localhost:3000/api/heartbeat || exit 1\nCMD ["node", "index.js"]\n',
    };
    expect(healthPath(tree)).toBe('/api/heartbeat');
    expect(analyseHealth(tree).metaMode).toBe('explicit');
  });

  it('a HEALTHCHECK that probes / is ROOT mode', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20\nHEALTHCHECK CMD curl -f http://localhost:3000/ || exit 1\nCMD ["node", "index.js"]\n',
    };
    const health = analyseHealth(tree);
    expect(health.finding?.path).toBe('/');
    expect(health.metaMode).toBe('root');
  });

  it('no health evidence anywhere is vendor_required and blocks the deployment gate', () => {
    const tree: FileTree = {
      ...NODE_APP,
      'src/index.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
    };
    const health = analyseHealth(tree);
    expect(health.metaMode).toBe('vendor_required');
    expect(health.metaPath).toBeNull();

    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.health.mode).toBe('vendor_required');
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('NEEDS_CONFIGURATION');
    expect(result.findings.some((f) => f.id === 'health-path-required')).toBe(true);
  });

  it('existing JS route evidence still resolves explicit and the gate passes', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(NODE_APP), {});
    expect(manifest.health).toMatchObject({ path: '/health', mode: 'explicit' });
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });
});
