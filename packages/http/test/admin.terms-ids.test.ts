import { describe, expect, it } from 'vitest';
import { adminRoutes, createRouter } from '@chatwarden/http';
import type { TermsAdmin } from '@chatwarden/http';
import { world } from './world.js';

// Synthetic words only. The pack ids are the matcher fixtures' own (`syn:zorbak`, `syn-ex:tarvo-lake`): the colon is
// the convention adopters copy, so these routes must reach them.

describe('pack ids with ":" are addressable', () => {
  it('PATCH and toggle a seeded term by raw and percent-encoded id, and the audit row keeps the id', async () => {
    const { call, live, routeAudit } = await world();
    for (const [i, id] of ['syn:zorbak', 'syn%3Azorbak', 'syn%3azorbak'].entries()) {
      const res = await call('PATCH', `/terms/${id}`, { body: { note: `n${i}` } });
      expect(res.status, id).toBe(200);
    }
    expect((await call('POST', '/terms/syn:snerp/active', { body: { active: false } })).status).toBe(200);
    expect(live.rows.terms.find((t) => t.id === 'syn:snerp')?.active).toBe(false);
    expect((await call('POST', '/terms/syn%3Asnerp/active', { body: { active: true } })).status).toBe(200);
    expect(live.rows.terms.find((t) => t.id === 'syn:snerp')?.active).toBe(true);
    expect(routeAudit().map((r) => r.target)).toEqual(
      expect.arrayContaining([
        { type: 'term', ref: 'syn:zorbak' },
        { type: 'term', ref: 'syn:snerp' },
      ]),
    );
    expect(routeAudit()).toHaveLength(5);
  });

  it('PATCH and toggle a seeded exception by raw and percent-encoded id', async () => {
    const { call, live, routeAudit } = await world();
    expect((await call('PATCH', '/exceptions/syn-ex:tarvo-lake', { body: { note: 'a' } })).status).toBe(200);
    expect((await call('PATCH', '/exceptions/syn-ex%3Atarvo-lake', { body: { note: 'b' } })).status).toBe(200);
    expect((await call('POST', '/exceptions/syn-ex:tarvo-lake/active', { body: { active: false } })).status).toBe(200);
    expect(live.rows.exceptions.find((e) => e.id === 'syn-ex:tarvo-lake')?.active).toBe(false);
    expect((await call('POST', '/exceptions/syn-ex%3Atarvo-lake/active', { body: { active: true } })).status).toBe(200);
    expect(routeAudit().map((r) => [r.action, r.target?.ref])).toEqual(
      expect.arrayContaining([
        ['exception.update', 'syn-ex:tarvo-lake'],
        ['exception.toggle', 'syn-ex:tarvo-lake'],
      ]),
    );
  });

  it('a colon id that does not exist is 404, and an exception id is not a term id', async () => {
    const { call } = await world();
    expect((await call('PATCH', '/terms/syn:nope', { body: { note: 'x' } })).status).toBe(404);
    expect((await call('PATCH', '/terms/syn-ex:tarvo-lake', { body: { note: 'x' } })).status).toBe(404);
    expect((await call('PATCH', '/exceptions/syn:zorbak', { body: { note: 'x' } })).status).toBe(404);
  });

  it('"." ".." and all-dot ids are 404, however written', async () => {
    const { call, routeAudit } = await world();
    for (const id of ['.', '..', '...', '%2E', '%2E%2E']) {
      expect((await call('PATCH', `/terms/${id}`, { body: { note: 'x' } })).status, id).toBe(404);
      expect((await call('POST', `/terms/${id}/active`, { body: { active: true } })).status, id).toBe(404);
      expect((await call('PATCH', `/exceptions/${id}`, { body: { note: 'x' } })).status, id).toBe(404);
    }
    expect(routeAudit()).toEqual([]);
  });

  it('every other route still rejects ":" in its id', async () => {
    const { call } = await world();
    expect((await call('POST', '/sanctions/a:b/revoke', { body: { reason: 'x' } })).status).toBe(404);
    expect((await call('POST', '/gaps/a:b/close', { role: 'owner', body: { status: 'not_a_rule' } })).status).toBe(404);
    expect((await call('GET', '/reports/a:b')).status).toBe(404);
    expect((await call('GET', '/people/a:b/history')).status).toBe(404);
  });
});

