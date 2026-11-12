import { describe, expect, it } from 'vitest';
import { DAY, HOUR, errorOf, world } from './world.js';

// The signal feeds over the staff routes (flood control and signals, Task 13): the Person page record (`signals` on the history), the
// queue boost (`boosted` on report items, `signalBoost` on take-next), the ladder sentence in a suggestion, and the editable feeds.

const KINDS = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  kicked_from_room: { label: 'Kicked from a room', polarity: 'negative' as const },
};
const RECORD = { record: { kinds: ['muted_by_player'], windowDays: 14 } };
const QUEUE = { queue: { kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14 } };
const LADDER = { ladder: [{ id: 'muted-a-lot', effect: 'note' as const, kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14 }] };

type W = Awaited<ReturnType<typeof signalWorld>>;
const signalWorld = (feeds: Record<string, unknown> | null, extra: Parameters<typeof world>[0] = {}) =>
  world({ ...extra, overrides: { signals: { kinds: KINDS, ...(feeds === null ? {} : { feeds }) } } as never });

/** Record `n` signals about `person` from `n` different players, in room `room-x`. */
function mute(w: W, person: string, n: number, kind: 'muted_by_player' | 'kicked_from_room' = 'muted_by_player', at?: number): void {
  for (let i = 0; i < n; i += 1) {
    const by = w.person();
    expect(w.cw.signals.record({ kind, subject: person, by, roomId: 'room-x', ...(at === undefined ? {} : { at }) })).toBe(true);
  }
}

const SIGNAL_COUNT_KEYS = ['distinct', 'firstAt', 'kind', 'label', 'lastAt', 'polarity', 'weight', 'windowDays'];

describe('GET /people/:ref/history: the record', () => {
  it('carries signals only when feeds.record is set, only the chosen kinds and window, and no by, room or row', async () => {
    const w = await signalWorld(RECORD);
    const f = await w.file();
    const by = w.person();
    w.cw.signals.record({ kind: 'muted_by_player', subject: f.target, by, roomId: 'room-x' });
    mute(w, f.target, 2);
    mute(w, f.target, 3, 'kicked_from_room');
    mute(w, f.target, 4, 'muted_by_player', w.clock.t - 20 * DAY); // older than the 14 day window
    const res = await w.call('GET', `/people/${f.target}/history`);
    expect(res.status).toBe(200);
    const body = res.body as { signals: Array<Record<string, unknown>> };
    expect(body.signals).toHaveLength(1);
    expect(Object.keys(body.signals[0]!).sort()).toEqual(SIGNAL_COUNT_KEYS);
    expect(body.signals[0]).toMatchObject({ kind: 'muted_by_player', label: 'Muted by other players', polarity: 'negative', distinct: 3, windowDays: 14 });
    const text = JSON.stringify(body.signals);
    for (const secret of [by, f.target, 'room-x', 'kicked_from_room', 'Kicked']) expect(text).not.toContain(secret);
  });

  it('the signals key is present as [] when the feed is on and no count qualifies, and absent when the feed is off', async () => {
    const on = await signalWorld(RECORD);
    const a = await on.file();
    expect((await on.call('GET', `/people/${a.target}/history`)).body).toMatchObject({ signals: [] });
    const off = await signalWorld(null);
    const b = await off.file();
    mute(off, b.target, 3);
    expect('signals' in ((await off.call('GET', `/people/${b.target}/history`)).body as object)).toBe(false);
    const queueOnly = await signalWorld(QUEUE);
    const c = await queueOnly.file();
    expect('signals' in ((await queueOnly.call('GET', `/people/${c.target}/history`)).body as object)).toBe(false);
  });

  it('history.view is the only audit row for a Person page read with signals; a viewer without history.read gets no signals', async () => {
    const w = await signalWorld(RECORD, { permissions: { 'history.read': 'senior' } });
    const f = await w.file();
    mute(w, f.target, 3);
    const before = w.routeAudit().length;
    const ok = await w.call('GET', `/people/${f.target}/history`, { role: 'senior' });
    expect(ok.status).toBe(200);
    const rows = w.routeAudit().slice(before);
    expect(rows.map((r) => r.action)).toEqual(['history.view']);
    const denied = await w.call('GET', `/people/${f.target}/history`, { role: 'moderator' });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('Muted');
    expect(w.routeAudit().slice(before)).toHaveLength(1);
  });
});

