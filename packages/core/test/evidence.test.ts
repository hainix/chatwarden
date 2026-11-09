import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_MAX_AGE_MS,
  EVIDENCE_MAX_LINES,
  EvidenceBuffer,
  RoomRoster,
  type EvidenceLine,
} from '../src/evidence.js';
import * as core from '../src/index.js';

type NewLine = Omit<EvidenceLine, 'lineId'>;

const line = (over: Partial<NewLine> = {}): NewLine => ({
  ts: 0,
  seatId: 'p1',
  handle: 'alice',
  subject: 's_aaaaaaaaaaaaaaaaaaaaaa',
  raw: 'hello',
  delivered: 'hello',
  blocked: false,
  audience: null,
  ...over,
});

// A clock the test moves by hand, so the age window is exact.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

function setup(maxLines = 3, maxAgeMs = 1000) {
  const clock = makeClock();
  const buffer = new EvidenceBuffer({ maxLines, maxAgeMs, clock });
  return { buffer, clock };
}

const ids = (xs: EvidenceLine[]) => xs.map((x) => x.lineId);

describe('EvidenceBuffer: production constants', () => {
  it('the ring holds 100 lines and the window is 15 minutes', () => {
    expect(EVIDENCE_MAX_LINES).toBe(100);
    expect(EVIDENCE_MAX_AGE_MS).toBe(900_000);
  });

  it('defaults to the production window when no sizes are given', () => {
    const clock = makeClock();
    const buffer = new EvidenceBuffer({ clock });
    for (let i = 0; i < 101; i++) buffer.append('R', line());
    expect(buffer.snapshot('R')).toHaveLength(100);
    clock.set(900_000);
    expect(buffer.snapshot('R')).toHaveLength(100);
    clock.set(900_001);
    expect(buffer.snapshot('R')).toEqual([]);
  });

  it('is exported from the package index', () => {
    expect(core.EvidenceBuffer).toBe(EvidenceBuffer);
    expect(core.RoomRoster).toBe(RoomRoster);
  });
});

describe('EvidenceBuffer: line ids', () => {
  it('the first line of a room is "1" and the counter counts up', () => {
    const { buffer } = setup(10);
    expect(buffer.append('R', line())).toBe('1');
    expect(buffer.append('R', line())).toBe('2');
    expect(buffer.append('R', line())).toBe('3');
  });

  it('each room has its own counter', () => {
    const { buffer } = setup(10);
    expect(buffer.append('A', line())).toBe('1');
    expect(buffer.append('B', line())).toBe('1');
    expect(buffer.append('A', line())).toBe('2');
    expect(buffer.append('B', line())).toBe('2');
  });

  it('the counter keeps running after eviction and never reuses an id', () => {
    const { buffer } = setup(2);
    for (let i = 0; i < 4; i++) buffer.append('R', line());
    expect(buffer.append('R', line())).toBe('5');
    expect(ids(buffer.snapshot('R'))).toEqual(['4', '5']);
  });

  it('every id is unique within a room across a long run', () => {
    const { buffer } = setup(EVIDENCE_MAX_LINES);
    const seen = new Set<string>();
    for (let i = 0; i < 250; i++) seen.add(buffer.append('R', line()));
    expect(seen.size).toBe(250);
  });

  it('ids are strings', () => {
    const { buffer } = setup(10);
    expect(typeof buffer.append('R', line())).toBe('string');
  });
});

