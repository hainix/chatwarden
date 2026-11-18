import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { RoomRoster } from '../src/evidence.js';
import { MAX_MUTES_PER_VIEWER, MUTE_TTL_MS, MuteService } from '../src/mutes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SubjectId } from '../src/types.js';
import { world } from './reportingWorld.js';
import { ChatService } from '../src/chat.js';
import { EvidenceBuffer } from '../src/evidence.js';
import { SanctionIndex } from '../src/sanctions.js';
import { StrikeService } from '../src/strikes.js';

// M4: Block. A block is a mute the viewer makes lasting and two-way. Mute and block share one row per pair (`block` 0 or 1): the latest action wins, muting a blocked pair changes nothing,
// unblocking removes the row; a block is never purged by age; the 500-per-viewer cap drops the oldest MUTE, never a block.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const who = (clientKey: string | null, accountId: string | null = null): Identifiers => ({ clientKey, accountId, ipHash: null });

function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const mutes = new MuteService(store, clock, subjects, { logger });
  const roster = new RoomRoster();
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
  return { store, clock, subjects, mutes, roster, logs, person, sit };
}

type Setup = ReturnType<typeof setup>;
const rows = (s: Setup) => s.store.rawMutes().map((r) => ({ viewer: r.viewer, target: r.target, block: r.block }));

describe('the service: mute and block share one row per pair', () => {
  it('a block is stored with block true; a mute with block false; unmuting or unblocking deletes the row', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    const c = s.person(who('c'));
    expect(s.mutes.set(a, b, true, 'block')).toBe('ok');
    expect(s.mutes.set(a, c, true)).toBe('ok');
    expect(rows(s)).toEqual([{ viewer: a, target: b, block: true }, { viewer: a, target: c, block: false }]);
    expect(s.mutes.isBlocked(a, b)).toBe(true);
    expect(s.mutes.isBlocked(a, c)).toBe(false);
    expect(s.mutes.isMuted(a, b)).toBe(true);
    s.mutes.set(a, b, false);
    s.mutes.set(a, c, false);
    expect(rows(s)).toEqual([]);
    expect(s.mutes.isBlocked(a, b)).toBe(false);
  });

  it('latest wins: a block over a mute makes it a block; a mute over a block changes nothing (a mute never downgrades a block); an unblock deletes the row', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    s.mutes.set(a, b, true);
    s.mutes.set(a, b, true, 'block');
    expect(rows(s)).toEqual([{ viewer: a, target: b, block: true }]);
    s.clock.t += 1000;
    const before = s.store.rawMutes()[0]!.createdAt;
    expect(s.mutes.set(a, b, true)).toBe('ok');
    expect(rows(s)).toEqual([{ viewer: a, target: b, block: true }]);
    expect(s.store.rawMutes()[0]!.createdAt).toBe(before);
    expect(s.mutes.isBlocked(a, b)).toBe(true);
    s.mutes.set(a, b, false, 'block');
    expect(rows(s)).toEqual([]);
    // and the other way round: a block over a mute, then the mute again after an unblock
    s.mutes.set(a, b, true);
    expect(rows(s)).toEqual([{ viewer: a, target: b, block: false }]);
  });

  it('blocking twice refreshes nothing harmful and keeps one row', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    s.mutes.set(a, b, true, 'block');
    s.mutes.set(a, b, true, 'block');
    expect(rows(s)).toHaveLength(1);
  });

  it('is directional: A blocking B does not make B a blocker of A, and other pairs are untouched', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    const c = s.person(who('c'));
    s.mutes.set(a, b, true, 'block');
    expect(s.mutes.isBlocked(b, a)).toBe(false);
    expect(s.mutes.isMuted(b, a)).toBe(false);
    expect(s.mutes.isBlocked(a, c)).toBe(false);
    expect(s.mutes.isBlocked(c, b)).toBe(false);
    expect(s.mutes.blockedBetween(a, b)).toBe(true);
    expect(s.mutes.blockedBetween(b, a)).toBe(true);
    expect(s.mutes.blockedBetween(a, c)).toBe(false);
  });

  it('blocking oneself, an empty id or a guest does nothing', () => {
    const s = setup();
    const a = s.person(who('a'));
    expect(s.mutes.set(a, a, true, 'block')).toBe('none');
    expect(s.mutes.set(a, '' as SubjectId, true, 'block')).toBe('none');
    expect(s.mutes.set(null as unknown as SubjectId, a, true, 'block')).toBe('none');
    expect(s.mutes.set(a, null as unknown as SubjectId, true, 'block')).toBe('none');
    expect(rows(s)).toEqual([]);
  });

  it('a block follows a merge on the blocked side, on the blocker side, and survives a new block over the merged person (one row)', () => {
    const s = setup();
    const v = s.person(who('v-key'));
    const t1 = s.person(who('t-key'));
    const t2 = s.person(who(null, 't-acct'));
    s.mutes.set(v, t1, true, 'block');
    expect(s.mutes.isBlocked(v, t2)).toBe(false);
    const merged = s.person(who('t-key', 't-acct')); // the two subjects are found to be one person
    expect(s.mutes.isBlocked(v, merged)).toBe(true);
    expect(s.mutes.isBlocked(v, t2)).toBe(true);
    expect(s.mutes.blockedBetween(t2, v)).toBe(true);
    s.mutes.set(v, merged, true, 'block');
    expect(rows(s)).toHaveLength(1);
    // the blocker's side: a block stored under the absorbed viewer id still applies to the surviving one, both ways
    const v1 = s.person(who('v1-key'));
    const v2 = s.person(who(null, 'v2-acct'));
    const x = s.person(who('x-key'));
    s.mutes.set(v2, x, true, 'block');
    s.person(who('v1-key', 'v2-acct'));
    expect(s.mutes.isBlocked(v1, x)).toBe(true);
    expect(s.mutes.blockedBetween(x, v1)).toBe(true);
    expect(s.mutes.blockedBetween(x, v2)).toBe(true);
  });

  it('a mute over a block of the same person under an older id changes nothing', () => {
    const s = setup();
    const v = s.person(who('v-key'));
    const t1 = s.person(who('t-key'));
    s.person(who(null, 't-acct'));
    s.mutes.set(v, t1, true, 'block');
    const merged = s.person(who('t-key', 't-acct'));
    expect(s.mutes.set(v, merged, true)).toBe('ok');
    expect(s.mutes.isBlocked(v, merged)).toBe(true);
    expect(rows(s).every((r) => r.block)).toBe(true);
  });

  it('a look-alike is not blocked: a new person with the same name is a new person', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    s.mutes.set(a, b, true, 'block');
    const stranger = s.person(who('someone-else'));
    expect(s.mutes.blockedBetween(a, stranger)).toBe(false);
  });
});