describe('GET /reports: boosted', () => {
  it('marks boosted only with the feed on and only on meeting people; no summary field names a signal', async () => {
    const w = await signalWorld(QUEUE);
    const a = await w.file();
    const b = await w.file();
    mute(w, a.target, 3);
    mute(w, b.target, 2);
    const items = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items;
    const byPerson = new Map(items.map((i) => [i['targetPerson'] as string, i]));
    expect(byPerson.get(a.target)?.['boosted']).toBe(true);
    expect('boosted' in byPerson.get(b.target)!).toBe(false);
    const text = JSON.stringify(items);
    for (const word of ['signal', 'muted', 'Muted']) expect(text).not.toContain(word);
  });

  it('with the feed off nothing is marked, whatever has been recorded', async () => {
    for (const feeds of [null, RECORD]) {
      const w = await signalWorld(feeds);
      const a = await w.file();
      mute(w, a.target, 5);
      const items = ((await w.call('GET', '/reports')).body as { items: Array<Record<string, unknown>> }).items;
      expect(items.some((i) => 'boosted' in i)).toBe(false);
    }
  });

  it('a caller without history.read sees no mark', async () => {
    const w = await signalWorld(QUEUE, { permissions: { 'history.read': 'senior' } });
    const a = await w.file();
    mute(w, a.target, 3);
    const asSenior = (await w.call('GET', '/reports', { role: 'senior' })).body as { items: Array<Record<string, unknown>> };
    expect(asSenior.items[0]!['boosted']).toBe(true);
    const asMod = (await w.call('GET', '/reports', { role: 'moderator' })).body as { items: Array<Record<string, unknown>> };
    expect('boosted' in asMod.items[0]!).toBe(false);
  });
});

describe('POST /cases/next', () => {
  it('passes signalBoost true only with the feed on: a newer boosted case is claimed ahead of an older ordinary one', async () => {
    for (const [feeds, expectBoosted] of [[QUEUE, true], [null, false]] as const) {
      const w = await signalWorld(feeds);
      const older = await w.file();
      const newer = await w.file();
      mute(w, newer.target, 3);
      const res = await w.call('POST', '/cases/next', { role: 'moderator', actor: 'mod-a', body: {} });
      expect(res.status).toBe(200);
      expect((res.body as { case: { person: string } }).case.person).toBe(expectBoosted ? newer.target : older.target);
    }
  });

  it('the body keeps its 0.1.6 keys', async () => {
    const w = await signalWorld(QUEUE);
    const f = await w.file();
    w.clock.t += HOUR;
    const res = await w.call('POST', '/cases/next', { body: {} });
    const c = (res.body as { case: Record<string, unknown> }).case;
    expect(Object.keys(c).sort()).toEqual(['claim', 'person', 'reportId']);
    expect(c['person']).toBe(f.target);
  });
});

describe('the suggestion carries the ladder feed', () => {
  it('POST /reports/:id/suggest and GET /reports/:id carry signals in the suggestion and the sentence in why when a rule fired', async () => {
    const w = await signalWorld(LADDER);
    const f = await w.file();
    mute(w, f.target, 3);
    const viaPost = await w.call('POST', `/reports/${f.id}/suggest`, { body: { level: 'rude' } });
    expect(viaPost.status).toBe(200);
    const s = viaPost.body as { why: string; signals?: { raised: boolean; ids: string[] } };
    expect(s.signals).toEqual({ raised: false, ids: ['muted-a-lot'] });
    expect(s.why).toContain('Muted by other players: 3 players in 14 days');
    const viaGet = (await w.call('GET', `/reports/${f.id}`, { query: { level: 'rude' } })).body as { suggest: { why: string; signals?: unknown } };
    expect(viaGet.suggest.signals).toEqual({ raised: false, ids: ['muted-a-lot'] });
    expect(viaGet.suggest.why).toContain('Muted by other players: 3 players in 14 days');
  });

  it('with no rule met (or the feed off) the suggestion has no signals key', async () => {
    const w = await signalWorld(LADDER);
    const f = await w.file();
    mute(w, f.target, 2);
    const body = (await w.call('POST', `/reports/${f.id}/suggest`, { body: { level: 'rude' } })).body as Record<string, unknown>;
    expect('signals' in body).toBe(false);
    const off = await signalWorld(null);
    const g = await off.file();
    mute(off, g.target, 5);
    expect('signals' in ((await off.call('POST', `/reports/${g.id}/suggest`, { body: { level: 'rude' } })).body as object)).toBe(false);
  });
});

