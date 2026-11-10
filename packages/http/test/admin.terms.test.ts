import { describe, expect, it } from 'vitest';
import { errorOf, keysDeep, world } from './world.js';

// Synthetic words only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn): no real term anywhere.

interface Rows {
  terms: Array<{ id: string; term: string; language: string; active: boolean }>;
  exceptions: Array<{ id: string; phrase: string; language: string; active: boolean }>;
}

describe('terms routes exist only when `terms` is passed', () => {
  it('without it every terms and exceptions route is 404', async () => {
    const { call, routes } = await world({ terms: false });
    expect(Object.keys(routes).filter((k) => /terms|exceptions/.test(k))).toEqual([]);
    expect((await call('GET', '/terms')).status).toBe(404);
    expect((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).status).toBe(404);
    expect((await call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } })).status).toBe(404);
  });

  it('with it, the nine routes are present', async () => {
    const { routes } = await world();
    expect(Object.keys(routes).filter((k) => /terms|exceptions/.test(k)).map((k) => k.replace('~ref', '')).sort()).toEqual([
      'GET /terms',
      'PATCH /exceptions/:id',
      'PATCH /terms/:id',
      'POST /exceptions',
      'POST /exceptions/:id/active',
      'POST /terms',
      'POST /terms/:id/active',
      'POST /terms/check',
      'POST /terms/test',
    ]);
  });
});

describe('GET /terms', () => {
  it('returns the term and exception rows (staff only) with their metadata, and no audit row', async () => {
    const { call, live, audit } = await world();
    const res = await call('GET', '/terms');
    expect(res.status).toBe(200);
    const body = res.body as Rows;
    expect(body.terms.map((t) => t.term)).toEqual(live.rows.terms.map((t) => t.term));
    expect(body.terms.map((t) => t.term)).toEqual(expect.arrayContaining(['zorbak', 'vlemmo', 'snerp']));
    expect(body.exceptions.map((e) => e.phrase)).toEqual(expect.arrayContaining(['tarvo lake', 'glarn zorbak']));
    expect(body.terms[0]).toEqual({
      id: expect.any(String), term: expect.any(String), language: 'en', active: true,
      note: null, addedBy: 'seed', addedAt: expect.any(Number), updatedBy: null, updatedAt: null,
    });
    expect(audit().filter((r) => r.role !== null)).toEqual([]);
  });

  it('terms.read is moderator by default and can be raised', async () => {
    expect((await (await world()).call('GET', '/terms', { role: 'moderator' })).status).toBe(200);
    const raised = await world({ permissions: { 'terms.read': 'owner' } });
    expect((await raised.call('GET', '/terms', { role: 'senior' })).status).toBe(403);
    expect((await raised.call('GET', '/terms', { role: 'owner' })).status).toBe(200);
  });
});

