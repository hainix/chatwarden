import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSanction } from '../../src/admin/apply.js';
import { sanctionFingerprint } from '../../src/webhooks/fingerprint.js';

// The fingerprint is stored beside an idempotency key. Moving the function must not change a single byte of it, or every
// stored key would look like a different request. The golden values below were computed with the function while it still
// lived in admin/apply.ts.
const GOLDEN: Array<[string, Record<string, unknown>, string]> = [
  ['a timed chat mute', { subject: 's_abc', kind: 'chat', durationMs: 5000, rule: 1, reason: 'spam' }, '324039ddfbb89a9f7333801c31089b31b39004aa9ced3832a15f280083570f0c'],
  [
    'a permanent ban with ip and a padded gap note',
    { subject: 's_abc', kind: 'ban', durationMs: null, rule: 3, reason: 'r', includeIp: true, gapNote: '  note  ' },
    '1dd26d9d64193af865c1666be0ca04d5ae204d0abd4fb727be96feb1ba459274',
  ],
  ['a warning with defaults (no reason)', { subject: 'a', kind: 'warning', durationMs: null, rule: 2 }, 'c53c78d1b19fddc215ee917e24527238fcf7700ec7ac3075a7e7981a43bfb9c4'],
  ['a multi-byte and astral reason', { subject: 's_abc', kind: 'chat', durationMs: 60000, rule: 4, reason: 'héllo 😀 "q"' }, 'a22407ad6408392d4b23fff2944a3bb60a5ef5edb734a8e7cf99d79be681c7db'],
];

describe('sanctionFingerprint (in webhooks/)', () => {
  for (const [name, input, hex] of GOLDEN) {
    it(`is byte-identical to the pre-move value: ${name}`, () => {
      expect(sanctionFingerprint(parseSanction(input))).toBe(hex);
    });
  }

  it('is 64 lowercase hex characters', () => {
    for (const [, input] of GOLDEN) expect(sanctionFingerprint(parseSanction(input))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order and spacing of the request, and the default includeIp', () => {
    const a = sanctionFingerprint(parseSanction({ subject: 's_abc', kind: 'chat', durationMs: 5000, rule: 1, reason: 'spam' }));
    const b = sanctionFingerprint(parseSanction({ reason: 'spam', rule: 1, durationMs: 5000, kind: 'chat', subject: 's_abc', includeIp: false }));
    expect(b).toBe(a);
  });

  it('changes with any field', () => {
    const base = { subject: 's_abc', kind: 'chat', durationMs: 5000, rule: 1, reason: 'spam' };
    const seen = new Set<string>([sanctionFingerprint(parseSanction(base))]);
    for (const over of [{ subject: 's_abd' }, { durationMs: 5001 }, { rule: 2 }, { reason: 'spam!' }, { includeIp: true }, { gapNote: 'n' }]) {
      seen.add(sanctionFingerprint(parseSanction({ ...base, ...over })));
    }
    expect(seen.size).toBe(7);
  });

  it('keeps node:crypto and Buffer off the staff path, and node:crypto in webhooks/fingerprint.ts', () => {
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
    for (const f of ['apply', 'context', 'reports', 'sanctions', 'gaps', 'terms', 'policy', 'audit', 'validate', 'index']) {
      expect(read(`../../src/admin/${f}.ts`), f).not.toMatch(/node:/);
    }
    for (const f of ['body', 'auth', 'permissions', 'router', 'errors', 'types']) expect(read(`../../src/${f}.ts`), f).not.toMatch(/node:|Buffer/);
    expect(read('../../src/webhooks/in.ts')).not.toMatch(/Buffer/);
    expect(read('../../src/webhooks/fingerprint.ts')).toContain("from 'node:crypto'");
  });
});
