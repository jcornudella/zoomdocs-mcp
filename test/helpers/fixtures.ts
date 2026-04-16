import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function fixturePath(...segments: string[]): string {
  return path.join(process.cwd(), 'test', 'fixtures', ...segments);
}

export async function readJsonFixture<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(fixturePath(...segments), 'utf8')) as T;
}

export async function readTextFixture(...segments: string[]): Promise<string> {
  return readFile(fixturePath(...segments), 'utf8');
}
