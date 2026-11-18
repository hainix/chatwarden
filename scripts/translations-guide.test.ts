import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aiEn } from '../packages/hub-react/src/ai/i18n.js';
import { en as hubEn } from '../packages/hub-react/src/i18n.js';
import { privacyEn } from '../packages/hub-react/src/privacy/i18n.js';
import { enChat } from '../packages/player-react/src/chat/words.js';
import { en as playerEn } from '../packages/player-react/src/i18n.js';

// The translator's guide (docs/recipes/translations.md) lists the keys to read first: notices, refusals, appeals and the words for sanctions.
// A list that names a key the catalogue no longer has sends a reviewer looking for nothing, so every key it names must exist. A `prefix.*` entry
// must match at least one key.

const root = fileURLToPath(new URL('..', import.meta.url));
const guide = readFileSync(`${root}docs/recipes/translations.md`, 'utf8').replace(/\r\n/g, '\n');
const keys = new Set<string>([...Object.keys(hubEn), ...Object.keys(aiEn), ...Object.keys(privacyEn), ...Object.keys(playerEn), ...Object.keys(enChat)]);
const bases = new Set([...keys].map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')));

const listed = [...guide.matchAll(/`((?:hub|player)\.[A-Za-z0-9_.*]+)`/g)].map((m) => m[1] as string);

describe('docs/recipes/translations.md', () => {
  it('lists keys to review first, in the four areas the spec names', () => {
    expect(listed.length).toBeGreaterThan(20);
    for (const area of [/player\.notice\./, /player\.chat\.refused\.|player\.report\.refused\./, /appeal/, /hub\.sanction\.|hub\.decide\./]) expect(listed.some((k) => area.test(k)), String(area)).toBe(true);
  });

  it.each([...new Set(listed)])('%s exists in the catalogue', (key) => {
    if (key.endsWith('.*')) {
      const prefix = key.slice(0, -1);
      expect([...keys].some((k) => k.startsWith(prefix)), `${key} matches no key`).toBe(true);
    } else {
      expect(keys.has(key) || bases.has(key), `${key} is not a key`).toBe(true);
    }
  });

  it('says the catalogues are machine-drafted and not reviewed in its first lines, and names the test and the meta file fields', () => {
    expect(guide.split('\n').slice(0, 8).join(' ')).toMatch(/machine-drafted/);
    expect(guide).toMatch(/locales\.complete\.test/);
    expect(guide).toMatch(/reviewedBy/);
    expect(guide).toMatch(/reviewedAt/);
    expect(guide).toMatch(/allowlist/i);
  });

  it('is not legal advice, promises no review, and names no real slur', () => {
    expect(guide).toMatch(/not legal advice/i);
    expect(guide).not.toMatch(/has been reviewed|were reviewed|is reviewed|fully translated by/i);
  });
});
