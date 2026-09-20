import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Drift protection for the Deployz brand assets
// (apps/web/brand/deployz/README.md). Each vector copy of the symbol must
// carry the path data of the master, and each raster export must be the
// approved file, byte for byte. Text files are compared after whitespace
// normalisation, so a CRLF checkout does not change the result.

const webRoot = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath: string): Buffer {
  return readFileSync(`${webRoot}/${relativePath}`);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function svgGeometry(relativePath: string): { viewBox: string; paths: string[] } {
  const svg = read(relativePath).toString('utf8');
  return {
    viewBox: /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '',
    paths: [...svg.matchAll(/\sd="([^"]+)"/g)].map((match) => normalise(match[1]!)),
  };
}

const approved = JSON.parse(read('brand/deployz/approved-checksums.json').toString('utf8')) as {
  masterPathSha256: string;
  raster: Record<string, string>;
};
const master = svgGeometry('brand/deployz/deployz-icon-master.svg');

describe('Deployz brand assets', () => {
  it('keeps the approved master symbol', () => {
    expect(master.paths).toHaveLength(1);
    expect(sha256(master.paths[0]!)).toBe(approved.masterPathSha256);
  });

  it.each(['public/brand/deployz/deployz-icon.svg', 'src/app/icon.svg'])(
    '%s carries the master geometry',
    (relativePath) => {
      expect(svgGeometry(relativePath)).toEqual(master);
    },
  );

  it('the DeployzIcon component carries the master geometry', () => {
    const source = read('src/components/deployz-brand.tsx').toString('utf8');
    expect(/ICON_VIEW_BOX = '([^']+)'/.exec(source)?.[1]).toBe(master.viewBox);
    expect(normalise(/ICON_PATH =\s*'([^']+)'/.exec(source)?.[1] ?? '')).toBe(master.paths[0]);
  });

  it.each(Object.entries(approved.raster))('%s is the approved export', (relativePath, checksum) => {
    expect(sha256(read(relativePath))).toBe(checksum);
  });

  it('public/brand/deployz holds only guarded files', () => {
    const guarded = [
      'deployz-icon.svg',
      ...Object.keys(approved.raster)
        .filter((relativePath) => relativePath.startsWith('public/brand/deployz/'))
        .map((relativePath) => relativePath.slice('public/brand/deployz/'.length)),
    ];
    expect(readdirSync(`${webRoot}/public/brand/deployz`).sort()).toEqual(guarded.sort());
  });
});
