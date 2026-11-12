import { describe, expect, it } from 'vitest';
import type { SignalRow } from '@chatwarden/core';
import { MemoryStore, createMemoryStore, withMemorySignals } from '../src/index.js';

// What is specific to MemoryStore in the signal methods: it stores copies, it is built to be subclassed, and it keeps its subject index
// in step. The behaviour it shares with SqliteStore is in the shared contract suite (test/contract/signals.contract.ts, run by contract.test.ts).

const NOW = 1_800_000_000_000;
const row = (over: Partial<SignalRow> = {}): SignalRow => ({
  id: 'sig-1',
  kind: 'muted_by_player',
  subject: 's_target',
  sourceKey: 'b:s_from',
  bySubject: 's_from',
  roomId: null,
  at: NOW,
  weight: 1,
  capBucket: 20_833,
  ...over,
});

describe('withMemorySignals: the signal methods are opt-in', () => {
  const NAMES = ['insertSignal', 'listSignalSources', 'purgeSignals'] as const;

  it('a plain MemoryStore, and createMemoryStore(), have none of the three methods', () => {
    for (const s of [new MemoryStore(), createMemoryStore()]) for (const name of NAMES) expect(typeof (s as unknown as Record<string, unknown>)[name]).toBe('undefined');
  });

  it('returns the same store, now with the three methods, that work', () => {
    const plain = new MemoryStore();
    const s = withMemorySignals(plain);
    expect(s).toBe(plain);
    for (const name of NAMES) expect(typeof s[name]).toBe('function');
    expect(s.insertSignal(row())).toBe(true);
    expect(s.listSignalSources(['s_target'], 0)).toHaveLength(1);
  });

  it('the methods are not enumerable, so they do not show as own state', () => {
    const s = withMemorySignals(new MemoryStore());
    expect(Object.keys(s).filter((k) => /Signal/.test(k))).toEqual([]);
  });

  it('is idempotent: a second call changes nothing, and rows already stored stay', () => {
    const s = withMemorySignals(new MemoryStore());
    s.insertSignal(row());
    const insert = s.insertSignal;
    withMemorySignals(s);
    expect(s.insertSignal).toBe(insert);
    expect(s.listSignalSources(['s_target'], 0)).toHaveLength(1);
  });

  it('keeps a method the store already has (a subclass override)', () => {
    class Own extends MemoryStore {
      insertSignal(): boolean {
        return false;
      }
    }
    const s = withMemorySignals(new Own());
    expect(s.insertSignal(row())).toBe(false);
    expect(typeof s.listSignalSources).toBe('function');
  });

  it('keeps the state apart per store', () => {
    const a = withMemorySignals(new MemoryStore());
    const b = withMemorySignals(new MemoryStore());
    a.insertSignal(row());
    expect(b.listSignalSources(['s_target'], 0)).toEqual([]);
  });

  it('an undone transaction undoes an insert and a purge', () => {
    const s = withMemorySignals(new MemoryStore());
    s.insertSignal(row());
    expect(() =>
      s.transaction(() => {
        s.insertSignal(row({ id: 'sig-2', sourceKey: 'b:s_other' }));
        expect(s.purgeSignals(NOW + 1)).toBe(2);
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(s.listSignalSources(['s_target'], 0)).toHaveLength(1);
    expect(s.insertSignal(row({ id: 'sig-2', sourceKey: 'b:s_other' }))).toBe(true);
  });
});

describe('MemoryStore signals', () => {
  it('stores a copy: editing the row after the insert changes nothing', () => {
    const s = withMemorySignals(new MemoryStore());
    const r = row();
    expect(s.insertSignal(r)).toBe(true);
    r.weight = 99;
    r.at = 0;
    expect(s.listSignalSources(['s_target'], 0)).toMatchObject([{ weight: 1, firstAt: NOW }]);
  });

  it('inserting does not move the change token (signals are not a queue change)', () => {
    const s = withMemorySignals(new MemoryStore());
    const before = s.changeToken();
    s.insertSignal(row());
    s.purgeSignals(NOW + 1);
    expect(s.changeToken()).toBe(before);
  });

  it('purges many rows of many subjects and keeps the per-subject index in step', () => {
    const s = withMemorySignals(new MemoryStore());
    for (let i = 0; i < 300; i += 1) s.insertSignal(row({ id: `s${i}`, subject: `s_${i % 10}`, sourceKey: `d:${i}`, bySubject: null, at: NOW + i }));
    expect(s.purgeSignals(NOW + 150)).toBe(150);
    expect(s.listSignalSources(['s_0'], 0)).toHaveLength(15);
    expect(s.purgeSignals(NOW + 10_000)).toBe(150);
    for (let i = 0; i < 10; i += 1) expect(s.listSignalSources([`s_${i}`], 0)).toEqual([]);
    expect(s.insertSignal(row({ id: 'again', sourceKey: 'd:0', bySubject: null, subject: 's_0' }))).toBe(true);
  });
});
