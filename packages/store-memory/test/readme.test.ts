import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as kit from '../src/testing/index.js';

// The test kit's README section is what an adopter reads first. These keep it true to the entry: every value the entry exports is named there, it
// says first that it is not for production, and it says the names are experimental. (The example itself is run by testing-policy.test.ts.)

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const entry = readFileSync(new URL('../src/testing/index.ts', import.meta.url), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const section = readme.slice(readme.indexOf('## The test kit'), readme.indexOf('\n## Options'));

describe('packages/store-memory/README.md, the test kit', () => {
  it('names every value and type the entry exports', () => {
    const values = Object.keys(kit);
    expect(values.length).toBeGreaterThanOrEqual(8);
    const types = [...entry.matchAll(/export type \{([^}]*)\}/g)].flatMap((m) => (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean));
    for (const name of [...values, ...types]) expect(flat(section), name).toContain(name);
  });

  it('says first that it is not for production, that it needs no test runner and no node: import, and that its names are part of the API', () => {
    const text = flat(section);
    expect(text.indexOf('Not for production')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Not for production')).toBeLessThan(80);
    expect(text).toContain('needs no test runner');
    expect(text).toContain('no `node:` import');
    expect(text).not.toContain('@experimental');
  });

  it('control: a name the entry does not export is not in the section', () => {
    expect(flat(section)).not.toContain('createTestKitForReal');
    expect(Object.keys(kit)).not.toContain('createTestKitForReal');
  });

  it('shows one example that starts with its import and uses invented words only', () => {
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
    expect(block.startsWith("import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';")).toBe(true);
    for (const word of ['zorbak', 'snerp', 'tarvo', 'fenrisk']) expect(block).toContain(word);
  });
});
