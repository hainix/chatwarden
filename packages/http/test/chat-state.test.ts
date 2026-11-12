import { describe, expect, it } from 'vitest';
import type { SendResult } from '../src/chat/wire.js';
import { chatWorld, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';

function say(w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult {
  w.advance(2 * SEC);
  return s.send({ text });
}

describe('noticePending', () => {
  it("writes notices and state to that person's streams only", async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    const tab = spoken();
    p.session.open(tab.sink);
    const q = w.attend(ROOM, 'wumbo');
    const elsewhere = w.attend('other-room', 'glarn');
    const subject = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'));
    if (subject === null) throw new Error('no subject');

    await w.sanction('chat', ROOM, 'plenk', 3_600_000);
    w.chat.noticePending(subject);

    for (const heard of [p.heard, tab]) {
      const tail = heard.frames.slice(1).map((f) => f.type);
      expect(tail).toEqual(['notices', 'state']);
      expect(heard.of('notices')[0]).toEqual({ type: 'notices' }); // carries nothing else
      expect(heard.of('state')[0]?.restriction).toEqual({ until: expect.any(Number), byModerator: true });
      expect(heard.of('state')[0]?.muted).toEqual([]);
    }
    expect(q.heard.frames.map((f) => f.type)).toEqual(['hello']);
    expect(elsewhere.heard.frames.map((f) => f.type)).toEqual(['hello']);
    // nothing in the frames names the subject
    expect(JSON.stringify([p.heard.frames, tab.frames])).not.toContain(subject);
  });

  it("including a merged alias: both seats of one person hear it", async () => {
    const w = await chatWorld();
    const byAccount = w.attend(ROOM, 'plenk', { accountId: 'acct-merge-1', clientKey: undefined });
    const byKey = w.attend(ROOM, 'wumbo', { clientKey: 'key-merge-aaaaaaaa' });
    const bystander = w.attend(ROOM, 'glarn');
    expect(w.chat.stats().members).toBe(3);
    const subjectA = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'));
    const subjectB = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'wumbo'));
    expect(subjectA).not.toBeNull();
    expect(subjectA).not.toBe(subjectB);
    // the same person shows both identifiers: the kit merges the two subjects into one
    w.chat.session('merge-room', { accountId: 'acct-merge-1', clientKey: 'key-merge-aaaaaaaa' }, { name: 'both' });
    const merged = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'));
    expect(merged).toBe(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'wumbo')));

    w.chat.noticePending(merged as string);
    expect(byAccount.heard.frames.slice(1).map((f) => f.type)).toEqual(['notices', 'state']);
    expect(byKey.heard.frames.slice(1).map((f) => f.type)).toEqual(['notices', 'state']);
    expect(bystander.heard.frames.map((f) => f.type)).toEqual(['hello']);
  });

  it('a subject nobody holds, or a non-subject, writes nothing and does not throw', async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    for (const bad of ['s_nobody', '', undefined, null, 5, {}]) expect(() => w.chat.noticePending(bad as never)).not.toThrow();
    expect(p.heard.frames).toHaveLength(1);
  });

  it('a person with no open stream (only a seat) gets nothing and nothing is queued for later', async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    const subject = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk')) as string;
    p.stream.close();
    w.chat.noticePending(subject);
    const later = spoken();
    p.session.open(later.sink);
    expect(later.frames.map((f) => f.type)).toEqual(['hello']);
  });

  it('a stream whose sink throws on the nudge is closed; the others still hear it', async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    const bad = spoken();
    const s = p.session.open(bad.sink);
    if ('refused' in s) throw new Error('refused');
    bad.broken = true;
    w.chat.noticePending(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk')) as string);
    expect(p.heard.of('notices')).toHaveLength(1);
    expect(w.chat.stats().streams).toBe(1);
  });
});

describe('a sanction that lands while connected', () => {
  it('shows in the next hello and the next refusal even without noticePending', async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    expect(say(w, p.session, 'before the sanction').ok).toBe(true);
    await w.sanction('chat', ROOM, 'plenk', 3_600_000);
    // no noticePending: the open stream is told nothing by itself
    expect(p.heard.frames.map((f) => f.type)).toEqual(['hello', 'line']);
    // the next send is refused with the reason
    const refused = say(w, p.session, 'after the sanction');
    expect(refused).toMatchObject({ ok: false, refused: { reason: 'restricted', byModerator: true } });
    // the next hello carries it
    const again = spoken();
    p.session.open(again.sink);
    expect(again.of('hello')[0]?.restriction).toEqual({ until: expect.any(Number), byModerator: true });
  });

  it('a restriction that ends is gone from the next hello', async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    await w.sanction('chat', ROOM, 'plenk', 60 * SEC);
    const during = spoken();
    p.session.open(during.sink);
    expect(during.of('hello')[0]?.restriction).not.toBeNull();
    w.advance(61 * SEC);
    const after = spoken();
    p.session.open(after.sink);
    expect(after.of('hello')[0]?.restriction).toBeNull();
    expect(say(w, p.session, 'free again').ok).toBe(true);
  });

  it('restriction in a state frame equals what cw.chat.restricted says right now', async () => {
    const w = await chatWorld();
    const p = w.attend(ROOM, 'plenk');
    const m = w.attend(ROOM, 'wumbo');
    const line = say(w, m.session, 'a line to mute');
    if (!line.ok) throw new Error('refused');
    await w.sanction('chat', ROOM, 'plenk', null);
    p.session.mute({ lineId: line.line.id, on: true });
    const answer = w.cw.chat.restricted(w.who('plenk'), { roomId: ROOM, seatId: w.seatOf(ROOM, 'plenk') });
    expect(answer.restricted).toBe(true);
    expect(p.heard.of('state')[0]?.restriction).toEqual({ until: answer.until, byModerator: true });
  });
});
