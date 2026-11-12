import { describe, expect, it } from 'vitest';
import type { SignalRow } from '@chatwarden/core';
import { MemoryStore } from '../src/index.js';

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

describe('MemoryStore signals', () => {
  it('stores a copy: editing the row after the insert changes nothing', () => {
    const s = new MemoryStore();
    const r = row();
    expect(s.insertSignal(r)).toBe(true);
    r.weight = 99;
    r.at = 0;
    expect(s.listSignalSources(['s_target'], 0)).toMatchObject([{ weight: 1, firstAt: NOW }]);
  });

  it('is built to be subclassed: the methods live on the prototype', () => {
    class Counting extends MemoryStore {
      inserts = 0;
      override insertSignal(r: SignalRow): boolean {
        this.inserts += 1;
        return super.insertSignal(r);
      }
    }
    const s = new Counting();
    s.insertSignal(row());
    s.insertSignal(row({ id: 'sig-2' }));
    expect(s.inserts).toBe(2);
    expect(s.listSignalSources(['s_target'], 0)).toHaveLength(1);
  });

  it('inserting does not move the change token (signals are not a queue change)', () => {
    const s = new MemoryStore();
    const before = s.changeToken();
    s.insertSignal(row());
    s.purgeSignals(NOW + 1);
    expect(s.changeToken()).toBe(before);
  });

  it('purges many rows of many subjects and keeps the per-subject index in step', () => {
    const s = new MemoryStore();
    for (let i = 0; i < 300; i += 1) s.insertSignal(row({ id: `s${i}`, subject: `s_${i % 10}`, sourceKey: `d:${i}`, bySubject: null, at: NOW + i }));
    expect(s.purgeSignals(NOW + 150)).toBe(150);
    expect(s.listSignalSources(['s_0'], 0)).toHaveLength(15);
    expect(s.purgeSignals(NOW + 10_000)).toBe(150);
    for (let i = 0; i < 10; i += 1) expect(s.listSignalSources([`s_${i}`], 0)).toEqual([]);
    expect(s.insertSignal(row({ id: 'again', sourceKey: 'd:0', bySubject: null, subject: 's_0' }))).toBe(true);
  });
});