describe('EvidenceBuffer: ring size', () => {
  it('at production size, the 101st line evicts line 1', () => {
    const clock = makeClock();
    const buffer = new EvidenceBuffer({ maxLines: EVIDENCE_MAX_LINES, maxAgeMs: EVIDENCE_MAX_AGE_MS, clock });
    for (let i = 0; i < 100; i++) buffer.append('R', line());
    expect(buffer.get('R', '1')).toBeDefined();
    expect(buffer.snapshot('R')).toHaveLength(100);

    buffer.append('R', line());
    expect(buffer.get('R', '1')).toBeUndefined();
    const snap = buffer.snapshot('R');
    expect(snap).toHaveLength(100);
    expect(snap[0]!.lineId).toBe('2');
    expect(snap[99]!.lineId).toBe('101');
  });

  it('evicts only the oldest lines and keeps the newest maxLines', () => {
    const { buffer } = setup(3);
    for (let i = 0; i < 5; i++) buffer.append('R', line());
    expect(ids(buffer.snapshot('R'))).toEqual(['3', '4', '5']);
  });

  it('get of an evicted lineId is undefined, get of a kept one is defined', () => {
    const { buffer } = setup(2);
    for (let i = 0; i < 3; i++) buffer.append('R', line());
    expect(buffer.get('R', '1')).toBeUndefined();
    expect(buffer.get('R', '2')?.lineId).toBe('2');
    expect(buffer.get('R', '3')?.lineId).toBe('3');
  });

  it('maxLines of 1 keeps only the latest line', () => {
    const { buffer } = setup(1);
    buffer.append('R', line({ raw: 'first' }));
    buffer.append('R', line({ raw: 'second' }));
    expect(buffer.snapshot('R').map((l) => l.raw)).toEqual(['second']);
  });

  it('a room under the cap keeps everything in append order', () => {
    const { buffer } = setup(5);
    buffer.append('R', line({ raw: 'a' }));
    buffer.append('R', line({ raw: 'b' }));
    expect(buffer.snapshot('R').map((l) => l.raw)).toEqual(['a', 'b']);
  });

  it('count cap enforced on append', () => {
    // The room is never read between writes, yet it stays bounded: we prove it
    // by reading only at the end with a window wide enough to keep everything.
    const { buffer } = setup(3, Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < 1000; i++) buffer.append('R', line({ raw: String(i) }));
    expect(buffer.snapshot('R').map((l) => l.raw)).toEqual(['997', '998', '999']);
  });
});

describe('EvidenceBuffer: age window', () => {
  it('a line exactly maxAgeMs old is kept; one ms older is pruned', () => {
    const { buffer, clock } = setup(10, 1000);
    buffer.append('R', line({ ts: clock.now() }));
    clock.set(1000);
    expect(ids(buffer.snapshot('R'))).toEqual(['1']);
    expect(buffer.get('R', '1')).toBeDefined();
    clock.set(1001);
    expect(buffer.snapshot('R')).toEqual([]);
    expect(buffer.get('R', '1')).toBeUndefined();
  });

  it('production window: a line at 15 minutes is kept, at 15 minutes plus 1 ms it is gone', () => {
    const clock = makeClock();
    const buffer = new EvidenceBuffer({ maxLines: EVIDENCE_MAX_LINES, maxAgeMs: EVIDENCE_MAX_AGE_MS, clock });
    buffer.append('R', line({ ts: 0 }));
    clock.set(EVIDENCE_MAX_AGE_MS);
    expect(ids(buffer.snapshot('R'))).toEqual(['1']);
    clock.set(EVIDENCE_MAX_AGE_MS + 1);
    expect(buffer.snapshot('R')).toEqual([]);
  });

  it('get returns undefined for an expired line, even though the room still exists', () => {
    const { buffer, clock } = setup(10, 1000);
    buffer.append('R', line({ ts: clock.now() }));
    clock.set(1001);
    expect(buffer.get('R', '1')).toBeUndefined();
  });

  it('snapshot drops only the expired lines and keeps the fresh ones', () => {
    const { buffer, clock } = setup(10, 1000);
    buffer.append('R', line({ ts: 0 }));
    buffer.append('R', line({ ts: 600 }));
    buffer.append('R', line({ ts: 1200 }));
    clock.set(1500);
    expect(ids(buffer.snapshot('R'))).toEqual(['2', '3']);
    expect(buffer.get('R', '1')).toBeUndefined();
    expect(buffer.get('R', '2')).toBeDefined();
  });

  it('a line whose ts is already outside the window is never returned', () => {
    const { buffer } = setup(10, 1000);
    buffer.append('R', line({ ts: -5000 }));
    expect(buffer.snapshot('R')).toEqual([]);
    expect(buffer.get('R', '1')).toBeUndefined();
  });

  it('the age is taken from the line ts, not from when it was appended', () => {
    const { buffer, clock } = setup(10, 1000);
    clock.set(5000);
    buffer.append('R', line({ ts: 4500 }));
    expect(ids(buffer.snapshot('R'))).toEqual(['1']);
    clock.set(5501);
    expect(buffer.snapshot('R')).toEqual([]);
  });

  it('the counter keeps running after every line has expired', () => {
    const { buffer, clock } = setup(10, 1000);
    buffer.append('R', line({ ts: 0 }));
    buffer.append('R', line({ ts: 0 }));
    clock.set(2000);
    expect(buffer.snapshot('R')).toEqual([]);
    expect(buffer.append('R', line({ ts: 2000 }))).toBe('3');
    expect(ids(buffer.snapshot('R'))).toEqual(['3']);
  });
});

