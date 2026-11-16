import { describe, expect, it } from 'vitest';
import { COMMUNITY_WORDS, OWN_WORD, communityPack, communityWorld } from './communityWorld.js';

// "Report a problem with this community term" (design 10.6, 14): a staff member with terms.write sends a term id and a closed kind. No
// word, no text. The audit row is `term.share` on the term id (the core names are exactly three: nothing is added for a report).
// Invented words only.

const text = (v: unknown): string => JSON.stringify(v);
type W = Awaited<ReturnType<typeof communityWorld>>;
const idOf = (w: W, word: string): string => w.rowByWord(word)?.id as string;
const audits = (w: W) => w.routeAudit().filter((r) => r.action === 'term.share');

describe('POST /terms/:id/report', () => {
  it('needs terms.write: below it is 403, without a caller 401, and nothing is sent', async () => {
    const w = await communityWorld({ permissions: { 'terms.write': 'senior' } });
    const id = idOf(w, 'glarn');
    expect((await w.call('POST', `/terms/${id}/report`, { body: { kind: 'removal' }, role: 'moderator' })).status).toBe(403);
    expect((await w.call('POST', `/terms/${id}/report`, { body: { kind: 'removal' }, role: null })).status).toBe(401);
    expect(w.share.reportCalls).toEqual([]);
    expect(audits(w)).toEqual([]);
  });

  it('sends the term id and the kind only, answers { status } only, and the audit row holds the term id and never the word', async () => {
    const w = await communityWorld();
    const id = idOf(w, 'glarn');
    const res = await w.call('POST', `/terms/${id}/report`, { body: { kind: 'innocent_sense' }, actor: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });
    expect(w.share.reportCalls).toEqual([{ termId: id, kind: 'innocent_sense' }]);
    expect(w.share.calls).toEqual([]);
    const rows = audits(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'ann', role: 'moderator', action: 'term.share', target: { type: 'term', ref: id } });
    expect(rows[0]?.detail).toBeUndefined();
    expect(Object.keys(rows[0] as object).sort()).toEqual(['action', 'actor', 'at', 'id', 'role', 'target']);
    expect(text(w.audit())).not.toMatch(/glarn|innocent_sense/);
    expect(text(res)).not.toContain('rep_abc123');
    expect(text(w.logged)).not.toContain('glarn');
  });

  it.each(['innocent_sense', 'wrong_category', 'removal'])('%s is a kind', async (kind) => {
    const w = await communityWorld();
    expect((await w.call('POST', `/terms/${idOf(w, 'tarvox')}/report`, { body: { kind } })).status).toBe(200);
    expect(w.share.reportCalls[0]?.kind).toBe(kind);
  });

  it('works for a community row a person has since touched (switched off), and for one the corpus itself changed', async () => {
    const w = await communityWorld();
    const id = idOf(w, 'glarn');
    expect((await w.call('POST', `/terms/${id}/active`, { body: { active: false } })).status).toBe(200);
    expect((await w.call('POST', `/terms/${id}/report`, { body: { kind: 'removal' } })).status).toBe(200);
    expect(w.live.syncPack(communityPack('2027.01.0', { active: { tarvox: false } }), { actor: 'corpus:2027.01.0' }).ok).toBe(true);
    expect((await w.call('POST', `/terms/${idOf(w, 'tarvox')}/report`, { body: { kind: 'removal' } })).status).toBe(200);
    expect(w.share.reportCalls).toHaveLength(2);
  });

  it("the adopter's own row cannot be reported (409 not_reportable): it is not on the list; nothing is sent or audited", async () => {
    const w = await communityWorld();
    const res = await w.call('POST', `/terms/${w.own.id}/report`, { body: { kind: 'removal' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_reportable' });
    expect(text(res)).not.toContain(OWN_WORD);
    expect(w.share.reportCalls).toEqual([]);
    expect(audits(w)).toEqual([]);
  });

  it('is 404 for an unknown id, an id outside the charset and an exception id', async () => {
    const w = await communityWorld();
    for (const id of ['CWT-2026-99999', w.live.rows.exceptions[0]?.id as string]) {
      expect((await w.call('POST', `/terms/${id}/report`, { body: { kind: 'removal' } })).status, id).toBe(404);
    }
    expect((await w.call('POST', '/terms/a%20b/report', { body: { kind: 'removal' } })).status).toBe(404);
    expect(w.share.reportCalls).toEqual([]);
  });

  it('the route is absent without a share object, and without a share object that can report', async () => {
    const off = await communityWorld({ share: false });
    expect((await off.call('POST', `/terms/${idOf(off, 'glarn')}/report`, { body: { kind: 'removal' } })).status).toBe(404);
    expect(Object.keys(off.routes).filter((k) => /terms.*report/.test(k))).toEqual([]);
    const old = await communityWorld({ report: false });
    expect((await old.call('POST', `/terms/${idOf(old, 'glarn')}/report`, { body: { kind: 'removal' } })).status).toBe(404);
    expect(Object.keys(old.routes).filter((k) => /terms.*report/.test(k))).toEqual([]);
    // Sharing still works on that world.
    expect((await old.call('POST', `/terms/${old.own.id}/share`, { body: { category: 'abuse' } })).status).toBe(200);
  });

  it('the body is validated: only { kind } with a kind from the closed list (400, nothing sent, nothing echoed)', async () => {
    const w = await communityWorld();
    const id = idOf(w, 'glarn');
    const bad: unknown[] = [
      {},
      { kind: 'spam' },
      { kind: 5 },
      { kind: null },
      { kind: ['removal'] },
      { kind: 'REMOVAL' },
      { kind: 'removal', note: 'a friend name' },
      { kind: 'removal', term: 'glarn' },
      { kind: 'removal', termId: 'CWT-2026-00002' },
      { kind: 'removal', category: 'abuse' },
      { note: 'free text' },
      [],
      'removal',
      null,
    ];
    for (const body of bad) {
      const res = await w.call('POST', `/terms/${id}/report`, { body });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(text(res.body)).not.toMatch(/friend|free text|glarn|spam/);
    }
    expect(w.share.reportCalls).toEqual([]);
    expect(audits(w)).toEqual([]);
  });

  it("a failed report is a fixed error code and never the service's text; no audit row", async () => {
    const w = await communityWorld();
    const id = idOf(w, 'glarn');
    const secret = 'service said: ip 203.0.113.9 key CLIENTKEY-secret';
    const table: Array<[unknown, number, string]> = [
      [{ ok: false, code: 'offline', message: secret }, 502, 'share_unavailable'],
      [{ ok: false, code: 'rate_limited', retryAfterMs: 5000, message: secret }, 429, 'rate_limited'],
      [{ ok: false, code: 'rejected', message: secret }, 422, 'share_refused'],
      [{ ok: false, code: 'invalid', message: secret }, 400, 'invalid_request'],
      [{ ok: false, code: 'something-new', message: secret }, 502, 'share_unavailable'],
      [null, 502, 'share_unavailable'],
      ['text', 502, 'share_unavailable'],
      [{ ok: 'yes' }, 502, 'share_unavailable'],
    ];
    for (const [result, status, code] of table) {
      w.share.reportResult = result;
      const res = await w.call('POST', `/terms/${id}/report`, { body: { kind: 'removal' } });
      expect({ result, status: res.status, error: (res.body as { error: string }).error }).toEqual({ result, status, error: code });
      expect(text(res)).not.toMatch(/service said|203\.0\.113|CLIENTKEY/);
    }
    expect(audits(w)).toEqual([]);
    // An acknowledgement the service dressed up is still only { status }.
    w.share.reportResult = { ok: true, id: '<script>', message: secret };
    const ok = await w.call('POST', `/terms/${id}/report`, { body: { kind: 'removal' } });
    expect(ok.body).toEqual({ status: 'received' });
    expect(text(ok)).not.toMatch(/service said|script/);
    expect(audits(w)).toHaveLength(1);
  });

  it('a throwing share object is a 502 with a fixed message, and the log never holds the word or the message', async () => {
    const w = await communityWorld();
    w.share.throws = true;
    const res = await w.call('POST', `/terms/${idOf(w, 'glarn')}/report`, { body: { kind: 'removal' } });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'share_unavailable' });
    expect(text(res)).not.toContain('exploded');
    expect(text(w.logged)).not.toMatch(/glarn|exploded/);
    expect(audits(w)).toEqual([]);
  });

  it('sends no identifier: the call holds the two keys and nothing else, whatever the request carried', async () => {
    const w = await communityWorld();
    await w.call('POST', `/terms/${idOf(w, 'glarn')}/report`, { body: { kind: 'removal' }, actor: 'ann' });
    expect(Object.keys(w.share.reportCalls[0] as object)).toEqual(['termId', 'kind']);
    expect(text(w.share.reportCalls)).not.toMatch(/ann|moderator|glarn/);
    expect(COMMUNITY_WORDS).toContain('glarn');
  });
});

describe('GET /community says whether reports can be sent', () => {
  it('reporting is true only when the share object can report', async () => {
    const get = async (o: Parameters<typeof communityWorld>[0]) => (await (await communityWorld(o)).call('GET', '/community')).body as { sharing: boolean; reporting: boolean };
    expect(await get({})).toMatchObject({ sharing: true, reporting: true });
    expect(await get({ report: false })).toMatchObject({ sharing: true, reporting: false });
    expect(await get({ share: false })).toMatchObject({ sharing: false, reporting: false });
  });
});
