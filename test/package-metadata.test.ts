import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('package metadata', () => {
  it('is ready for public npm distribution', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      name?: string;
      author?: string;
      license?: string;
      keywords?: string[];
      scripts?: Record<string, string>;
      publishConfig?: { access?: string };
      bin?: Record<string, string>;
    };

    expect(packageJson.name).toBe('@jcornudella/zoomdocs-mcp');
    expect(packageJson.author).toBe('Joan Cornudella');
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(['mcp', 'model-context-protocol', 'zoom', 'zoom-docs', 'claude', 'browser-automation'])
    );
    expect(packageJson.scripts?.verify).toBe('npm test && npm run typecheck && npm run build');
    expect(packageJson.scripts?.prepublishOnly).toBe('npm run verify');
    expect(packageJson.publishConfig?.access).toBe('public');
    expect(packageJson.bin).toEqual({
      'zoomdocs-mcp': 'dist/index.js',
    });
  });

  it('ships a real open-source license file', async () => {
    const licenseText = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');

    expect(licenseText).toContain('MIT License');
    expect(licenseText).toContain('Permission is hereby granted, free of charge');
  });
});