describe('POST /terms/check', () => {
  it('is a dry run: the lines a candidate would block, nothing written, no audit row', async () => {
    const { call, live, audit, store } = await world({ recentLines: () => ['we all like glarn here', 'hello there', 'GLARN!'] });
    const before = JSON.stringify(live.rows);
    const res = await call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } });
    expect(res.status).toBe(200);
    expect((res.body as { hits: string[] }).hits).toEqual(['we all like glarn here', 'GLARN!']);
    expect(JSON.stringify(live.rows)).toBe(before);
    expect(store.listTerms().some((t) => t.term === 'glarn')).toBe(false);
    expect(audit()).toEqual([]);
  });

  it('recentLines defaults to none, and is read on each call', async () => {
    const none = await world();
    expect((await none.call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } })).body).toEqual({ hits: [] });
    let lines: string[] = [];
    const live = await world({ recentLines: () => lines });
    expect(((await live.call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } })).body as { hits: string[] }).hits).toEqual([]);
    lines = ['a glarn line'];
    expect(((await live.call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } })).body as { hits: string[] }).hits).toEqual(['a glarn line']);
  });

  it('a recentLines hook that throws is a plain 500', async () => {
    const { call } = await world({
      recentLines: () => {
        throw new Error('buffer gone');
      },
    });
    const res = await call('POST', '/terms/check', { body: { term: 'glarn', language: 'en' } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
  });

  it('a term the matcher cannot build is 400 invalid_term and never echoed', async () => {
    const { call } = await world();
    const res = await call('POST', '/terms/check', { body: { term: 'a', language: 'en' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_term']);
    expect(JSON.stringify(res.body)).not.toContain('"a"');
  });

  it('validates the body: term and language must be bounded strings', async () => {
    const { call } = await world();
    const bodies: unknown[] = [
      {},
      { term: 'glarn' },
      { language: 'en' },
      { term: '', language: 'en' },
      { term: 7, language: 'en' },
      { term: 'glarn', language: 7 },
      { term: 'glarn', language: '' },
      { term: 'glarn', language: 'en us' },
      { term: 'glarn', language: 'x'.repeat(40) },
      { term: 'x'.repeat(201), language: 'en' },
      { term: null, language: null },
      [],
    ];
    for (const body of bodies) {
      const res = await call('POST', '/terms/check', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    for (const raw of ['', '{nope', '"glarn"']) expect((await call('POST', '/terms/check', { raw })).status).toBe(400);
  });

  it('terms.read gates it (a moderator by default), not terms.write', async () => {
    const { call } = await world({ permissions: { 'terms.write': 'owner' } });
    expect((await call('POST', '/terms/check', { role: 'moderator', body: { term: 'glarn', language: 'en' } })).status).toBe(200);
    const raised = await world({ permissions: { 'terms.read': 'senior' } });
    expect((await raised.call('POST', '/terms/check', { role: 'moderator', body: { term: 'glarn', language: 'en' } })).status).toBe(403);
  });
});

describe('POST /terms, PATCH /terms/:id, POST /terms/:id/active', () => {
  it('adds a term, which the live matcher blocks at once; audits term.add with the row id and never the text', async () => {
    const { call, live, routeAudit, clock } = await world();
    expect(live.match('say glarn now')).toBeNull();
    const res = await call('POST', '/terms', { actor: 'ann', role: 'moderator', body: { term: 'glarn', language: 'en', note: 'new slang' } });
    expect(res.status).toBe(200);
    const { id } = res.body as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(Object.keys(res.body as object)).toEqual(['id']);
    expect(live.match('say glarn now')).toEqual({ termId: id });
    expect(routeAudit()).toEqual([
      { id: expect.any(String), at: clock.t, actor: 'ann', role: 'moderator', action: 'term.add', target: { type: 'term', ref: id } },
    ]);
    expect(JSON.stringify(routeAudit())).not.toContain('glarn');
    // And it shows in the list.
    const list = (await call('GET', '/terms')).body as Rows;
    expect(list.terms.find((t) => t.id === id)).toEqual({
      id, term: 'glarn', language: 'en', active: true, note: 'new slang', addedBy: 'ann', addedAt: clock.t, updatedBy: null, updatedAt: null,
    });
  });

  it('the note is optional; a null or string note is accepted, other types are 400', async () => {
    const { call } = await world();
    expect((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).status).toBe(200);
    expect((await call('POST', '/terms', { body: { term: 'glarnix', language: 'en', note: null } })).status).toBe(200);
    for (const note of [5, {}, [], true, 'n'.repeat(501)]) {
      expect((await call('POST', '/terms', { body: { term: 'glarnox', language: 'en', note } })).status, JSON.stringify(note)).toBe(400);
    }
  });

  it('a duplicate is refused 400 invalid_term, writes nothing and never echoes the term', async () => {
    const { call, live, routeAudit } = await world();
    const before = JSON.stringify(live.rows);
    for (const term of ['zorbak', 'ZORBAK', 'Zorbak!']) {
      const res = await call('POST', '/terms', { body: { term, language: 'en' } });
      expect([res.status, errorOf(res)], term).toEqual([400, 'invalid_term']);
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain('zorbak');
    }
    expect(JSON.stringify(live.rows)).toBe(before);
    expect(routeAudit()).toEqual([]);
  });

  it('a malformed term (too short) is 400 invalid_term and never echoed', async () => {
    const { call, routeAudit } = await world();
    const res = await call('POST', '/terms', { body: { term: 'qq', language: 'en' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_term']);
    expect(JSON.stringify(res.body)).not.toContain('qq');
    expect(routeAudit()).toEqual([]);
  });

  it('updates a term (word, language, note), audits term.update with the id', async () => {
    const { call, live, routeAudit } = await world();
    const id = ((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).body as { id: string }).id;
    const res = await call('PATCH', `/terms/${id}`, { actor: 'bob', role: 'senior', body: { term: 'glarnix', note: 'renamed' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(live.rows.terms.find((t) => t.id === id)?.term).toBe('glarnix');
    expect(live.match('a glarnix b')).toEqual({ termId: id });
    const row = routeAudit().find((r) => r.action === 'term.update');
    expect(row).toMatchObject({ actor: 'bob', role: 'senior', target: { type: 'term', ref: id } });
    expect(JSON.stringify(routeAudit())).not.toContain('glarnix');
    const lang = await call('PATCH', `/terms/${id}`, { body: { language: 'es' } });
    expect(lang.status).toBe(200);
    expect(live.rows.terms.find((t) => t.id === id)?.language).toBe('es');
    expect((await call('PATCH', `/terms/${id}`, { body: { note: null } })).status).toBe(200);
  });

  it('an empty patch, an unknown-only patch and bad field types are 400', async () => {
    const { call } = await world();
    const id = ((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).body as { id: string }).id;
    for (const body of [{}, { other: 1 }, { term: '' }, { term: 5 }, { language: '' }, { language: 5 }, { note: 5 }, { term: 'x'.repeat(201) }, []]) {
      expect((await call('PATCH', `/terms/${id}`, { body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('PATCH to another term\'s word is refused 400 invalid_term without echoing it', async () => {
    const { call, live } = await world();
    const id = ((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).body as { id: string }).id;
    const res = await call('PATCH', `/terms/${id}`, { body: { term: 'vlemmo' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_term']);
    expect(JSON.stringify(res.body)).not.toContain('vlemmo');
    expect(live.rows.terms.find((t) => t.id === id)?.term).toBe('glarn');
  });

  it('an unknown id is 404 for PATCH and active, with no audit row', async () => {
    const { call, routeAudit } = await world();
    expect((await call('PATCH', '/terms/nope', { body: { term: 'glarn' } })).status).toBe(404);
    expect((await call('POST', '/terms/nope/active', { body: { active: false } })).status).toBe(404);
    // An exception id is not a term id.
    expect((await call('PATCH', '/terms/syn-ex:tarvo-lake', { body: { term: 'glarn' } })).status).toBe(404);
    expect(routeAudit()).toEqual([]);
  });

  it('toggles active, audits term.toggle; the matcher follows; a no-op toggle still answers 200', async () => {
    const { call, live, routeAudit } = await world();
    const id = ((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).body as { id: string }).id;
    expect((await call('POST', `/terms/${id}/active`, { body: { active: false } })).status).toBe(200);
    expect(live.match('a glarn b')).toBeNull();
    expect((await call('POST', `/terms/${id}/active`, { body: { active: true } })).status).toBe(200);
    expect(live.match('a glarn b')).toEqual({ termId: id });
    expect(routeAudit().filter((r) => r.action === 'term.toggle')).toHaveLength(2);
    expect((await call('POST', `/terms/${id}/active`, { body: { active: true } })).status).toBe(200);
  });

  it('active must be a boolean', async () => {
    const { call } = await world();
    const id = ((await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } })).body as { id: string }).id;
    for (const body of [{}, { active: 'true' }, { active: 1 }, { active: null }, []]) {
      expect((await call('POST', `/terms/${id}/active`, { body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses to disable the last active term (400 invalid_term) and rolls back', async () => {
    const { call, live } = await world();
    const terms = (await call('GET', '/terms')).body as Rows;
    for (const t of terms.terms.slice(1)) {
      expect((await call('POST', `/terms/${t.id}/active`, { body: { active: false } })).status).toBe(200);
    }
    const last = terms.terms[0] as Rows['terms'][number];
    const res = await call('POST', `/terms/${last.id}/active`, { body: { active: false } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_term']);
    expect(live.rows.terms.find((t) => t.id === last.id)?.active).toBe(true);
  });

  describe('permissions', () => {
    it('terms.write is moderator by default (the Moxgate decision) and can be raised', async () => {
      const def = await world();
      expect((await def.call('POST', '/terms', { role: 'moderator', body: { term: 'glarn', language: 'en' } })).status).toBe(200);
      const raised = await world({ permissions: { 'terms.write': 'senior' } });
      const body = { term: 'glarn', language: 'en' };
      expect((await raised.call('POST', '/terms', { role: 'moderator', body })).status).toBe(403);
      expect((await raised.call('PATCH', '/terms/x', { role: 'moderator', body: { term: 'glarn' } })).status).toBe(403);
      expect((await raised.call('POST', '/terms/x/active', { role: 'moderator', body: { active: true } })).status).toBe(403);
      expect((await raised.call('POST', '/terms', { role: 'senior', body })).status).toBe(200);
      expect(raised.routeAudit().filter((r) => r.action === 'term.add')).toHaveLength(1);
    });

    it('terms.read does not allow writes', async () => {
      const { call } = await world({ permissions: { 'terms.read': 'moderator', 'terms.write': 'owner' } });
      expect((await call('GET', '/terms', { role: 'moderator' })).status).toBe(200);
      expect((await call('POST', '/terms', { role: 'senior', body: { term: 'glarn', language: 'en' } })).status).toBe(403);
    });
  });

  describe('failures', () => {
    it('a failed audit write after a committed change is logged and the answer stands (200)', async () => {
      const { call, logged, live } = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
      const res = await call('POST', '/terms', { body: { term: 'glarn', language: 'en' } });
      expect(res.status).toBe(200);
      expect(logged.some(([e]) => e === 'chatwarden.http_audit_failed')).toBe(true);
      expect(live.rows.terms.some((t) => t.term === 'glarn')).toBe(true);
    });

    it('a rejecting terms editor is a plain 500 and nothing about the term is logged', async () => {
      const { cw, live } = await world();
      const { createRouter, adminRoutes } = await import('@chatwarden/http');
      const logged: string[] = [];
      const broken = {
        get rows() {
          return live.rows;
        },
        check: live.check.bind(live),
        change: () => Promise.reject(new Error('store says glarnoid')),
      };
      const router = createRouter(
        adminRoutes(cw, { authorize: () => ({ actor: 'ann', role: 'moderator' }), terms: broken, logger: { warn: (e, d) => void logged.push(JSON.stringify([e, d])) } }),
      );
      const res = await router({ method: 'POST', path: '/terms', query: {}, headers: {}, body: undefined, rawBody: JSON.stringify({ term: 'glarnoid', language: 'en' }) });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal' });
      expect(logged.join('')).not.toContain('glarnoid');
    });
  });
});

describe('exceptions: POST /exceptions, PATCH /exceptions/:id, POST /exceptions/:id/active', () => {
  it('adds an exception (phrase field), audits exception.add with the row id, and the matcher follows', async () => {
    const { call, live, routeAudit } = await world();
    expect(live.match('a zorbak b')).not.toBeNull();
    const res = await call('POST', '/exceptions', { actor: 'ann', body: { phrase: 'zorbak party', language: 'en' } });
    expect(res.status).toBe(200);
    const { id } = res.body as { id: string };
    expect(live.rows.exceptions.some((e) => e.id === id && e.phrase === 'zorbak party')).toBe(true);
    expect(routeAudit()).toEqual([
      expect.objectContaining({ action: 'exception.add', actor: 'ann', role: 'moderator', target: { type: 'exception', ref: id } }),
    ]);
    expect(JSON.stringify(routeAudit())).not.toContain('party');
  });

  it('updates and toggles an exception: exception.update and exception.toggle', async () => {
    const { call, live, routeAudit } = await world();
    const id = ((await call('POST', '/exceptions', { body: { phrase: 'zorbak party', language: 'en' } })).body as { id: string }).id;
    expect((await call('PATCH', `/exceptions/${id}`, { body: { phrase: 'zorbak picnic', note: 'x' } })).status).toBe(200);
    expect(live.rows.exceptions.find((e) => e.id === id)?.phrase).toBe('zorbak picnic');
    expect((await call('POST', `/exceptions/${id}/active`, { body: { active: false } })).status).toBe(200);
    expect(live.rows.exceptions.find((e) => e.id === id)?.active).toBe(false);
    expect(routeAudit().map((r) => [r.action, r.target])).toEqual(
      expect.arrayContaining([
        ['exception.update', { type: 'exception', ref: id }],
        ['exception.toggle', { type: 'exception', ref: id }],
      ]),
    );
  });

  it('validates the body (phrase, not term) and 404s an unknown id or a term id', async () => {
    const { call } = await world();
    expect((await call('POST', '/exceptions', { body: { term: 'zorbak party', language: 'en' } })).status).toBe(400);
    expect((await call('POST', '/exceptions', { body: { phrase: '', language: 'en' } })).status).toBe(400);
    expect((await call('PATCH', '/exceptions/nope', { body: { phrase: 'abc def' } })).status).toBe(404);
    expect((await call('POST', '/exceptions/nope/active', { body: { active: true } })).status).toBe(404);
    expect((await call('PATCH', '/exceptions/syn:zorbak', { body: { phrase: 'abc def' } })).status).toBe(404);
    expect((await call('PATCH', '/exceptions/syn-ex:tarvo-lake', { body: {} })).status).toBe(400);
  });

  it('an exception that would unblock a pack positive line is refused 400 invalid_term, no echo', async () => {
    const { call, live } = await world();
    const before = JSON.stringify(live.rows.exceptions);
    const res = await call('POST', '/exceptions', { body: { phrase: 'zorbak', language: 'en' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_term']);
    expect(JSON.stringify(res.body)).not.toMatch(/zorbak|positive line/);
    expect(JSON.stringify(live.rows.exceptions)).toBe(before);
  });

  it('terms.write gates the exception writes', async () => {
    const { call } = await world({ permissions: { 'terms.write': 'owner' } });
    expect((await call('POST', '/exceptions', { role: 'senior', body: { phrase: 'zorbak party', language: 'en' } })).status).toBe(403);
    expect((await call('POST', '/exceptions', { role: 'owner', body: { phrase: 'zorbak party', language: 'en' } })).status).toBe(200);
  });
});

describe('term text stays in GET /terms and POST /terms/check only', () => {
  it('no other response, error, log line or audit row holds a term typed in the request', async () => {
    const { call, audit, logged } = await world({ recentLines: () => ['say glarnoid now'] });
    const responses = [
      await call('POST', '/terms', { body: { term: 'glarnoid', language: 'en' } }),
      await call('POST', '/terms', { body: { term: 'glarnoid', language: 'en' } }),
      await call('POST', '/terms', { body: { term: 'glarnoid', language: 'bad lang' } }),
      await call('PATCH', '/terms/nope', { body: { term: 'glarnoid' } }),
      await call('POST', '/exceptions', { body: { phrase: 'glarnoid party', language: 'en' } }),
      await call('POST', '/terms', { role: 'moderator', raw: '{"term":"glarnoid"' }),
    ];
    for (const res of responses) expect(JSON.stringify(res.body)).not.toContain('glarnoid');
    expect(JSON.stringify(audit().filter((r) => r.role !== null))).not.toContain('glarnoid');
    expect(JSON.stringify(logged)).not.toContain('glarnoid');
    // The two places it is allowed.
    expect(JSON.stringify((await call('GET', '/terms')).body)).toContain('glarnoid');
    expect(JSON.stringify((await call('POST', '/terms/check', { body: { term: 'glarnoid', language: 'en' } })).body)).toContain('glarnoid');
  });

  it('no response carries an ip, hash or key', async () => {
    const { call } = await world();
    const res = await call('GET', '/terms');
    const forbidden = /^(ip|ips|ipHash|keyHash|clientKey|key|rawKey|secret|hash)$/i;
    for (const k of keysDeep(res.body)) expect(forbidden.test(k), k).toBe(false);
  });
});
