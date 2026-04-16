import { describe, expect, it } from 'vitest';

import { waitForCondition } from '../src/browser/transport.js';

describe('browser auth bootstrap wait', () => {
  it('resolves once the condition becomes true before timeout', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 25);

    await expect(
      waitForCondition(() => ready, { timeoutMs: 200, intervalMs: 5 })
    ).resolves.toBe(true);
  });

  it('returns false when the timeout expires first', async () => {
    await expect(
      waitForCondition(() => false, { timeoutMs: 30, intervalMs: 5 })
    ).resolves.toBe(false);
  });
});
