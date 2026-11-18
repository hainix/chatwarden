import { describe, expect, it } from 'vitest';
import { verifyBundle } from '@chatwarden/core';
import type { EvidenceBundle, KitEvent } from '@chatwarden/core';
import { errorOf, world } from './world.js';

// The hold and bundle routes (design 6, 8): PUT /reports/:id/hold (`legal.hold`, a senior's, lowerable), DELETE /reports/:id/hold and GET /reports/:id/bundle (the
// owner's, fixed in code), and the `hold` key on the staff report body.

const OWNER = { role: 'owner' as const, actor: 'owner_ann' };
const SENIOR = { role: 'senior' as const, actor: 'senior_gus' };
const SECRET = 'route-bundle-secret-route-bundle-32';
const hold = (id: string) => `/reports/${id}/hold`;
const bundle = (id: string) => `/reports/${id}/bundle`;

describe('PUT /reports/:id/hold', () => {
  it('a senior may hold; a moderator gets 403; no caller 401', async () => {
    const w = await world();
    const f = await w.file();
    expect((await w.call('PUT', hold(f.id), { role: 'moderator', body: { code: 'other' } })).status).toBe(403);
    expect((await w.call('PUT', hold(f.id), { role: null, body: { code: 'other' } })).status).toBe(401);
    const ok = await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'legal_proceeding' } });
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });
    expect(ok.headers?.['cache-control']).toBe('no-store');
    expect(w.store.loadHold(f.id)).toMatchObject({ code: 'legal_proceeding', heldBy: 'senior_gus' });
  });

  it('the permissions option can lower legal.hold to a moderator or raise it to the owner; an unknown key is refused', async () => {
    const low = await world({ permissions: { 'legal.hold': 'moderator' } });
    const f1 = await low.file();
    expect((await low.call('PUT', hold(f1.id), { role: 'moderator', body: { code: 'other' } })).status).toBe(200);
    const high = await world({ permissions: { 'legal.hold': 'owner' } });
    const f2 = await high.file();
    expect((await high.call('PUT', hold(f2.id), { ...SENIOR, body: { code: 'other' } })).status).toBe(403);
    expect((await high.call('PUT', hold(f2.id), { ...OWNER, body: { code: 'other' } })).status).toBe(200);
    await expect(world({ permissions: { 'legal.release': 'moderator' } as never })).rejects.toThrow(/legal\.release/);
  });

  it('a second hold is 409 already_held; an unknown report is 404 not_found', async () => {
    const w = await world();
    const f = await w.file();
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'other' } });
    const again = await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'safety_review' } });
    expect(again.status).toBe(409);
    expect(errorOf(again)).toBe('already_held');
    expect(w.store.loadHold(f.id)?.code).toBe('other');
    const missing = await w.call('PUT', hold('r_nope'), { ...SENIOR, body: { code: 'other' } });
    expect(missing.status).toBe(404);
    expect(errorOf(missing)).toBe('not_found');
  });

  it.each([
    ['no body', undefined],
    ['no code', {}],
    ['a code that is free text', { code: 'because I said so' }],
    ['a code not on the list', { code: 'OTHER' }],
    ['a code that is not a string', { code: 3 }],
    ['an extra key (a note)', { code: 'other', note: 'text' }],
    ['an actor in the body', { code: 'other', actor: 'someone' }],
  ])('%s is 400 and writes nothing', async (_n, body) => {
    const w = await world();
    const f = await w.file();
    const r = await w.call('PUT', hold(f.id), { ...SENIOR, ...(body === undefined ? {} : { body }) });
    expect(r.status).toBe(400);
    expect(w.store.loadHold(f.id)).toBeNull();
  });

  it('audits legal.hold on the report, best-effort after the write: a failing audit leaves the hold and the 200', async () => {
    const w = await world();
    const f = await w.file();
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'other' } });
    expect(w.routeAudit().filter((r) => r.action === 'legal.hold')).toEqual([expect.objectContaining({ actor: 'senior_gus', role: 'senior', target: { type: 'report', ref: f.id } })]);
    const g = await w.file();
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    expect((await w.call('PUT', hold(g.id), { ...SENIOR, body: { code: 'other' } })).status).toBe(200);
    expect(w.store.loadHold(g.id)).not.toBeNull();
    expect(w.logged.some(([e]) => e === 'chatwarden.http_audit_failed')).toBe(true);
  });

  it('emits report.escalated once, with ids and the code only', async () => {
    const w = await world();
    const f = await w.file();
    const seen: KitEvent[] = [];
    w.cw.on('report.escalated', (e) => void seen.push(e));
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'platform_request' } });
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'platform_request' } });
    expect(seen).toEqual([{ type: 'report.escalated', reportId: f.id, at: w.clock.t, code: 'platform_request', target: f.target }]);
  });
});

