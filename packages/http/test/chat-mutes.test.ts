import { describe, expect, it } from 'vitest';
import type { SendResult } from '../src/chat/wire.js';
import { chatWorld, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';

function say(w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult {
  w.advance(2 * SEC);
  return s.send({ text });
}

/** Author `plenk`, muter `wumbo` with two tabs, bystander `glarn`; one line from plenk already spoken. */
async function scene() {
  const w = await chatWorld();
  const author = w.attend(ROOM, 'plenk');
  const muter = w.attend(ROOM, 'wumbo');
  const tab2 = spoken();
  const second = muter.session.open(tab2.sink);
  if ('refused' in second) throw new Error('refused');
  const other = w.attend(ROOM, 'glarn');
  const first = say(w, author.session, 'plenk says one');
  if (!first.ok) throw new Error('refused');
  return { w, author, muter, tab2, other, firstId: first.line.id };
}

describe("a mute hides the muted author from the muter only", () => {
  it("a muted author's lines skip only the muter's streams and the muter's other tabs", async () => {
    const { w, author, muter, tab2, other, firstId } = await scene();
    expect(muter.session.mute({ lineId: firstId, on: true })).toBe(true);
    const res = say(w, author.session, 'plenk says two');
    expect(res.ok).toBe(true);
    expect(muter.heard.texts()).toEqual(['plenk says one']); // the earlier line was there; the new one is not
    expect(tab2.texts()).toEqual(['plenk says one']);
    expect(other.heard.texts()).toEqual(['plenk says one', 'plenk says two']);
    expect(author.heard.texts()).toEqual(['plenk says one', 'plenk says two']);
    // and the muter's own lines still reach the muted author
    say(w, muter.session, 'wumbo replies');
    expect(author.heard.texts()).toContain('wumbo replies');
    expect(muter.heard.texts()).toContain('wumbo replies');
  });

  it("the author's answer to send is unchanged and no frame about the mute ever reaches the author", async () => {
    const { w, author, muter, firstId } = await scene();
    const before = say(w, author.session, 'before the mute');
    muter.session.mute({ lineId: firstId, on: true });
    const after = say(w, author.session, 'after the mute');
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) {
      expect(Object.keys(after.line).sort()).toEqual(Object.keys(before.line).sort());
      expect(after.line.mine).toBe(true);
      expect(Object.keys(after).sort()).toEqual(['line', 'ok']);
    }
    muter.session.mute({ lineId: firstId, on: false });
    const types = author.heard.frames.map((f) => f.type);
    expect(types.filter((t) => t !== 'hello' && t !== 'line')).toEqual([]);
    // nothing the author has ever been sent names the muter
    expect(JSON.stringify(author.heard.frames.slice(1))).not.toMatch(/"muted"|"hide"|"state"/);
    expect(author.heard.of('hello')[0]?.muted).toEqual([]);
  });

  it('hide removes the author\'s earlier lines from the muter\'s open streams; a later hello omits them; unmute by ref restores future lines', async () => {
    const { w, author, muter, tab2, other, firstId } = await scene();
    say(w, author.session, 'plenk says two');
    const ids = author.heard.ids();
    expect(muter.session.mute({ lineId: firstId, on: true })).toBe(true);

    for (const heard of [muter.heard, tab2]) {
      const hides = heard.of('hide');
      expect(hides).toHaveLength(1);
      expect(hides[0]?.ids).toEqual(ids);
      const states = heard.of('state');
      expect(states).toHaveLength(1);
      expect(states[0]?.muted).toEqual([{ ref: expect.stringMatching(/^[a-z0-9]{8}$/), name: 'plenk' }]);
      expect(states[0]?.restriction).toBeNull();
    }
    expect(other.heard.of('hide')).toEqual([]);
    expect(other.heard.of('state')).toEqual([]);

    // a later hello omits them and lists the muted player
    const reopened = spoken();
    const reopenedStream = muter.session.open(reopened.sink);
    const hello = reopened.of('hello')[0];
    expect(hello?.lines).toEqual([]);
    expect(hello?.muted).toHaveLength(1);
    const ref = hello?.muted[0]?.ref as string;

    if ('refused' in reopenedStream) throw new Error('refused');
    reopenedStream.close(); // three tabs is the limit

    // unmute by the token: future lines come back, and so does the history in the next hello
    expect(muter.session.mute({ ref, on: false })).toBe(true);
    expect(muter.heard.of('state').at(-1)?.muted).toEqual([]);
    expect(muter.heard.of('hide')).toHaveLength(1); // no second hide
    say(w, author.session, 'plenk says three');
    expect(muter.heard.texts()).toContain('plenk says three');
    const back = spoken();
    muter.session.open(back.sink);
    expect(back.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['plenk says one', 'plenk says two', 'plenk says three']);
    expect(back.of('hello')[0]?.muted).toEqual([]);
  });

  it('unmute by line id works too, and muting twice or unmuting twice is harmless', async () => {
    const { w, author, muter, firstId } = await scene();
    expect(muter.session.mute({ lineId: firstId, on: true })).toBe(true);
    const states = muter.heard.of('state').length;
    expect(muter.session.mute({ lineId: firstId, on: true })).toBe(true); // already muted: nothing new is written
    expect(muter.heard.of('state')).toHaveLength(states);
    expect(muter.session.mute({ lineId: firstId, on: false })).toBe(true);
    expect(muter.session.mute({ lineId: firstId, on: false })).toBe(true);
    say(w, author.session, 'back again');
    expect(muter.heard.texts()).toContain('back again');
  });

  it('the mute writes only to the muter: nothing reaches anyone else', async () => {
    const { author, muter, other, firstId } = await scene();
    const authorFrames = author.heard.frames.length;
    const otherFrames = other.heard.frames.length;
    muter.session.mute({ lineId: firstId, on: true });
    expect(author.heard.frames).toHaveLength(authorFrames);
    expect(other.heard.frames).toHaveLength(otherFrames);
  });

  it('refs are per viewer, stable for one viewer, and differ between viewers', async () => {
    const { w, author, muter, other, firstId } = await scene();
    muter.session.mute({ lineId: firstId, on: true });
    other.session.mute({ lineId: firstId, on: true });
    const refOf = (heard: ReturnType<typeof spoken>) => heard.of('state').at(-1)?.muted[0]?.ref;
    expect(refOf(muter.heard)).toBeDefined();
    expect(refOf(other.heard)).toBeDefined();
    expect(refOf(muter.heard)).not.toBe(refOf(other.heard));
    const again = spoken();
    muter.session.open(again.sink);
    expect(again.of('hello')[0]?.muted[0]?.ref).toBe(refOf(muter.heard));
    void author;
    void w;
  });

  it('the ref is a random token: it contains no seat id, name or line id', async () => {
    const { w, muter, firstId } = await scene();
    muter.session.mute({ lineId: firstId, on: true });
    const ref = muter.heard.of('state')[0]?.muted[0]?.ref as string;
    expect(ref).toMatch(/^[a-z0-9]{8}$/);
    expect(w.seatOf(ROOM, 'plenk')).not.toContain(ref);
    expect(ref).not.toBe(firstId);
  });
});

describe('a mute that does nothing returns false', () => {
  it('a ref from another player, another room or a stale seat is a no-op', async () => {
    const { w, author, muter, other, firstId } = await scene();
    muter.session.mute({ lineId: firstId, on: true });
    const ref = muter.heard.of('state')[0]?.muted[0]?.ref as string;

    // another player holding the muter's token cannot undo it
    expect(other.session.mute({ ref, on: false })).toBe(false);
    expect(other.session.mute({ ref, on: true })).toBe(false);
    // the muter is still muted: the next line still skips them
    say(w, author.session, 'still muted');
    expect(muter.heard.texts()).not.toContain('still muted');

    // the same player in another room: the token names nothing there
    const elsewhere = w.join('other-room', 'wumbo');
    expect(elsewhere.mute({ ref, on: false })).toBe(false);

    // a made-up token, an empty one and a wrong type
    for (const bad of ['', 'aaaaaaaa', ref + 'x', 'ref'.repeat(30)]) expect(muter.session.mute({ ref: bad, on: false })).toBe(false);
    expect(muter.session.mute({ ref: 5 as never, on: false })).toBe(false);

    // after a real unmute the token is stale
    expect(muter.session.mute({ ref, on: false })).toBe(true);
    expect(muter.session.mute({ ref, on: false })).toBe(false);
    expect(muter.session.mute({ ref, on: true })).toBe(false);
  });

  it('a token for a player who has left names nothing', async () => {
    const w = await chatWorld({ options: { seatGraceMs: 10 * SEC } });
    const author = w.attend(ROOM, 'plenk');
    const muter = w.attend(ROOM, 'wumbo');
    const line = say(w, author.session, 'plenk says one');
    if (!line.ok) throw new Error('refused');
    muter.session.mute({ lineId: line.line.id, on: true });
    const ref = muter.heard.of('state')[0]?.muted[0]?.ref as string;
    author.stream.close();
    w.advance(10 * SEC); // the author's seat is released
    expect(muter.session.mute({ ref, on: false })).toBe(false);
    expect(muter.session.mute({ lineId: line.line.id, on: false })).toBe(false); // the line is still in the ring, its author is gone
  });

  it('muting yourself, an unknown line id and an aged-out line return false', async () => {
    const { w, author, muter, firstId } = await scene();
    const own = say(w, muter.session, 'my own line');
    if (!own.ok) throw new Error('refused');
    expect(muter.session.mute({ lineId: own.line.id, on: true })).toBe(false);
    expect(muter.session.mute({ lineId: 'nope', on: true })).toBe(false);
    expect(muter.session.mute({ lineId: '', on: true })).toBe(false);
    w.advance(16 * 60 * SEC);
    expect(muter.session.mute({ lineId: firstId, on: true })).toBe(false);
    expect(muter.heard.of('state')).toEqual([]);
    void author;
  });

  it('a malformed request is false and writes nothing', async () => {
    const { muter, firstId } = await scene();
    for (const bad of [undefined, null, 5, 'x', {}, { on: true }, { lineId: firstId }, { lineId: firstId, on: 'yes' }, { lineId: 5, on: true }, { lineId: firstId, ref: 'x' }]) {
      expect(muter.session.mute(bad as never)).toBe(false);
    }
    expect(muter.heard.of('state')).toEqual([]);
    expect(muter.heard.of('hide')).toEqual([]);
  });

  it('a kit that does nothing (no person behind a seat) is false', async () => {
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as typeof cw;
        f.mutes = { ...cw.mutes, set: () => undefined };
        return f;
      },
    });
    const a = w.attend(ROOM, 'plenk');
    const m = w.attend(ROOM, 'wumbo');
    const line = say(w, a.session, 'hello there');
    if (!line.ok) throw new Error('refused');
    expect(m.session.mute({ lineId: line.line.id, on: true })).toBe(false);
    expect(m.heard.of('state')).toEqual([]);
  });

  it('a kit whose mute throws is false and logged by class', async () => {
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as typeof cw;
        f.mutes = {
          ...cw.mutes,
          set: () => {
            throw new RangeError('boom plenk');
          },
        };
        return f;
      },
    });
    const a = w.attend(ROOM, 'plenk');
    const m = w.attend(ROOM, 'wumbo');
    const line = say(w, a.session, 'hello there');
    if (!line.ok) throw new Error('refused');
    expect(m.session.mute({ lineId: line.line.id, on: true })).toBe(false);
    expect(w.logs.filter((l) => l[0].startsWith('chatwarden.chat_'))).toEqual([['chatwarden.chat_mute_failed', { error: 'RangeError' }]]);
  });
});

describe('a mute persists in the kit', () => {
  it('a new broadcaster over the same store still hides the author', async () => {
    const { w, muter, firstId } = await scene();
    muter.session.mute({ lineId: firstId, on: true });

    // a restart: a second broadcaster over the same kit (the mute table is the kit's)
    w.chat.close();
    const { createRoomBroadcaster } = await import('../src/chat/broadcaster.js');
    const second = createRoomBroadcaster(w.cw, { now: w.now, schedule: w.schedule });
    const join = (name: string) => {
      const s = second.session(ROOM, w.who(name), { name });
      if ('refused' in s) throw new Error('refused');
      const heard = spoken();
      s.open(heard.sink);
      return { s, heard };
    };
    const a = join('plenk');
    const m = join('wumbo');
    const o = join('glarn');
    expect(m.heard.of('hello')[0]?.muted.map((x) => x.name)).toEqual(['plenk']);
    w.advance(2 * SEC);
    a.s.send({ text: 'after the restart' });
    expect(o.heard.texts()).toEqual(['after the restart']);
    expect(m.heard.texts()).toEqual([]);
    // and the history snapshot omits them too
    const late = spoken();
    m.s.open(late.sink);
    expect(late.of('hello')[0]?.lines).toEqual([]);
  });
});
