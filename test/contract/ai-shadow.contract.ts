import { describe, expect, it } from 'vitest';
import type { AIRead, AiActingRow, AiReadPending, Store } from '@chatwarden/core';

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
  });
}
