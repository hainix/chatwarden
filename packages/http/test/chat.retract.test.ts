import { describe, expect, it } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { chatWorld, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

// R3: a retraction reaches the chat box. The broadcaster listens to the kit (`line.retracted`), drops the text from its history ring, sends one `retract` frame to every stream (the author's too) and a new
// joiner's hello has neither the id nor the text. A game with its own socket listens to the same event. Closing the broadcaster unsubscribes.

const ROOM = 'lobby';
const SENTINEL = 'SENTINEL-retract-text';

function say(w: ChatWorld, session: { send(i: { text: string }): unknown }, text: string): string {
  w.advance(2 * SEC);
  const res = session.send({ text }) as { ok: boolean; line?: { id: string } };
  if (!res.ok || res.line === undefined) throw new Error('refused');
  return res.line.id;
}

/** A seat id of a player, for the staff-side retract (the kit's own seat ids are the broadcaster's secret; the line ids are what a moderator names). */
const retract = (w: ChatWorld, lineId: string, opts?: { allFromAuthor?: boolean }) => w.real.rooms.retract(ROOM, lineId, opts);

describe('the broadcaster and a retraction', () => {
  it('removes the text from its ring, sends one retract frame to every stream including the author\'s, and a new joiner\'s hello has no retracted line (id or text)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const a2 = spoken();
    expect('close' in a.session.open(a2.sink)).toBe(true);
    const b = w.attend(ROOM, 'wumbo');
    const keep = say(w, b.session, 'a fine line');
    const gone = say(w, a.session, `rude ${SENTINEL}`);
    expect(retract(w, gone)).toEqual({ ok: true, lineIds: [gone] });
    for (const heard of [a.heard, a2, b.heard]) {
      const frames = heard.of('retract');
      expect(frames, 'one frame per stream').toEqual([{ type: 'retract', ids: [gone] }]);
    }
    // a viewer who joins now never gets the line
    const late = w.attend(ROOM, 'glarn');
    const hello = late.heard.of('hello')[0];
    expect(hello?.lines.map((l) => l.id)).toEqual([keep]);
    expect(JSON.stringify(late.heard.frames)).not.toContain(SENTINEL);
    expect(JSON.stringify(late.heard.frames)).not.toContain(`"id":"${gone}"`);
  });

  it('one retract frame names every line of an allFromAuthor retraction', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const ids = [say(w, a.session, 'one'), say(w, b.session, 'fine'), say(w, a.session, 'two'), say(w, a.session, 'three')];
    expect(retract(w, ids[0]!, { allFromAuthor: true })).toEqual({ ok: true, lineIds: [ids[0], ids[2], ids[3]] });
    const frames = b.heard.of('retract');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.ids).toEqual([ids[0], ids[2], ids[3]]);
    const late = w.attend(ROOM, 'glarn');
    expect(late.heard.of('hello')[0]?.lines.map((l) => l.id)).toEqual([ids[1]]);
  });

  it('a viewer who muted the author still hears the retract (it is about removing, never about showing)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const id = say(w, a.session, 'hello there');
    expect(b.session.mute({ lineId: id, on: true })).toBe(true);
    retract(w, id);
    expect((b.heard.of('retract')).length).toBe(1);
  });

  it('a retraction in another room, or of a room the broadcaster does not hold, sends nothing here', async () => {
    const w = await chatWorld();
    const a = w.attend('room-a', 'plenk');
    const b = w.attend('room-b', 'wumbo');
    const id = say(w, a.session, 'only a');
    w.real.rooms.retract('room-a', id);
    expect((b.heard.of('retract')).length).toBe(0);
    expect((a.heard.of('retract')).length).toBe(1);
    w.real.rooms.retract('some-room-nobody-is-in', '1');
  });

  it('a sink that throws on the retract frame loses only its own stream', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const id = say(w, a.session, 'one');
    a.heard.broken = true;
    expect(retract(w, id).ok).toBe(true);
    expect((b.heard.of('retract')).length).toBe(1);
    expect(a.heard.ended).toBe(1);
  });

  it('writes nothing to the author: no notice, no state frame, no sanction', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const id = say(w, a.session, 'rude');
    const framesBefore = a.heard.frames.length;
    retract(w, id);
    const after = a.heard.frames.slice(framesBefore);
    expect(after.map((f) => f.type)).toEqual(['retract']);
    expect(w.store.loadSanctions(w.clock.t)).toEqual([]);
    expect(w.store.loadStrikes(0)).toEqual([]);
  });
});

describe('a game with its own socket', () => {
  it('hears the same through cw.on', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const heard: KitEvent[] = [];
    w.real.on('line.retracted', (e) => void heard.push(e));
    const id = say(w, a.session, 'one');
    retract(w, id);
    expect(heard).toEqual([{ type: 'line.retracted', roomId: ROOM, lineIds: [id], at: w.clock.t }]);
  });
});

describe('closing the broadcaster', () => {
  it('unsubscribes both listeners (room.mode and line.retracted)', async () => {
    const subscribed: string[] = [];
    const unsubscribed: string[] = [];
    const w = await chatWorld({
      wrap: (cw) => {
        const facade = Object.create(cw) as Chatwarden;
        facade.on = ((type: string, fn: never) => {
          subscribed.push(type);
          const off = (cw.on as (t: string, f: never) => () => void)(type, fn);
          return () => {
            unsubscribed.push(type);
            off();
          };
        }) as Chatwarden['on'];
        return facade;
      },
    });
    expect(subscribed.sort()).toEqual(['line.retracted', 'room.mode']);
    expect(unsubscribed).toEqual([]);
    const a = w.attend(ROOM, 'plenk');
    const id = say(w, a.session, 'one');
    w.chat.close();
    expect(unsubscribed.sort()).toEqual(['line.retracted', 'room.mode']);
    // a retraction after close reaches nobody and throws nothing
    expect(() => retract(w, id)).not.toThrow();
  });
});
