import { describe, expect, it } from 'vitest';
import { applySanction, AUDIT_ACTIONS, SubjectIndex } from '@chatwarden/core';
import type { AuditRow, Store } from '@chatwarden/core';

// The contract of the staff audit trail methods of the Store (insertAudit, listAudit, purgeAudit, and the gap.close
// entry closeGap writes). One suite, run against every Store.

const NOW = 1_800_000_000_000;

const row = (id: string, at: number, over: Partial<AuditRow> = {}): AuditRow => ({
  id,
  at,
  actor: 'alice',
  role: 'moderator',
  action: 'report.view',
  target: { type: 'report', ref: `ref_${id}` },
  ...over,
});

export function auditContract(name: string, make: () => Store): void {
  describe(`audit contract: ${name}`, () => {
    it('round-trips a row exactly', () => {
      const s = make();
      const r = row('r1', NOW, { role: 'senior', action: 'sanction.apply', target: { type: 'person', ref: 's_abc' } });
      s.insertAudit(r);
      expect(s.listAudit({ limit: 5 })).toEqual([r]);
    });

    it('a row with no target and no role round-trips as null / null', () => {
      const s = make();
      s.insertAudit(row('r1', NOW, { role: null, target: null, action: 'policy.view' }));
      expect(s.listAudit({ limit: 5 })).toEqual([row('r1', NOW, { role: null, target: null, action: 'policy.view' })]);
    });

    it('every audit action round-trips', () => {
      const s = make();
      for (const action of AUDIT_ACTIONS) s.insertAudit(row(`id_${action}`, 1, { action }));
      const got = s.listAudit({ limit: 200 });
      expect(got.map((r) => r.action).sort()).toEqual([...AUDIT_ACTIONS].sort());
    });

    it('the appeal and name rows round-trip: an appeal target, no target on appeal.view, a person target on name.rename_required', () => {
      const s = make();
      const view = row('v1', NOW, { action: 'appeal.view', target: { type: 'appeal', ref: 'ap_1' } });
      const list = row('v2', NOW + 1, { action: 'appeal.view', target: null });
      const decide = row('v3', NOW + 2, { role: 'senior', action: 'appeal.decide', target: { type: 'appeal', ref: 'ap_1' } });
      const rename = row('v4', NOW + 3, { role: 'senior', action: 'name.rename_required', target: { type: 'person', ref: 's_abc' } });
      for (const r of [view, list, decide, rename]) s.insertAudit(r);
      expect(s.listAudit({ limit: 10 })).toEqual([rename, decide, list, view]);
      expect(s.listAudit({ limit: 10, action: 'appeal.decide' })).toEqual([decide]);
      expect(s.listAudit({ limit: 10, action: 'appeal.view' })).toEqual([list, view]);
      expect(s.listAudit({ limit: 10, action: 'name.rename_required' })).toEqual([rename]);
    });

    it('an ai.read row (an ai: actor, no role, a report target) round-trips and filters by action and actor', () => {
      const s = make();
      const ai = row('a1', NOW, { actor: 'ai:anthropic:claude-haiku-5-5', role: null, action: 'ai.read', target: { type: 'report', ref: 'rep_1' } });
      s.insertAudit(ai);
      s.insertAudit(row('m1', NOW + 1, { action: 'ai.rerun', target: { type: 'report', ref: 'rep_1' } }));
      s.insertAudit(row('m2', NOW + 2, { action: 'ai.outcome', target: { type: 'report', ref: 'rep_1' } }));
      expect(s.listAudit({ limit: 5, action: 'ai.read' })).toEqual([ai]);
      expect(s.listAudit({ limit: 5, actor: 'ai:anthropic:claude-haiku-5-5' })).toEqual([ai]);
      expect(s.listAudit({ limit: 5 }).map((r) => r.action)).toEqual(['ai.outcome', 'ai.rerun', 'ai.read']);
    });

    it('newest first, ties on at by id descending', () => {
      const s = make();
      for (const [id, at] of [['b', 10], ['a', 10], ['c', 10], ['d', 5], ['e', 20]] as const) s.insertAudit(row(id, at));
      expect(s.listAudit({ limit: 10 }).map((r) => r.id)).toEqual(['e', 'c', 'b', 'a', 'd']);
    });

    it('ids compare by code point, like SQLite bytes: U+FF21 sorts before a character outside the BMP', () => {
      const s = make();
      s.insertAudit(row('\uFF21', 10));
      s.insertAudit(row('\u{1F600}', 10));
      s.insertAudit(row('z', 10));
      expect(s.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['\u{1F600}', '\uFF21', 'z']);
      expect(s.listAudit({ limit: 9, before: 10, beforeId: '\u{1F600}' }).map((r) => r.id)).toEqual(['\uFF21', 'z']);
    });

    it('keyset paging: before + beforeId, with a tie straddling the page edge', () => {
      const s = make();
      for (const [id, at] of [['a', 10], ['b', 10], ['c', 10], ['d', 10], ['e', 5]] as const) s.insertAudit(row(id, at));
      const p1 = s.listAudit({ limit: 2 });
      expect(p1.map((r) => r.id)).toEqual(['d', 'c']);
      const p2 = s.listAudit({ limit: 2, before: 10, beforeId: 'c' });
      expect(p2.map((r) => r.id)).toEqual(['b', 'a']);
      const p3 = s.listAudit({ limit: 2, before: 10, beforeId: 'a' });
      expect(p3.map((r) => r.id)).toEqual(['e']);
      expect(s.listAudit({ limit: 2, before: 5, beforeId: 'e' })).toEqual([]);
    });

    it('before without beforeId is exclusive on at; beforeId without before is ignored', () => {
      const s = make();
      for (const [id, at] of [['a', 10], ['b', 10], ['c', 5]] as const) s.insertAudit(row(id, at));
      expect(s.listAudit({ limit: 9, before: 10 }).map((r) => r.id)).toEqual(['c']);
      expect(s.listAudit({ limit: 9, beforeId: 'a' }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    });

    it('filters by actor and action, alone and together', () => {
      const s = make();
      s.insertAudit(row('1', 1, { actor: 'alice', action: 'report.view' }));
      s.insertAudit(row('2', 2, { actor: 'bob', action: 'report.view' }));
      s.insertAudit(row('3', 3, { actor: 'alice', action: 'suggest' }));
      const ids = (q: object) => s.listAudit({ limit: 9, ...q }).map((r) => r.id);
      expect(ids({ actor: 'alice' })).toEqual(['3', '1']);
      expect(ids({ action: 'report.view' })).toEqual(['2', '1']);
      expect(ids({ actor: 'alice', action: 'report.view' })).toEqual(['1']);
      expect(ids({ actor: 'nobody' })).toEqual([]);
      expect(ids({ actor: 'Alice' })).toEqual([]);
    });

    it('limit is clamped to 1..200 and a fraction is floored', () => {
      const s = make();
      for (let i = 0; i < 205; i++) s.insertAudit(row(`id${String(i).padStart(3, '0')}`, i));
      expect(s.listAudit({ limit: 500 })).toHaveLength(200);
      expect(s.listAudit({ limit: 0 })).toHaveLength(1);
      expect(s.listAudit({ limit: 2.9 })).toHaveLength(2);
    });

    it('an empty trail lists nothing', () => {
      expect(make().listAudit({ limit: 10 })).toEqual([]);
    });

    it('a duplicate id throws and writes nothing', () => {
      const s = make();
      s.insertAudit(row('same', 1));
      expect(() => s.insertAudit(row('same', 2))).toThrow();
      expect(s.listAudit({ limit: 9 })).toHaveLength(1);
    });

    it('insertAudit joins the surrounding transaction: a throw after it undoes it', () => {
      const s = make();
      s.insertAudit(row('keep', 1));
      expect(() =>
        s.transaction(() => {
          s.insertAudit(row('gone', 2));
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(s.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['keep']);
    });

    it('listed rows are copies', () => {
      const s = make();
      s.insertAudit(row('a', 1));
      const [first] = s.listAudit({ limit: 1 });
      if (first?.target) first.target.ref = 'tampered';
      expect(s.listAudit({ limit: 1 })[0]?.target?.ref).toBe('ref_a');
    });

    it('the stored row is a copy of what was inserted', () => {
      const s = make();
      const r = row('a', 1);
      s.insertAudit(r);
      if (r.target) r.target.ref = 'tampered';
      expect(s.listAudit({ limit: 1 })[0]?.target?.ref).toBe('ref_a');
    });

    it('purgeAudit deletes strictly older rows and returns the count; a row on the line is kept', () => {
      const s = make();
      s.insertAudit(row('old', 99));
      s.insertAudit(row('line', 100));
      s.insertAudit(row('new', 101));
      expect(s.purgeAudit(100)).toBe(1);
      expect(s.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['new', 'line']);
      expect(s.purgeAudit(100)).toBe(0);
      expect(s.purgeAudit(1_000)).toBe(2);
    });

    it('purgeAudit is undone with its transaction', () => {
      const s = make();
      s.insertAudit(row('a', 1));
      expect(() =>
        s.transaction(() => {
          s.purgeAudit(100);
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(s.listAudit({ limit: 9 })).toHaveLength(1);
    });

    it('pages a mixed trail identically however it is walked: by cursor and by one big read', () => {
      const s = make();
      for (let i = 0; i < 40; i++) {
        s.insertAudit(
          row(`id${String((i * 7) % 40).padStart(2, '0')}`, NOW + Math.floor(i / 4), {
            actor: i % 3 === 0 ? 'alice' : 'bob',
            action: AUDIT_ACTIONS[i % AUDIT_ACTIONS.length] as AuditRow['action'],
            role: i % 5 === 0 ? null : (['moderator', 'senior', 'owner'] as const)[i % 3] ?? null,
            target: i % 4 === 0 ? null : { type: 'report', ref: `r${i}` },
          }),
        );
      }
      const all = s.listAudit({ limit: 200 });
      expect(all).toHaveLength(40);
      const walked: AuditRow[] = [];
      let cursor: { before: number; beforeId: string } | undefined;
      for (;;) {
        const page = s.listAudit({ limit: 7, ...(cursor ?? {}) });
        if (page.length === 0) break;
        walked.push(...page);
        const last = page[page.length - 1] as AuditRow;
        cursor = { before: last.at, beforeId: last.id };
      }
      expect(walked).toEqual(all);
    });

    it('closeGap records a gap.close entry (null role, sanction target), once', async () => {
      const store = make();
      const subjects = new SubjectIndex(store, { now: () => NOW }, { logger: { warn() {} } });
      const sub = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null });
      if (sub === null) throw new Error('expected a subject');
      const w = await applySanction(
        store,
        subjects,
        {
          kind: 'ban', subject: sub, includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator',
          automated: false, rule: 'uncovered', gapNote: 'a note about a gap',
        } as never,
        NOW,
      );
      expect(store.closeGap(w.groupId, 'ruled', '9', 'boss', NOW + 100)).toBe(true);
      expect(store.closeGap(w.groupId, 'ruled', '9', 'boss', NOW + 200)).toBe(false);
      const items = store.listAudit({ limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ at: NOW + 100, actor: 'boss', role: null, action: 'gap.close', target: { type: 'sanction', ref: w.groupId } });
      expect(typeof items[0]?.id).toBe('string');
      expect(items[0]?.id.length).toBeGreaterThan(0);
    });
  });
}
