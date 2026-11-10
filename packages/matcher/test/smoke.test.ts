import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

const manifestVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('@chatwarden/matcher smoke', () => {
  it('exports the version in package.json', () => {
    expect(VERSION).toBe(manifestVersion);
  });
});