describe('EvidenceBuffer: lines are copied in and out', () => {
  it('mutating a snapshot result does not change what the buffer holds', () => {
    const { buffer } = setup(10);
    buffer.append('R', line({ raw: 'original', audience: ['p1', 'p2'] }));
    const first = buffer.snapshot('R');
    first[0]!.raw = 'tampered';
    first[0]!.subject = 's_forged';
    first[0]!.blocked = true;
    first[0]!.audience!.push('p9');
    first.push({ ...first[0]!, lineId: '99' });
    first.splice(0, 1);

    const again = buffer.snapshot('R');
    expect(again).toHaveLength(1);
    expect(again[0]!.raw).toBe('original');
    expect(again[0]!.subject).toBe('s_aaaaaaaaaaaaaaaaaaaaaa');
    expect(again[0]!.blocked).toBe(false);
    expect(again[0]!.audience).toEqual(['p1', 'p2']);
  });

  it('mutating a returned line does not change the buffer', () => {
    const { buffer } = setup(10);
    buffer.append('R', line({ raw: 'original', audience: ['p1'] }));
    const got = buffer.get('R', '1')!;
    got.raw = 'tampered';
    got.audience!.push('p2');
    const again = buffer.get('R', '1')!;
    expect(again.raw).toBe('original');
    expect(again.audience).toEqual(['p1']);
  });

  it('each snapshot is a fresh array', () => {
    const { buffer } = setup(10);
    buffer.append('R', line());
    expect(buffer.snapshot('R')).not.toBe(buffer.snapshot('R'));
  });

  it('mutating the object passed to append does not change the stored line', () => {
    const { buffer } = setup(10);
    const input = line({ raw: 'original', audience: ['p1'] });
    buffer.append('R', input);
    input.raw = 'changed';
    input.audience!.push('p2');
    const stored = buffer.get('R', '1')!;
    expect(stored.raw).toBe('original');
    expect(stored.audience).toEqual(['p1']);
  });
});

describe('EvidenceBuffer: stored fields', () => {
  it('round-trips every field, including a blocked line with delivered null and a team audience', () => {
    const { buffer } = setup(10);
    const input = line({
      ts: 7,
      seatId: 'p3',
      handle: 'bob',
      subject: 's_bbbbbbbbbbbbbbbbbbbbbb',
      raw: 'bad words',
      delivered: null,
      audience: ['p3', 'p4'],
      blocked: true,
    });
    const id = buffer.append('R', input);
    expect(buffer.get('R', id)).toEqual({ lineId: id, ...input });
  });

  it('keeps a null subject as null and a null audience (whole room) as null', () => {
    const { buffer } = setup(10);
    buffer.append('R', line({ subject: null, audience: null }));
    const got = buffer.get('R', '1')!;
    expect(got.subject).toBeNull();
    expect(got.audience).toBeNull();
  });

  it('an empty audience list stays an empty list, not the whole room', () => {
    const { buffer } = setup(10);
    buffer.append('R', line({ audience: [] }));
    expect(buffer.get('R', '1')!.audience).toEqual([]);
  });

  it('keeps a blocked line in the buffer as evidence of what was sent', () => {
    const { buffer } = setup(10);
    buffer.append('R', line({ raw: 'x', delivered: null, blocked: true }));
    const [only] = buffer.snapshot('R');
    expect(only!.blocked).toBe(true);
    expect(only!.delivered).toBeNull();
    expect(only!.raw).toBe('x');
  });
});

describe('EvidenceBuffer: rooms are isolated', () => {
  it('a snapshot only shows its own room', () => {
    const { buffer } = setup(10);
    buffer.append('A', line({ raw: 'in A' }));
    buffer.append('B', line({ raw: 'in B' }));
    expect(buffer.snapshot('A').map((l) => l.raw)).toEqual(['in A']);
    expect(buffer.snapshot('B').map((l) => l.raw)).toEqual(['in B']);
  });

  it('a lineId is only valid in the room that issued it', () => {
    const { buffer } = setup(10);
    buffer.append('A', line({ raw: 'a1' }));
    buffer.append('A', line({ raw: 'a2' }));
    buffer.append('B', line({ raw: 'b1' }));
    expect(buffer.get('A', '2')?.raw).toBe('a2');
    expect(buffer.get('B', '2')).toBeUndefined();
  });
});

