import { describe, expect, it } from 'vitest';
import { errorOf, keysDeep, world } from './world.js';

// R4: GET /people/:ref/links, counts only: how many accounts and devices the kit has linked to a person, how many subjects were merged into them and how many sanctions in force sit on a merged alias.
// history.read, audited history.view on the person; 404 for a ref the kit does not hold; never an id, a key, a hash or an address.

type W = Awaited<ReturnType<typeof world>>;

/** A person with 2 accounts, 1 key and 1 merged alias (a ban was placed on the alias before the merge). */
async function linked(w: W) {
  w.cw.rooms.seat('L1', 'p1', { clientKey: 'links-http-key-aaaaaaaaaaaa', accountId: 'links-http-acct-1', ip: '203.0.113.9' }, 'One');
  const root = w.cw.rooms.subjectAt('L1', 'p1') as string;
  // the older subject survives a merge (a tie goes to the smaller id): let the clock tick so the first one is the older
  w.clock.t += 1000;
  w.cw.rooms.seat('L2', 'p1', { accountId: 'links-http-acct-2', ip: '203.0.113.10' }, 'Two');
  const alias = w.cw.rooms.subjectAt('L2', 'p1') as string;
  await w.cw.sanctions.apply({ kind: 'ban', subject: alias, includeIp: false, durationMs: null, reason: 'PRIVATE-REASON', actor: 'ann', source: 'moderator', automated: false, rule: 2 });
  w.cw.rooms.seat('L3', 'p1', { clientKey: 'links-http-key-aaaaaaaaaaaa', accountId: 'links-http-acct-2' }, 'Both');
  return { person: w.cw.rooms.subjectAt('L3', 'p1') as string, root, alias };
}

describe('GET /people/:ref/links', () => {
  it('answers counts only for a linked person, no-store', async () => {
    const w = await world();
    const { person } = await linked(w);
    const res = await w.call('GET', `/people/${person}/links`);
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ accounts: 2, devices: 1, merged: 1, inForceOnLinked: { ban: 1, area: 0, chat: 0 } });
  });

  it('a merged alias asked by its own ref gives the person\'s answer', async () => {
    const w = await world();
    const { alias, root } = await linked(w);
    expect((await w.call('GET', `/people/${alias}/links`)).body).toEqual((await w.call('GET', `/people/${root}/links`)).body);
  });

  it('needs history.read: a moderator by default, raised by the permissions option; 401 without authz', async () => {
    const w = await world({ permissions: { 'history.read': 'senior' } });
    const { person } = await linked(w);
    expect((await w.call('GET', `/people/${person}/links`, { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', `/people/${person}/links`, { role: 'senior' })).status).toBe(200);
    expect((await w.call('GET', `/people/${person}/links`, { role: null })).status).toBe(401);
    const d = await world();
    const l = await linked(d);
    expect((await d.call('GET', `/people/${l.person}/links`, { role: 'moderator' })).status).toBe(200);
  });

  it('audits history.view on the person, required: a failing audit write fails the read', async () => {
    const w = await world();
    const { person } = await linked(w);
    await w.call('GET', `/people/${person}/links`, { actor: 'mod_ann' });
    expect(w.routeAudit().filter((r) => r.action === 'history.view')).toEqual([
      expect.objectContaining({ actor: 'mod_ann', role: 'moderator', target: { type: 'person', ref: person } }),
    ]);
    const orig = w.cw.audit.record.bind(w.cw.audit);
    w.cw.audit.record = () => {
      throw new Error('audit down');
    };
    const res = await w.call('GET', `/people/${person}/links`);
    w.cw.audit.record = orig;
    expect(res.status).toBe(500);
  });

  it('counts only (key scan): no ids, keys, hashes or ips, and no string values', async () => {
    const w = await world();
    const { person, alias, root } = await linked(w);
    const res = await w.call('GET', `/people/${person}/links`);
    const text = JSON.stringify(res.body);
    for (const needle of ['links-http', person, alias, root, '203.0.113', 'PRIVATE-REASON', 'ann']) expect(text, needle).not.toContain(needle);
    expect([...keysDeep(res.body)].sort()).toEqual(['accounts', 'area', 'ban', 'chat', 'devices', 'inForceOnLinked', 'merged']);
    const strings: unknown[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk(res.body);
    expect(strings).toEqual([]);
  });

  it('404 not_found for a ref the kit does not hold, with the body of any unknown route', async () => {
    const w = await world();
    const res = await w.call('GET', '/people/s_nobody_here/links');
    expect([res.status, errorOf(res)]).toEqual([404, 'not_found']);
    expect(res.body).toEqual((await w.call('GET', '/people/s_nobody_here/does-not-exist')).body);
    expect(w.routeAudit().filter((r) => r.action === 'history.view')).toEqual([]);
  });

  it('a person with one key and nothing else is a 200 with devices 1', async () => {
    const w = await world();
    w.cw.rooms.seat('S1', 'p1', { clientKey: 'links-solo-key-aaaaaaaaaaa' }, 'Solo');
    const subject = w.cw.rooms.subjectAt('S1', 'p1') as string;
    expect((await w.call('GET', `/people/${subject}/links`)).body).toEqual({ accounts: 0, devices: 1, merged: 0, inForceOnLinked: { ban: 0, area: 0, chat: 0 } });
  });

  it('reads change nothing: the link counts are the same before and after', async () => {
    const w = await world();
    const { person } = await linked(w);
    const a = await w.call('GET', `/people/${person}/links`);
    const b = await w.call('GET', `/people/${person}/links`);
    expect(a.body).toEqual(b.body);
  });
});