describe('a block lasts until undone', () => {
  it('a block older than 180 days still applies, a mute that old does not, after a reload too', async () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    const c = s.person(who('c'));
    s.mutes.set(a, b, true, 'block');
    s.mutes.set(a, c, true);
    s.clock.t += MUTE_TTL_MS + DAY;
    expect(s.mutes.isBlocked(a, b)).toBe(true);
    expect(s.mutes.isMuted(a, b)).toBe(true);
    expect(s.mutes.isMuted(a, c)).toBe(false);
    const again = new MuteService(s.store, s.clock, s.subjects);
    await again.load();
    expect(again.isBlocked(a, b)).toBe(true);
    expect(again.isMuted(a, c)).toBe(false);
  });

  it('a block survives the retention purge at any age while a mute older than 180 days goes', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    const c = s.person(who('c'));
    s.store.upsertMute({ viewer: a, target: b, createdAt: NOW - 900 * DAY, block: true });
    s.store.upsertMute({ viewer: a, target: c, createdAt: NOW - 200 * DAY, block: false });
    expect(s.store.purgeMutes(NOW - MUTE_TTL_MS)).toBe(1);
    expect(rows(s)).toEqual([{ viewer: a, target: b, block: true }]);
  });
});

describe('the 500 per viewer cap', () => {
  it('drops the oldest mute for a new one and never a block', () => {
    const s = setup();
    const v = s.person(who('v'));
    const ids: SubjectId[] = [];
    for (let i = 0; i < MAX_MUTES_PER_VIEWER; i += 1) ids.push(s.person(who(`t${i}`)));
    // the oldest is a block, the next a mute, the rest mutes
    s.mutes.set(v, ids[0] as SubjectId, true, 'block');
    for (let i = 1; i < MAX_MUTES_PER_VIEWER; i += 1) {
      s.clock.t += 1;
      s.mutes.set(v, ids[i] as SubjectId, true);
    }
    expect(rows(s)).toHaveLength(MAX_MUTES_PER_VIEWER);
    const extra = s.person(who('extra'));
    expect(s.mutes.set(v, extra, true)).toBe('ok');
    expect(rows(s)).toHaveLength(MAX_MUTES_PER_VIEWER);
    expect(s.mutes.isBlocked(v, ids[0] as SubjectId)).toBe(true);
    expect(s.mutes.isMuted(v, ids[1] as SubjectId)).toBe(false);
    expect(s.mutes.isMuted(v, extra)).toBe(true);
  });

  it('with 500 blocks a new block or a new mute is refused (limit) and nothing is written; an existing pair can still be changed', () => {
    const s = setup();
    const v = s.person(who('v'));
    const ids: SubjectId[] = [];
    for (let i = 0; i < MAX_MUTES_PER_VIEWER; i += 1) {
      const t = s.person(who(`t${i}`));
      ids.push(t);
      s.mutes.set(v, t, true, 'block');
    }
    const extra = s.person(who('extra'));
    expect(s.mutes.set(v, extra, true, 'block')).toBe('limit');
    expect(s.mutes.set(v, extra, true)).toBe('limit');
    expect(rows(s)).toHaveLength(MAX_MUTES_PER_VIEWER);
    expect(s.mutes.isMuted(v, extra)).toBe(false);
    // unblocking one makes room
    s.mutes.set(v, ids[0] as SubjectId, false);
    expect(s.mutes.set(v, extra, true, 'block')).toBe('ok');
    expect(rows(s)).toHaveLength(MAX_MUTES_PER_VIEWER);
  });

  it('turning an existing mute into a block never needs room', () => {
    const s = setup();
    const v = s.person(who('v'));
    const ids: SubjectId[] = [];
    for (let i = 0; i < MAX_MUTES_PER_VIEWER; i += 1) {
      const t = s.person(who(`t${i}`));
      ids.push(t);
      s.mutes.set(v, t, true);
    }
    expect(s.mutes.set(v, ids[7] as SubjectId, true, 'block')).toBe('ok');
    expect(rows(s)).toHaveLength(MAX_MUTES_PER_VIEWER);
    expect(s.mutes.isBlocked(v, ids[7] as SubjectId)).toBe(true);
  });

  it('with 499 blocks and one mute, a new block drops the mute and the cap holds', () => {
    const s = setup();
    const v = s.person(who('v'));
    for (let i = 0; i < MAX_MUTES_PER_VIEWER - 1; i += 1) s.mutes.set(v, s.person(who(`b${i}`)), true, 'block');
    const m = s.person(who('m'));
    s.mutes.set(v, m, true);
    const extra = s.person(who('extra'));
    expect(s.mutes.set(v, extra, true, 'block')).toBe('ok');
    expect(s.mutes.isMuted(v, m)).toBe(false);
    expect(s.mutes.isBlocked(v, extra)).toBe(true);
    expect(rows(s).filter((r) => r.block)).toHaveLength(MAX_MUTES_PER_VIEWER);
  });
});

