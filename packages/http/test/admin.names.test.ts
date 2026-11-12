import { describe, expect, it } from 'vitest';
import type { Matcher, ProfanityFilter } from '@chatwarden/core';
import type { KitEvent } from '@chatwarden/core';
import { DAY, errorOf, HOUR, NOW, world } from './world.js';
import type { Role } from '@chatwarden/http';

// Names, staff side: `POST /people/:ref/rename` (ask a player to choose a new name) and `GET /blocked?source=name` (the kept blocked names).
// Synthetic terms only: zorbak (a slur here) and snerp (a swear word here).

const matcher: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
const profanity: ProfanityFilter = { apply: (text) => ({ hit: /snerp/i.test(text), text }) };
const REASON = 'private reason: a name against the rules';

type W = Awaited<ReturnType<typeof world>>;

const renameWorld = (names: Record<string, unknown> = { renames: true }, over: Parameters<typeof world>[0] = {}) =>
  world({ ...over, matcher, profanity, overrides: { names, ...(over.overrides ?? {}) } });

const rename = (w: W, ref: string, body: unknown = { reason: REASON }, o: { role?: Role | null; actor?: string } = {}) =>
  w.call('POST', `/people/${ref}/rename`, { role: o.role === undefined ? 'moderator' : o.role, actor: o.actor ?? 'ann', body });

