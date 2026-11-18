import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import { APPEALS_START_TOKEN, SanctionError, validateSanctionInput, writeSanction } from '../src/sanctions.js';
import type { SanctionInput } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { SubjectId } from '../src/types.js';

// `termId` on a sanction (0.2.1): the term of the strike that tipped an automatic restriction, kept on the subject row. For the kit's own chat path only: it is
// accepted with the same internal key as `reportId` and `startsAt`, and refused with the same RangeError for anyone else.

const H = 3_600_000;
const NOW = 1_800_000_000_000;

function bare() {
  const store = withMemoryAppeals(new MemoryStore());
  const subjects = new SubjectIndex(store, { now: () => NOW }, { logger: { warn() {} } });
  const subject = (): SubjectId => {
    const s = subjects.resolve({ clientKey: 'termid-player', accountId: null, ipHash: 'iphash-1' });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const input = (over: Partial<SanctionInput> = {}): SanctionInput => ({
    kind: 'chat',
    subject: subject(),
    includeIp: false,
    durationMs: 6 * H,
    reason: 'r',
    actor: 'chat_filter',
    source: 'auto_filter',
    automated: true,
    rule: 2,
    ...over,
  });
  return { store, subjects, input };
}
const KEYED = { startsAtToken: APPEALS_START_TOKEN } as const;

describe('termId on a sanction', () => {
  it('with the internal key it is stored on the subject row and read back by loadSanctionSubjectRow', () => {
    const { store, subjects, input } = bare();
    const w = writeSanction(store, subjects, input({ termId: 'term-9', ...KEYED }), NOW, false);
    expect(w.rows[0]).toMatchObject({ targetType: 'subject', termId: 'term-9' });
    expect(store.loadSanctionSubjectRow(w.groupId)?.termId).toBe('term-9');
  });

  it('only the subject row carries it: the address row does not', () => {
    const { store, subjects, input } = bare();
    const w = writeSanction(store, subjects, input({ termId: 'term-9', includeIp: true, ...KEYED }), NOW, false);
    expect(w.rows.map((r) => r.targetType)).toEqual(['subject', 'ip']);
    for (const r of w.rows.filter((x) => x.targetType === 'ip')) expect(r).not.toHaveProperty('termId');
  });

  it('without a term id the key is absent, so every other row keeps the shape it had', () => {
    const { store, subjects, input } = bare();
    const w = writeSanction(store, subjects, input(), NOW, false);
    expect(w.rows[0]).not.toHaveProperty('termId');
    expect(store.loadSanctionSubjectRow(w.groupId)?.termId).toBeNull();
  });

  it('without the internal key it is a RangeError, the same as reportId, and nothing is written', () => {
    const { store, subjects, input } = bare();
    for (const over of [{ termId: 'term-9' }, { reportId: 'r1' }]) {
      expect(() => writeSanction(store, subjects, input(over), NOW, false)).toThrow(RangeError);
      expect(() => validateSanctionInput(input(over))).toThrow(RangeError);
    }
    expect(store.loadSanctions(NOW)).toEqual([]);
  });

  it('a wrong key is refused too', () => {
    const { store, subjects, input } = bare();
    expect(() => writeSanction(store, subjects, input({ termId: 'term-9', startsAtToken: Symbol('x') }), NOW, false)).toThrow(RangeError);
  });

  it.each([['an empty string', ''], ['a number', 7], ['null', null], ['an object', {}]])('with the key, %s is not a term id', (_n, bad) => {
    const { store, subjects, input } = bare();
    expect(() => writeSanction(store, subjects, input({ termId: bad as unknown as string, ...KEYED }), NOW, false)).toThrow(SanctionError);
    expect(store.loadSanctions(NOW)).toEqual([]);
  });

  it('the property is read once: an input with a getter that changes its answer stores what was checked', () => {
    const { store, subjects, input } = bare();
    let reads = 0;
    const tricky = input({ ...KEYED });
    Object.defineProperty(tricky, 'termId', { get: () => (++reads === 1 ? 'first' : 'second'), enumerable: true });
    const w = writeSanction(store, subjects, tricky, NOW, false);
    expect(store.loadSanctionSubjectRow(w.groupId)?.termId).toBe('first');
    expect(reads).toBe(1);
  });

  it('it can be given together with a report id and a start', () => {
    const { store, subjects, input } = bare();
    const w = writeSanction(store, subjects, input({ termId: 'term-9', reportId: 'r1', startsAt: NOW - 1000, ...KEYED }), NOW, false);
    expect(store.loadSanctionSubjectRow(w.groupId)).toMatchObject({ termId: 'term-9', reportId: 'r1', startsAt: NOW - 1000 });
  });
});
