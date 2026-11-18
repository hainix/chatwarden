import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { ChatService } from '../src/chat.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { MUTE_TTL_MS, MuteService } from '../src/mutes.js';
import { SanctionIndex } from '../src/sanctions.js';
import { StrikeService } from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SubjectId } from '../src/types.js';

// I-2: `hiddenFor` (the seats that must not be shown a sender's line) comes from an inverse index: the cost is the number of people who muted or blocked the sender, not the seats in the room.
// The reference answer is always the slow one: every other seat asked `visibleTo`.

const NOW = 1_800_000_000_000;
const who = (clientKey: string | null, accountId: string | null = null): Identifiers => ({ clientKey, accountId, ipHash: null });

function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const quiet: Logger = { warn() {} };
  const subjects = new SubjectIndex(store, clock, { logger: quiet });
  const mutes = new MuteService(store, clock, subjects, { logger: quiet });
  const roster = new RoomRoster();
  const chat = new ChatService({
    roster,
    buffer: new EvidenceBuffer({ clock }),
    subjects,
    sanctions: new SanctionIndex({ enabled: () => true, subjects }),
    store,
    strikes: new StrikeService(store, clock, subjects, { logger: quiet }),
    mutes,
    clock,
    logger: quiet,
  });
  const person = (ids: Identifiers): SubjectId => {
    clock.t += 1;
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const sit = (seat: string, ids: Identifiers, room = 'R'): SubjectId => {
    const s = person(ids);
    roster.seat(room, seat, s, seat);
    return s;
  };
  /** The reference: every other seat asked `visibleTo`. */
  const slow = (room: string, sender: string): string[] =>
    roster
      .seats(room)
      .filter((v) => v !== sender && !chat.visibleTo(room, v, sender))
      .sort();
  return { store, clock, subjects, mutes, roster, chat, person, sit, slow };
}
type Setup = ReturnType<typeof setup>;

describe('RoomRoster.seatsOf: the seats a person holds in a room', () => {
  it('finds the seats of a subject, follows seat changes, unseat, close and forget', () => {
    const r = new RoomRoster();
    r.seat('R', 'a', 's1', 'A');
    r.seat('R', 'b', 's1', 'B');
    r.seat('R', 'c', 's2', 'C');
    r.seat('Q', 'a', 's1', 'A');
    expect(r.seatsOf('R', 's1').sort()).toEqual(['a', 'b']);
    expect(r.seatsOf('R', 's2')).toEqual(['c']);
    expect(r.seatsOf('R', 'nobody')).toEqual([]);
    expect(r.seatsOf('NOROOM', 's1')).toEqual([]);
    // the seat changed hands
    r.seat('R', 'a', 's2', 'A2');
    expect(r.seatsOf('R', 's1')).toEqual(['b']);
    expect(r.seatsOf('R', 's2').sort()).toEqual(['a', 'c']);
    // a guest seat is under nobody
    r.seat('R', 'g', null, 'G');
    r.seat('R', 'b', null, 'B');
    expect(r.seatsOf('R', 's1')).toEqual([]);
    r.unseat('R', 'a');
    expect(r.seatsOf('R', 's2')).toEqual(['c']);
    r.forget(new Set(['s2']));
    expect(r.seatsOf('R', 's2')).toEqual([]);
    expect(r.seatsOf('Q', 's1')).toEqual(['a']);
    r.close('Q');
    expect(r.seatsOf('Q', 's1')).toEqual([]);
    // re-seating the same person in the same seat leaves one entry
    r.seat('R', 'z', 's9', 'Z');
    r.seat('R', 'z', 's9', 'Z');
    expect(r.seatsOf('R', 's9')).toEqual(['z']);
  });

  it('counts the rooms and the seats of one room in constant time', () => {
    const r = new RoomRoster();
    expect(r.roomCount()).toBe(0);
    r.seat('R', 'a', 's1', 'A');
    r.seat('Q', 'a', 's1', 'A');
    expect(r.roomCount()).toBe(2);
    expect(r.seatCount('R')).toBe(1);
    expect(r.seatCount('NOROOM')).toBe(0);
    r.close('R');
    expect(r.roomCount()).toBe(1);
  });
});