describe('DELETE /reports/:id/hold', () => {
  it('is the owner\'s, fixed in code: a senior and a moderator get 403 whatever the permissions say', async () => {
    const w = await world({ permissions: { 'legal.hold': 'moderator', 'policy.read': 'moderator' } });
    const f = await w.file();
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'other' } });
    for (const role of ['moderator', 'senior'] as const) expect((await w.call('DELETE', hold(f.id), { role })).status).toBe(403);
    expect(w.store.loadHold(f.id)?.releasedAt).toBeNull();
    const r = await w.call('DELETE', hold(f.id), OWNER);
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(w.store.loadHold(f.id)).toMatchObject({ releasedBy: 'owner_ann' });
  });

  it('a report that is not held is 404 not_found; audits legal.release on the report, best-effort', async () => {
    const w = await world();
    const f = await w.file();
    expect((await w.call('DELETE', hold(f.id), OWNER)).status).toBe(404);
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'other' } });
    await w.call('DELETE', hold(f.id), OWNER);
    expect(w.routeAudit().filter((r) => r.action === 'legal.release')).toEqual([expect.objectContaining({ actor: 'owner_ann', role: 'owner', target: { type: 'report', ref: f.id } })]);
    const g = await w.file();
    await w.call('PUT', hold(g.id), { ...SENIOR, body: { code: 'other' } });
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    expect((await w.call('DELETE', hold(g.id), OWNER)).status).toBe(200);
    expect(w.store.loadHold(g.id)?.releasedAt).not.toBeNull();
  });
});

describe('GET /reports/:id/bundle', () => {
  it('is the owner\'s: moderator and senior get 403; the owner gets a JSON attachment, no-store, and an audit row legal.bundle', async () => {
    const w = await world({ bundleSecret: SECRET });
    const f = await w.file();
    for (const role of ['moderator', 'senior'] as const) expect((await w.call('GET', bundle(f.id), { role })).status).toBe(403);
    expect((await w.call('GET', bundle(f.id), { role: null })).status).toBe(401);
    const r = await w.call('GET', bundle(f.id), OWNER);
    expect(r.status).toBe(200);
    expect(r.headers?.['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.json"$/);
    expect(r.headers?.['cache-control']).toBe('no-store');
    const b = r.body as EvidenceBundle;
    expect(b.format).toBe('chatwarden.evidence-bundle');
    expect(b.report.id).toBe(f.id);
    expect(verifyBundle(b, SECRET)).toEqual({ sha256: true, hmac: true });
    expect(w.routeAudit().filter((x) => x.action === 'legal.bundle')).toEqual([expect.objectContaining({ actor: 'owner_ann', role: 'owner', target: { type: 'report', ref: f.id } })]);
  });

  it('accounts only with accounts=1', async () => {
    const w = await world();
    w.cw.rooms.seat('room-b', 'p1', { clientKey: 'raw-key-bundle-0001', accountId: 'acct-bundle-0001' }, 'Rep');
    w.cw.rooms.seat('room-b', 'p2', { clientKey: 'raw-key-bundle-0002', accountId: 'acct-bundle-0002' }, 'Tgt');
    w.cw.chat.accept('room-b', 'p2', 'a bundle line');
    const filed = await w.cw.reports.submit({ roomId: 'room-b', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!filed.ok) throw new Error('refused');
    const plain = JSON.stringify((await w.call('GET', bundle(filed.reportId), OWNER)).body);
    expect(plain).not.toContain('acct-bundle-000');
    const withAccounts = JSON.stringify((await w.call('GET', bundle(filed.reportId), { ...OWNER, query: { accounts: '1' } })).body);
    expect(withAccounts).toContain('acct-bundle-0001');
    expect(withAccounts).toContain('acct-bundle-0002');
    expect(withAccounts).not.toContain('raw-key-bundle');
    const other = JSON.stringify((await w.call('GET', bundle(filed.reportId), { ...OWNER, query: { accounts: '0' } })).body);
    expect(other).not.toContain('acct-bundle-000');
  });

  it('without a bundleSecret the bundle is unsigned', async () => {
    const w = await world();
    const f = await w.file();
    const b = (await w.call('GET', bundle(f.id), OWNER)).body as EvidenceBundle;
    expect(b.integrity.hmacSha256).toBeNull();
  });

  it('an unknown report is 404 and leaves no audit row', async () => {
    const w = await world();
    const r = await w.call('GET', bundle('r_nope'), OWNER);
    expect(r.status).toBe(404);
    expect(w.routeAudit().filter((x) => x.action === 'legal.bundle')).toEqual([]);
  });

  it('audit is REQUIRED: a failing audit write fails the request and sends no bundle', async () => {
    const w = await world();
    const f = await w.file();
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    const r = await w.call('GET', bundle(f.id), OWNER);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('chatwarden.evidence-bundle');
  });
});

describe('GET /reports/:id carries hold only for a held report', () => {
  it('a held report has hold { code, at } for a caller with reports.read; every other body is unchanged', async () => {
    const w = await world();
    const f = await w.file();
    const read = async () => ((await w.call('GET', `/reports/${f.id}`, { role: 'moderator' })).body as { report: Record<string, unknown> }).report;
    const plain = await read();
    expect('hold' in plain).toBe(false);
    await w.call('PUT', hold(f.id), { ...SENIOR, body: { code: 'law_enforcement_request' } });
    const held = await read();
    expect(held.hold).toEqual({ code: 'law_enforcement_request', at: w.clock.t });
    const rest = { ...held };
    delete rest.hold;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(plain).sort());
    // who held it is not shown
    expect(JSON.stringify(held)).not.toContain('senior_gus');
    await w.call('DELETE', hold(f.id), OWNER);
    expect('hold' in (await read())).toBe(false);
  });

  it('GET /me lists legal.hold in can for a senior and not for a moderator, and carries the role', async () => {
    const w = await world();
    const mod = (await w.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean>; role: string };
    const sen = (await w.call('GET', '/me', SENIOR)).body as { can: Record<string, boolean>; role: string };
    expect(mod.can['legal.hold']).toBe(false);
    expect(sen.can['legal.hold']).toBe(true);
    expect(sen.role).toBe('senior');
  });
});
