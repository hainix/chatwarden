import { describe, expect, it } from 'vitest';
import type { AiActingRow, Store } from '@chatwarden/core';

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
