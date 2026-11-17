import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEYS, PERMISSIONS } from '../src/index.js';
import { errorOf, world } from './world.js';

// F6: the chat filter routes (`filters.read`, a moderator's by default): GET /filters/stats, POST /filters/test, POST /filters/check. Counts and tests only:
// nothing is written, nothing is audited, every body is no-store.

const LINK = 'see vlemmo.com now';
const rec = (role: 'moderator' | 'senior' | 'owner' = 'moderator') => ({ role });
const post = (body: unknown, role: 'moderator' | 'senior' | 'owner' = 'moderator') => ({ role, body });

describe('permission boundaries', () => {
  it("filters.read is a moderator's, appended after the keys of the earlier releases (legal.hold follows it)", () => {
    expect(PERMISSIONS['filters.read']).toBe('moderator');
    expect(PERMISSION_KEYS.at(-2)).toBe('filters.read');
    expect(PERMISSION_KEYS.at(-1)).toBe('legal.hold');
  });

  it('permission boundaries at moderator, senior and owner; filters.read lowered or raised by the permissions option works; an unknown key is still refused', async () => {
    const w = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      expect((await w.call('GET', '/filters/stats', { role, query: { days: '7' } })).status, role).toBe(200);
      expect((await w.call('POST', '/filters/test', post({ text: 'hi' }, role))).status, role).toBe(200);
      expect((await w.call('POST', '/filters/check', post({ candidate: {} }, role))).status, role).toBe(200);
    }
    expect((await w.call('GET', '/filters/stats', { role: null, query: { days: '7' } })).status).toBe(401);
    expect((await w.call('POST', '/filters/test', { role: null, body: { text: 'hi' } })).status).toBe(401);
    const raised = await world({ permissions: { 'filters.read': 'owner' } });
    for (const [role, status] of [['moderator', 403], ['senior', 403], ['owner', 200]] as const) {
      expect((await raised.call('GET', '/filters/stats', { role, query: { days: '7' } })).status, role).toBe(status);
      expect((await raised.call('POST', '/filters/test', post({ text: 'hi' }, role))).status, role).toBe(status);
      expect((await raised.call('POST', '/filters/check', post({ candidate: {} }, role))).status, role).toBe(status);
    }
    const lowered = await world({ permissions: { 'filters.read': 'moderator' } });
    expect((await lowered.call('GET', '/filters/stats', { role: 'moderator', query: { days: '30' } })).status).toBe(200);
    await expect(world({ permissions: { 'filters.reads': 'owner' } as never })).rejects.toThrow(/"filters\.reads"/);
  });

  it('GET /me can has filters.read for every role by default, and follows the override', async () => {
    const w = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const me = (await w.call('GET', '/me', { role })).body as { can: Record<string, boolean> };
      expect(me.can['filters.read'], role).toBe(true);
    }
    const raised = await world({ permissions: { 'filters.read': 'senior' } });
    expect(((await raised.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean> }).can['filters.read']).toBe(false);
    expect(((await raised.call('GET', '/me', { role: 'senior' })).body as { can: Record<string, boolean> }).can['filters.read']).toBe(true);
  });
});

