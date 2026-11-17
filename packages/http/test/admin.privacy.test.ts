import { describe, expect, it } from 'vitest';
import type { KitResponse } from '../src/types.js';
import { errorOf, keysDeep, world } from './world.js';

// The privacy routes (design 5, 8): find, export, erase (with a dry run) and the statement. Owner-only IN CODE (a permission override cannot lower them), never on a
// player route, audited as the design says: find and the hold calls best-effort, export required (no audit, no export), erase by core after the commit.

type W = Awaited<ReturnType<typeof world>>;
const OWNER = { role: 'owner' as const, actor: 'owner_ann' };

/** A person with an account, a key and one report about them: what an erase and an export have something to say about. */
async function target(w: W) {
  const f = await w.file();
  await w.cw.flush();
  return f;
}
const exportPath = (ref: string) => `/people/${ref}/privacy/export`;
const erasePath = (ref: string) => `/people/${ref}/privacy/erase`;

describe('permission boundaries: owner only, in code', () => {
  it.each([
    ['POST /privacy/find', 'POST', () => '/privacy/find', { accountId: 'acct-x' }],
    ['GET export', 'GET', (r: string) => exportPath(r), undefined],
    ['POST erase', 'POST', (r: string) => erasePath(r), { keep: 'safety', confirm: 'x' }],
    ['GET /privacy/statement', 'GET', () => '/privacy/statement', undefined],
  ] as const)('%s: moderator and senior get 403, no caller 401, the owner passes the gate', async (_n, method, path, body) => {
    const w = await world();
    const f = await target(w);
    const p = path(f.target);
    for (const role of ['moderator', 'senior'] as const) {
      const res = await w.call(method, p, { role, ...(body === undefined ? {} : { body }) });
      expect(res.status, role).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
    }
    expect((await w.call(method, p, { role: null, ...(body === undefined ? {} : { body }) })).status).toBe(401);
    const owner = await w.call(method, p, { ...OWNER, ...(body === undefined ? {} : { body }) });
    expect([200, 400, 404]).toContain(owner.status);
    expect(owner.status).not.toBe(403);
  });

  it('the permissions option can lower every permission the routes sit behind and still cannot let a senior or a moderator in', async () => {
    const w = await world({ permissions: { 'policy.read': 'moderator', 'legal.hold': 'moderator', 'audit.read': 'moderator', settings: 'moderator', 'automation.write': 'moderator' } });
    const f = await target(w);
    for (const role of ['moderator', 'senior'] as const) {
      expect((await w.call('GET', exportPath(f.target), { role })).status).toBe(403);
      expect((await w.call('POST', erasePath(f.target), { role, body: { keep: 'none', confirm: f.target } })).status).toBe(403);
      expect((await w.call('POST', '/privacy/find', { role, body: { accountId: 'a' } })).status).toBe(403);
      expect((await w.call('GET', '/privacy/statement', { role })).status).toBe(403);
    }
  });

  it('an unknown permission key is refused at creation, naming the key', async () => {
    await expect(world({ permissions: { 'privacy.erase': 'moderator' } as never })).rejects.toThrow(/privacy\.erase/);
  });
});

describe('POST /privacy/find', () => {
  it('finds the person by account id: 200 { ref }; unknown: { ref: null }; audits privacy.find with no target and no account id', async () => {
    const w = await world();
    w.cw.rooms.seat('room-f', 'p1', { clientKey: 'raw-key-find-0001', accountId: 'acct-find-0001' }, 'Fin');
    await w.cw.flush();
    const subject = w.cw.rooms.subjectAt('room-f', 'p1') as string;
    const hit = await w.call('POST', '/privacy/find', { ...OWNER, body: { accountId: 'acct-find-0001' } });
    expect(hit).toMatchObject({ status: 200, body: { ref: subject } });
    expect(hit.headers?.['cache-control']).toBe('no-store');
    const miss = await w.call('POST', '/privacy/find', { ...OWNER, body: { accountId: 'acct-nobody' } });
    expect(miss).toMatchObject({ status: 200, body: { ref: null } });
    const rows = w.routeAudit().filter((r) => r.action === 'privacy.find');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ actor: 'owner_ann', role: 'owner' });
    expect(JSON.stringify(rows)).not.toContain('acct-find-0001');
    expect(rows.every((r) => r.target === undefined)).toBe(true);
  });

  it('creates no person for an unknown account id', async () => {
    const w = await world();
    const before = (await w.store.loadSubjects()).subjects.length;
    await w.call('POST', '/privacy/find', { ...OWNER, body: { accountId: 'acct-nobody-at-all' } });
    await w.cw.flush();
    expect((await w.store.loadSubjects()).subjects.length).toBe(before);
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['an account id that is not a string', { accountId: 7 }],
    ['an empty account id', { accountId: '' }],
    ['an account id over 128 characters', { accountId: 'a'.repeat(129) }],
    ['an extra key (an actor)', { accountId: 'x', actor: 'someone' }],
    ['a client key instead', { clientKey: 'x' }],
  ])('%s is 400 invalid_request', async (_n, body) => {
    const w = await world();
    const res = await w.call('POST', '/privacy/find', { ...OWNER, ...(body === undefined ? {} : { body }) });
    expect(res.status).toBe(400);
    expect(['invalid_request', 'invalid_json', 'forbidden_key']).toContain(errorOf(res));
  });

  it('is best-effort: a failing audit write is logged, never a failed lookup', async () => {
    const w = await world();
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    const res = await w.call('POST', '/privacy/find', { ...OWNER, body: { accountId: 'acct-x' } });
    expect(res.status).toBe(200);
    expect(w.logged.some(([e]) => e === 'chatwarden.http_audit_failed')).toBe(true);
  });
});

