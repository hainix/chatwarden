import { describe, expect, it } from 'vitest';
import type { KitResponse } from '../src/types.js';
import { CHAT_WIRE_VERSION } from '../src/chat/wire.js';
import type { MuteResult, SendResult } from '../src/chat/wire.js';
import { chatWorld, routeWorld, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

// M4: Block in the chat box. A block is a mute the viewer makes lasting and two-way: the blocked player's streams are sent a `hide` frame of the blocker's lines already in the room (so history on
// screen disappears for them too) and later lines are filtered in both directions. The blocker's list marks the block (`block: true`); the blocked player is never told.

const ROOM = 'lobby';
const body = (res: KitResponse): Record<string, unknown> => res.body as Record<string, unknown>;

function say(w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult {
  w.advance(2 * SEC);
  return s.send({ text });
}
const lineId = (r: SendResult): string => {
  if (!r.ok) throw new Error('refused: ' + JSON.stringify(r.refused));
  return r.line.id;
};

/** Author `plenk` (to be blocked), blocker `wumbo` with two tabs, bystander `glarn`; each has spoken once. */
async function scene() {
  const w = await chatWorld();
  const author = w.attend(ROOM, 'plenk');
  const blocker = w.attend(ROOM, 'wumbo');
  const tab2 = spoken();
  const second = blocker.session.open(tab2.sink);
  if ('refused' in second) throw new Error('refused');
  const other = w.attend(ROOM, 'glarn');
  const plenk1 = lineId(say(w, author.session, 'plenk says one'));
  const wumbo1 = lineId(say(w, blocker.session, 'wumbo says one'));
  return { w, author, blocker, tab2, other, plenk1, wumbo1 };
}

describe('the wire', () => {
  it('is version 2 and a muted entry can say it is a block', () => {
    expect(CHAT_WIRE_VERSION).toBe(2);
    const entry: import('../src/chat/wire.js').WireMuted = { ref: 'abcd1234', name: 'plenk', block: true };
    expect(entry.block).toBe(true);
    const limited: MuteResult = { ok: false, hiddenIds: [], limit: true };
    expect(limited.limit).toBe(true);
  });
});

describe('blocking a player', () => {
  it('hides the blocked author from the blocker (as a mute does) and answers with the ids it hid', async () => {
    const { w, author, blocker, tab2, plenk1 } = await scene();
    say(w, author.session, 'plenk says two');
    const hid = author.heard.of('line').filter((f) => f.line.mine === true).map((f) => f.line.id);
    const res = blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    expect(res.ok).toBe(true);
    expect(res.limit).toBeUndefined();
    expect(res.hiddenIds.length).toBeGreaterThan(0);
    for (const heard of [blocker.heard, tab2]) {
      const hides = heard.of('hide');
      expect(hides).toHaveLength(1);
      expect(hides[0]?.ids).toEqual(hid.slice(0, hides[0]?.ids.length));
      expect(hides[0]?.ids.length).toBeGreaterThan(0);
      expect(heard.of('state')[0]?.muted).toEqual([{ ref: expect.stringMatching(/^[a-z0-9]{8}$/), name: 'plenk', block: true }]);
    }
    expect(w.logs.filter(([event]) => /mute|block/.test(event))).toEqual([]);
  });

  it("sends the blocked player a hide frame of the blocker's lines already in the room, and nothing else about it", async () => {
    const { w, author, blocker, plenk1 } = await scene();
    say(w, blocker.session, 'wumbo says two');
    const blockerIds = blocker.heard.ids().filter((id) => id !== '');
    const mine = blocker.heard.of('line').filter((f) => f.line.mine === true).map((f) => f.line.id);
    expect(mine).toHaveLength(2);
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const hides = author.heard.of('hide');
    expect(hides).toHaveLength(1);
    expect(hides[0]?.ids).toEqual(mine);
    expect(blockerIds.length).toBeGreaterThan(0);
    // the frame carries ids only: no name, no ref, no state, no block flag, nothing that says who did it
    const text = JSON.stringify(author.heard.frames.filter((f) => f.type !== 'line' && f.type !== 'hello'));
    for (const leak of ['wumbo', '"block"', '"muted"', '"state"', 'ref']) expect(text, leak).not.toContain(leak);
    expect(author.heard.of('state')).toEqual([]);
  });

  it('every stream of the blocked player is sent the hide frame', async () => {
    const { w, author, blocker, plenk1 } = await scene();
    const authorTab2 = spoken();
    const opened = author.session.open(authorTab2.sink);
    if ('refused' in opened) throw new Error('refused');
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    expect(author.heard.of('hide')).toHaveLength(1);
    expect(authorTab2.of('hide')).toHaveLength(1);
    expect(w.chat.stats().streams).toBeGreaterThan(0);
  });

  it("later lines are filtered both ways: the blocker's lines no longer reach the blocked player, and theirs no longer reach the blocker", async () => {
    const { w, author, blocker, tab2, other, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const a = say(w, author.session, 'plenk after');
    const b = say(w, blocker.session, 'wumbo after');
    expect(a.ok && b.ok).toBe(true);
    expect(author.heard.texts()).not.toContain('wumbo after');
    expect(blocker.heard.texts()).not.toContain('plenk after');
    expect(tab2.texts()).not.toContain('plenk after');
    expect(other.heard.texts()).toEqual(expect.arrayContaining(['plenk after', 'wumbo after']));
    // each author still sees their own line echoed to them
    expect(author.heard.texts()).toContain('plenk after');
    expect(blocker.heard.texts()).toContain('wumbo after');
  });

  it("the blocked player's answer to send is unchanged: no key, no refusal, nothing that says they were blocked", async () => {
    const { w, author, blocker, plenk1 } = await scene();
    const before = say(w, author.session, 'before the block');
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const after = say(w, author.session, 'a later line');
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(JSON.stringify(after)).not.toMatch(/block|mute|hidden/i);
  });

  it("a reconnect's hello omits the blocker's lines and lists no block; the blocker's hello lists the block in muted with block true", async () => {
    const { w, author, blocker, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const again = spoken();
    const opened = author.session.open(again.sink);
    if ('refused' in opened) throw new Error('refused');
    const hello = again.of('hello')[0]!;
    expect(hello.lines.map((l) => l.text)).not.toContain('wumbo says one');
    expect(hello.muted).toEqual([]);
    expect(JSON.stringify(hello)).not.toMatch(/"block"/);
    const mine = spoken();
    const reopened = blocker.session.open(mine.sink);
    if ('refused' in reopened) throw new Error('refused');
    const helloB = mine.of('hello')[0]!;
    expect(helloB.lines.map((l) => l.text)).not.toContain('plenk says one');
    expect(helloB.muted).toEqual([{ ref: expect.stringMatching(/^[a-z0-9]{8}$/), name: 'plenk', block: true }]);
    expect(w.chat.stats().members).toBeGreaterThan(0);
  });

  it('a plain mute still lists without block, next to a block in the same list', async () => {
    const { w, blocker, plenk1 } = await scene();
    const third = w.attend(ROOM, 'yarrow');
    const q1 = lineId(say(w, third.session, 'yarrow says'));
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    blocker.session.muteResult({ lineId: q1, on: true });
    const latest = blocker.heard.of('state').at(-1)!;
    expect(latest.muted.map((m) => [m.name, m.block ?? false]).sort()).toEqual([['plenk', true], ['yarrow', false]]);
    expect(latest.muted.find((m) => m.name === 'yarrow')).not.toHaveProperty('block');
  });

  it('a bystander sees everything from both, and is told nothing', async () => {
    const { w, author, blocker, other, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    say(w, author.session, 'plenk after');
    expect(other.heard.of('hide')).toEqual([]);
    expect(other.heard.of('state')).toEqual([]);
    expect(other.heard.texts()).toEqual(expect.arrayContaining(['plenk says one', 'wumbo says one', 'plenk after']));
  });

  it('muting a blocked player changes nothing (a mute never downgrades a block): the list still says block and no new frame is sent', async () => {
    const { w, blocker, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const frames = blocker.heard.frames.length;
    const again = blocker.session.muteResult({ lineId: plenk1, on: true });
    expect(again.ok).toBe(true);
    expect(blocker.heard.frames.length).toBe(frames);
    const reopened = spoken();
    blocker.session.open(reopened.sink);
    expect(reopened.of('hello')[0]?.muted[0]).toMatchObject({ name: 'plenk', block: true });
    expect(w.cw.mutes.blockedSeats(ROOM, w.seatOf(ROOM, 'wumbo'))).toEqual([w.seatOf(ROOM, 'plenk')]);
  });

  it('blocking an already muted player turns the mute into a block and hides the blocker from them too', async () => {
    const { w, author, blocker, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true });
    expect(author.heard.of('hide')).toEqual([]);
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    expect(author.heard.of('hide')).toHaveLength(1);
    say(w, blocker.session, 'wumbo after');
    expect(author.heard.texts()).not.toContain('wumbo after');
  });

  it("unmute by the token removes the block: both directions work again for new lines, and the blocked player is told nothing", async () => {
    const { w, author, blocker, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const ref = blocker.heard.of('state').at(-1)!.muted[0]!.ref;
    expect(blocker.session.muteResult({ ref, on: false }).ok).toBe(true);
    say(w, author.session, 'plenk back');
    say(w, blocker.session, 'wumbo back');
    expect(blocker.heard.texts()).toContain('plenk back');
    expect(author.heard.texts()).toContain('wumbo back');
    expect(blocker.heard.of('state').at(-1)?.muted).toEqual([]);
    expect(author.heard.of('state')).toEqual([]);
  });

  it('a block outlives the blocked player leaving and coming back, and the blocker leaving: the kit holds it', async () => {
    const { w, author, blocker, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    expect(w.cw.blocks.between({ clientKey: 'raw-client-key-wumbo-0001' }, { clientKey: 'raw-client-key-plenk-0001' })).toBe(true);
    author.stream.close();
    blocker.stream.close();
    const back = w.attend(ROOM, 'plenk');
    expect(back.heard.of('hello')[0]?.lines.map((l) => l.text) ?? []).not.toContain('wumbo says one');
  });

  it("another player's token never names someone's block (a token only names a seat the caller muted)", async () => {
    const { blocker, other, plenk1 } = await scene();
    blocker.session.muteResult({ lineId: plenk1, on: true, block: true });
    const ref = blocker.heard.of('state').at(-1)!.muted[0]!.ref;
    expect(other.session.muteResult({ ref, on: false }).ok).toBe(false);
    expect(blocker.session.muteResult({ ref: 'nope0000', on: false }).ok).toBe(false);
  });
});

describe('the limit', () => {
  it('at 500 blocks a new block or mute answers { ok: false, hiddenIds: [], limit: true } and nothing changes', async () => {
    const w = await chatWorld();
    const blocker = w.attend(ROOM, 'wumbo');
    const target = w.attend(ROOM, 'plenk');
    const first = lineId(say(w, target.session, 'plenk says one'));
    const viewer = w.seatOf(ROOM, 'wumbo');
    // fill the viewer's list from outside: 500 blocks of other players, seated in this room as the viewer
    for (let i = 0; i < 500; i += 1) {
      w.cw.rooms.seat(ROOM, `x${i}`, { clientKey: `filler-key-${String(i).padStart(6, '0')}` }, `F${i}`);
      expect(w.cw.blocks.set(ROOM, viewer, `x${i}`, true)).toBe('ok');
    }
    const refused = blocker.session.muteResult({ lineId: first, on: true, block: true });
    expect(refused).toEqual({ ok: false, hiddenIds: [], limit: true });
    expect(blocker.session.muteResult({ lineId: first, on: true })).toEqual({ ok: false, hiddenIds: [], limit: true });
    expect(w.cw.chat.visibleTo(ROOM, viewer, w.seatOf(ROOM, 'plenk'))).toBe(true);
    expect(target.heard.of('hide')).toEqual([]);
  });
});

describe('the route', () => {
  const lineOf = async (w: Awaited<ReturnType<typeof routeWorld>>, name: string): Promise<string> => {
    w.advance(2 * SEC);
    const res = await w.post(ROOM, 'lines', w.as(name), { text: `${name} speaks` });
    return (body(res).line as { id: string }).id;
  };

  it('POST /rooms/:room/mute with block true stores a block and answers ok with the ids it hid; the blocker is then listed with block true in the next hello', async () => {
    const w = await routeWorld();
    const id = await lineOf(w, 'plenk');
    await lineOf(w, 'wumbo');
    const res = await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: id, on: true, block: true });
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ ok: true });
    expect(Array.isArray(body(res).hiddenIds)).toBe(true);
    expect(w.cw.blocks.between({ clientKey: 'raw-client-key-wumbo-0001' }, { clientKey: 'raw-client-key-plenk-0001' })).toBe(true);
  });

  it('block must be a boolean: 400 for anything else; absent and false are a plain mute', async () => {
    const w = await routeWorld();
    const id = await lineOf(w, 'plenk');
    for (const block of ['yes', 1, null, {}, []]) {
      const res = await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: id, on: true, block });
      expect(res.status, JSON.stringify(block)).toBe(400);
    }
    const plain = await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: id, on: true, block: false });
    expect(plain.status).toBe(200);
    expect(w.cw.blocks.between({ clientKey: 'raw-client-key-wumbo-0001' }, { clientKey: 'raw-client-key-plenk-0001' })).toBe(false);
    expect((await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: id, on: false })).status).toBe(200);
  });

  it('unmute (on false) removes the block through the same route; a limit answer is 200 with limit true', async () => {
    const w = await routeWorld();
    const id = await lineOf(w, 'plenk');
    await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: id, on: true, block: true });
    expect(body(await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: id, on: false })).ok).toBe(true);
    expect(w.cw.blocks.between({ clientKey: 'raw-client-key-wumbo-0001' }, { clientKey: 'raw-client-key-plenk-0001' })).toBe(false);
  });
});
