import { describe, expect, it } from 'vitest';
import type { AIRead, AiActingRow, AiActionRow, AiReadPending, Store, StoredReport } from '@chatwarden/core';

// The contract of the shadow release's store methods (AI levels 3 and 4, design 6.5, release 2): the one-row acting state (a conditional transition, so two
// processes cannot both move it), the confirming read's `purpose` (a confirming read is its own row and never the case's read) and the action rows
// (`kit_ai_actions`, one per report). One suite, run against every Store; SqliteStore is the reference.

const T = 1_800_000_000_000;
const OFF: AiActingRow = { mode: 'off', modeSince: null, modeBy: null, paused: false, pausedSince: null, pausedBy: null };

type ActingStore = Store & Required<Pick<Store, 'aiActingState' | 'setAiActingState'>>;
const acting = (s: Store): ActingStore => {
  for (const m of ['aiActingState', 'setAiActingState'] as const) if (s[m] === undefined) throw new Error(`this store has no ${m}`);
  return s as ActingStore;
};

export function aiShadowContract(name: string, make: () => Store): void {
  describe(`ai shadow contract: ${name}`, () => {
    describe('the confirming read (purpose)', () => {
      type ReadStore = Store & Required<Pick<Store, 'reserveAiRead' | 'completeAiRead' | 'failAiRead' | 'loadAiRead' | 'loadAiReads' | 'loadAiReadById' | 'loadAiReadFor' | 'listAiRetries' | 'aiSpendSince'>>;
      const reads = (s: Store): ReadStore => {
        for (const m of ['reserveAiRead', 'completeAiRead', 'failAiRead', 'loadAiRead', 'loadAiReads', 'loadAiReadById', 'loadAiReadFor', 'listAiRetries', 'aiSpendSince'] as const) {
          if (s[m] === undefined) throw new Error(`this store has no ${m}`);
        }
        return s as ReadStore;
      };
      const READ: AIRead = { severity: 'hostile', rule: 2, summary: 's', evidence: ['line1'], confidence: 'high', injectionSuspected: false, recommendation: { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['line1'] } };
      const usage = { model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 700, latencyMs: 5 };
      const pending = (over: Partial<AiReadPending> = {}): AiReadPending => ({ reportId: 'r1', inputHash: 'h-read', promptVersion: 5, adapter: 'a', ...over });
      /** A finished read of purpose `purpose` at `at` (the clock the store sees is the caller's). */
      const done = (s: ReadStore, purpose: 'read' | 'confirm' | undefined, hash: string, at: number, report = 'r1'): string => {
        const r = s.reserveAiRead(pending({ reportId: report, inputHash: hash, ...(purpose === undefined ? {} : { purpose }) }), at + 60_000, at);
        if (!r.reserved) throw new Error('not reserved');
        expect(s.completeAiRead(r.id, r.lease, { ...usage, read: READ })).toBe(true);
        return r.id;
      };

      it('a row says what it is for: read by default, confirm when asked, and the choice is kept', () => {
        const s = reads(make());
        const a = done(s, undefined, 'h1', T);
        const b = done(s, 'read', 'h2', T + 1);
        const c = done(s, 'confirm', 'h3', T + 2);
        expect([a, b, c].map((id) => s.loadAiReadById(id)?.purpose)).toEqual(['read', 'read', 'confirm']);
        expect(s.loadAiReadFor('r1', 'h3')?.purpose).toBe('confirm');
      });

      it('a confirming read is a row of its own beside the case read, even for the same report and the same time', () => {
        const s = reads(make());
        const a = done(s, 'read', 'h-read', T);
        const b = done(s, 'confirm', 'h-confirm', T);
        expect(a).not.toBe(b);
        expect(s.loadAiReadFor('r1', 'h-read')?.id).toBe(a);
        expect(s.loadAiReadFor('r1', 'h-confirm')?.id).toBe(b);
      });

      it('loadAiRead and loadAiReads never return a confirming read, however new', () => {
        const s = reads(make());
        const a = done(s, 'read', 'h1', T);
        done(s, 'confirm', 'h2', T + 5_000);
        expect(s.loadAiRead('r1')?.id).toBe(a);
        expect(s.loadAiReads(['r1']).map((r) => r.id)).toEqual([a]);
      });

      it('a report with only a confirming read has no case read at all', () => {
        const s = reads(make());
        done(s, 'confirm', 'h2', T);
        expect(s.loadAiRead('r1')).toBeNull();
        expect(s.loadAiReads(['r1', 'r2'])).toEqual([]);
      });

      it('listAiRetries leaves out a confirming read that failed, was skipped or lost its lease, and still lists the same for a read', () => {
        const s = reads(make());
        // a failed confirming read, due now
        const c1 = s.reserveAiRead(pending({ inputHash: 'c1', purpose: 'confirm' }), T + 1000, T);
        if (!c1.reserved) throw new Error('not reserved');
        s.failAiRead(c1.id, c1.lease, 'failed', 'retryable', T + 10);
        // a confirming read whose owner died (lease ended)
        s.reserveAiRead(pending({ reportId: 'r2', inputHash: 'c2', purpose: 'confirm' }), T + 5, T);
        // a case read in the same two states
        const r1 = s.reserveAiRead(pending({ reportId: 'r3', inputHash: 'x1' }), T + 1000, T);
        if (!r1.reserved) throw new Error('not reserved');
        s.failAiRead(r1.id, r1.lease, 'failed', 'retryable', T + 10);
        s.reserveAiRead(pending({ reportId: 'r4', inputHash: 'x2' }), T + 5, T);
        expect(s.listAiRetries(T + 60_000, 50).map((r) => r.reportId).sort()).toEqual(['r3', 'r4']);
      });

      it('both kinds are booked to the same spend and call count', () => {
        const s = reads(make());
        done(s, 'read', 'h1', T);
        done(s, 'confirm', 'h2', T + 1);
        expect(s.aiSpendSince(T)).toEqual({ micros: 1400, calls: 2 });
      });

      it('a confirming read is taken over, retried and finished like a read (the fence and the lease are the same)', () => {
        const s = reads(make());
        const first = s.reserveAiRead(pending({ inputHash: 'c', purpose: 'confirm' }), T + 100, T);
        if (!first.reserved) throw new Error('not reserved');
        // a second caller while the lease holds gets the row, not a call
        expect(s.reserveAiRead(pending({ inputHash: 'c', purpose: 'confirm' }), T + 200, T + 50)).toMatchObject({ reserved: false, existing: { id: first.id, purpose: 'confirm', status: 'pending' } });
        // after the lease ends the next caller takes it over, with a higher fence, and the first owner is stale
        const second = s.reserveAiRead(pending({ inputHash: 'c', purpose: 'confirm' }), T + 400, T + 150);
        if (!second.reserved) throw new Error('not reserved');
        expect(second.id).toBe(first.id);
        expect(second.lease).toBe(first.lease + 1);
        expect(s.completeAiRead(first.id, first.lease, { ...usage, read: READ })).toBe(false);
        expect(s.completeAiRead(second.id, second.lease, { ...usage, read: READ })).toBe(true);
        expect(s.loadAiReadById(second.id)).toMatchObject({ purpose: 'confirm', status: 'ok' });
      });
    });

    describe('the acting state', () => {
      it('reads as off, not paused, with nothing set, on a fresh store', () => {
        expect(acting(make()).aiActingState()).toEqual(OFF);
      });

      it('moves only from the state the caller expects, and says whether it did', () => {
        const s = acting(make());
        const shadow: AiActingRow = { ...OFF, mode: 'shadow', modeSince: T, modeBy: 'owner_ann' };
        expect(s.setAiActingState({ mode: 'off', paused: false }, shadow)).toBe(true);
        expect(s.aiActingState()).toEqual(shadow);
        // a second caller that read "off" a moment ago changes nothing
        const other: AiActingRow = { ...OFF, mode: 'shadow', modeSince: T + 5, modeBy: 'owner_bob' };
        expect(s.setAiActingState({ mode: 'off', paused: false }, other)).toBe(false);
        expect(s.aiActingState()).toEqual(shadow);
      });

      it('compares the paused flag too: pause and resume are conditional', () => {
        const s = acting(make());
        const on: AiActingRow = { ...OFF, mode: 'on', modeSince: T, modeBy: 'owner_ann' };
        expect(s.setAiActingState({ mode: 'off', paused: false }, on)).toBe(true);
        const paused: AiActingRow = { ...on, paused: true, pausedSince: T + 1, pausedBy: 'sen_ann' };
        expect(s.setAiActingState({ mode: 'on', paused: true }, paused)).toBe(false);
        expect(s.setAiActingState({ mode: 'on', paused: false }, paused)).toBe(true);
        expect(s.aiActingState()).toEqual(paused);
        // a second pause is refused: the state is no longer "not paused"
        expect(s.setAiActingState({ mode: 'on', paused: false }, { ...paused, pausedBy: 'sen_bob' })).toBe(false);
        expect(s.aiActingState().pausedBy).toBe('sen_ann');
        expect(s.setAiActingState({ mode: 'on', paused: true }, on)).toBe(true);
        expect(s.aiActingState()).toEqual(on);
      });

      it('an expected state that is not off does not create a row from nothing', () => {
        const s = acting(make());
        expect(s.setAiActingState({ mode: 'shadow', paused: false }, { ...OFF, mode: 'on', modeSince: T, modeBy: 'o' })).toBe(false);
        expect(s.aiActingState()).toEqual(OFF);
      });

      it('returns a copy: changing it changes nothing in the store', () => {
        const s = acting(make());
        s.setAiActingState({ mode: 'off', paused: false }, { ...OFF, mode: 'shadow', modeSince: T, modeBy: 'o' });
        const a = s.aiActingState();
        a.mode = 'on';
        expect(s.aiActingState().mode).toBe('shadow');
      });

      it('is undone with a rolled-back transaction', () => {
        const s = acting(make());
        expect(() =>
          s.transaction(() => {
            expect(s.setAiActingState({ mode: 'off', paused: false }, { ...OFF, mode: 'shadow', modeSince: T, modeBy: 'o' })).toBe(true);
            throw new Error('rollback');
          }),
        ).toThrow('rollback');
        expect(s.aiActingState()).toEqual(OFF);
      });

      it('keeps off with a time and a name too (turning it off is a state, not an absence)', () => {
        const s = acting(make());
        s.setAiActingState({ mode: 'off', paused: false }, { ...OFF, mode: 'shadow', modeSince: T, modeBy: 'o' });
        const off: AiActingRow = { ...OFF, modeSince: T + 9, modeBy: 'owner_ann' };
        expect(s.setAiActingState({ mode: 'shadow', paused: false }, off)).toBe(true);
        expect(s.aiActingState()).toEqual(off);
      });
    });

    describe('the action rows (kit_ai_actions)', () => {
      type ActionStore = Store & Required<Pick<Store, 'insertAiAction' | 'loadAiAction' | 'transitionAiAction' | 'dueAiActions' | 'listAiActions' | 'aiActionCounts' | 'aiActedCount' | 'aiActionsOnSubjects' | 'aiUnreviewed'>>;
      const METHODS = ['insertAiAction', 'loadAiAction', 'transitionAiAction', 'dueAiActions', 'listAiActions', 'aiActionCounts', 'aiActedCount', 'aiActionsOnSubjects', 'aiUnreviewed'] as const;
      const actions = (s: Store): ActionStore => {
        for (const m of METHODS) if (s[m] === undefined) throw new Error(`this store has no ${m}`);
        return s as ActionStore;
      };
      let n = 0;
      /** A queued row for report `report`, due ten minutes after T; anything a test cares about is overridden. */
      const row = (report: string, over: Partial<AiActionRow> = {}): AiActionRow => {
        n += 1;
        return {
          id: `act${n}`,
          reportId: report,
          readId: `read-${report}`,
          confirmReadId: null,
          rule: '3',
          severity: 'hostile',
          state: 'queued',
          refusedCode: null,
          notBefore: T + 600_000,
          createdAt: T,
          groupId: null,
          kind: null,
          durationMs: null,
          actedAt: null,
          reviewDueAt: null,
          reviewedAt: null,
          reviewedBy: null,
          undoCode: null,
          undoNote: null,
          adapter: 'fake:model',
          promptVersion: 5,
          ...over,
        };
      };
      const report = (id: string, target: string): StoredReport => ({
        id,
        createdAt: T,
        roomId: `room-${id}`,
        tags: {},
        reporterSubject: 's_reporter',
        reporterSeat: 'p1',
        reporterHandle: 'R',
        targetSubject: target,
        targetSeat: 'p2',
        targetHandle: 'T',
        category: 'harassment',
        reportedReason: 'harassment',
        note: null,
        lineId: null,
        excerpt: [],
        people: [target],
        status: 'open',
      });

      it('inserts one row per report, ever: a second insert for the same report writes nothing and says false', () => {
        const s = actions(make());
        expect(s.insertAiAction(row('r1'))).toBe(true);
        expect(s.insertAiAction(row('r1', { state: 'held_back' }))).toBe(false);
        expect(s.loadAiAction('r1')).toMatchObject({ state: 'queued' });
        expect(s.insertAiAction(row('r2'))).toBe(true);
      });

      it('loads by report, a copy, with every field; unknown is null', () => {
        const s = actions(make());
        const r = row('r1', { confirmReadId: 'c1', kind: 'chat', durationMs: 3_600_000, actedAt: T + 5, undoNote: 'private', adapter: null, promptVersion: null });
        s.insertAiAction(r);
        expect(s.loadAiAction('r1')).toEqual(r);
        expect(s.loadAiAction('nope')).toBeNull();
        const copy = s.loadAiAction('r1');
        if (copy !== null) copy.state = 'undone';
        expect(s.loadAiAction('r1')?.state).toBe('queued');
      });

      it('transitions only from a state the caller names: a second caller changes nothing and is told so', () => {
        const s = actions(make());
        const r = row('r1');
        s.insertAiAction(r);
        expect(s.transitionAiAction(r.id, ['queued'], { state: 'shadow', actedAt: T + 1, kind: 'warning', confirmReadId: 'c1' })).toBe(true);
        expect(s.loadAiAction('r1')).toMatchObject({ state: 'shadow', actedAt: T + 1, kind: 'warning', confirmReadId: 'c1', readId: r.readId, createdAt: T });
        expect(s.transitionAiAction(r.id, ['queued'], { state: 'refused', refusedCode: 'cap_hour' })).toBe(false);
        expect(s.loadAiAction('r1')).toMatchObject({ state: 'shadow', refusedCode: null });
        expect(s.transitionAiAction(r.id, ['shadow', 'active'], { state: 'confirmed' })).toBe(true);
        expect(s.transitionAiAction('no-such-id', ['queued'], { state: 'refused' })).toBe(false);
      });

      it('a patch changes only the fields it names; the report and the creation time never move', () => {
        const s = actions(make());
        const r = row('r1', { confirmReadId: 'c1', adapter: 'a1' });
        s.insertAiAction(r);
        s.transitionAiAction(r.id, ['queued'], { state: 'refused', refusedCode: 'gate_failed:volume' });
        expect(s.loadAiAction('r1')).toEqual({ ...r, state: 'refused', refusedCode: 'gate_failed:volume' });
        s.transitionAiAction(r.id, ['refused'], { confirmReadId: null, reportId: 'other', createdAt: 1 } as never);
        expect(s.loadAiAction('r1')).toMatchObject({ reportId: 'r1', createdAt: T, confirmReadId: null });
      });

      it('is undone with a rolled-back transaction, insert and transition alike', () => {
        const s = actions(make());
        const r = row('r1');
        expect(() =>
          s.transaction(() => {
            expect(s.insertAiAction(r)).toBe(true);
            expect(s.transitionAiAction(r.id, ['queued'], { state: 'shadow' })).toBe(true);
            throw new Error('rollback');
          }),
        ).toThrow('rollback');
        expect(s.loadAiAction('r1')).toBeNull();
        s.insertAiAction(r);
        expect(() =>
          s.transaction(() => {
            s.transitionAiAction(r.id, ['queued'], { state: 'refused', refusedCode: 'x' });
            throw new Error('rollback');
          }),
        ).toThrow('rollback');
        expect(s.loadAiAction('r1')).toMatchObject({ state: 'queued', refusedCode: null });
      });

      it('lists the queued rows that are due, oldest first, at most limit, and no other state', () => {
        const s = actions(make());
        s.insertAiAction(row('a', { notBefore: T + 300 }));
        s.insertAiAction(row('b', { notBefore: T + 100 }));
        s.insertAiAction(row('c', { notBefore: T + 900 }));
        s.insertAiAction(row('d', { notBefore: T + 50, state: 'shadow' }));
        s.insertAiAction(row('e', { notBefore: T + 60, state: 'held_back' }));
        s.insertAiAction(row('f', { notBefore: T + 70, state: 'refused' }));
        expect(s.dueAiActions(T + 99, 10)).toEqual([]);
        expect(s.dueAiActions(T + 100, 10).map((r) => r.reportId)).toEqual(['b']);
        expect(s.dueAiActions(T + 500, 10).map((r) => r.reportId)).toEqual(['b', 'a']);
        expect(s.dueAiActions(T + 5000, 2).map((r) => r.reportId)).toEqual(['b', 'a']);
        expect(s.dueAiActions(T + 5000, undefined).map((r) => r.reportId)).toEqual(['b', 'a', 'c']);
        expect(s.dueAiActions(T + 5000, 0)).toHaveLength(3);
      });

      it('lists newest first by creation time then id, filtered by state, a page at a time with a cursor', () => {
        const s = actions(make());
        for (let i = 0; i < 5; i += 1) s.insertAiAction(row(`s${i}`, { state: 'shadow', createdAt: T + i * 10, id: `id-s${i}` }));
        s.insertAiAction(row('q0', { createdAt: T + 100, id: 'id-q0' }));
        s.insertAiAction(row('x0', { state: 'refused', refusedCode: 'cap_day', createdAt: T + 110, id: 'id-x0' }));
        expect(s.listAiActions({ state: 'shadow', limit: 10 }).map((r) => r.reportId)).toEqual(['s4', 's3', 's2', 's1', 's0']);
        expect(s.listAiActions({ state: ['queued', 'refused'], limit: 10 }).map((r) => r.reportId)).toEqual(['x0', 'q0']);
        expect(s.listAiActions({ limit: 3 }).map((r) => r.reportId)).toEqual(['x0', 'q0', 's4']);
        const page1 = s.listAiActions({ state: 'shadow', limit: 2 });
        const last = page1[1] as AiActionRow;
        expect(s.listAiActions({ state: 'shadow', limit: 2, after: { at: last.createdAt, id: last.id } }).map((r) => r.reportId)).toEqual(['s2', 's1']);
        expect(s.listAiActions({ state: 'shadow', limit: 0 })).toHaveLength(5);
        expect(s.listAiActions({ state: 'shadow', limit: 9999 })).toHaveLength(5);
      });

      it('lists rows created at the same time in a stable order (id, newest first)', () => {
        const s = actions(make());
        for (const k of ['a', 'b', 'c']) s.insertAiAction(row(`r-${k}`, { state: 'shadow', createdAt: T, id: `id-${k}` }));
        expect(s.listAiActions({ state: 'shadow', limit: 10 }).map((r) => r.id)).toEqual(['id-c', 'id-b', 'id-a']);
      });

      it('counts by state and refusals by code from a time on, never a text', () => {
        const s = actions(make());
        s.insertAiAction(row('a', { state: 'shadow', createdAt: T }));
        s.insertAiAction(row('b', { state: 'shadow', createdAt: T + 10 }));
        s.insertAiAction(row('c', { state: 'refused', refusedCode: 'gate_failed:volume', createdAt: T + 10 }));
        s.insertAiAction(row('d', { state: 'refused', refusedCode: 'gate_failed:volume', createdAt: T + 20 }));
        s.insertAiAction(row('e', { state: 'refused', refusedCode: 'cap_hour', createdAt: T + 30 }));
        s.insertAiAction(row('f', { state: 'held_back', createdAt: T + 30 }));
        s.insertAiAction(row('g', { createdAt: T + 40 }));
        expect(s.aiActionCounts(T)).toEqual({ byState: { shadow: 2, refused: 3, held_back: 1, queued: 1 }, refused: { 'gate_failed:volume': 2, cap_hour: 1 } });
        expect(s.aiActionCounts(T + 15)).toEqual({ byState: { refused: 2, held_back: 1, queued: 1 }, refused: { 'gate_failed:volume': 1, cap_hour: 1 } });
        expect(s.aiActionCounts(T + 1000)).toEqual({ byState: {}, refused: {} });
      });

      it('counts the actions that acted (or would have: shadow, active, confirmed, undone) from a time on, by when they acted', () => {
        const s = actions(make());
        s.insertAiAction(row('a', { state: 'shadow', actedAt: T + 10 }));
        s.insertAiAction(row('b', { state: 'active', actedAt: T + 20 }));
        s.insertAiAction(row('c', { state: 'confirmed', actedAt: T + 30 }));
        s.insertAiAction(row('d', { state: 'undone', actedAt: T + 40, undoCode: 'wrong_rule', reviewedAt: T + 50 }));
        s.insertAiAction(row('e', { state: 'queued', actedAt: null }));
        s.insertAiAction(row('f', { state: 'refused', refusedCode: 'cap_day', actedAt: null }));
        s.insertAiAction(row('g', { state: 'held_back' }));
        expect(s.aiActedCount(T)).toBe(4);
        expect(s.aiActedCount(T + 20)).toBe(3);
        expect(s.aiActedCount(T + 40)).toBe(1);
        expect(s.aiActedCount(T + 41)).toBe(0);
      });

      it('counts the actions on a person (their aliases, through the report) and the undos as not a violation', () => {
        const s = actions(make());
        s.insertReport(report('r1', 's_p1'));
        s.insertReport(report('r2', 's_p1_alias'));
        s.insertReport(report('r3', 's_other'));
        s.insertReport(report('r4', 's_p1'));
        s.insertAiAction(row('r1', { state: 'shadow', actedAt: T + 10 }));
        s.insertAiAction(row('r2', { state: 'undone', actedAt: T + 20, undoCode: 'not_a_violation', reviewedAt: T + 30 }));
        s.insertAiAction(row('r3', { state: 'active', actedAt: T + 20 }));
        s.insertAiAction(row('r4', { state: 'undone', actedAt: T + 5, undoCode: 'too_heavy', reviewedAt: T + 6 }));
        expect(s.aiActionsOnSubjects(['s_p1', 's_p1_alias'], T, T)).toEqual({ acted: 3, undone: 1 });
        expect(s.aiActionsOnSubjects(['s_p1'], T, T)).toEqual({ acted: 2, undone: 0 });
        expect(s.aiActionsOnSubjects(['s_p1', 's_p1_alias'], T + 15, T + 31)).toEqual({ acted: 1, undone: 0 });
        expect(s.aiActionsOnSubjects(['s_other'], T, T)).toEqual({ acted: 1, undone: 0 });
        expect(s.aiActionsOnSubjects(['s_nobody'], T, T)).toEqual({ acted: 0, undone: 0 });
        expect(s.aiActionsOnSubjects([], T, T)).toEqual({ acted: 0, undone: 0 });
      });

      it('counts the unreviewed (active) actions and the oldest one time; shadow, confirmed and undone are not unreviewed', () => {
        const s = actions(make());
        expect(s.aiUnreviewed()).toEqual({ n: 0, oldestActedAt: null });
        s.insertAiAction(row('a', { state: 'active', actedAt: T + 30 }));
        s.insertAiAction(row('b', { state: 'active', actedAt: T + 10 }));
        s.insertAiAction(row('c', { state: 'shadow', actedAt: T }));
        s.insertAiAction(row('d', { state: 'confirmed', actedAt: T, reviewedAt: T + 1 }));
        s.insertAiAction(row('e', { state: 'undone', actedAt: T, undoCode: 'wrong_rule', reviewedAt: T + 1 }));
        expect(s.aiUnreviewed()).toEqual({ n: 2, oldestActedAt: T + 10 });
      });
    });
  });
}