describe('GET /people/:ref/privacy/export', () => {
  it('is a JSON attachment, no-store, with the export of the person and an audit row privacy.export on the person', async () => {
    const w = await world();
    const f = await target(w);
    const res = await w.call('GET', exportPath(f.target), OWNER);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.json"$/);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const body = res.body as { format: string; person: { ref: string }; sections: Record<string, unknown> };
    expect(body.format).toBe('chatwarden.privacy-export');
    expect(body.person.ref).toBe(f.target);
    expect(Object.keys(body.sections)).toContain('reportsAbout');
    const rows = w.routeAudit().filter((r) => r.action === 'privacy.export');
    expect(rows).toEqual([expect.objectContaining({ actor: 'owner_ann', role: 'owner', target: { type: 'person', ref: f.target } })]);
  });

  it('holds no hash, key, address or other player\'s id', async () => {
    const w = await world();
    const f = await target(w);
    const text = JSON.stringify(res(await w.call('GET', exportPath(f.target), OWNER)));
    for (const bad of [f.key, '203.0.113.99', f.reporter, 'raw-client-key-reporter']) expect(text, bad).not.toContain(bad);
  });

  it('an unknown person is 404 not_found and leaves no audit row', async () => {
    const w = await world();
    const r = await w.call('GET', exportPath('s_nobody_at_all_000000'), OWNER);
    expect(r.status).toBe(404);
    expect(errorOf(r)).toBe('not_found');
    expect(w.routeAudit().filter((x) => x.action === 'privacy.export')).toEqual([]);
  });

  it('audit is REQUIRED: when the row cannot be written the request fails and sends nothing', async () => {
    const w = await world();
    const f = await target(w);
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    const r = await w.call('GET', exportPath(f.target), OWNER);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('chatwarden.privacy-export');
    expect(JSON.stringify(r.body)).not.toContain(f.target);
  });
});