describe('EvidenceBuffer: unknown rooms', () => {
  it('get on an unknown room is undefined', () => {
    const { buffer } = setup(10);
    expect(buffer.get('NOPE', '1')).toBeUndefined();
  });

  it('snapshot on an unknown room is an empty array', () => {
    const { buffer } = setup(10);
    expect(buffer.snapshot('NOPE')).toEqual([]);
  });

  it('get of an unknown lineId in a known room is undefined', () => {
    const { buffer } = setup(10);
    buffer.append('R', line());
    expect(buffer.get('R', '99')).toBeUndefined();
  });

  it('drop on an unknown room is a no-op and does not throw', () => {
    const { buffer } = setup(10);
    buffer.append('R', line({ raw: 'kept' }));
    expect(() => buffer.drop('NOPE')).not.toThrow();
    expect(buffer.snapshot('R').map((l) => l.raw)).toEqual(['kept']);
  });
});

describe('EvidenceBuffer: drop', () => {
  it('drop clears the room: snapshot is empty and get is undefined', () => {
    const { buffer } = setup(10);
    buffer.append('R', line());
    buffer.append('R', line());
    buffer.drop('R');
    expect(buffer.snapshot('R')).toEqual([]);
    expect(buffer.get('R', '1')).toBeUndefined();
    expect(buffer.get('R', '2')).toBeUndefined();
  });

  it('after drop, the same room starts again at "1"', () => {
    const { buffer } = setup(10);
    buffer.append('R', line());
    buffer.append('R', line());
    buffer.drop('R');
    expect(buffer.append('R', line())).toBe('1');
    expect(ids(buffer.snapshot('R'))).toEqual(['1']);
  });

  it('drop only clears its own room', () => {
    const { buffer } = setup(10);
    buffer.append('A', line());
    buffer.append('B', line({ raw: 'b-line' }));
    buffer.drop('A');
    expect(buffer.snapshot('A')).toEqual([]);
    expect(buffer.snapshot('B').map((l) => l.raw)).toEqual(['b-line']);
  });

  it('dropping twice is harmless', () => {
    const { buffer } = setup(10);
    buffer.append('R', line());
    buffer.drop('R');
    expect(() => buffer.drop('R')).not.toThrow();
    expect(buffer.snapshot('R')).toEqual([]);
  });
});

describe('RoomRoster', () => {
  it('occupant of a seated seat returns subject and handle', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice');
    expect(roster.occupant('R', 'p1')).toEqual({ subject: 's_one', handle: 'alice' });
  });

  it('occupant of an unknown room or an empty seat is null', () => {
    const roster = new RoomRoster();
    expect(roster.occupant('NOPE', 'p1')).toBeNull();
    roster.seat('R', 'p1', 's_one', 'alice');
    expect(roster.occupant('R', 'p2')).toBeNull();
  });

  it('a seat can be occupied by an unknown subject (null)', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', null, 'guest');
    expect(roster.occupant('R', 'p1')).toEqual({ subject: null, handle: 'guest' });
  });

  it('seat on an occupied seat replaces the occupant', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice');
    roster.seat('R', 'p1', 's_two', 'bob');
    expect(roster.occupant('R', 'p1')).toEqual({ subject: 's_two', handle: 'bob' });
  });

  it('unseat empties the seat; unseat of an empty seat or unknown room is a no-op', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice');
    roster.seat('R', 'p2', 's_two', 'bob');
    roster.unseat('R', 'p1');
    expect(roster.occupant('R', 'p1')).toBeNull();
    expect(roster.occupant('R', 'p2')).toEqual({ subject: 's_two', handle: 'bob' });
    expect(() => roster.unseat('R', 'p1')).not.toThrow();
    expect(() => roster.unseat('NOPE', 'p1')).not.toThrow();
  });

  it('the roster keeps the subject id as given, even one that may later be merged away', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_mergedaway', 'alice');
    expect(roster.occupant('R', 'p1')!.subject).toBe('s_mergedaway');
  });

  it('rooms are isolated and seat ids do not collide across rooms', () => {
    const roster = new RoomRoster();
    roster.seat('A', 'p1', 's_a', 'alice');
    roster.seat('B', 'p1', 's_b', 'bob');
    expect(roster.occupant('A', 'p1')!.handle).toBe('alice');
    expect(roster.occupant('B', 'p1')!.handle).toBe('bob');
    roster.unseat('A', 'p1');
    expect(roster.occupant('B', 'p1')!.handle).toBe('bob');
  });

  it('occupant returns a copy', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice');
    const got = roster.occupant('R', 'p1')!;
    got.handle = 'tampered';
    got.subject = 's_forged';
    expect(roster.occupant('R', 'p1')).toEqual({ subject: 's_one', handle: 'alice' });
  });

  it('tags of an unknown room is an empty object', () => {
    expect(new RoomRoster().tags('NOPE')).toEqual({});
  });

  it('tags given on seat are stored for the room', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice', { mode: 'ranked', region: 'eu' });
    expect(roster.tags('R')).toEqual({ mode: 'ranked', region: 'eu' });
  });

  it('seat without tags leaves the room tags unchanged', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice', { mode: 'ranked' });
    roster.seat('R', 'p2', 's_two', 'bob');
    expect(roster.tags('R')).toEqual({ mode: 'ranked' });
  });

  it('later tags merge over earlier ones', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice', { mode: 'ranked', region: 'eu' });
    roster.seat('R', 'p2', 's_two', 'bob', { mode: 'casual' });
    expect(roster.tags('R')).toEqual({ mode: 'casual', region: 'eu' });
  });

  it('tags are copied in and out', () => {
    const roster = new RoomRoster();
    const input = { mode: 'ranked' };
    roster.seat('R', 'p1', 's_one', 'alice', input);
    input.mode = 'changed';
    const out = roster.tags('R');
    out['mode'] = 'tampered';
    out['extra'] = 'x';
    expect(roster.tags('R')).toEqual({ mode: 'ranked' });
  });

  it('unseating the last player does not clear the room tags', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice', { mode: 'ranked' });
    roster.unseat('R', 'p1');
    expect(roster.tags('R')).toEqual({ mode: 'ranked' });
  });

  it('close forgets the roster and tags of that room only', () => {
    const roster = new RoomRoster();
    roster.seat('A', 'p1', 's_a', 'alice', { mode: 'ranked' });
    roster.seat('B', 'p1', 's_b', 'bob', { mode: 'casual' });
    roster.close('A');
    expect(roster.occupant('A', 'p1')).toBeNull();
    expect(roster.tags('A')).toEqual({});
    expect(roster.occupant('B', 'p1')!.handle).toBe('bob');
    expect(roster.tags('B')).toEqual({ mode: 'casual' });
  });

  it('close of an unknown room is a no-op', () => {
    expect(() => new RoomRoster().close('NOPE')).not.toThrow();
  });
});

