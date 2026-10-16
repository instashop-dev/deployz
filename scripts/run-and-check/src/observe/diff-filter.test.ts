import { describe, expect, it } from 'vitest';

import { filterLocalDiskWrites, sqliteFileWritten } from './diff-filter.js';

describe('filterLocalDiskWrites', () => {
  it('drops temp, run, log, cache and pid paths', () => {
    const lines = [
      'A /tmp/x',
      'C /var/tmp',
      'A /run/app.sock',
      'A /var/run/a',
      'C /proc/1',
      'A /dev/shm/x',
      'A /app/server.pid',
      'A /app/out.log',
      'A /root/.cache/pip/x',
      'A /home/node/.cache/yarn',
      'A /var/log/nginx/access',
      'A /var/cache/apt',
      'A /app/node_modules/.cache/babel',
      'A /app/pkg/__pycache__/m.pyc',
    ];
    expect(filterLocalDiskWrites(lines)).toEqual([]);
  });

  it('keeps real local state, sorted and without the change letter', () => {
    expect(filterLocalDiskWrites(['A /app/uploads/a.png', 'C /app', 'A /tmp/x', 'A /app/uploads/a.png'])).toEqual([
      '/app',
      '/app/uploads/a.png',
    ]);
  });

  it('does not treat a similar folder name as ignored', () => {
    expect(filterLocalDiskWrites(['A /tmpdata/x', 'A /runtime/y'])).toEqual(['/runtime/y', '/tmpdata/x']);
  });
});

describe('sqliteFileWritten', () => {
  it('detects sqlite and db files', () => {
    expect(sqliteFileWritten(['A /app/data.sqlite3'])).toBe(true);
    expect(sqliteFileWritten(['A /app/data.db'])).toBe(true);
    expect(sqliteFileWritten(['A /app/data.txt'])).toBe(false);
  });
});
