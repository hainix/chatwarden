import { describe, expect, it } from 'vitest';
import { appealsKit } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// The signed link on each sanction notice of `pending` and `record` (0.2.1, R2 minor 4): what is read from the store to make a link is read once per notice for one call, however many
// times the list names it, and nothing is remembered between calls (a decision made between two calls shows in the second).

const LANDING = 'https://game.example/appeal';
const URL_RE = /^https:\/\/game\.example\/appeal\?t=/;

type Reads = { loadNotice: number; loadAppealByGroup: number };

/** Count the two store reads a link makes, and optionally make the store list every notice twice. */
function spy(k: AppealsKit, o: { doubled?: boolean } = {}): Reads {
  const counts: Reads = { loadNotice: 0, loadAppealByGroup: 0 };
  const s = k.store as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['loadNotice', 'loadAppealByGroup'] as const) {
    const real = s[name] as (...a: unknown[]) => unknown;
    s[name] = (...a: unknown[]) => {
      counts[name] += 1;
      return real.apply(k.store, a);
    };
  }
  if (o.doubled === true) {
    const real = s.loadNotices as (...a: unknown[]) => unknown[];
    s.loadNotices = (...a: unknown[]) => {
      const rows = real.apply(k.store, a);
      return [...rows, ...rows];
    };
  }
  return counts;
}
const make = (landing = true) => appealsKit(landing ? ({ appeals: { landingUrl: LANDING } } as never) : ({} as never), { perPlayerPerWeek: 20 });

describe('the links of one pending or record call', () => {
  it('two sanction notices: a link on each, one notice read and one appeal read for each', async () => {
    const k = await make();
    const a = await k.sanction({ key: 'memo-a' });
    await k.sanction({ key: 'memo-a', kind: 'warning' });
    const counts = spy(k);
    const pending = k.cw.notices.pending(a.who);
    expect(pending).toHaveLength(2);
    for (const n of pending) expect(n.appealUrl).toMatch(URL_RE);
    expect(counts).toEqual({ loadNotice: 2, loadAppealByGroup: 2 });
  });

  it('a notice the store lists twice gets its link twice but its reads once, in pending and in record', async () => {
    const k = await make();
    const a = await k.sanction({ key: 'memo-dup' });
    const counts = spy(k, { doubled: true });
    const pending = k.cw.notices.pending(a.who);
    expect(pending).toHaveLength(2);
    expect(pending[0]?.appealUrl).toMatch(URL_RE);
    expect(pending[1]?.appealUrl).toBe(pending[0]?.appealUrl);
    expect(counts).toEqual({ loadNotice: 1, loadAppealByGroup: 1 });
    const record = k.cw.notices.record(a.who);
    expect(record).toHaveLength(2);
    expect(record[1]?.appealUrl).toBe(record[0]?.appealUrl);
    expect(counts).toEqual({ loadNotice: 2, loadAppealByGroup: 2 });
  });

  it('nothing is remembered between calls: every call reads again, and a decision between two calls shows in the second', async () => {
    const k = await make();
    const s = await k.sanction({ key: 'memo-c' });
    const counts = spy(k);
    expect(k.cw.notices.record(s.who)[0]?.appealUrl).toMatch(URL_RE);
    expect(k.cw.notices.record(s.who)[0]?.appealUrl).toMatch(URL_RE);
    expect(counts.loadNotice).toBe(2);
    const filed = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    await k.cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'revoke', actor: 'senior_bea', reason: 'private', reasonCode: 'mistake' } as never);
    expect(k.cw.notices.record(s.who).find((n) => n.id === s.noticeId)).toBeUndefined();
  });

  it('a link that cannot be made (no landing address) leaves the notice untouched and reads nothing for it', async () => {
    const k = await make(false);
    const s = await k.sanction({ key: 'memo-off' });
    const counts = spy(k);
    const list = k.cw.notices.pending(s.who);
    expect(list).toHaveLength(1);
    expect(list[0]?.appealUrl).toBeUndefined();
    expect(counts.loadAppealByGroup).toBe(0);
  });
});
