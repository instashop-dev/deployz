import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectPort } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function portFinding(tree: FileTree) {
  return detectPort(tree);
}

const EXPRESS_TREE: FileTree = {
  'package.json': JSON.stringify({
    name: 'app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0' },
  }),
  'src/index.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
};

// ==========================================================================
// Runtime literals (COMP-030)
// ==========================================================================

describe('port runtime literals (COMP-030)', () => {
  it('Go: http.ListenAndServe(":8080", ...)', () => {
    const tree: FileTree = { 'main.go': 'http.ListenAndServe(":8080", nil)\n' };
    const finding = portFinding(tree);
    expect(finding.value).toBe('8080');
    expect(finding.portSource).toBe('runtime-literal');
    expect(finding.portConfidence).toBe('high');
  });

  it('Python: uvicorn.run(app, port=8000)', () => {
    const tree: FileTree = { 'app.py': 'uvicorn.run(app, host="0.0.0.0", port=8000)\n' };
    expect(portFinding(tree).value).toBe('8000');
  });

  it('Python: app.run(port=5000)', () => {
    const tree: FileTree = { 'app.py': 'app.run(port=5000)\n' };
    expect(portFinding(tree).value).toBe('5000');
  });

  it('Java: server.port=8080 in application.properties', () => {
    const tree: FileTree = { 'src/main/resources/application.properties': 'server.port=8080\n' };
    expect(portFinding(tree).value).toBe('8080');
  });

  it('Ruby/PHP: rails server -p 3000 / artisan serve --port in a start script', () => {
    const ruby: FileTree = {
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'rails server -p 3000' } }),
    };
    expect(portFinding(ruby).value).toBe('3000');
    const php: FileTree = {
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'php artisan serve --port=8000' } }),
    };
    expect(portFinding(php).value).toBe('8000');
  });

  it('placeholder/env-dependent values are NOT runtime literals', () => {
    // Go placeholder + a Java server.port placeholder: neither is a literal,
    // and no framework marker is present, so nothing is detected.
    const tree: FileTree = {
      'main.go': 'port := os.Getenv("PORT")\nhttp.ListenAndServe(":"+port, nil)\n',
      'src/main/resources/application.properties': 'server.port=${PORT:8080}\n',
    };
    expect(portFinding(tree).detected).toBe(false);
  });
});

// ==========================================================================
// Framework defaults — prefill only, never gate-passing
// ==========================================================================

describe('framework-default ports (COMP-030)', () => {
  it('Express runtime yields 3000 as a LOW-confidence framework default', () => {
    const finding = portFinding(EXPRESS_TREE);
    expect(finding.detected).toBe(true);
    expect(finding.value).toBe('3000');
    expect(finding.portSource).toBe('framework-default');
    expect(finding.portConfidence).toBe('low');
  });

  it('framework default alone NEVER passes the manifest gate', () => {
    const tree: FileTree = {
      ...EXPRESS_TREE,
      'src/index.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
      'Dockerfile': [
        'FROM node:20-alpine',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["node", "dist/index.js"]',
        '',
      ].join('\n'),
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    // The prefill value is present…
    expect(manifest.web.port).toBe(3000);
    expect(manifest.web.portIsDefault).toBe(true);
    // …but the gate still refuses to auto-deploy on a guessed port.
    const gate = evaluateManifestReadiness(manifest);
    expect(gate.state).toBe('NEEDS_CONFIGURATION');
    expect(gate.findings.some((f) => f.id === 'port-missing')).toBe(true);
  });

  it('EXPOSE outranks a framework default', () => {
    const tree: FileTree = {
      ...EXPRESS_TREE,
      'Dockerfile': 'FROM node:20-alpine\nEXPOSE 4242\nCMD ["node", "dist/index.js"]\n',
    };
    const finding = portFinding(tree);
    expect(finding.value).toBe('4242');
    expect(finding.portSource).toBe('dockerfile-expose');
  });

  it('a runtime literal outranks a framework default', () => {
    const tree: FileTree = {
      ...EXPRESS_TREE,
      'app.py': 'uvicorn.run(app, port=8000)\n',
    };
    const finding = portFinding(tree);
    expect(finding.value).toBe('8000');
    expect(finding.portSource).toBe('runtime-literal');
  });
});

// ==========================================================================
// Compose + provenance on metadata
// ==========================================================================

describe('compose container-side mapping and metadata provenance', () => {
  it('uses the CONTAINER side of a production compose port mapping', () => {
    const tree: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    build: .',
        '    ports:',
        '      - "8000:8080"',
        '',
      ].join('\n'),
    };
    const finding = portFinding(tree);
    expect(finding.value).toBe('8080');
    expect(finding.portSource).toBe('compose');
  });

  it('records portSource/portConfidence on analysed metadata', () => {
    const tree: FileTree = {
      ...EXPRESS_TREE,
      'Dockerfile': 'FROM node:20-alpine\nEXPOSE 9999\nCMD ["node", "dist/index.js"]\n',
    };
    const analysis = analyseRepo(tree);
    expect(analysis.metadata['port']).toBe('9999');
    expect(analysis.metadata['portSource']).toBe('dockerfile-expose');
    expect(analysis.metadata['portConfidence']).toBe('high');
  });
});