describe('seat handover and room close', () => {
  it('a seat that changes hands: lines keep the subject that wrote them', () => {
    const { buffer } = setup(10);
    const roster = new RoomRoster();

    roster.seat('R', 'A', 's_one', 'alice');
    const first = roster.occupant('R', 'A')!;
    buffer.append('R', line({ seatId: 'A', handle: first.handle, subject: first.subject }));

    roster.unseat('R', 'A');
    roster.seat('R', 'A', 's_two', 'bob');
    const second = roster.occupant('R', 'A')!;
    buffer.append('R', line({ seatId: 'A', handle: second.handle, subject: second.subject }));

    const snap = buffer.snapshot('R');
    expect(snap.map((l) => l.subject)).toEqual(['s_one', 's_two']);
    expect(snap.map((l) => l.handle)).toEqual(['alice', 'bob']);
    expect(snap.every((l) => l.seatId === 'A')).toBe(true);
  });

  it('close drops roster and buffer', () => {
    const { buffer } = setup(10);
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice', { mode: 'ranked' });
    buffer.append('R', line());

    roster.close('R');
    buffer.drop('R');

    expect(roster.occupant('R', 'p1')).toBeNull();
    expect(roster.tags('R')).toEqual({});
    expect(buffer.snapshot('R')).toEqual([]);
    expect(buffer.append('R', line())).toBe('1');
  });
});

describe('RoomRoster.seats', () => {
  it('lists the seat ids of a room, sorted, and [] for an unknown room', () => {
    const roster = new RoomRoster();
    expect(roster.seats('NOPE')).toEqual([]);
    roster.seat('R', 'p2', 's_two', 'bob');
    roster.seat('R', 'p1', 's_one', 'alice');
    roster.seat('R', 'p10', null, 'guest');
    roster.seat('OTHER', 'z9', 's_z', 'zed');
    expect(roster.seats('R')).toEqual(['p1', 'p10', 'p2']);
  });

  it('follows unseat and close, and returns a copy', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_one', 'alice');
    roster.seat('R', 'p2', 's_two', 'bob');
    roster.unseat('R', 'p1');
    expect(roster.seats('R')).toEqual(['p2']);
    roster.seats('R').push('hacked');
    expect(roster.seats('R')).toEqual(['p2']);
    roster.close('R');
    expect(roster.seats('R')).toEqual([]);
  });
});
