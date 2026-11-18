import { describe, expect, it } from 'vitest';
import { EvidenceBuffer } from '../src/evidence.js';
import type { KitEvent } from '../src/events.js';
import { MIN, roomsWorld, SEC } from './roomsWorld.js';
import type { RoomsWorld } from './roomsWorld.js';

// R3: taking a line back for everyone. The evidence line keeps its text and is flagged; reports filed afterwards carry the flag; the kit raises line.retracted (ids and a time, never text or a seat). It is not a
// sanction: no notice, no strike, nothing said to the author.

const lineIdOf = (res: ReturnType<RoomsWorld['cw']['chat']['accept']>): string => {
  if (!('deliver' in res)) throw new Error('not delivered');
  return res.deliver.lineId;
};

async function room() {
  const w = await roomsWorld();
  const a = w.player('R1', { handle: 'Alice' });
  const b = w.player('R1', { handle: 'Bob' });
  const retracted: KitEvent[] = [];
  w.cw.on('line.retracted', (e) => void retracted.push(e));
  return { w, a, b, retracted };
}

async function reportOn(w: RoomsWorld, reporterSeat: string, targetSeat: string, lineId?: string) {
  const res = await w.submit('R1', { reporterSeat, targetSeat, ...(lineId === undefined ? {} : { lineId }) });
  if (!res.ok) throw new Error(res.refused);
  return w.cw.reports.get(res.reportId)!;
}

describe('rooms.retract', () => {
  it('flags the evidence line and keeps its text; a report filed after carries retracted true on that excerpt line', async () => {
    const { w, a, b } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'zzz you tarvo'));
    w.clock.t += 6 * SEC;
    const other = lineIdOf(w.cw.chat.accept('R1', a, 'a second line'));
    expect(w.cw.rooms.retract('R1', id)).toEqual({ ok: true, lineIds: [id] });
    const report = await reportOn(w, b, a);
    const first = report.excerpt.find((l) => l.lineId === id)!;
    expect(first).toMatchObject({ raw: 'zzz you tarvo', delivered: 'zzz you tarvo', retracted: true });
    const second = report.excerpt.find((l) => l.lineId === other)!;
    expect('retracted' in second).toBe(false);
  });

  it('a report already filed keeps its excerpt unchanged', async () => {
    const { w, a, b } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'something rude'));
    const filed = await reportOn(w, b, a, id);
    const before = JSON.stringify(filed.excerpt);
    expect(w.cw.rooms.retract('R1', id).ok).toBe(true);
    expect(JSON.stringify(w.cw.reports.get(filed.id)!.excerpt)).toBe(before);
    expect(w.cw.reports.get(filed.id)!.excerpt.every((l) => !('retracted' in l))).toBe(true);
  });

  it('a report on a retracted line is accepted (the reporter may have seen it before it went)', async () => {
    const { w, a, b } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'gone now'));
    w.cw.rooms.retract('R1', id);
    const res = await w.submit('R1', { reporterSeat: b, targetSeat: a, lineId: id });
    expect(res.ok).toBe(true);
    if (res.ok) expect(w.cw.reports.get(res.reportId)?.lineId).toBe(id);
  });

  it('a retracted line is already retracted: a second call and a call on a blocked line are not_found, nothing is raised twice', async () => {
    const { w, a, b, retracted } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'one'));
    expect(w.cw.rooms.retract('R1', id).ok).toBe(true);
    expect(w.cw.rooms.retract('R1', id)).toEqual({ ok: false, refused: 'not_found' });
    expect(retracted).toHaveLength(1);
    // a line the matcher blocked was never delivered to anyone: there is nothing to take back
    w.clock.t += 6 * SEC;
    expect(w.cw.chat.accept('R1', a, 'you zorbak')).toMatchObject({ refuse: { reason: 'blocked' } });
    const blocked = (await reportOn(w, b, a)).excerpt.find((l) => l.blocked)!;
    expect(w.cw.rooms.retract('R1', blocked.lineId)).toEqual({ ok: false, refused: 'not_found' });
  });
});