describe('MuteService.unseenBy: who must not see a sender', () => {
  it('a muter, a blocker, and the people the sender blocked; nobody else; never the sender', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    const c = s.person(who('c'));
    const d = s.person(who('d'));
    s.person(who('e'));
    s.mutes.set(a, b, true);
    s.mutes.set(c, b, true, 'block');
    s.mutes.set(b, d, true, 'block');
    expect([...s.mutes.unseenBy(b)].sort()).toEqual([a, c, d].sort());
    expect([...s.mutes.unseenBy(a)]).toEqual([]);
    // a mute by the sender (not a block) hides nothing of the muted person's lines from the sender's audience
    const f = s.person(who('f'));
    s.mutes.set(b, f, true);
    expect([...s.mutes.unseenBy(b)].sort()).toEqual([a, c, d].sort());
    expect([...s.mutes.unseenBy(f)]).toEqual([b]);
  });

  it('follows a mute, a block, an unmute and an unblock at once', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    expect([...s.mutes.unseenBy(b)]).toEqual([]);
    s.mutes.set(a, b, true);
    expect([...s.mutes.unseenBy(b)]).toEqual([a]);
    s.mutes.set(a, b, true, 'block');
    expect([...s.mutes.unseenBy(a)]).toEqual([b]);
    s.mutes.set(a, b, false);
    expect([...s.mutes.unseenBy(b)]).toEqual([]);
    expect([...s.mutes.unseenBy(a)]).toEqual([]);
  });

  it('a mute ends after its 180 days and a block never does', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    const c = s.person(who('c'));
    s.mutes.set(a, b, true);
    s.mutes.set(c, b, true, 'block');
    s.clock.t += MUTE_TTL_MS;
    expect([...s.mutes.unseenBy(b)].sort()).toEqual([a, c].sort());
    s.clock.t += 5;
    expect([...s.mutes.unseenBy(b)]).toEqual([c]);
  });

  it('null, an empty id, and a person nobody muted give an empty list', () => {
    const s = setup();
    s.person(who('a'));
    expect([...s.mutes.unseenBy(null)]).toEqual([]);
    expect([...s.mutes.unseenBy('')]).toEqual([]);
    expect([...s.mutes.unseenBy('never-seen')]).toEqual([]);
  });

  it('after a merge, rows under a merged-away viewer id or target id are found for the person', () => {
    const s = setup();
    const v1 = s.person(who('v-key'));
    s.person(who('v-acct-key', 'v-acct'));
    const t1 = s.person(who('t-key'));
    const t2 = s.person(who('t-acct-key', 't-acct'));
    const blocker = s.person(who('bl-key'));
    s.mutes.set(v1, t1, true);
    s.mutes.set(t1, blocker, true, 'block');
    expect([...s.mutes.unseenBy(t1)].sort()).toEqual([blocker, v1].sort());
    // viewer v1 and v2 become one; t1 and t2 become one
    const vm = s.person(who('v-key', 'v-acct'));
    s.person(who('t-key', 't-acct'));
    const canonical = (id: SubjectId): SubjectId => s.subjects.canonical(id);
    expect(canonical(vm)).toBe(canonical(v1));
    const got = [...s.mutes.unseenBy(t2)].map(canonical).sort();
    expect(got).toEqual([canonical(v1), canonical(blocker)].sort());
    // the same through the merged-away target id
    expect([...s.mutes.unseenBy(t1)].map(canonical).sort()).toEqual(got);
  });

  it('a lookup does not scan the viewers: with 3000 mutes of other people it costs a handful of canonical calls', () => {
    const s = setup();
    const target = s.person(who('crowd-target'));
    for (let i = 0; i < 3000; i += 1) s.mutes.set(s.person(who(`crowd-viewer-${i}`)), target, true);
    const a = s.person(who('plain-a'));
    const b = s.person(who('plain-b'));
    s.mutes.set(a, b, true);
    s.mutes.unseenBy(b); // the first call after a change builds the index
    let calls = 0;
    const real = s.subjects.canonical.bind(s.subjects);
    s.subjects.canonical = (id: SubjectId): SubjectId => {
      calls += 1;
      return real(id);
    };
    expect([...s.mutes.unseenBy(b)]).toEqual([a]);
    expect(calls).toBeLessThanOrEqual(8);
  });
});