describe('POST /people/:ref/rename needs sanctions.apply, honours the claim gate (gateCase) and takeOver, audits name.rename_required best-effort, 404 when renames are off, 409 pending_rename, 400 for a bad reason', () => {
  it('200 { ok: true }: the player is now pending a rename and the game hears rename.required', async () => {
    const w = await renameWorld();
    const f = await w.file();
    const events: KitEvent[] = [];
    w.cw.on('rename.required', (e) => void events.push(e));
    const res = await rename(w, f.target);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(true);
    expect(events).toEqual([{ type: 'rename.required', at: NOW + 1000, target: f.target, rule: expect.anything() }]);
    // The notice names no name and no reason.
    const notices = w.cw.notices.pending({ clientKey: f.key });
    expect(notices.map((n) => n.kind)).toContain('rename_required');
    expect(JSON.stringify(notices)).not.toContain(REASON);
  });

  it('a rule is optional and must be an active rule; the default is the slur filter\'s rule', async () => {
    const w = await renameWorld();
    const a = await w.file();
    const b = await w.file();
    expect((await rename(w, a.target, { reason: REASON, rule: 2 })).status).toBe(200);
    expect(w.cw.notices.pending({ clientKey: a.key }).find((n) => n.kind === 'rename_required')?.rule).toBe(2);
    expect((await rename(w, b.target)).status).toBe(200);
    expect(w.cw.notices.pending({ clientKey: b.key }).find((n) => n.kind === 'rename_required')?.rule).toBe(1);
  });

  it('needs sanctions.apply: with it locked to the owner a moderator and a senior are 403, the owner may; no authz is 401, before the body is read', async () => {
    const w = await renameWorld({ renames: true }, { permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.file();
    for (const role of ['moderator', 'senior'] as const) {
      const res = await rename(w, f.target, { reason: REASON }, { role });
      expect(res.status, role).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
    }
    expect((await w.call('POST', `/people/${f.target}/rename`, { role: 'moderator', raw: '{nope' })).status).toBe(403);
    expect((await w.call('POST', `/people/${f.target}/rename`, { role: null, raw: '{nope' })).status).toBe(401);
    expect(w.routeAudit()).toEqual([]);
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    expect((await rename(w, f.target, { reason: REASON }, { role: 'owner' })).status).toBe(200);
  });

  it('the default is a moderator: any role with sanctions.apply may ask', async () => {
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const w = await renameWorld();
      const f = await w.file();
      expect((await rename(w, f.target, { reason: REASON }, { role })).status, role).toBe(200);
    }
  });

  it('audits name.rename_required with the person as target, the caller as actor, after the write; no reason, name or detail in the row', async () => {
    const w = await renameWorld();
    const f = await w.file();
    await rename(w, f.target, { reason: REASON }, { actor: 'gus', role: 'senior' });
    const rows = w.routeAudit();
    expect(rows.map((r) => [r.actor, r.role, r.action, r.target])).toEqual([['gus', 'senior', 'name.rename_required', { type: 'person', ref: f.target }]]);
    expect(JSON.stringify(w.audit())).not.toContain(REASON);
    expect(rows[0]).not.toHaveProperty('detail');
  });

  it('the audit is best-effort: the rename stands and the answer is 200 when its row cannot be written, and the failure is logged by class', async () => {
    const w = await renameWorld({ renames: true }, { wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const f = await w.file();
    w.logged.length = 0;
    const res = await rename(w, f.target);
    expect(res.status).toBe(200);
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(true);
    expect(w.logged.map(([e]) => e)).toContain('chatwarden.http_audit_failed');
    expect(JSON.stringify(w.logged)).not.toContain(REASON);
  });

  it('a refused request (404, 409, 400, 403) writes no name.rename_required row', async () => {
    const w = await renameWorld();
    const f = await w.file();
    await rename(w, f.target);
    const before = w.routeAudit().length;
    expect((await rename(w, f.target)).status).toBe(409);
    expect((await rename(w, 's_nobody_nobody_nobody_00')).status).toBe(404);
    expect((await rename(w, f.target, { reason: '' })).status).toBe(400);
    expect(w.routeAudit()).toHaveLength(before);
  });

  it('404 not_found when renames are off, for every role, whatever the body, and nothing is written', async () => {
    for (const names of [{}, { renames: false }, { profanity: true }]) {
      const w = await renameWorld(names);
      const f = await w.file();
      for (const role of ['moderator', 'senior', 'owner'] as const) {
        for (const body of [{ reason: REASON }, {}, { reason: '' }, 'nope']) {
          const res = await rename(w, f.target, body, { role });
          expect(res.status, `${JSON.stringify(names)} ${role}`).toBe(404);
          expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
        }
      }
      expect(w.routeAudit()).toEqual([]);
      expect(w.cw.notices.pending({ clientKey: f.key }).filter((n) => n.kind === 'rename_required')).toEqual([]);
    }
  });

  it('404 when the store cannot release a rename, the same capability GET /me reports: the hub never offers a rename that always 404s', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect(((await w.call('GET', '/me')).body as { features?: { renames: boolean } }).features?.renames).toBe(true);
    (w.store as unknown as { withdrawNotice?: unknown }).withdrawNotice = undefined;
    expect(Object.keys((await w.call('GET', '/me')).body as object)).not.toContain('features');
    const res = await rename(w, f.target);
    expect(res.status).toBe(404);
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
  });

  it('the setting is read live: turning renames on in the policy opens the route', async () => {
    const w = await renameWorld({});
    const f = await w.file();
    expect((await rename(w, f.target)).status).toBe(404);
    w.cw.policy.save({ names: { renames: true } }, { version: 0, actor: 'owner', reason: 'on' });
    expect((await rename(w, f.target)).status).toBe(200);
  });

  it('404 for a person the kit does not hold; a ref that is not an id at all is no route', async () => {
    const w = await renameWorld();
    const res = await rename(w, 's_nobody_nobody_nobody_00');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
    expect((await rename(w, 'bad%20ref')).status).toBe(404);
    expect((await rename(w, 'a'.repeat(65))).status).toBe(404);
  });

  it('409 pending_rename while one is waiting; released by the game, the next request goes through', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect((await rename(w, f.target)).status).toBe(200);
    const again = await rename(w, f.target);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'pending_rename', message: 'A rename is already waiting for this player.' });
    expect(w.cw.notices.pending({ clientKey: f.key }).filter((n) => n.kind === 'rename_required')).toHaveLength(1);
    expect(w.cw.names.renamed({ clientKey: f.key })).toBe(true);
    expect((await rename(w, f.target)).status).toBe(200);
  });

  it('400 for a missing, empty, blank, non-string or over-long reason, a bad rule, a bad takeOver, and a body that is not an object', async () => {
    const w = await renameWorld();
    const f = await w.file();
    const bad: unknown[] = [
      {},
      { reason: '' },
      { reason: '   \n\t ' },
      { reason: 5 },
      { reason: null },
      { reason: ['x'] },
      { reason: 'x'.repeat(501) },
      { reason: 'x'.repeat(2001) },
      { reason: REASON, rule: 0 },
      { reason: REASON, rule: -1 },
      { reason: REASON, rule: 1.5 },
      { reason: REASON, rule: '2' },
      { reason: REASON, rule: 'uncovered' },
      { reason: REASON, rule: null },
      { reason: REASON, rule: 9999 },
      { reason: REASON, takeOver: 'yes' },
      { reason: REASON, takeOver: 1 },
      [],
      'x',
      null,
      7,
    ];
    for (const body of bad) {
      const res = await w.call('POST', `/people/${f.target}/rename`, { role: 'moderator', raw: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(errorOf(await w.call('POST', `/people/${f.target}/rename`, { role: 'moderator', raw: '{nope' }))).toBe('invalid_json');
    expect(errorOf(await w.call('POST', `/people/${f.target}/rename`, { role: 'moderator' }))).toBe('invalid_request');
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    // 500 characters exactly is fine.
    expect((await rename(w, f.target, { reason: 'x'.repeat(500) })).status).toBe(200);
  });

  it('the actor is the authenticated caller, never the body', async () => {
    const w = await renameWorld();
    const f = await w.file();
    await rename(w, f.target, { reason: REASON, actor: 'someone_else' } as never, { actor: 'gus' });
    expect(w.routeAudit()[0]?.actor).toBe('gus');
  });

  describe('the claim gate', () => {
    it('another moderator\'s live claim is 409 claimed with who and until; the rename is not written', async () => {
      const w = await renameWorld();
      const f = await w.file();
      expect(w.cw.cases.claim(f.target, 'bob')).toMatchObject({ ok: true });
      const res = await rename(w, f.target, { reason: REASON }, { actor: 'ann' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'claimed', by: 'bob', until: expect.any(Number) });
      expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
      expect(w.routeAudit()).toEqual([]);
    });

    it('takeOver without claims.override is still 409 claimed', async () => {
      const w = await renameWorld();
      const f = await w.file();
      w.cw.cases.claim(f.target, 'bob');
      const res = await rename(w, f.target, { reason: REASON, takeOver: true }, { role: 'moderator' });
      expect(res.status).toBe(409);
      expect(errorOf(res)).toBe('claimed');
      expect(w.cw.cases.holder(f.target)?.by).toBe('bob');
    });

    it('takeOver with claims.override (a senior) takes the case over, audited as case.takeover FIRST, then the rename; the claim stays with the caller', async () => {
      const w = await renameWorld();
      const f = await w.file();
      w.cw.cases.claim(f.target, 'bob');
      const res = await rename(w, f.target, { reason: REASON, takeOver: true }, { role: 'senior', actor: 'sen_cy' });
      expect(res.status).toBe(200);
      expect(w.routeAudit().map((r) => r.action).sort()).toEqual(['case.takeover', 'name.rename_required']);
      expect(w.cw.cases.holder(f.target)?.by).toBe('sen_cy');
      expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(true);
    });

    it('the caller\'s own claim, and no claim, pass; a claim on another person does not matter', async () => {
      const w = await renameWorld();
      const a = await w.file();
      const b = await w.file();
      const c = await w.file();
      w.cw.cases.claim(a.target, 'ann');
      w.cw.cases.claim(c.target, 'bob');
      expect((await rename(w, a.target, { reason: REASON }, { actor: 'ann' })).status).toBe(200);
      expect((await rename(w, b.target, { reason: REASON }, { actor: 'ann' })).status).toBe(200);
    });

    it('a takeover that cannot be recorded does not happen (500, the claim untouched)', async () => {
      const w = await renameWorld({ renames: true }, { wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
      const f = await w.file();
      w.cw.cases.claim(f.target, 'bob');
      const res = await rename(w, f.target, { reason: REASON, takeOver: true }, { role: 'senior' });
      expect(res.status).toBe(500);
      expect(w.cw.cases.holder(f.target)?.by).toBe('bob');
      expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    });
  });

  it('a store failure under the write is a 500 internal with nothing echoed', async () => {
    const w = await renameWorld(
      { renames: true },
      {
        wrap: (cw) => ({
          ...cw,
          names: {
            ...cw.names,
            requireRename: () => {
              throw new Error(`store down ${REASON}`);
            },
          },
        }),
      },
    );
    const f = await w.file();
    const res = await rename(w, f.target);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(JSON.stringify(w.logged)).not.toContain(REASON);
    expect(w.routeAudit()).toEqual([]);
  });
});

describe('GET /blocked?source=name lists kept names with text as the name, needs blocked.read, audits blocked.view; the default source is unchanged; empty when keepBlocked is off', () => {
  const keep = { keepBlocked: true, profanity: true };

  it('lists the kept names newest first, with text as the name, the reason, the person and their handle', async () => {
    const w = await renameWorld(keep);
    const f = await w.file();
    const t0 = w.clock.now();
    w.cw.names.check('Zorbak_99', { who: { clientKey: f.key } });
    w.clock.t += 1000;
    w.cw.names.check('big_snerp');
    const res = await w.call('GET', '/blocked', { query: { source: 'name' } });
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.text)).toEqual(['big_snerp', 'Zorbak_99']);
    expect(items[0]).toMatchObject({ roomId: null, termId: null, person: null, handle: null, text: 'big_snerp', reason: 'name_profane', at: t0 + 1000 });
    expect(items[1]).toMatchObject({ roomId: null, termId: 'syn:zorbak', person: f.target, handle: 'TargetName', text: 'Zorbak_99', reason: 'name_not_allowed', at: t0 });
    expect(Object.keys(items[1] as object).sort()).toEqual(['at', 'handle', 'id', 'language', 'person', 'reason', 'roomId', 'term', 'termId', 'text']);
    expect(res.headers?.['cache-control']).toBe('no-store');
  });

  it('the window is 1, 7 or 30 days (default 7); any other days or source is 400 invalid_query', async () => {
    const w = await renameWorld(keep);
    w.cw.names.check('zorbak_old');
    w.clock.t += 8 * DAY;
    w.cw.names.check('zorbak_new');
    const names = async (query: Record<string, string>) => ((await w.call('GET', '/blocked', { query: { source: 'name', ...query } })).body as { items: Array<{ text: string }> }).items.map((i) => i.text);
    expect(await names({})).toEqual(['zorbak_new']);
    expect(await names({ days: '1' })).toEqual(['zorbak_new']);
    expect(await names({ days: '30' })).toEqual(['zorbak_new', 'zorbak_old']);
    for (const days of ['0', '2', '31', 'x', '']) expect((await w.call('GET', '/blocked', { query: { source: 'name', days } })).status, days).toBe(400);
    for (const source of ['', 'names', 'NAME', 'line', 'x']) {
      const res = await w.call('GET', '/blocked', { query: { source } });
      expect(res.status, source).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
    }
  });

  it('needs blocked.read: locked to the owner, a moderator and a senior are 403; no authz is 401; a refused read writes no row', async () => {
    const w = await renameWorld(keep, { permissions: { 'blocked.read': 'owner' } });
    w.cw.names.check('zorbak_x');
    for (const role of ['moderator', 'senior'] as const) expect((await w.call('GET', '/blocked', { role, query: { source: 'name' } })).status, role).toBe(403);
    expect((await w.call('GET', '/blocked', { role: null, query: { source: 'name' } })).status).toBe(401);
    expect(w.routeAudit()).toEqual([]);
    expect((await w.call('GET', '/blocked', { role: 'owner', query: { source: 'name' } })).status).toBe(200);
  });

  it('audits blocked.view with no target, once, as the chat list does; an audit failure fails the read', async () => {
    const w = await renameWorld(keep);
    w.cw.names.check('zorbak_x');
    await w.call('GET', '/blocked', { actor: 'gus', role: 'senior', query: { source: 'name' } });
    expect(w.routeAudit().map((a) => [a.actor, a.role, a.action, a.target])).toEqual([['gus', 'senior', 'blocked.view', undefined]]);
    const broken = await renameWorld(keep, { wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    broken.cw.names.check('zorbak_x');
    const res = await broken.call('GET', '/blocked', { query: { source: 'name' } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res)).not.toContain('zorbak_x');
  });

  it('the default source is unchanged: the chat lines, the same keys, and the kept names are not in them', async () => {
    const w = await renameWorld(keep);
    w.cw.names.check('zorbak_name_only');
    w.store.insertStrike({ id: 'k1', at: NOW - HOUR, subject: 's_blocked', roomId: 'ROOM1', termId: 'syn:zorbak', rawLine: 'you zorbak' });
    for (const query of [{}, { source: 'chat' }] as Array<Record<string, string>>) {
      const body = (await w.call('GET', '/blocked', { query })).body as { items: Array<Record<string, unknown>> };
      expect(body.items.map((i) => i.id), JSON.stringify(query)).toEqual(['k1']);
      expect(Object.keys(body.items[0] as object)).toEqual(['id', 'at', 'roomId', 'termId', 'term', 'language', 'person', 'handle', 'text']);
      expect(JSON.stringify(body)).not.toContain('zorbak_name_only');
    }
  });

  it('is empty (still 200, still audited) when nothing was kept: keepBlocked off, or only an allowed name was checked', async () => {
    const off = await renameWorld({ profanity: true });
    off.cw.names.check('zorbak_x');
    const res = await off.call('GET', '/blocked', { query: { source: 'name' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    expect(off.routeAudit().map((r) => r.action)).toEqual(['blocked.view']);
    const on = await renameWorld(keep);
    on.cw.names.check('Fine Name');
    expect(((await on.call('GET', '/blocked', { query: { source: 'name' } })).body as { items: unknown[] }).items).toEqual([]);
  });

  it('term and language come from the injected terms and need terms.read; the handle needs history.read', async () => {
    const w = await renameWorld(keep, { permissions: { 'terms.read': 'senior', 'history.read': 'senior' } });
    const f = await w.file();
    w.cw.names.check('zorbak_x', { who: { clientKey: f.key } });
    const as = async (role: Role) => ((await w.call('GET', '/blocked', { role, query: { source: 'name' } })).body as { items: Array<{ term: unknown; language: unknown; handle: unknown }> }).items[0];
    expect(await as('moderator')).toMatchObject({ term: null, language: null, handle: null });
    const known = w.live.rows.terms.find((t) => t.id === 'syn:zorbak');
    const senior = await as('senior');
    expect(senior?.handle).toBe('TargetName');
    expect(senior?.term).toBe(known === undefined ? null : known.term);
  });

  it('no name is logged, and no raw name is in an audit row', async () => {
    const w = await renameWorld(keep);
    const f = await w.file();
    w.cw.names.check('zorbak_unique_77', { who: { clientKey: f.key } });
    await w.call('GET', '/blocked', { query: { source: 'name' } });
    expect(JSON.stringify(w.logged)).not.toContain('unique_77');
    expect(JSON.stringify(w.audit())).not.toContain('unique_77');
  });
});
