import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Review m1: the byte order mark in `chatwarden serve`'s JSON reader is written as an escape, not as the invisible character.

describe('serve.ts source', () => {
  it('is ASCII only and names the byte order mark with an escape', () => {
    const src = readFileSync(new URL('../src/service/serve.ts', import.meta.url), 'utf8');
    expect(/^[\p{ASCII}]*$/u.test(src)).toBe(true);
    expect(src).toContain(`${String.fromCharCode(92)}uFEFF`);
  });
});