// FD M2: the ladder sentence is a count of what other players did to the person, like the counts on the record: it needs history.read.
describe('the ladder sentence needs history.read, the outcome does not', () => {
  const RAISE = { ladder: [{ id: 'muted-a-lot', effect: 'raise' as const, kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14 }] };
  const GATED = { permissions: { 'history.read': 'senior' as const } };
  type Sug = { outcome: unknown; label: string; why: string; signals?: unknown };

  async function both(feeds: Record<string, unknown>) {
    const w = await signalWorld(feeds, GATED);
    const f = await w.file();
    mute(w, f.target, 3);
    const post = (role: 'moderator' | 'senior') => w.call('POST', `/reports/${f.id}/suggest`, { role, body: { level: 'rude' } });
    const get = (role: 'moderator' | 'senior') => w.call('GET', `/reports/${f.id}`, { role, query: { level: 'rude' } });
    return { w, f, post, get };
  }

  it.each([['a note rule', LADDER], ['a raise rule', RAISE]])('%s: a caller without history.read gets no signals key and no count sentence, from both routes', async (_n, feeds) => {
    const { post, get } = await both(feeds);
    const viaPost = (await post('moderator')).body as Sug;
    const viaGet = ((await get('moderator')).body as { suggest: Sug }).suggest;
    for (const s of [viaPost, viaGet]) {
      expect('signals' in s).toBe(false);
      expect(s.why).not.toMatch(/Muted by other players|Also:|Raised one step|players? in \d+ days?/);
      expect(s.why).toMatch(/^[A-Za-z]+ profile: .*\.$/);
    }
  });

  it('a caller with history.read still gets the sentence and the signals, as before', async () => {
    const { post, get } = await both(LADDER);
    const viaPost = (await post('senior')).body as Sug;
    expect(viaPost.signals).toEqual({ raised: false, ids: ['muted-a-lot'] });
    expect(viaPost.why).toContain('Muted by other players: 3 players in 14 days');
    expect((((await get('senior')).body as { suggest: Sug }).suggest).why).toContain('Muted by other players: 3 players in 14 days');
  });

  it('the outcome moves the same for both callers: a raise rule raises for the moderator too, only unexplained', async () => {
    const { post } = await both(RAISE);
    const senior = (await post('senior')).body as Sug;
    const moderator = (await post('moderator')).body as Sug;
    expect(senior.signals).toMatchObject({ raised: true });
    expect(moderator.outcome).toEqual(senior.outcome);
    expect(moderator.label).toBe(senior.label);
  });

  it('with the permission left at its default every staff role sees the sentence', async () => {
    const w = await signalWorld(LADDER);
    const f = await w.file();
    mute(w, f.target, 3);
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const s = (await w.call('POST', `/reports/${f.id}/suggest`, { role, body: { level: 'rude' } })).body as Sug;
      expect(s.why, role).toContain('Muted by other players: 3 players in 14 days');
    }
  });
});

describe('PUT /policy/profile with signals.feeds', () => {
  const PUT = (body: unknown) => ({ role: 'owner' as const, actor: 'owner_ann', body });

  it('200 and the feeds apply; a stale version is 409', async () => {
    const w = await signalWorld(null);
    const ok = await w.call('PUT', '/policy/profile', PUT({ layer: { signals: { feeds: QUEUE } }, version: 0, reason: 'boost the queue' }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, changed: ['signals'], version: 1 });
    expect(Object.keys(w.cw.profile.signals.feeds)).toEqual(['queue']);
    const stale = await w.call('PUT', '/policy/profile', PUT({ layer: { signals: { feeds: RECORD } }, version: 0, reason: 'again' }));
    expect([stale.status, errorOf(stale)]).toEqual([409, 'conflict']);
  });

  it.each([
    ['a layer naming a kind', { signals: { kinds: { x_kind: { label: 'X', polarity: 'negative' } } } }, 'layer.signals.kinds'],
    ['a feed with an undeclared kind', { signals: { feeds: { queue: { kinds: ['nope_kind'], minDistinct: 3, windowDays: 7 } } } }, 'layer.signals.feeds.queue.kinds[0]'],
    ['a window above retention', { signals: { feeds: { queue: { ...QUEUE.queue, windowDays: 91 } } } }, 'layer.signals.feeds.queue.windowDays'],
  ])('400 invalid_profile with the layer path: %s', async (_name, layer, path) => {
    const w = await signalWorld(null);
    const res = await w.call('PUT', '/policy/profile', PUT({ layer, version: 0, reason: 'bad' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', path]);
  });

  it('adds no audit action: the row is policy.update with the section name', async () => {
    const w = await signalWorld(null);
    await w.call('PUT', '/policy/profile', PUT({ layer: { signals: { feeds: RECORD } }, version: 0, reason: 'record' }));
    const rows = w.routeAudit().filter((r) => r.action.startsWith('policy.'));
    expect(rows.map((r) => r.action)).toEqual(['policy.update']);
  });
});

describe('every route stays no-store and JSON', () => {
  it('the routes this task touches', async () => {
    const w = await signalWorld({ ...RECORD, ...QUEUE, ...LADDER });
    const f = await w.file();
    mute(w, f.target, 3);
    const calls: Array<[string, string, Record<string, unknown>?]> = [
      ['GET', '/reports'],
      ['GET', `/reports/${f.id}`],
      ['POST', `/reports/${f.id}/suggest`, { body: { level: 'rude' } }],
      ['GET', `/people/${f.target}/history`],
      ['POST', '/cases/next', { body: {} }],
      ['GET', '/policy/profile'],
    ];
    for (const [method, path, o] of calls) {
      const res = await w.call(method, path, o as never);
      expect(res.status, path).toBe(200);
      expect(res.headers?.['cache-control'], path).toBe('no-store');
      expect(typeof res.body, path).toBe('object');
    }
  });
});