describe('POST /people/:ref/privacy/erase', () => {
  it('confirm must equal the canonical ref: 400 confirm_mismatch, nothing erased, no audit', async () => {
    const w = await world();
    const f = await target(w);
    for (const confirm of ['', 'ERASE', f.target.toLowerCase().replace('s_', 'S_'), `${f.target}x`]) {
      const r = await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm } });
      expect(r.status, confirm).toBe(400);
      expect(errorOf(r)).toBe('confirm_mismatch');
    }
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).toContain(f.target);
    expect(w.routeAudit().filter((x) => x.action === 'privacy.erase')).toEqual([]);
  });

  it.each([
    ['a keep that is neither', { keep: 'some', confirm: 'REF' }],
    ['no keep', { confirm: 'REF' }],
    ['no confirm', { keep: 'none' }],
    ['a dryRun that is not a boolean', { keep: 'none', confirm: 'REF', dryRun: 'yes' }],
    ['an actor in the body', { keep: 'none', confirm: 'REF', actor: 'someone_else' }],
    ['any extra key', { keep: 'none', confirm: 'REF', note: 'x' }],
    ['a confirm that is not a string', { keep: 'none', confirm: 5 }],
  ])('%s is 400 invalid_request and erases nothing', async (_n, body) => {
    const w = await world();
    const f = await target(w);
    const r = await w.call('POST', erasePath(f.target), { ...OWNER, body: JSON.parse(JSON.stringify(body).replace('REF', f.target)) });
    expect(r.status).toBe(400);
    expect(errorOf(r)).toBe('invalid_request');
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).toContain(f.target);
  });

  it('an unknown person is 404 not_found (with a confirm that matches)', async () => {
    const w = await world();
    const ref = 's_nobody_at_all_0000000';
    const r = await w.call('POST', erasePath(ref), { ...OWNER, body: { keep: 'none', confirm: ref } });
    expect(r.status).toBe(404);
    expect(errorOf(r)).toBe('not_found');
  });

  it('dryRun returns the preview, writes nothing, audits nothing and moves no epoch', async () => {
    const w = await world();
    const f = await target(w);
    const before = w.store.erasureEpoch();
    const r = await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'safety', confirm: f.target, dryRun: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, mode: 'safety', removed: expect.any(Object), kept: { identifiers: false, sanctions: 0, heldReports: 0 } });
    expect(w.routeAudit().filter((x) => x.action === 'privacy.erase')).toEqual([]);
    expect(w.audit().filter((x) => x.action === 'privacy.erase')).toEqual([]);
    expect(w.store.erasureEpoch()).toBe(before);
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).toContain(f.target);
    expect(w.store.loadReport(f.id)).not.toBeNull();
  });

  it('erases: the body is the receipt only (no subject, line, handle, key or secret), and one privacy.erase row names the receipt', async () => {
    const w = await world();
    const f = await target(w);
    const r = await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm: f.target } });
    expect(r.status).toBe(200);
    const receipt = r.body as { id: string; at: number; mode: string; removed: Record<string, number>; kept: object };
    expect(Object.keys(receipt).sort()).toEqual(['at', 'id', 'kept', 'mode', 'removed']);
    expect(receipt.id).toMatch(/^e_/);
    expect(receipt.mode).toBe('none');
    expect(receipt.removed.subjects).toBe(1);
    const text = JSON.stringify(r.body);
    for (const bad of [f.target, f.reporter, f.key, 'a line from the target', 'TargetName', '203.0.113.99']) expect(text, bad).not.toContain(bad);
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).not.toContain(f.target);
    const rows = w.audit().filter((x) => x.action === 'privacy.erase');
    expect(rows).toEqual([expect.objectContaining({ actor: 'owner_ann', role: 'owner', target: { type: 'person', ref: receipt.id } })]);
    expect(w.routeAudit().filter((x) => x.action === 'privacy.erase').length).toBe(1);
  });

  it('erase audits after the commit and reports auditFailed; the erase stands', async () => {
    const w = await world();
    const f = await target(w);
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    const r = await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm: f.target } });
    expect(r.status).toBe(200);
    expect((r.body as { auditFailed?: boolean }).auditFailed).toBe(true);
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).not.toContain(f.target);
  });

  it('erasing the same person twice: the second is 404', async () => {
    const w = await world();
    const f = await target(w);
    expect((await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm: f.target } })).status).toBe(200);
    expect((await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm: f.target } })).status).toBe(404);
  });

  it('a held report about the person survives; the receipt says so', async () => {
    const w = await world();
    const f = await target(w);
    await w.cw.legal.hold(f.id, { code: 'legal_proceeding', actor: 'senior_gus' });
    const r = await w.call('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm: f.target } });
    expect((r.body as { kept: { heldReports: number } }).kept.heldReports).toBe(1);
    expect(w.store.loadReport(f.id)).not.toBeNull();
  });
});

describe('GET /privacy/statement', () => {
  it('lists every category with the live retention and the disclaimer; no audit row; no-store', async () => {
    const w = await world({ retention: { strikesMs: 7 * 86_400_000 } });
    const r = await w.call('GET', '/privacy/statement', OWNER);
    expect(r.status).toBe(200);
    const body = r.body as { categories: Array<{ category: string; retentionMs: number | null }>; disclaimer: string };
    expect(body.categories.find((c) => c.category === 'strikes')?.retentionMs).toBe(7 * 86_400_000);
    expect(body.categories.length).toBeGreaterThan(10);
    expect(body.disclaimer.toLowerCase()).toContain('not legal advice');
    expect(r.headers?.['cache-control']).toBe('no-store');
    expect(w.routeAudit().length).toBe(0);
  });
});

describe('the bodies and the errors hold no line, handle, hash, key or secret', () => {
  it('across every route and every refusal', async () => {
    const w = await world();
    const f = await target(w);
    const seen: KitResponse[] = [];
    const go = async (method: string, path: string, o: Parameters<W['call']>[2]) => void seen.push(await w.call(method, path, o));
    await go('POST', '/privacy/find', { ...OWNER, body: { accountId: 'nobody' } });
    await go('POST', erasePath(f.target), { ...OWNER, body: { keep: 'none', confirm: 'wrong' } });
    await go('POST', erasePath(f.target), { ...OWNER, body: { keep: 'bad', confirm: f.target } });
    await go('GET', exportPath('s_nobody_at_all_000000'), OWNER);
    await go('GET', '/privacy/statement', OWNER);
    await go('POST', erasePath(f.target), { role: 'moderator', body: { keep: 'none', confirm: f.target } });
    for (const r of seen) {
      const text = JSON.stringify(r.body);
      for (const bad of [f.key, '203.0.113.99', 'a line from the target', 'TargetName', 'admin-world-secret']) expect(text, bad).not.toContain(bad);
      expect(keysDeep(r.body).has('rawLine')).toBe(false);
    }
  });
});

/** The body of a response as a plain value (a helper that keeps the call sites short). */
const res = (r: KitResponse): unknown => r.body;
