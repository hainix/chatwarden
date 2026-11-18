import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PrivacyExport, SubjectExport } from '../src/privacy.js';
import { A, fillA, privacyWorld } from './privacyWorld.js';

// 0.2.1 is additive on the published 0.2.0: an appeals row of `Store.exportSubjects` gained `overturnedAt` and `reasonCode`, and a custom 0.2.0 store does not return them.
// The two keys are therefore optional in the type (checked by `tsc -b`, which compiles this file), and an export built from a store that omits them still works.

type Row = SubjectExport['appeals'][number];

/** An appeals row exactly as a 0.2.0 store returned it. */
const OLD_ROW = { createdAt: 1, kind: 'chat', rule: '2', status: 'upheld', statement: 'it was not me', decidedAt: 5 } as const;

describe('SubjectExport.appeals rows: the 0.2.1 keys are optional', () => {
  it('a 0.2.0-shaped row (no overturnedAt, no reasonCode) is a valid row', () => {
    const row: Row = OLD_ROW; // fails to compile when either key is required
    expectTypeOf(OLD_ROW).toExtend<Row>();
    expect(row.statement).toBe('it was not me');
  });

  it('the keys are allowed, and null is allowed', () => {
    const full: Row = { ...OLD_ROW, overturnedAt: 7, reasonCode: 'mistake' };
    const nulls: Row = { ...OLD_ROW, overturnedAt: null, reasonCode: null };
    expectTypeOf<Row['overturnedAt']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Row['reasonCode']>().toEqualTypeOf<string | null | undefined>();
    expect([full.overturnedAt, nulls.reasonCode]).toEqual([7, null]);
  });
});

describe('an export from a store that returns the 0.2.0 appeals rows', () => {
  it('passes the rows through: no throw, the keys stay absent (read as none)', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const real = w.store.exportSubjects.bind(w.store);
    w.store.exportSubjects = (subjects) => {
      const out = real(subjects);
      return { ...out, appeals: [{ ...OLD_ROW }] };
    };
    const out = await w.cw.privacy.export(w.aId);
    expect('ok' in out).toBe(false);
    const sections = (out as PrivacyExport).sections;
    expect(sections.appeals).toEqual([OLD_ROW]);
    expect(sections.appeals[0]).not.toHaveProperty('overturnedAt');
    expect((out as PrivacyExport).accounts).toEqual([A.account]);
  });

  it('control: the first-party store still emits both keys (null when none)', async () => {
    const w = await privacyWorld();
    await fillA(w);
    w.store.insertAppeal?.({
      id: 'ap-a', subject: w.aId, groupId: 'g-a', noticeId: 'n-a', reportId: null, rule: '2', kind: 'chat', statement: 'st', status: 'open',
      createdAt: 1, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null,
    });
    const out = (await w.cw.privacy.export(w.aId)) as PrivacyExport;
    expect(out.sections.appeals).toHaveLength(1);
    expect(out.sections.appeals[0]).toMatchObject({ overturnedAt: null, reasonCode: null });
  });
});