describe('seats', () => {
  it('blockedSeats lists the seats the viewer blocked and mutedSeats lists blocks too; neither lists the other direction', () => {
    const s = setup();
    const v = s.sit('p1', who('v'));
    const b = s.sit('p2', who('b'));
    const m = s.sit('p3', who('m'));
    const x = s.sit('p4', who('x'));
    s.mutes.set(v, b, true, 'block');
    s.mutes.set(v, m, true);
    s.mutes.set(x, v, true, 'block');
    expect(s.mutes.blockedSeats('R', 'p1', s.roster)).toEqual(['p2']);
    expect(s.mutes.mutedSeats('R', 'p1', s.roster)).toEqual(['p2', 'p3']);
    expect(s.mutes.blockedSeats('R', 'p4', s.roster)).toEqual(['p1']);
    expect(s.mutes.blockedSeats('R', 'p2', s.roster)).toEqual([]);
    expect(s.mutes.blockedSeats('R', 'nobody', s.roster)).toEqual([]);
  });
});

describe('visibleTo is two-way for a block', () => {
  function chatOf(s: Setup) {
    const clock = s.clock;
    const quiet: Logger = { warn() {} };
    return new ChatService({
      roster: s.roster,
      buffer: new EvidenceBuffer({ clock }),
      subjects: s.subjects,
      sanctions: new SanctionIndex({ enabled: () => true, subjects: s.subjects }),
      store: s.store,
      strikes: new StrikeService(s.store, clock, s.subjects, { logger: quiet }),
      mutes: s.mutes,
      clock,
      logger: quiet,
    });
  }

  it('viewer muted sender false; viewer blocked sender false; sender blocked viewer false; neither true; own lines always true', () => {
    const s = setup();
    const chat = chatOf(s);
    const a = s.sit('p1', who('a'));
    const b = s.sit('p2', who('b'));
    s.sit('p3', who('c'));
    expect(chat.visibleTo('R', 'p1', 'p2')).toBe(true);
    s.mutes.set(a, b, true);
    expect(chat.visibleTo('R', 'p1', 'p2')).toBe(false);
    expect(chat.visibleTo('R', 'p2', 'p1')).toBe(true);
    s.mutes.set(a, b, true, 'block');
    expect(chat.visibleTo('R', 'p1', 'p2')).toBe(false);
    expect(chat.visibleTo('R', 'p2', 'p1')).toBe(false);
    expect(chat.visibleTo('R', 'p3', 'p1')).toBe(true);
    expect(chat.visibleTo('R', 'p3', 'p2')).toBe(true);
    expect(chat.visibleTo('R', 'p1', 'p1')).toBe(true);
    expect(chat.visibleTo('R', 'p2', 'p2')).toBe(true);
    s.mutes.set(a, b, false);
    expect(chat.visibleTo('R', 'p2', 'p1')).toBe(true);
    // a mute (not a block) stays one-way
    s.mutes.set(b, a, true);
    expect(chat.visibleTo('R', 'p2', 'p1')).toBe(false);
    expect(chat.visibleTo('R', 'p1', 'p2')).toBe(true);
  });

  it('an empty seat reads as visible, and a throwing store reads as visible (a broken block store must not silence a room)', () => {
    const s = setup();
    const chat = chatOf(s);
    const a = s.sit('p1', who('a'));
    const b = s.sit('p2', who('b'));
    s.mutes.set(a, b, true, 'block');
    expect(chat.visibleTo('R', 'p1', 'nobody')).toBe(true);
    expect(chat.visibleTo('R', 'nobody', 'p1')).toBe(true);
    s.mutes.isBlocked = () => {
      throw new Error('store down');
    };
    expect(chat.visibleTo('R', 'p2', 'p1')).toBe(true);
  });
});

