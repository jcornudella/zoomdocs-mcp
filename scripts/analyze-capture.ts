#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';

import { analyzeCaptureLines, formatCaptureAnalysis } from '../src/zoomdocs/capture-analyzer.js';

async function main(argv = process.argv.slice(2)): Promise<void> {
  const filePath = argv[0];
  if (!filePath || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage:',
        '  npm run analyze:capture -- <capture.jsonl>',
        '',
        'Groups captured Zoom Docs HTTP requests by normalized method/path, shows status counts,',
        'and prints one request/response example per endpoint group.',
      ].join('\n') + '\n'
    );
    process.exitCode = filePath ? 0 : 1;
    return;
  }

  const raw = await readFile(filePath, 'utf8');
  const result = analyzeCaptureLines(raw.split('\n'));
  process.stdout.write(formatCaptureAnalysis(result));
}

main().catch((error) => {
  process.stderr.write(`[analyze-capture] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
