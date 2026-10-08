import { describe, expect, it } from 'vitest';

import { parseRunArgs } from './index.js';

describe('Stage B AI mode', () => {
  it('is off by default and live only with --ai live', () => {
    expect(parseRunArgs(['--gate']).ai).toBe('off');
    expect(parseRunArgs(['--gate', '--ai', 'live']).ai).toBe('live');
    expect(() => parseRunArgs(['--gate', '--ai', 'on'])).toThrow('--ai must be "off" or "live"');
  });
});
