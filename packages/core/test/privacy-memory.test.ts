import { describe, expect, it } from 'vitest';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { createPacer } from '../src/pacing.js';
import { SubjectIndex } from '../src/subjects.js';
import { ViewingPresence } from '../src/team.js';
import type { ResolvedPace } from '../src/pace.js';
import { A, A_LINE, B, B_LINE, NOW, dump, fillA, privacyWorld } from './privacyWorld.js';
import { MemoryStore } from '@chatwarden/store-memory';

// What an erase does in memory (design 5.1, last paragraph): the subject index, the room roster (seats become guests), the evidence buffers, the sanction and mute
// indexes, pacing, notices, strikes, signals, claims and viewing hints. A line from a still-connected player afterwards makes a new, unlinked subject.

const OWNER = 'owner_ann';

describe('a connected player after an erase none', () => {
  it('their seat reads as a guest, and the next line makes a new unlinked subject, never a row under the old id', async () => {
    const w = await privacyWorld();
    await fillA(w);
    expect(w.cw.rooms.subjectAt('R1', 'p1')).toBe(w.aId);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(w.cw.rooms.subjectAt('R1', 'p1')).toBeNull();
    // the connection says another line: delivered as a guest's line, with nothing stored under the old person
    expect(w.cw.chat.accept('R1', 'p1', 'one more line after the erase')).toMatchObject({ deliver: { text: 'one more line after the erase' } });
    // the game seats them again (a new session): a NEW subject, linked to nothing
    w.seat('R1', 'p1', A);
    await w.cw.flush();
    const fresh = w.cw.rooms.subjectAt('R1', 'p1') as string;
    expect(fresh).not.toBe(w.aId);
    expect(w.cw.people.aliases(fresh)).toEqual([fresh]);
    const after = dump(w.store);
    expect(after).not.toContain(w.aId);
    // the new subject holds the identifiers the player just presented, not the old ones' history
    expect(w.store.loadStrikes(0).some((s) => s.subject === w.aId)).toBe(false);
  });

  it('no row under the old id appears later either: a strike, a signal, a notice and a claim written for the old id by a stale writer are dropped by the sweep', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    w.store.insertStrike({ id: 'late-strike', at: NOW, subject: w.aId, roomId: 'R1', termId: 't', rawLine: A_LINE });
    w.store.insertSignal({ id: 'late-sig', kind: 'muted_by_player', subject: w.aId, sourceKey: 'd:1', bySubject: null, roomId: null, at: NOW, weight: 1, capBucket: 1 });
    w.clock.t = NOW + 11 * 60_000;
    const result = await w.cw.purge();
    expect(result.strayRows).toBeGreaterThanOrEqual(2);
    expect(dump(w.store)).not.toContain('late-strike');
    expect(dump(w.store)).not.toContain('late-sig');
  });

  it('their evidence lines lose text, handle and subject: a report filed afterwards shows a marker where they spoke, and the other player\'s lines intact', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    // a third player in the same room reports the other player
    w.seat('R1', 'p3', { key: 'key-c-0003', account: 'acct-c-0003', ip: '10.0.0.33', handle: 'CharlieHandle' });
    await w.cw.flush();
    const res = await w.cw.reports.submit({ roomId: 'R1', reporterSeat: 'p3', targetSeat: 'p2', reason: 'spam' });
    if (!res.ok) throw new Error('refused');
    const stored = w.store.loadReport(res.reportId);
    const lines = stored?.excerpt ?? [];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.raw.includes('tarvo alpha'))).toBe(false);
    expect(lines.filter((l) => l.raw === '[erased]').length).toBe(2);
    for (const l of lines.filter((l) => l.raw === '[erased]')) expect(l).toMatchObject({ handle: '', p: null });
    expect(lines.some((l) => l.raw === B_LINE && l.handle === B.handle)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(w.aId);
  });

  it('the mute and sanction indexes forget them: a mute that hid their lines no longer applies, and a ban that was theirs no longer refuses the key', async () => {
    const w = await privacyWorld();
    await fillA(w);
    expect(w.cw.chat.visibleTo('R1', 'p2', 'p1')).toBe(false);
    await w.cw.sanctions.apply({ kind: 'ban', subject: w.aId, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(true);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(w.cw.chat.visibleTo('R1', 'p2', 'p1')).toBe(true);
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(false);
  });

  it('the person is gone from the subject index: aliases, canonical and accounts read as an unknown id', async () => {
    const w = await privacyWorld();
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(w.cw.people.accountIds(w.aId)).toEqual([]);
    expect(w.cw.people.aliases(w.aId)).toEqual([w.aId]);
    expect(w.cw.people.accountIds(w.bId)).toEqual([B.account]);
  });
});