describe('allFromAuthor', () => {
  it('retracts every line of the same occupant still in the buffer and leaves other players\' lines', async () => {
    const { w, a, b } = await room();
    const ids: string[] = [];
    const bs: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      w.clock.t += 6 * SEC;
      ids.push(lineIdOf(w.cw.chat.accept('R1', a, `spam ${i}`)));
      bs.push(lineIdOf(w.cw.chat.accept('R1', b, `fine ${i}`)));
    }
    expect(w.cw.rooms.retract('R1', ids[2]!, { allFromAuthor: true })).toEqual({ ok: true, lineIds: ids });
    const report = await reportOn(w, b, a);
    expect(report.excerpt.filter((l) => 'retracted' in l).map((l) => l.lineId)).toEqual(ids);
    for (const id of bs) expect('retracted' in report.excerpt.find((l) => l.lineId === id)!).toBe(false);
  });

  it('without allFromAuthor only that line goes', async () => {
    const { w, a } = await room();
    const first = lineIdOf(w.cw.chat.accept('R1', a, 'one'));
    w.clock.t += 6 * SEC;
    const second = lineIdOf(w.cw.chat.accept('R1', a, 'two'));
    expect(w.cw.rooms.retract('R1', first, { allFromAuthor: false })).toEqual({ ok: true, lineIds: [first] });
    expect(w.cw.rooms.retract('R1', second)).toEqual({ ok: true, lineIds: [second] });
  });

  it('follows the occupant at the time of each line when the seat changed hands, and the same person in another seat', async () => {
    const w = await roomsWorld();
    const sa = w.player('R1', { seat: 's1', handle: 'Alice', account: 'acct-alice-1' });
    const a1 = lineIdOf(w.cw.chat.accept('R1', sa, 'alice one'));
    w.clock.t += 6 * SEC;
    const a2 = lineIdOf(w.cw.chat.accept('R1', sa, 'alice two'));
    // the seat changes hands: Bob now sits in s1
    w.cw.rooms.seat('R1', 's1', { clientKey: 'bob-key-aaaaaaaaaaaaaaaa', accountId: 'acct-bob-1' }, 'Bob');
    w.clock.t += 6 * SEC;
    const b1 = lineIdOf(w.cw.chat.accept('R1', 's1', 'bob one'));
    // Alice comes back in another seat
    w.cw.rooms.seat('R1', 's2', { clientKey: 'key-1-bbbbbbbbbbbb', accountId: 'acct-alice-1' }, 'Alice');
    w.clock.t += 6 * SEC;
    const a3 = lineIdOf(w.cw.chat.accept('R1', 's2', 'alice three'));
    expect(w.cw.rooms.retract('R1', a2, { allFromAuthor: true })).toEqual({ ok: true, lineIds: [a1, a2, a3] });
    // Bob's line, in the same seat Alice's lines were in, stays
    expect(w.cw.rooms.retract('R1', b1)).toEqual({ ok: true, lineIds: [b1] });
  });

  it('a guest (no subject) loses the lines of their seat only', async () => {
    const w = await roomsWorld();
    const g1 = w.player('R1', { account: null, seat: 'g1' });
    const g2 = w.player('R1', { account: null, seat: 'g2' });
    const x = lineIdOf(w.cw.chat.accept('R1', g1, 'guest one'));
    w.clock.t += 6 * SEC;
    const y = lineIdOf(w.cw.chat.accept('R1', g1, 'guest two'));
    const z = lineIdOf(w.cw.chat.accept('R1', g2, 'other guest'));
    expect(w.cw.rooms.retract('R1', x, { allFromAuthor: true })).toEqual({ ok: true, lineIds: [x, y] });
    expect(w.cw.rooms.retract('R1', z)).toEqual({ ok: true, lineIds: [z] });
  });
});

