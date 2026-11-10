import { describe, expect, it } from 'vitest';
import type { Store, SubjectIdRecord, SubjectRecord } from '@chatwarden/core';

// The contract of the subject and identifier methods of the Store (the async ones). One suite, run against every Store.

const T = 1_800_000_000_000;
const subject = (id: string, createdAt = T, mergedInto: string | null = null): SubjectRecord => ({ id, createdAt, mergedInto });
const ident = (subjectId: string, kind: SubjectIdRecord['kind'], value: string, firstSeen = T, lastSeen = T): SubjectIdRecord => ({
  subjectId,
  kind,
  value,
  firstSeen,
  lastSeen,
});

export function subjectsContract(name: string, make: () => Store): void {
  describe(`subjects contract: ${name}`, () => {
    it('an empty store loads nothing', async () => {
      expect(await make().loadSubjects()).toEqual({ subjects: [], ids: [] });
    });

    it('saveSubject then loadSubjects round-trips the record', async () => {
      const s = make();
      await s.saveSubject(subject('s_a', T, null));
      expect((await s.loadSubjects()).subjects).toEqual([subject('s_a')]);
    });

    it('saving an existing subject leaves it unchanged (first write wins)', async () => {
      const s = make();
      await s.saveSubject(subject('s_a', T));
      await s.saveSubject(subject('s_a', T + 99, 's_other'));
      expect((await s.loadSubjects()).subjects).toEqual([subject('s_a', T)]);
    });

    it('subjects come back oldest first, ties by id', async () => {
      const s = make();
      await s.saveSubject(subject('s_c', T + 5));
      await s.saveSubject(subject('s_b', T));
      await s.saveSubject(subject('s_a', T));
      expect((await s.loadSubjects()).subjects.map((x) => x.id)).toEqual(['s_a', 's_b', 's_c']);
    });

    it('identifiers come back ordered by subject, kind, then value', async () => {
      const s = make();
      await s.saveSubject(subject('s_b'));
      await s.saveSubject(subject('s_a'));
      await s.saveIdentifier(ident('s_b', 'key', 'z'));
      await s.saveIdentifier(ident('s_a', 'key', 'y'));
      await s.saveIdentifier(ident('s_a', 'key', 'x'));
      await s.saveIdentifier(ident('s_a', 'account', 'q'));
      await s.saveIdentifier(ident('s_a', 'ip', 'a'));
      expect((await s.loadSubjects()).ids.map((r) => `${r.subjectId}/${r.kind}/${r.value}`)).toEqual([
        's_a/account/q',
        's_a/ip/a',
        's_a/key/x',
        's_a/key/y',
        's_b/key/z',
      ]);
    });

    it('saveIdentifier keeps firstSeen from the first write and only moves lastSeen forward', async () => {
      const s = make();
      await s.saveSubject(subject('s_a'));
      await s.saveIdentifier(ident('s_a', 'key', 'h1', T, T + 10));
      await s.saveIdentifier(ident('s_a', 'key', 'h1', T + 5, T + 50));
      await s.saveIdentifier(ident('s_a', 'key', 'h1', T + 7, T + 20));
      expect((await s.loadSubjects()).ids).toEqual([ident('s_a', 'key', 'h1', T, T + 50)]);
    });

    it('an identifier is keyed by subject, kind and value', async () => {
      const s = make();
      await s.saveSubject(subject('s_a'));
      await s.saveSubject(subject('s_b'));
      await s.saveIdentifier(ident('s_a', 'key', 'same'));
      await s.saveIdentifier(ident('s_a', 'account', 'same'));
      await s.saveIdentifier(ident('s_b', 'key', 'same'));
      await s.saveIdentifier(ident('s_a', 'key', 'Same'));
      expect((await s.loadSubjects()).ids).toHaveLength(4);
    });

    it('an IP may be recorded on several subjects', async () => {
      const s = make();
      await s.saveSubject(subject('s_a'));
      await s.saveSubject(subject('s_b'));
      await s.saveIdentifier(ident('s_a', 'ip', 'iphash'));
      await s.saveIdentifier(ident('s_b', 'ip', 'iphash'));
      expect((await s.loadSubjects()).ids.map((r) => r.subjectId).sort()).toEqual(['s_a', 's_b']);
    });

    it('saveIdentifier for an unknown subject rejects and writes nothing', async () => {
      const s = make();
      await expect(s.saveIdentifier(ident('s_ghost', 'key', 'h'))).rejects.toThrow();
      expect((await s.loadSubjects()).ids).toEqual([]);
    });

    it('markMerged sets mergedInto; marking an unknown subject is a no-op', async () => {
      const s = make();
      await s.saveSubject(subject('s_a'));
      await s.saveSubject(subject('s_b', T + 1));
      await s.markMerged('s_b', 's_a');
      await s.markMerged('s_ghost', 's_a');
      const { subjects } = await s.loadSubjects();
      expect(subjects).toEqual([subject('s_a'), subject('s_b', T + 1, 's_a')]);
    });

    it('the loaded records are copies', async () => {
      const s = make();
      await s.saveSubject(subject('s_a'));
      await s.saveIdentifier(ident('s_a', 'key', 'h'));
      const first = await s.loadSubjects();
      first.subjects[0]!.mergedInto = 'tampered';
      first.ids[0]!.lastSeen = 0;
      const second = await s.loadSubjects();
      expect(second.subjects[0]?.mergedInto).toBeNull();
      expect(second.ids[0]?.lastSeen).toBe(T);
    });

    it('writes made inside a rolled-back transaction are undone', async () => {
      const s = make();
      await s.saveSubject(subject('s_keep'));
      await s.saveIdentifier(ident('s_keep', 'key', 'k', T, T + 1));
      let pending: Promise<unknown> = Promise.resolve();
      expect(() =>
        s.transaction(() => {
          pending = Promise.all([
            s.saveSubject(subject('s_gone')),
            s.saveIdentifier(ident('s_keep', 'key', 'k', T, T + 99)),
            s.markMerged('s_keep', 's_gone'),
          ]);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      await pending.catch(() => undefined);
      const { subjects, ids } = await s.loadSubjects();
      expect(subjects.map((x) => x.id)).toEqual(['s_keep']);
      expect(subjects[0]?.mergedInto).toBeNull();
      expect(ids[0]?.lastSeen).toBe(T + 1);
    });
  });
}