describe('keep safety with a ban in force: the door still refuses the same key', () => {
  it('the person stays in the subject index and the ban still applies, while their lines and other rows are gone', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.sanctions.apply({ kind: 'ban', subject: w.aId, includeIp: true, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    await w.cw.privacy.erase(w.aId, { keep: 'safety', actor: OWNER });
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(true);
    expect(w.cw.chat.restricted({ accountId: A.account }).restricted).toBe(true);
    expect(w.cw.rooms.subjectAt('R1', 'p1')).toBe(w.aId);
    expect(w.cw.privacy.find({ clientKey: A.key })).toBe(w.aId);
    expect(w.store.loadStrikes(0).some((s) => s.subject === w.aId)).toBe(false);
    // the mute that hid them is gone: the mutes were erased
    expect(w.cw.chat.visibleTo('R1', 'p2', 'p1')).toBe(true);
  });
});

describe('the in-memory pieces, one by one', () => {
  it('EvidenceBuffer.scrub: lines of the set lose text, handle and subject; others and the order are untouched; ids keep counting', () => {
    const clock = { now: () => NOW };
    const buffer = new EvidenceBuffer({ clock });
    const put = (subject: string | null, handle: string, raw: string) => buffer.append('R', { ts: NOW, seatId: 'p1', handle, subject, raw, delivered: raw, blocked: false, audience: ['p1', 'p2'] });
    put('s_a', 'Aa', 'a one');
    put('s_b', 'Bb', 'b one');
    put('s_a', 'Aa', 'a two');
    put(null, 'Gg', 'guest');
    buffer.scrub(new Set(['s_a']));
    const lines = buffer.snapshot('R');
    expect(lines.map((l) => [l.lineId, l.subject, l.handle, l.raw, l.delivered])).toEqual([
      ['1', null, '', '[erased]', '[erased]'],
      ['2', 's_b', 'Bb', 'b one', 'b one'],
      ['3', null, '', '[erased]', '[erased]'],
      ['4', null, 'Gg', 'guest', 'guest'],
    ]);
    expect(lines[0]?.audience).toEqual(['p1', 'p2']);
    expect(put('s_b', 'Bb', 'b two')).toBe('5');
    // a blocked line has no delivered text: it stays null
    buffer.append('R', { ts: NOW, seatId: 'p1', handle: 'Aa', subject: 's_a', raw: 'blocked a', delivered: null, blocked: true, audience: null });
    buffer.scrub(new Set(['s_a']));
    expect(buffer.snapshot('R').at(-1)).toMatchObject({ raw: '[erased]', delivered: null, subject: null, blocked: true });
    // an empty set and an unknown person change nothing
    const before = JSON.stringify(buffer.snapshot('R'));
    buffer.scrub(new Set());
    buffer.scrub(new Set(['s_zzz']));
    expect(JSON.stringify(buffer.snapshot('R'))).toBe(before);
  });

  it('RoomRoster.forget: seats of the set become guests (the handle stays: it is the seat\'s), other seats and the tags are kept', () => {
    const roster = new RoomRoster();
    roster.seat('R', 'p1', 's_a', 'Aa', { mode: 'x' });
    roster.seat('R', 'p2', 's_b', 'Bb');
    roster.seat('Q', 'p1', 's_a', 'Aa');
    roster.forget(new Set(['s_a']));
    expect(roster.occupant('R', 'p1')).toEqual({ subject: null, handle: 'Aa' });
    expect(roster.occupant('Q', 'p1')).toEqual({ subject: null, handle: 'Aa' });
    expect(roster.occupant('R', 'p2')).toEqual({ subject: 's_b', handle: 'Bb' });
    expect(roster.tags('R')).toEqual({ mode: 'x' });
    expect(roster.seats('R')).toEqual(['p1', 'p2']);
  });

  it('SubjectIndex.forget: the people, their keys and accounts and their aliases are gone; others are kept; a returning key makes a new subject', async () => {
    const store = new MemoryStore();
    const clock = { t: NOW, now: () => clock.t };
    const idx = new SubjectIndex(store, clock, { logger: { warn() {} } });
    await idx.load();
    const a = idx.resolve({ clientKey: 'k-a', accountId: 'acct-a', ipHash: 'ip-a' }) as string;
    const a2 = idx.resolve({ clientKey: 'k-a2', accountId: 'acct-a', ipHash: null }) as string;
    const b = idx.resolve({ clientKey: 'k-b', accountId: null, ipHash: null }) as string;
    expect(a2).toBe(a);
    await idx.flush();
    idx.forget(idx.aliasesOf(a));
    expect(idx.knows(a)).toBe(false);
    expect(idx.lookup({ clientKey: 'k-a', accountId: null, ipHash: null })).toBeNull();
    expect(idx.lookup({ clientKey: 'k-a2', accountId: 'acct-a', ipHash: null })).toBeNull();
    expect(idx.identifiersOf(a)).toEqual({ accounts: [], keys: [], ips: [] });
    expect(idx.aliasesOf(a)).toEqual([a]);
    expect(idx.lookup({ clientKey: 'k-b', accountId: null, ipHash: null })).toBe(b);
    const again = idx.resolve({ clientKey: 'k-a', accountId: 'acct-a', ipHash: 'ip-a' }) as string;
    expect(again).not.toBe(a);
    expect(idx.aliasesOf(again)).toEqual([again]);
  });

  it('ViewingPresence.forgetPeople: a staff member who had the case open no longer shows as viewing it', () => {
    const clock = { now: () => NOW };
    const v = new ViewingPresence(clock);
    v.touch('s_a', 'mod_ann');
    v.touch('s_a', 'mod_bea');
    v.touch('s_b', 'mod_ann');
    v.forgetPeople(new Set(['s_a']));
    expect(v.viewers('s_a')).toEqual([]);
    expect(v.viewers('s_b')).toEqual(['mod_ann']);
    v.touch('s_a', 'mod_ann');
    expect(v.viewers('s_a')).toEqual(['mod_ann']);
  });

  it('Pacer.forgetPeople: the slow-mode and duplicate memory of the person is dropped, others kept', () => {
    const clock = { t: NOW, now: () => clock.t };
    const settings: ResolvedPace = { slowModeMs: 10_000, burst: null, duplicateWindowMs: 60_000 };
    const pacer = createPacer({ clock, settings: () => settings });
    const key = (who: string) => ({ roomId: 'R', who });
    pacer.commit(key('s_a'), 'hello there friend');
    pacer.commit(key('s_b'), 'hello there friend');
    expect(pacer.check(key('s_a'), 'hello there friend').ok).toBe(false);
    pacer.forgetPeople(new Set(['s_a']));
    expect(pacer.check(key('s_a'), 'hello there friend').ok).toBe(true);
    expect(pacer.check(key('s_b'), 'hello there friend').ok).toBe(false);
    expect(pacer.size()).toBe(1);
  });
});

describe('claims and the case: an erased person\'s case claim is released', () => {
  it('the claim is gone from the store, and the holders read empty', async () => {
    const w = await privacyWorld();
    await fillA(w);
    expect(w.cw.cases.holders([w.aId]).size).toBe(1);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(w.cw.cases.holders([w.aId]).size).toBe(0);
  });
});