describe('not found', () => {
  it('a line older than 15 minutes, a line past the 100-line cap and an unknown id are not_found with the same shape', async () => {
    const { w, a, retracted } = await room();
    const old = lineIdOf(w.cw.chat.accept('R1', a, 'very old'));
    w.clock.t += 15 * MIN + 1;
    expect(w.cw.rooms.retract('R1', old)).toEqual({ ok: false, refused: 'not_found' });
    // the cap: 101 lines, the first one is gone
    const w2 = await roomsWorld();
    const p = w2.player('R2');
    const first = lineIdOf(w2.cw.chat.accept('R2', p, 'line 0'));
    for (let i = 1; i <= 100; i += 1) {
      w2.clock.t += 2 * SEC;
      w2.cw.chat.accept('R2', p, `line ${i}`);
    }
    expect(w2.cw.rooms.retract('R2', first)).toEqual({ ok: false, refused: 'not_found' });
    expect(w2.cw.rooms.retract('R2', 'nope')).toEqual({ ok: false, refused: 'not_found' });
    expect(w2.cw.rooms.retract('no-such-room', '1')).toEqual({ ok: false, refused: 'not_found' });
    for (const bad of [undefined, null, 5, {}, '']) {
      expect(w2.cw.rooms.retract(bad as never, '1'), String(bad)).toEqual({ ok: false, refused: 'not_found' });
      expect(w2.cw.rooms.retract('R2', bad as never), String(bad)).toEqual({ ok: false, refused: 'not_found' });
    }
    expect(retracted).toEqual([]);
  });

  it('exactly 15 minutes old is still in the window (the evidence rule)', async () => {
    const { w, a } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'edge'));
    w.clock.t += 15 * MIN;
    expect(w.cw.rooms.retract('R1', id).ok).toBe(true);
  });
});

describe('the event', () => {
  it('line.retracted holds the room, the ids and a time and no text or seat', async () => {
    const { w, a, retracted } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'SENTINEL-line-text'));
    w.cw.rooms.retract('R1', id);
    expect(retracted).toEqual([{ type: 'line.retracted', roomId: 'R1', lineIds: [id], at: w.clock.t }]);
    const text = JSON.stringify(retracted);
    for (const needle of ['SENTINEL', a, 'Alice']) expect(text, needle).not.toContain(needle);
    expect(Object.isFrozen((retracted[0] as { lineIds: unknown }).lineIds)).toBe(true);
  });

  it('a listener that throws does not change the answer', async () => {
    const { w, a } = await room();
    w.cw.on('line.retracted', () => {
      throw new Error('down');
    });
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'one'));
    expect(w.cw.rooms.retract('R1', id)).toEqual({ ok: true, lineIds: [id] });
  });
});

describe('not a sanction (review focus 4)', () => {
  it('writes no sanction, notice or strike and tells the author nothing', async () => {
    const { w, a, retracted } = await room();
    const id = lineIdOf(w.cw.chat.accept('R1', a, 'rude'));
    const author = { clientKey: 'key-1-bbbbbbbbbbbb', accountId: 'acct-1-aaaaaaaa' };
    const snapshot = () => JSON.stringify([w.store.loadStrikes(0), w.store.loadSanctions(w.clock.t), w.cw.notices.record(author), w.cw.audit.list({ limit: 50 }).items]);
    const events: KitEvent[] = [];
    w.cw.on('*', (e) => void events.push(e));
    const before = snapshot();
    w.cw.rooms.retract('R1', id);
    expect(snapshot()).toBe(before);
    expect(events.map((e) => e.type)).toEqual(['line.retracted']);
    expect(retracted).toHaveLength(1);
    // the author's next line is judged as ever
    w.clock.t += 6 * SEC;
    expect('deliver' in w.cw.chat.accept('R1', a, 'polite now')).toBe(true);
  });
});

