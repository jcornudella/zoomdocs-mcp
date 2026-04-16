import { describe, expect, it } from 'vitest';

import { buildLaunchOptions, formatBrowserLaunchError } from '../src/browser/transport.js';

describe('browser launch policy', () => {
  it('prefers local Chrome and does not require bundled Chromium installs', () => {
    expect(
      buildLaunchOptions({
        headless: false,
        browserChannel: 'chrome',
      })
    ).toEqual({
      headless: false,
      channel: 'chrome',
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  });

  it('tells the user to install Chrome instead of Playwright browsers', () => {
    expect(formatBrowserLaunchError(new Error('boom'))).toContain('Google Chrome');
    expect(formatBrowserLaunchError(new Error('boom'))).not.toContain('install:browsers');
  });
});