describe('GET /filters/stats', () => {
  it('windows 7 and 30 only; 400 invalid_query otherwise', async () => {
    const w = await world();
    for (const days of ['7', '30']) expect((await w.call('GET', '/filters/stats', { query: { days } })).status).toBe(200);
    for (const days of ['0', '1', '14', '31', '7.5', '07', 'seven', '', '-7', '7 ']) {
      const res = await w.call('GET', '/filters/stats', { query: { days } });
      expect(res.status, days).toBe(400);
      expect(errorOf(res), days).toBe('invalid_query');
    }
    const none = await w.call('GET', '/filters/stats');
    expect(none.status).toBe(400);
    expect(errorOf(none)).toBe('invalid_query');
  });

  it('empty with no data; every body is no-store JSON', async () => {
    const w = await world();
    const res = await w.call('GET', '/filters/stats', { query: { days: '7' } });
    expect(res.body).toEqual({ days: 7, keys: {} });
    expect(res.headers?.['cache-control']).toBe('no-store');
  });

  it('rows per key with counts by action and the rule\'s label for phrase keys', async () => {
    const w = await world({
      overrides: { filters: { links: { action: 'mask' }, personalInfo: { action: 'refuse' }, phrases: [{ id: 'ads', label: 'Gold ads', action: 'count', phrases: ['buy gold'] }] } },
    });
    w.cw.rooms.seat('R', 'p1', { clientKey: 'k1' }, 'Spk');
    w.cw.chat.accept('R', 'p1', LINK);
    w.clock.t += 10_000;
    w.cw.chat.accept('R', 'p1', 'mail me at a@b.com');
    w.clock.t += 10_000;
    w.cw.chat.accept('R', 'p1', 'buy gold now');
    const res = await w.call('GET', '/filters/stats', { query: { days: '7' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      days: 7,
      keys: {
        'link.unlisted': { count: 0, flag: 0, mask: 1, refuse: 0, flag_capped: 0 },
        'personal_info.email': { count: 0, flag: 0, mask: 0, refuse: 1, flag_capped: 0 },
        'phrase.ads': { count: 1, flag: 0, mask: 0, refuse: 0, flag_capped: 0, label: 'Gold ads' },
      },
    });
    // a phrase rule that is no longer in the settings keeps its counts and has no label
    const today = Math.floor(w.clock.t / 86_400_000);
    w.store.addFilterHits([{ day: today, key: 'phrase.retired', action: 'refuse', hits: 3 }]);
    const after = (await w.call('GET', '/filters/stats', { query: { days: '30' } })).body as { keys: Record<string, Record<string, unknown>> };
    expect(after.keys['phrase.retired']).toEqual({ count: 0, flag: 0, mask: 0, refuse: 3, flag_capped: 0 });
    expect(after.keys['phrase.ads']).toMatchObject({ label: 'Gold ads' });
  });

  it('no person, room, text or id is in the body, and nothing is audited', async () => {
    const w = await world({ overrides: { filters: { links: { action: 'flag' } } } });
    w.cw.rooms.seat('ROOM-SECRET', 'p1', { clientKey: 'raw-client-key-zorbak' }, 'Spk');
    w.cw.chat.accept('ROOM-SECRET', 'p1', LINK);
    const before = w.audit().length;
    const res = await w.call('GET', '/filters/stats', { query: { days: '7' } });
    const text = JSON.stringify(res.body);
    for (const leak of ['ROOM-SECRET', 'raw-client-key', 'vlemmo', 'Spk', 's_']) expect(text).not.toContain(leak);
    expect(w.audit().length).toBe(before);
  });

  it('a store failure reading the counts is a 500 with a fixed body', async () => {
    const w = await world();
    w.store.listFilterHits = () => {
      throw new TypeError('boom vlemmo.com');
    };
    const res = await w.call('GET', '/filters/stats', { query: { days: '7' } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('vlemmo');
  });
});

describe('POST /filters/test', () => {
  const live = { filters: { links: { action: 'refuse' as const, rule: 4 }, personalInfo: { action: 'mask' as const } } };

  it('the verdict with kinds, details, actions, rules and spans, and the line as it would be delivered', async () => {
    const w = await world({ overrides: live });
    const res = await w.call('POST', '/filters/test', post({ text: 'mail a@b.com or see vlemmo.com' }));
    expect(res.status).toBe(200);
    const body = res.body as { verdict: { hits: Array<Record<string, unknown>>; refuse: unknown; spans: unknown[] }; delivered: string | null };
    expect(body.delivered).toBeNull();
    expect(body.verdict.refuse).toEqual({ reason: 'link', rule: 4 });
    expect(body.verdict.hits.map((h) => [h.key, h.kind, h.action, h.rule])).toEqual([
      ['link.unlisted', 'link', 'refuse', 4],
      ['personal_info.email', 'personal_info', 'mask', 2],
    ]);
    const at = 'mail a@b.com or see vlemmo.com'.indexOf('vlemmo.com');
    expect(body.verdict.hits[0]!.spans).toEqual([{ start: at, end: at + 'vlemmo.com'.length }]);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const clean = (await w.call('POST', '/filters/test', post({ text: 'mail a@b.com please' }))).body as { delivered: string | null; verdict: { hits: unknown[] } };
    expect(clean.delivered).toBe('mail ******* please');
    expect(clean.verdict.hits).toHaveLength(1);
  });

  it('a candidate is tried instead of the live settings, and is not saved', async () => {
    const w = await world();
    const none = (await w.call('POST', '/filters/test', post({ text: LINK }))).body as { verdict: { hits: unknown[] } };
    expect(none.verdict.hits).toEqual([]);
    const res = await w.call('POST', '/filters/test', post({ text: LINK, candidate: { links: { action: 'mask' } } }));
    expect((res.body as { delivered: string }).delivered).toBe('see ********** now');
    const again = (await w.call('POST', '/filters/test', post({ text: LINK }))).body as { verdict: { hits: unknown[] } };
    expect(again.verdict.hits).toEqual([]);
    expect(w.cw.policy.get().version).toBe(0);
  });

  it('a candidate that is invalid is 400 invalid_filters with the path and never the value', async () => {
    const w = await world();
    const res = await w.call('POST', '/filters/test', post({ text: 'hi', candidate: { links: { action: 'nuke-vlemmo' } } }));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_filters');
    expect((res.body as { path: string }).path).toMatch(/links\.action/);
    expect(JSON.stringify(res.body)).not.toContain('vlemmo');
    for (const candidate of [[], 'x', 5, { nope: true }, { links: { action: 'count', rule: 'x' } }, { phrases: [{ id: 'A B', action: 'count', phrases: ['x'] }] }]) {
      const r = await w.call('POST', '/filters/test', post({ text: 'hi', candidate }));
      expect(r.status, JSON.stringify(candidate)).toBe(400);
    }
  });

  it('text is 1 to 2000 characters; anything else is 400 invalid_request', async () => {
    const w = await world();
    for (const text of ['', 'a'.repeat(2001), 5, null, undefined, ['a']]) {
      const res = await w.call('POST', '/filters/test', post({ text }));
      expect(res.status, String(text).slice(0, 10)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    expect((await w.call('POST', '/filters/test', post({ text: 'a'.repeat(2000) }))).status).toBe(200);
    expect((await w.call('POST', '/filters/test', post({ text: 'a' }))).status).toBe(200);
    expect((await w.call('POST', '/filters/test', { role: 'moderator', raw: '{bad' })).status).toBe(400);
    expect((await w.call('POST', '/filters/test', post([]))).status).toBe(400);
  });

  it('nothing is written (spy store), no audit row, and the text is not logged', async () => {
    const w = await world({ overrides: live });
    const spies = [vi.spyOn(w.store, 'insertReport'), vi.spyOn(w.store, 'addFilterHits'), vi.spyOn(w.store, 'insertStrike'), vi.spyOn(w.store, 'insertAudit')];
    const before = w.audit().length;
    w.logged.length = 0;
    await w.call('POST', '/filters/test', post({ text: 'mail a@b.com or see vlemmo.com' }));
    await w.call('POST', '/filters/test', post({ text: 'see vlemmo.com', candidate: { links: { action: 'flag' } } }));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(w.audit().length).toBe(before);
    expect(JSON.stringify(w.logged)).not.toContain('vlemmo');
    expect((await w.cw.filters.stats({ days: 7 })).keys).toEqual({});
  });
});

describe('POST /filters/check', () => {
  it('counts and at most 20 samples per rule', async () => {
    const lines = [...Array.from({ length: 30 }, (_, i) => `visit vlemmo${i}.com now`), 'plain chat', 'mail a@b.com'];
    const w = await world({ recentLines: () => lines });
    const res = await w.call('POST', '/filters/check', post({ candidate: { links: { action: 'refuse' }, personalInfo: { action: 'mask' } } }));
    expect(res.status).toBe(200);
    const body = res.body as { lines: number; refused: number; masked: number; rules: Array<{ key: string; hits: number; samples: unknown[] }> };
    expect(body).toMatchObject({ lines: 32, refused: 30, masked: 1 });
    const link = body.rules.find((r) => r.key === 'link.unlisted')!;
    expect(link.hits).toBe(30);
    expect(link.samples).toHaveLength(20);
    expect(res.headers?.['cache-control']).toBe('no-store');
  });

  it('at most 5000 lines are read', async () => {
    const w = await world({ recentLines: () => Array.from({ length: 6000 }, () => 'see vlemmo.com') });
    const body = (await w.call('POST', '/filters/check', post({ candidate: { links: { action: 'count' } } }))).body as { lines: number };
    expect(body.lines).toBe(5000);
  });

  it('with no recentLines option it answers empty counts', async () => {
    const w = await world();
    const res = await w.call('POST', '/filters/check', post({ candidate: { links: { action: 'refuse' } } }));
    expect(res.body).toEqual({ lines: 0, refused: 0, masked: 0, rules: [] });
  });

  it('400 for a bad candidate, a missing candidate and a body that is not an object', async () => {
    const w = await world({ recentLines: () => [LINK] });
    const bad = await w.call('POST', '/filters/check', post({ candidate: { links: { action: 'zap' } } }));
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toBe('invalid_filters');
    expect((bad.body as { path: string }).path).toMatch(/links\.action/);
    for (const body of [{}, { candidate: null }, { candidate: 'x' }, { candidate: [] }, []]) {
      expect((await w.call('POST', '/filters/check', post(body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('a recentLines hook that throws gives empty counts and logs the class only; non-string lines are skipped', async () => {
    const w = await world({
      recentLines: () => {
        throw new TypeError('boom vlemmo.com');
      },
    });
    const res = await w.call('POST', '/filters/check', post({ candidate: { links: { action: 'refuse' } } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lines: 0, refused: 0, masked: 0, rules: [] });
    expect(JSON.stringify(w.logged)).not.toContain('vlemmo');
    const mixed = await world({ recentLines: () => [LINK, 5 as never, null as never] });
    expect(((await mixed.call('POST', '/filters/check', post({ candidate: { links: { action: 'count' } } }))).body as { lines: number }).lines).toBe(1);
  });

  it('nothing is written and no audit row is added', async () => {
    const w = await world({ recentLines: () => [LINK] });
    const spies = [vi.spyOn(w.store, 'insertReport'), vi.spyOn(w.store, 'addFilterHits'), vi.spyOn(w.store, 'insertAudit')];
    const before = w.audit().length;
    await w.call('POST', '/filters/check', post({ candidate: { links: { action: 'flag' } } }));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(w.audit().length).toBe(before);
  });
});

describe('GET /me and GET /policy/profile', () => {
  it('GET /policy/profile reports limits.filters.accountAge true only when the hook is configured', async () => {
    const without = await world();
    const a = (await without.call('GET', '/policy/profile', rec())).body as { limits: { filters: { accountAge: boolean } } };
    expect(a.limits.filters).toEqual({ accountAge: false });
    const withHook = await world({ signals: { accountAgeDays: () => 10 } });
    const b = (await withHook.call('GET', '/policy/profile', rec())).body as { limits: { filters: { accountAge: boolean } } };
    expect(b.limits.filters).toEqual({ accountAge: true });
  });
});