describe('ChatService.hiddenFor equals the seats visibleTo hides', () => {
  it('basic: muter, blocker, blocked-by-sender, bystander; sorted; never the sender', () => {
    const s = setup();
    const a = s.sit('a', who('a'));
    const b = s.sit('b', who('b'));
    const c = s.sit('c', who('c'));
    const d = s.sit('d', who('d'));
    s.sit('e', who('e'));
    expect(s.chat.hiddenFor('R', 'b')).toEqual([]);
    s.mutes.set(a, b, true);
    s.mutes.set(c, b, true, 'block');
    s.mutes.set(b, d, true, 'block');
    expect(s.chat.hiddenFor('R', 'b')).toEqual(['a', 'c', 'd']);
    expect(s.chat.hiddenFor('R', 'b')).toEqual(s.slow('R', 'b'));
    expect(s.chat.hiddenFor('R', 'a')).toEqual(s.slow('R', 'a'));
    expect(s.chat.hiddenFor('R', 'e')).toEqual([]);
  });

  it('unknown room, unknown seat, an empty seat and a guest sender give []', () => {
    const s = setup();
    const a = s.sit('a', who('a'));
    s.roster.seat('R', 'guest', null, 'guest');
    s.mutes.set(a, s.person(who('x')), true);
    expect(s.chat.hiddenFor('NOROOM', 'a')).toEqual([]);
    expect(s.chat.hiddenFor('R', 'nobody')).toEqual([]);
    expect(s.chat.hiddenFor('R', 'guest')).toEqual([]);
  });

  it('a muter who left the room (or is not seated) is not listed; one seated twice lists both seats; a seat that changed hands follows the new occupant', () => {
    const s = setup();
    const a = s.sit('a1', who('a'));
    s.roster.seat('R', 'a2', a, 'a2');
    const b = s.sit('b', who('b'));
    const away = s.person(who('away'));
    s.mutes.set(a, b, true);
    s.mutes.set(away, b, true);
    expect(s.chat.hiddenFor('R', 'b')).toEqual(['a1', 'a2']);
    s.roster.unseat('R', 'a2');
    expect(s.chat.hiddenFor('R', 'b')).toEqual(['a1']);
    // a different person takes seat a1: they never muted b
    s.sit('a1', who('newcomer'));
    expect(s.chat.hiddenFor('R', 'b')).toEqual([]);
    // the muter takes another seat
    s.roster.seat('R', 'z', a, 'z');
    expect(s.chat.hiddenFor('R', 'b')).toEqual(['z']);
    // the same person in two rooms is hidden only in the room they sit in
    expect(s.chat.hiddenFor('Q', 'b')).toEqual([]);
  });

  it('the sender seated twice: the muter is hidden from either of the sender seats, and the sender own other seat is never listed', () => {
    const s = setup();
    const b = s.sit('b1', who('b'));
    s.roster.seat('R', 'b2', b, 'b2');
    const a = s.sit('a', who('a'));
    s.mutes.set(a, b, true);
    expect(s.chat.hiddenFor('R', 'b1')).toEqual(['a']);
    expect(s.chat.hiddenFor('R', 'b2')).toEqual(['a']);
    expect(s.chat.hiddenFor('R', 'b1')).toEqual(s.slow('R', 'b1'));
    s.mutes.set(b, a, true, 'block');
    expect(s.chat.hiddenFor('R', 'b1')).toEqual(['a']);
    expect(s.chat.hiddenFor('R', 'a')).toEqual(['b1', 'b2']);
    expect(s.chat.hiddenFor('R', 'a')).toEqual(s.slow('R', 'a'));
  });

  it('after merges: a muter whose two ids merged, listed through whichever id the seat holds', () => {
    const s = setup();
    const v1 = s.sit('v1', who('v-key'));
    const v2 = s.sit('v2', who('v-acct-key', 'v-acct'));
    const t = s.sit('t', who('t-key'));
    s.mutes.set(v1, t, true);
    expect(s.chat.hiddenFor('R', 't')).toEqual(['v1']);
    s.person(who('v-key', 'v-acct'));
    expect(s.subjects.canonical(v1)).toBe(s.subjects.canonical(v2));
    expect(s.chat.hiddenFor('R', 't')).toEqual(['v1', 'v2']);
    expect(s.chat.hiddenFor('R', 't')).toEqual(s.slow('R', 't'));
  });

  it('differential: over a random world of mutes, blocks, unmutes and seat changes it always equals the slow answer', () => {
    const s = setup();
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const people: SubjectId[] = [];
    for (let i = 0; i < 14; i += 1) people.push(s.sit(`s${i}`, who(`p${i}`)));
    for (let step = 0; step < 300; step += 1) {
      const op = rnd(10);
      const x = people[rnd(people.length)] as SubjectId;
      const y = people[rnd(people.length)] as SubjectId;
      if (op < 4) s.mutes.set(x, y, true);
      else if (op < 6) s.mutes.set(x, y, true, 'block');
      else if (op < 8) s.mutes.set(x, y, false);
      else if (op === 8) s.roster.unseat('R', `s${rnd(14)}`);
      else s.roster.seat('R', `s${rnd(14)}`, people[rnd(people.length)] as SubjectId, 'h');
      for (let i = 0; i < 14; i += 1) expect(s.chat.hiddenFor('R', `s${i}`), `step ${step} seat s${i}`).toEqual(s.slow('R', `s${i}`));
    }
  });
});

describe('the cost is the muters, not the seats', () => {
  it('a room of 5000 seats with 3 muters: 200 lines answer well inside a generous budget, and equal the slow answer', () => {
    const s = setup();
    const sender = s.sit('sender', who('sender'));
    const muters: SubjectId[] = [];
    for (let i = 0; i < 3; i += 1) muters.push(s.sit(`m${i}`, who(`muter-${i}`)));
    for (let i = 0; i < 5000; i += 1) s.sit(`seat${i}`, who(`quiet-${i}`));
    for (const m of muters) s.mutes.set(m, sender, true);
    expect(s.chat.hiddenFor('R', 'sender')).toEqual(['m0', 'm1', 'm2']);
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) s.chat.hiddenFor('R', 'sender');
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(s.slow('R', 'sender')).toEqual(['m0', 'm1', 'm2']);
  });
});

export type { Setup };