describe('unroutable stored term ids are warned about once, at build time', () => {
  const stub = (ids: { terms: string[]; exceptions: string[] }): TermsAdmin => ({
    rows: {
      terms: ids.terms.map((id) => ({ id, term: 'secretword', language: 'en', active: true })),
      exceptions: ids.exceptions.map((id) => ({ id, phrase: 'secretphrase', language: 'en', active: true })),
    },
    check: () => ({ ok: true, hits: [] }),
    change: () => Promise.resolve({ ok: false, error: 'x' }),
  });
  const build = async (terms: TermsAdmin) => {
    const { cw } = await world();
    const logged: Array<[string, unknown]> = [];
    createRouter(adminRoutes(cw, { authorize: () => null, terms, logger: { warn: (e, d) => void logged.push([e, d]) } }));
    return logged;
  };

  it('warns with the count only, never an id or text', async () => {
    const bad = ['has space', 'a/b', 'x'.repeat(65), '..', 'é'];
    const logged = await build(stub({ terms: ['ok:id', ...bad.slice(0, 3)], exceptions: ['fine', ...bad.slice(3)] }));
    expect(logged).toEqual([['chatwarden.http_unroutable_term_ids', { count: 5 }]]);
    const text = JSON.stringify(logged);
    for (const s of [...bad, 'secretword', 'secretphrase']) expect(text).not.toContain(s);
  });

  it('is silent when every id routes (colon ids included), when the lists are empty, and for the real pack', async () => {
    expect(await build(stub({ terms: ['syn:zorbak', 'a.b', 'X_1-2'], exceptions: ['syn-ex:tarvo-lake'] }))).toEqual([]);
    expect(await build(stub({ terms: [], exceptions: [] }))).toEqual([]);
    const { cw, live } = await world();
    const logged: unknown[] = [];
    createRouter(adminRoutes(cw, { authorize: () => null, terms: live, logger: { warn: (e) => void logged.push(e) } }));
    expect(logged).toEqual([]);
  });
});

describe('a term write leaves exactly two audit rows: the editor row (no role) and the route row (with the role)', () => {
  /** The rows about one id, role-null (editor) first, reduced to what pins the pair. */
  const rowsFor = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    w
      .audit()
      .filter((r) => r.target?.ref === id)
      .map((r) => [r.action, r.role, r.actor] as const)
      .sort((a, b) => (a[1] === null ? -1 : b[1] === null ? 1 : 0));

  it('add: term.add from the editor (role null) and from the route (role set); exceptions the same', async () => {
    const w = await world();
    const t = ((await w.call('POST', '/terms', { actor: 'ann', role: 'senior', body: { term: 'glarn', language: 'en' } })).body as { id: string }).id;
    expect(rowsFor(w, t)).toEqual([
      ['term.add', null, 'ann'],
      ['term.add', 'senior', 'ann'],
    ]);
    const e = ((await w.call('POST', '/exceptions', { actor: 'ann', role: 'senior', body: { phrase: 'zorbak party', language: 'en' } })).body as { id: string }).id;
    expect(rowsFor(w, e)).toEqual([
      ['exception.add', null, 'ann'],
      ['exception.add', 'senior', 'ann'],
    ]);
  });

  it('update: term.update twice; toggle: term.toggle twice (the editor enable/disable reads back as term.toggle)', async () => {
    const w = await world();
    await w.call('PATCH', '/terms/syn:zorbak', { actor: 'bob', role: 'moderator', body: { note: 'n' } });
    expect(rowsFor(w, 'syn:zorbak')).toEqual([
      ['term.update', null, 'bob'],
      ['term.update', 'moderator', 'bob'],
    ]);
    await w.call('POST', '/terms/syn:snerp/active', { actor: 'bob', role: 'moderator', body: { active: false } });
    expect(rowsFor(w, 'syn:snerp')).toEqual([
      ['term.toggle', null, 'bob'],
      ['term.toggle', 'moderator', 'bob'],
    ]);
    await w.call('POST', '/exceptions/syn-ex:tarvo-lake/active', { actor: 'bob', role: 'moderator', body: { active: false } });
    expect(rowsFor(w, 'syn-ex:tarvo-lake')).toEqual([
      ['exception.toggle', null, 'bob'],
      ['exception.toggle', 'moderator', 'bob'],
    ]);
  });

  it('a no-op toggle leaves only the route row (the editor writes nothing)', async () => {
    const w = await world();
    await w.call('POST', '/terms/syn:snerp/active', { actor: 'bob', role: 'moderator', body: { active: true } });
    expect(rowsFor(w, 'syn:snerp')).toEqual([['term.toggle', 'moderator', 'bob']]);
  });

  it('a refused change leaves neither row', async () => {
    const w = await world();
    const before = w.audit().length;
    expect((await w.call('POST', '/terms', { body: { term: 'zorbak', language: 'en' } })).status).toBe(400);
    expect(w.audit()).toHaveLength(before);
  });
});