describe('EvidenceBuffer.retract', () => {
  const clock = { now: () => 1000 };
  const mk = () => {
    const buffer = new EvidenceBuffer({ clock });
    const add = (seat: string, subject: string | null, extra: { blocked?: boolean } = {}) =>
      buffer.append('R', { ts: 1000, seatId: seat, handle: seat, subject, raw: `raw ${seat}`, delivered: extra.blocked === true ? null : `raw ${seat}`, blocked: extra.blocked === true, audience: null });
    return { buffer, add };
  };

  it('returns the ids it changed, oldest first, and the lines keep their text', () => {
    const { buffer, add } = mk();
    const x = add('a', 's_1');
    const y = add('b', 's_2');
    const z = add('a', 's_1');
    expect(buffer.retract('R', y)).toEqual([y]);
    expect(buffer.retract('R', x, { allFromAuthor: true })).toEqual([x, z]);
    const lines = buffer.snapshot('R');
    expect(lines.map((l) => [l.lineId, l.retracted === true, l.raw])).toEqual([[x, true, 'raw a'], [y, true, 'raw b'], [z, true, 'raw a']]);
  });

  it('canonicalises authors: two subject ids of one person are one author', () => {
    const { buffer, add } = mk();
    const x = add('a', 's_old');
    const y = add('b', 's_new');
    expect(buffer.retract('R', x, { allFromAuthor: true, canonical: (s) => (s === 's_old' ? 's_new' : s) })).toEqual([x, y]);
  });

  it('skips blocked lines, answers [] for an unknown room or line, and never throws', () => {
    const { buffer, add } = mk();
    const blocked = add('a', 's_1', { blocked: true });
    const ok = add('a', 's_1');
    expect(buffer.retract('R', blocked)).toEqual([]);
    expect(buffer.retract('R', ok, { allFromAuthor: true })).toEqual([ok]);
    expect(buffer.retract('nope', '1')).toEqual([]);
    expect(buffer.retract('R', '999')).toEqual([]);
  });

  it('a snapshot is a copy: changing it never un-retracts', () => {
    const { buffer, add } = mk();
    const x = add('a', 's_1');
    buffer.retract('R', x);
    const snap = buffer.snapshot('R');
    delete (snap[0] as { retracted?: boolean }).retracted;
    expect(buffer.snapshot('R')[0]?.retracted).toBe(true);
    expect(buffer.get('R', x)?.retracted).toBe(true);
  });

  it('scrub (erase) keeps the flag while it blanks the text', () => {
    const { buffer, add } = mk();
    const x = add('a', 's_1');
    buffer.retract('R', x);
    buffer.scrub(new Set(['s_1']));
    expect(buffer.get('R', x)).toMatchObject({ retracted: true, raw: '[erased]' });
  });
});

describe('rooms.lineStates and audit.roomRef (what the staff routes read)', () => {
  it('lineStates lists the room\'s buffered lines as id, time and whether each was taken back, and nothing else', async () => {
    const { w, a } = await room();
    const first = lineIdOf(w.cw.chat.accept('R1', a, 'SENTINEL-state-text'));
    w.clock.t += 6 * SEC;
    const second = lineIdOf(w.cw.chat.accept('R1', a, 'two'));
    w.cw.rooms.retract('R1', first);
    expect(w.cw.rooms.lineStates('R1')).toEqual([
      { lineId: first, ts: w.clock.t - 6 * SEC, retracted: true },
      { lineId: second, ts: w.clock.t, retracted: false },
    ]);
    const text = JSON.stringify(w.cw.rooms.lineStates('R1'));
    for (const needle of ['SENTINEL', a, 'Alice']) expect(text, needle).not.toContain(needle);
  });

  it('lineStates is empty for an unknown room and for a bad argument, and drops lines that left the window', async () => {
    const { w, a } = await room();
    lineIdOf(w.cw.chat.accept('R1', a, 'old'));
    expect(w.cw.rooms.lineStates('nope')).toEqual([]);
    expect(w.cw.rooms.lineStates(undefined as never)).toEqual([]);
    w.clock.t += 16 * MIN;
    expect(w.cw.rooms.lineStates('R1')).toEqual([]);
  });

  it('roomRef is the id itself when it fits the ref alphabet and a stable keyed hash otherwise', async () => {
    const { w } = await room();
    expect(w.cw.audit.roomRef('lobby-1')).toBe('lobby-1');
    expect(w.cw.audit.roomRef('match:42.eu')).toBe('match:42.eu');
    const awkward = w.cw.audit.roomRef('Ranked lobby / EU #7');
    expect(awkward).toMatch(/^h-[0-9a-f]{16}$/);
    expect(w.cw.audit.roomRef('Ranked lobby / EU #7')).toBe(awkward);
    expect(w.cw.audit.roomRef('Ranked lobby / EU #8')).not.toBe(awkward);
    expect(awkward).not.toContain('Ranked');
    // an id that itself looks like a hashed ref is hashed too, so a ref starting h- is always a hash
    expect(w.cw.audit.roomRef('h-0123456789abcdef')).not.toBe('h-0123456789abcdef');
    // the same secret gives the same ref in another kit (across a restart)
    const other = await roomsWorld();
    expect(other.cw.audit.roomRef('Ranked lobby / EU #7')).toBe(awkward);
  });
});