describe('cw.blocks', () => {
  const player = (w: Awaited<ReturnType<typeof world>>, room: string, seat: string, key: string, account?: string): void => {
    w.cw.rooms.seat(room, seat, { clientKey: key, ...(account === undefined ? {} : { accountId: account }) }, `Handle-${seat}`);
  };

  it('set blocks and unblocks by seat; between is true in both directions; chat.visibleTo follows', async () => {
    const w = await world();
    player(w, 'R', 'p1', 'key-aaaaaaaaaaaa-1');
    player(w, 'R', 'p2', 'key-bbbbbbbbbbbb-2');
    expect(w.cw.blocks.between({ clientKey: 'key-aaaaaaaaaaaa-1' }, { clientKey: 'key-bbbbbbbbbbbb-2' })).toBe(false);
    expect(w.cw.blocks.set('R', 'p1', 'p2', true)).toBe('ok');
    expect(w.cw.blocks.between({ clientKey: 'key-aaaaaaaaaaaa-1' }, { clientKey: 'key-bbbbbbbbbbbb-2' })).toBe(true);
    expect(w.cw.blocks.between({ clientKey: 'key-bbbbbbbbbbbb-2' }, { clientKey: 'key-aaaaaaaaaaaa-1' })).toBe(true);
    expect(w.cw.chat.visibleTo('R', 'p2', 'p1')).toBe(false);
    expect(w.cw.mutes.blockedSeats('R', 'p1')).toEqual(['p2']);
    expect(w.cw.mutes.mutedSeats('R', 'p1')).toEqual(['p2']);
    expect(w.cw.blocks.set('R', 'p1', 'p2', false)).toBe('ok');
    expect(w.cw.blocks.between({ clientKey: 'key-aaaaaaaaaaaa-1' }, { clientKey: 'key-bbbbbbbbbbbb-2' })).toBe(false);
    expect(w.cw.chat.visibleTo('R', 'p2', 'p1')).toBe(true);
  });

  it('between is false for an unknown person and never creates a subject', async () => {
    const w = await world();
    player(w, 'R', 'p1', 'key-aaaaaaaaaaaa-1');
    await new Promise((r) => setTimeout(r, 20));
    const before = (await w.store.loadSubjects()).subjects.length;
    expect(w.cw.blocks.between({ clientKey: 'never-seen-anywhere-000' }, { clientKey: 'key-aaaaaaaaaaaa-1' })).toBe(false);
    expect(w.cw.blocks.between({ clientKey: 'never-seen-anywhere-000' }, { clientKey: 'never-seen-anywhere-001' })).toBe(false);
    expect(w.cw.blocks.between({ ip: '203.0.113.9' }, { clientKey: 'key-aaaaaaaaaaaa-1' })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect((await w.store.loadSubjects()).subjects.length).toBe(before);
  });

  it('anyBetween preserves order and answers one boolean per other; a limit of 50 and a non-list are refused', async () => {
    const w = await world();
    player(w, 'R', 'p1', 'key-aaaaaaaaaaaa-1');
    player(w, 'R', 'p2', 'key-bbbbbbbbbbbb-2');
    player(w, 'R', 'p3', 'key-cccccccccccc-3');
    w.cw.blocks.set('R', 'p1', 'p3', true);
    const me = { clientKey: 'key-aaaaaaaaaaaa-1' };
    const others = [{ clientKey: 'key-bbbbbbbbbbbb-2' }, { clientKey: 'key-cccccccccccc-3' }, { clientKey: 'nobody-0000000000' }, { clientKey: 'key-cccccccccccc-3' }];
    expect(w.cw.blocks.anyBetween(me, others)).toEqual([false, true, false, true]);
    expect(w.cw.blocks.anyBetween(me, [])).toEqual([]);
    expect(w.cw.blocks.anyBetween(me, Array.from({ length: 50 }, () => ({ clientKey: 'key-bbbbbbbbbbbb-2' })))).toHaveLength(50);
    expect(() => w.cw.blocks.anyBetween(me, Array.from({ length: 51 }, () => ({ clientKey: 'key-bbbbbbbbbbbb-2' })))).toThrow(RangeError);
    expect(() => w.cw.blocks.anyBetween(me, 'x' as never)).toThrow();
    // the asker is unknown: all false
    expect(w.cw.blocks.anyBetween({ clientKey: 'nobody-0000000000' }, others)).toEqual([false, false, false, false]);
  });

  it('two guests are never blocked, and a seat with no person does nothing', async () => {
    const w = await world();
    w.cw.rooms.seat('R', 'p1', { clientKey: 'key-aaaaaaaaaaaa-1' }, 'A');
    w.cw.rooms.seat('R', 'p2', { clientKey: 'key-bbbbbbbbbbbb-2' }, 'B');
    // erase both so their seats become guests
    for (const seat of ['p1', 'p2']) {
      const subject = w.cw.rooms.subjectAt('R', seat)!;
      await w.cw.privacy.erase(subject, { keep: 'none', actor: 'owner_ann' });
    }
    expect(w.cw.rooms.subjectAt('R', 'p1')).toBeNull();
    expect(w.cw.blocks.set('R', 'p1', 'p2', true)).toBe('none');
    expect(w.cw.blocks.set('R', 'p1', 'p9', true)).toBe('none');
    expect(w.cw.blocks.set('R', 'p9', 'p1', true)).toBe('none');
    expect((w.store as MemoryStore).rawMutes()).toEqual([]);
  });

  it('a block is a mute for hiding but is refused as limit through the facade at 500 blocks', async () => {
    const w = await world();
    w.cw.rooms.seat('R', 'v', { clientKey: 'key-viewer-000000' }, 'V');
    for (let i = 0; i < MAX_MUTES_PER_VIEWER; i += 1) {
      w.cw.rooms.seat('R', `t${i}`, { clientKey: `key-target-${String(i).padStart(6, '0')}` }, `T${i}`);
      expect(w.cw.blocks.set('R', 'v', `t${i}`, true)).toBe('ok');
    }
    w.cw.rooms.seat('R', 'extra', { clientKey: 'key-target-extra000' }, 'E');
    expect(w.cw.blocks.set('R', 'v', 'extra', true)).toBe('limit');
    expect(w.cw.mutes.set('R', 'v', 'extra', true)).toBe('limit');
  });
});

describe('off means unchanged', () => {
  it('with no block ever made, mute behaves as it did: set returns ok, rows carry block false, the TTL and the cap are the old ones', () => {
    const s = setup();
    const a = s.person(who('a'));
    const b = s.person(who('b'));
    expect(s.mutes.set(a, b, true)).toBe('ok');
    expect(rows(s)).toEqual([{ viewer: a, target: b, block: false }]);
    s.clock.t += MUTE_TTL_MS + 1;
    expect(s.mutes.isMuted(a, b)).toBe(false);
    expect(s.mutes.isBlocked(a, b)).toBe(false);
  });
});
