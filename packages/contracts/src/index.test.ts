import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index';

describe('@deployz/contracts scaffold', () => {
  it('exports the package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('@deployz/contracts');
  });
});
