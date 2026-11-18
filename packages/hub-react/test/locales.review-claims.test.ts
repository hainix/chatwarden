// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { afterHeader, CLAIM_WORDS } from './locales.helpers.js';

// No locale file claims a review outside its header block: not in a string, a comment or a name. The header says the draft is machine-made.

const dir = fileURLToPath(new URL('../src/locales/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

describe('review claims', () => {
  it('there are locale files to check', () => {
    expect(files).toEqual(expect.arrayContaining(['es.ts', 'pt.ts', 'match.ts', 'load.ts']));
  });

  it.each(files)('%s: none of the claim words (English, Spanish, Portuguese) outside the header', (file) => {
    const body = afterHeader(readFileSync(`${dir}${file}`, 'utf8'));
    expect(body.match(CLAIM_WORDS)?.[0]).toBeUndefined();
  });

  it.each(['es.ts', 'pt.ts'])('%s: the header says machine-drafted and not reviewed', (file) => {
    const head = readFileSync(`${dir}${file}`, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('//'))
      .join(' ')
      .toLowerCase();
    expect(head).toContain('machine-drafted');
    expect(head).toContain('not reviewed');
  });

  it('the checker sees a claim and ignores the meta field names (controls)', () => {
    expect(afterHeader("// header reviewed\nconst a = 'Texto revisado';").match(CLAIM_WORDS)?.[0]).toBe('revisado');
    expect(afterHeader("// header\nconst a = 'official';").match(CLAIM_WORDS)?.[0]).toBe('official');
    expect(afterHeader('// header\nconst meta = { reviewedBy: [], reviewedAt: null };').match(CLAIM_WORDS)).toBeNull();
    expect(afterHeader("// header\nconst a = 'Idioma nativo';").match(CLAIM_WORDS)?.[0]).toBe('nativo');
    expect('Aprovado'.match(CLAIM_WORDS)?.[0]).toBe('Aprovado');
  });
});
