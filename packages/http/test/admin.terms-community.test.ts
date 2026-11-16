import { describe, expect, it } from 'vitest';
import { COMMUNITY_ACTOR, COMMUNITY_WORDS, OWN_WORD, communityPack, communityWorld } from './communityWorld.js';
import { world } from './world.js';

// The term routes when the shared list is wired (design 8.5, Review Focus 4 and 5): untouched community rows are hidden from the list,
// one is reachable by id or by exact word, one of the adopter's own can be shared, and nothing carries a word where it must not.
// Invented words only.

interface Row {
  id: string;
  term: string;
  language: string;
  active: boolean;
  addedBy: string | null;
  updatedBy: string | null;
  community?: boolean;
  blocks30d?: number;
}
interface List {
  terms: Row[];
  exceptions: Array<{ id: string; phrase: string }>;
  blocks30d: Record<string, number>;
  community?: { hidden: number };
}
const text = (v: unknown): string => JSON.stringify(v);
const idOf = (w: Awaited<ReturnType<typeof communityWorld>>, word: string): string => w.rowByWord(word)?.id as string;
const audits = (w: Awaited<ReturnType<typeof communityWorld>>) => w.routeAudit().filter((r) => r.action === 'term.share');

describe('GET /terms with the shared list wired', () => {
  it('lists the adopter\'s rows, omits untouched community rows and reports community.hidden (terms and exceptions together)', async () => {
    const w = await communityWorld();
    const res = await w.call('GET', '/terms');
    const body = res.body as List;
    const words = body.terms.map((t) => t.term);
    expect(words).toEqual(expect.arrayContaining(['zorbak', 'vlemmo', 'snerp']));
    for (const hidden of COMMUNITY_WORDS) expect(words).not.toContain(hidden);
    expect(body.exceptions.map((e) => e.phrase)).not.toContain('glarn lake');
    expect(body.community).toEqual({ hidden: 4 });
    expect(text(body.blocks30d)).not.toContain('CWT-2026');
    expect(Object.keys(body).sort()).toEqual(['blocks30d', 'community', 'exceptions', 'terms']);
  });

  it('a community row a person touched is the adopter\'s: it is listed, and no longer counted as hidden', async () => {
    const w = await communityWorld();
    expect((await w.call('POST', `/terms/${idOf(w, 'glarn')}/active`, { body: { active: false }, actor: 'ann' })).status).toBe(200);
    const body = (await w.call('GET', '/terms')).body as List;
    const glarn = body.terms.find((t) => t.term === 'glarn');
    expect(glarn).toMatchObject({ active: false, addedBy: COMMUNITY_ACTOR, updatedBy: 'ann' });
    expect(body.terms.map((t) => t.term)).not.toContain('tarvox');
    expect(body.community).toEqual({ hidden: 3 });
    expect(Object.hasOwn(body.blocks30d, glarn?.id as string)).toBe(true);
  });

  it('a row the corpus itself changed (a later release deactivated it) is still hidden; a human renaming one lists it', async () => {
    const w = await communityWorld();
    const next = communityPack('2027.01.0', { active: { tarvox: false } });
    expect(w.live.syncPack(next, { actor: 'corpus:2027.01.0' }).ok).toBe(true);
    expect(w.rowByWord('tarvox')).toMatchObject({ active: false, updatedBy: 'corpus:2027.01.0' });
    let body = (await w.call('GET', '/terms')).body as List;
    expect(body.terms.map((t) => t.term)).not.toContain('tarvox');
    expect(body.community?.hidden).toBe(4);
    expect((await w.call('PATCH', `/terms/${idOf(w, 'tarvox')}`, { body: { note: 'seen in play' }, actor: 'ann' })).status).toBe(200);
    body = (await w.call('GET', '/terms')).body as List;
    expect(body.terms.map((t) => t.term)).toContain('tarvox');
    expect(body.community?.hidden).toBe(3);
  });

  it('exposeCommunityRows lists them all, still reports the field, and the existing keys are unchanged', async () => {
    const w = await communityWorld({ exposeCommunityRows: true });
    const body = (await w.call('GET', '/terms')).body as List;
    expect(body.terms.map((t) => t.term)).toEqual(expect.arrayContaining([...COMMUNITY_WORDS, 'zorbak']));
    expect(body.exceptions.map((e) => e.phrase)).toContain('glarn lake');
    expect(body.community).toEqual({ hidden: 0 });
    for (const t of body.terms) expect(Object.hasOwn(body.blocks30d, t.id)).toBe(true);
  });

  it('a list with only the adopter\'s own rows reports hidden 0', async () => {
    const w = await communityWorld({ seedCorpus: false });
    expect(((await w.call('GET', '/terms')).body as List).community).toEqual({ hidden: 0 });
  });

  it('editing a hidden row by id still works (the handoff): it becomes a touched row', async () => {
    const w = await communityWorld();
    const id = idOf(w, 'quisselo');
    expect((await w.call('PATCH', `/terms/${id}`, { body: { note: 'ours now' } })).status).toBe(200);
    expect(((await w.call('GET', '/terms')).body as List).terms.map((t) => t.term)).toContain('quisselo');
  });
});

describe('routes are absent when community is not passed, and the term routes are unchanged', () => {
  it('the four new routes are 404, the route table has none of them, and GET /terms has the same keys and no community field', async () => {
    const w = await world();
    const id = w.live.rows.terms[0]?.id as string;
    // The path of a term row exists for PATCH, so GET and POST answer 405 there; the point is that nothing answers 200.
    expect([404, 405]).toContain((await w.call('GET', `/terms/${id}`)).status);
    expect([404, 405]).toContain((await w.call('POST', '/terms/lookup', { body: { word: 'zorbak' } })).status);
    expect((await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } })).status).toBe(404);
    expect((await w.call('GET', `/terms/${id}/share`)).status).toBe(404);
    expect(Object.keys(w.routes).filter((k) => /lookup|share|community/.test(k))).toEqual([]);
    expect(Object.keys(w.routes).filter((k) => /^GET \/terms\/:id/.test(k))).toEqual([]);
    const body = (await w.call('GET', '/terms')).body as List;
    expect(Object.keys(body).sort()).toEqual(['blocks30d', 'exceptions', 'terms']);
  });

  it('the same world with and without community answers the existing term routes the same way (byte for byte, apart from the community field)', async () => {
    const plain = await world();
    const wired = await communityWorld({ seedCorpus: false });
    // Both have the same one row of their own; its id is random, so it is masked.
    const plainId = (plain.live.changeSync('seed-admin', (e) => e.addTerm({ term: OWN_WORD, language: 'en' })) as { value: string }).value;
    const mask = (v: unknown, id: string): string => text(v).replaceAll(id, 'OWN');
    const a = (await plain.call('GET', '/terms')).body as List;
    const b = (await wired.call('GET', '/terms')).body as List;
    const { community, ...rest } = b;
    expect(community).toEqual({ hidden: 0 });
    expect(mask(rest, wired.own.id)).toBe(mask(a, plainId));
    for (const [method, path, body] of [
      ['POST', '/terms/check', { term: 'glarn', language: 'en' }],
      ['POST', '/terms/test', { text: 'you zorbak' }],
      ['POST', '/terms', { term: 'glarn', language: 'en' }],
    ] as const) {
      const x = await plain.call(method, path, { body });
      const y = await wired.call(method, path, { body });
      expect({ path, status: y.status, body: text(y.body).replace(/"id":"[^"]*"/, '"id":"X"') }).toEqual({ path, status: x.status, body: text(x.body).replace(/"id":"[^"]*"/, '"id":"X"') });
    }
  });
});

describe('GET /terms/:id', () => {
  it('returns a hidden row, with who and when, whether the community added it, and its blocked count', async () => {
    const w = await communityWorld();
    const id = idOf(w, 'glarn');
    const res = await w.call('GET', `/terms/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      term: 'glarn',
      language: 'en',
      active: true,
      note: null,
      addedBy: COMMUNITY_ACTOR,
      addedAt: expect.any(Number),
      updatedBy: null,
      updatedAt: null,
      community: true,
      blocks30d: 0,
    });
    expect(w.routeAudit()).toEqual([]);
  });

  it('an adopter row reads community false; an unknown id, an id outside the charset and a stored exception id are 404', async () => {
    const w = await communityWorld();
    const own = w.live.rows.terms.find((t) => t.term === 'zorbak');
    expect(((await w.call('GET', `/terms/${own?.id}`)).body as Row).community).toBe(false);
    for (const id of ['CWT-2026-99999', 'nope', '..', 'a%2Fb']) expect((await w.call('GET', `/terms/${id}`)).status, id).toBe(404);
    const exceptionId = w.live.rows.exceptions[0]?.id as string;
    expect((await w.call('GET', `/terms/${exceptionId}`)).status).toBe(404);
  });

  it('needs terms.read, can be raised, and 401s without a caller', async () => {
    const w = await communityWorld({ permissions: { 'terms.read': 'senior' } });
    const id = idOf(w, 'glarn');
    expect((await w.call('GET', `/terms/${id}`, { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', `/terms/${id}`, { role: 'senior' })).status).toBe(200);
    expect((await w.call('GET', `/terms/${id}`, { role: null })).status).toBe(401);
  });
});

describe('POST /terms/lookup', () => {
  it('finds an exact word, folded (case, accents, spaces), and the word is only ever in the body', async () => {
    const w = await communityWorld();
    for (const word of ['glarn', 'GLARN', '  Glarn ', `gl${String.fromCharCode(0xe1)}rn`]) {
      const res = await w.call('POST', '/terms/lookup', { body: { word } });
      expect(res.status, word).toBe(200);
      expect(res.body).toMatchObject({ id: idOf(w, 'glarn'), term: 'glarn', community: true, addedBy: COMMUNITY_ACTOR });
    }
    // The adopter's own word is found too, and says it is theirs.
    expect((await w.call('POST', '/terms/lookup', { body: { word: 'zorbak' } })).body).toMatchObject({ term: 'zorbak', community: false });
    expect(w.routeAudit()).toEqual([]);
    // Nothing about the word is in a URL: the route has no param.
    expect(Object.keys(w.routes).filter((k) => /lookup/.test(k))).toEqual(['POST /terms/lookup']);
  });

  it('is 404 for a miss, a part of a word, a different word and a near match', async () => {
    const w = await communityWorld();
    for (const word of ['glar', 'glarns', 'glarn lake', 'tarv', 'nothing']) {
      const res = await w.call('POST', '/terms/lookup', { body: { word } });
      expect(res.status, word).toBe(404);
      expect(text(res.body)).not.toContain(word);
    }
  });

  it('refuses a missing, empty, non-string or oversize word, and any other body shape (400, nothing echoed)', async () => {
    const w = await communityWorld();
    for (const body of [{}, { word: '' }, { word: '   ' }, { word: 5 }, { word: null }, { word: 'x'.repeat(201) }, { word: 'glarn', extra: 1 }, [], 'glarn']) {
      const res = await w.call('POST', '/terms/lookup', { body });
      expect(res.status, text(body)).toBe(400);
      expect(text(res.body)).not.toContain('glarn');
    }
    expect((await w.call('POST', '/terms/lookup', { raw: '{"word":' })).status).toBe(400);
  });

  it('needs terms.read and 401s without a caller', async () => {
    const w = await communityWorld({ permissions: { 'terms.read': 'owner' } });
    expect((await w.call('POST', '/terms/lookup', { body: { word: 'glarn' }, role: 'senior' })).status).toBe(403);
    expect((await w.call('POST', '/terms/lookup', { body: { word: 'glarn' }, role: null })).status).toBe(401);
  });
});

describe('POST /terms/:id/share', () => {
  const ownId = (w: Awaited<ReturnType<typeof communityWorld>>): string => w.own.id;

  it('needs terms.write: below it is 403, and nothing is sent', async () => {
    const w = await communityWorld({ permissions: { 'terms.write': 'senior' } });
    expect((await w.call('POST', `/terms/${ownId(w)}/share`, { body: { category: 'abuse' }, role: 'moderator' })).status).toBe(403);
    expect((await w.call('POST', `/terms/${ownId(w)}/share`, { body: { category: 'abuse' }, role: null })).status).toBe(401);
    expect(w.share.calls).toEqual([]);
  });

  it('sends one term with the closed list of keys, answers { status } only, and the audit row holds the term id and never the word', async () => {
    const w = await communityWorld();
    const id = ownId(w);
    const res = await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse', note: 'used against newcomers' }, actor: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });
    expect(w.share.calls).toEqual([{ term: OWN_WORD, language: 'en', category: 'abuse', note: 'used against newcomers' }]);
    const rows = w.routeAudit().filter((r) => r.action === 'term.share');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'ann', role: 'moderator', action: 'term.share', target: { type: 'term', ref: id } });
    expect(rows[0]?.detail).toBeUndefined();
    expect(Object.keys(rows[0] as object).sort()).toEqual(['action', 'actor', 'at', 'id', 'role', 'target']);
    expect(text(w.audit())).not.toContain(OWN_WORD);
    expect(text(rows)).not.toContain('used against');
    expect(text(res)).not.toContain('sub_abc123');
  });

  it('a slur needs a target (never none); a target and no note are sent as given; known and duplicate are answered as they are', async () => {
    const w = await communityWorld();
    const id = ownId(w);
    expect((await w.call('POST', `/terms/${id}/share`, { body: { category: 'slur', target: 'religion' } })).status).toBe(200);
    expect(w.share.calls[0]).toEqual({ term: OWN_WORD, language: 'en', category: 'slur', target: 'religion' });
    w.share.result = { ok: true, status: 'known', termId: 'CWT-2026-00001' };
    expect((await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } })).body).toEqual({ status: 'known' });
    w.share.result = { ok: true, status: 'duplicate' };
    expect((await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse', note: null } })).body).toEqual({ status: 'duplicate' });
    expect(w.share.calls[2]).toEqual({ term: OWN_WORD, language: 'en', category: 'abuse', note: null });
  });

  it('a community row cannot be shared (409), touched or not, and nothing is sent or audited', async () => {
    const w = await communityWorld();
    const glarn = idOf(w, 'glarn');
    expect((await w.call('POST', `/terms/${glarn}/share`, { body: { category: 'abuse' } })).status).toBe(409);
    expect((await w.call('POST', `/terms/${glarn}/active`, { body: { active: false } })).status).toBe(200);
    const res = await w.call('POST', `/terms/${glarn}/share`, { body: { category: 'abuse' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_shareable' });
    expect(w.share.calls).toEqual([]);
    expect(w.routeAudit().filter((r) => r.action === 'term.share')).toEqual([]);
  });

  it('is 404 for an unknown id or an exception id, and the route is absent without a share object', async () => {
    const w = await communityWorld();
    expect((await w.call('POST', '/terms/CWT-2026-99999/share', { body: { category: 'abuse' } })).status).toBe(404);
    expect((await w.call('POST', `/terms/${w.live.rows.exceptions[0]?.id}/share`, { body: { category: 'abuse' } })).status).toBe(404);
    const off = await communityWorld({ share: false });
    expect((await off.call('POST', `/terms/${ownId(off)}/share`, { body: { category: 'abuse' } })).status).toBe(404);
    expect((await off.call('GET', `/terms/${ownId(off)}/share`)).status).toBe(404);
    expect(Object.keys(off.routes).filter((k) => /share/.test(k))).toEqual([]);
  });

  it('the body is validated: category, target for slurs, note rules, unknown keys, shape (400, nothing sent, nothing echoed)', async () => {
    const w = await communityWorld();
    const id = ownId(w);
    const bad: unknown[] = [
      {},
      { category: 'other-thing' },
      { category: 5 },
      { category: 'slur' },
      { category: 'slur', target: 'none' },
      { category: 'slur', target: 'planet' },
      { category: 'abuse', target: 5 },
      { category: 'abuse', target: 'planet' },
      { category: 'abuse', note: 5 },
      { category: 'abuse', note: 'n'.repeat(201) },
      { category: 'abuse', note: 'see https://example.test/page' },
      { category: 'abuse', note: 'see www.example.test' },
      { category: 'abuse', note: 'mail me @someone' },
      { category: 'abuse', note: 'call 555123456' },
      { category: 'abuse', note: 'line\nbreak' },
      { category: 'abuse', term: 'vlemmo' },
      { category: 'abuse', language: 'es' },
      { category: 'abuse', id: 'x' },
      [],
      'abuse',
      null,
    ];
    for (const body of bad) {
      const res = await w.call('POST', `/terms/${id}/share`, { body });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(text(res.body)).not.toMatch(/example|someone|zorbak|vlemmo/);
    }
    expect(w.share.calls).toEqual([]);
    expect(w.routeAudit().filter((r) => r.action === 'term.share')).toEqual([]);
  });

  it("a failed share is a fixed error code and never the service's text; each attempt that reached the service leaves one audit row, and the log holds the outcome code only", async () => {
    const w = await communityWorld();
    const id = ownId(w);
    const secret = 'service said: ip 203.0.113.9 key CLIENTKEY-secret';
    const table: Array<[unknown, number, string, string]> = [
      [{ ok: false, code: 'offline', message: secret }, 502, 'share_unavailable', 'offline'],
      [{ ok: false, code: 'rate_limited', retryAfterMs: 5000, message: secret }, 429, 'rate_limited', 'rate_limited'],
      [{ ok: false, code: 'rejected', message: secret }, 422, 'share_refused', 'rejected'],
      [{ ok: false, code: 'unsupported_language', message: secret }, 422, 'share_refused', 'unsupported_language'],
      [{ ok: false, code: 'too_large', message: secret }, 400, 'invalid_request', 'too_large'],
      [{ ok: false, code: 'invalid', message: secret }, 400, 'invalid_request', 'invalid'],
      [{ ok: false, code: 'something-new', message: secret }, 502, 'share_unavailable', 'unknown'],
      [{ ok: true, status: 'surprise', message: secret }, 502, 'share_unavailable', 'unknown'],
      [null, 502, 'share_unavailable', 'unknown'],
      ['text', 502, 'share_unavailable', 'unknown'],
    ];
    let attempts = 0;
    for (const [result, status, code, outcome] of table) {
      w.share.result = result;
      w.logged.length = 0;
      const res = await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
      attempts += 1;
      expect({ result, status: res.status, error: (res.body as { error: string }).error }).toEqual({ result, status, error: code });
      expect(Object.keys(res.body as object).sort()).toEqual(['error', 'message']);
      expect(text(res)).not.toMatch(/service said|203\.0\.113|CLIENTKEY|sub_abc/);
      // The word may have left the server: one best-effort row on the term id, and a log line with the closed outcome and nothing else.
      expect(audits(w)).toHaveLength(attempts);
      const outcomes = w.logged.filter((l) => /share_outcome/.test(text(l)));
      expect(outcomes).toHaveLength(1);
      expect(text(outcomes[0])).toContain(`"code":"${outcome}"`);
      expect(text(w.logged)).not.toMatch(/service said|203\.0\.113|CLIENTKEY|fenriskz/);
    }
    for (const row of audits(w)) {
      expect(row).toMatchObject({ action: 'term.share', target: { type: 'term', ref: id } });
      expect(Object.keys(row as object).sort()).toEqual(['action', 'actor', 'at', 'id', 'role', 'target']);
    }
    expect(text(w.audit())).not.toContain(OWN_WORD);
  });

  it('a share that never reached the service (a bad body, an unknown id, a community row, too low a role) leaves no audit row', async () => {
    const w = await communityWorld();
    await w.call('POST', `/terms/${ownId(w)}/share`, { body: { category: 'nope' } });
    await w.call('POST', '/terms/CWT-2026-99999/share', { body: { category: 'abuse' } });
    await w.call('POST', `/terms/${idOf(w, 'glarn')}/share`, { body: { category: 'abuse' } });
    await w.call('POST', `/terms/${ownId(w)}/share`, { body: { category: 'abuse' }, role: null });
    expect(w.share.calls).toEqual([]);
    expect(audits(w)).toEqual([]);
  });

  it('a throwing share object is a 502 with a fixed message, and the log never holds the word; the attempt is audited as an unknown outcome', async () => {
    const w = await communityWorld();
    w.share.throws = true;
    const res = await w.call('POST', `/terms/${ownId(w)}/share`, { body: { category: 'abuse' } });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'share_unavailable' });
    expect(text(res)).not.toContain('exploded');
    expect(text(w.logged)).not.toContain(OWN_WORD);
    expect(text(w.logged)).not.toContain('exploded');
    expect(audits(w)).toHaveLength(1);
    expect(text(w.logged)).toContain('"code":"threw"');
  });
});

describe('GET /terms/:id/share', () => {
  const own = (w: Awaited<ReturnType<typeof communityWorld>>): string => w.own.id;

  it('says { status: null } for a term that was never shared (a browser logs a 404 as an error), 404 for a term that is not there, and needs terms.read', async () => {
    const w = await communityWorld({ permissions: { 'terms.read': 'senior' } });
    const never = await w.call('GET', `/terms/${own(w)}/share`, { role: 'senior' });
    expect(never.status).toBe(200);
    expect(never.body).toEqual({ status: null });
    expect(w.share.statusCalls).toEqual([]);
    expect((await w.call('GET', `/terms/${own(w)}/share`, { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/terms/CWT-2026-99999/share', { role: 'senior' })).status).toBe(404);
  });

  it('asks the service about the last share with the service id only, and answers { status, reason? } from a closed set', async () => {
    const w = await communityWorld();
    const id = own(w);
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    w.share.statusResult = { status: 'declined', reason: 'known_innocent', message: 'secret text' };
    const res = await w.call('GET', `/terms/${id}/share`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'declined', reason: 'known_innocent' });
    expect(w.share.statusCalls).toEqual(['sub_abc123']);
    expect(w.routeAudit().filter((r) => r.action === 'term.share')).toHaveLength(1); // the share's own row; a status read adds none
    w.share.statusResult = { status: 'accepted' };
    w.shareClock.t += 15_000;
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'accepted' });
  });

  it('does not ask the service again within 15 seconds: a reload in a loop is one outbound request; after that it asks again and sees the change', async () => {
    const w = await communityWorld();
    const id = own(w);
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    w.share.statusResult = { status: 'in_review' };
    const first = await w.call('GET', `/terms/${id}/share`);
    expect(first.body).toEqual({ status: 'in_review' });
    w.share.statusResult = { status: 'accepted' };
    for (let i = 0; i < 20; i += 1) {
      w.shareClock.t += 500;
      expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'in_review' });
    }
    expect(w.share.statusCalls).toEqual(['sub_abc123']);
    w.shareClock.t += 15_000;
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'accepted' });
    expect(w.share.statusCalls).toHaveLength(2);
  });

  it('many reads at the same moment are one outbound request, and a new share of the term forgets the remembered answer', async () => {
    const w = await communityWorld();
    const id = own(w);
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    const all = await Promise.all(Array.from({ length: 8 }, () => w.call('GET', `/terms/${id}/share`)));
    expect(all.every((r) => text(r.body) === text(all[0]?.body))).toBe(true);
    expect(w.share.statusCalls).toHaveLength(1);
    w.share.statusResult = { status: 'declined', reason: 'duplicate' };
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'declined', reason: 'duplicate' });
    expect(w.share.statusCalls).toHaveLength(2);
  });

  it('an answer that could not be had is not remembered: the next read asks again', async () => {
    const w = await communityWorld();
    const id = own(w);
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    w.share.throws = true;
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'received' });
    w.share.throws = false;
    w.share.statusResult = { status: 'accepted' };
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'accepted' });
  });

  it('falls back to what the share answered when the service cannot be asked (null, a throw, an answer that is not understood)', async () => {
    const w = await communityWorld();
    const id = own(w);
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    for (const answer of [null, { status: 'something-else' }, 'text', { reason: 'x' }]) {
      w.share.statusResult = answer;
      expect((await w.call('GET', `/terms/${id}/share`)).body, text(answer)).toEqual({ status: 'received' });
    }
    w.share.throws = true;
    const res = await w.call('GET', `/terms/${id}/share`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });
    expect(text(w.logged)).not.toContain('exploded');
  });

  it('a share that was already known or a duplicate has no id to ask about: it answers that status', async () => {
    const w = await communityWorld();
    const id = own(w);
    w.share.result = { ok: true, status: 'known', termId: 'CWT-2026-00001' };
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'known' });
    expect(w.share.statusCalls).toEqual([]);
  });

  it('an unsafe reason from the service is dropped, never passed on', async () => {
    const w = await communityWorld();
    const id = own(w);
    await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } });
    w.share.statusResult = { status: 'declined', reason: 'free text from a reviewer: vlemmo is fine' };
    expect((await w.call('GET', `/terms/${id}/share`)).body).toEqual({ status: 'declined' });
  });
});

describe('no identifier and no word in any response, header or log of the new routes (Review Focus 5)', () => {
  it('seeded identifiers and every word stay out of what the routes return and log', async () => {
    const w = await communityWorld();
    const secrets = ['CLIENTKEY-secret-9f3a', 'subj_secret_41', '203.0.113.77', 'room-secret-lobby'];
    w.share.result = { ok: true, status: 'received', id: 'sub_abc123', clientKey: secrets[0], ip: secrets[2] };
    w.share.statusResult = { status: 'in_review', subject: secrets[1], room: secrets[3] };
    const id = w.own.id;
    const responses = [
      await w.call('GET', '/community'),
      await w.call('POST', '/community/refresh'),
      await w.call('POST', `/terms/${id}/share`, { body: { category: 'abuse' } }),
      await w.call('GET', `/terms/${id}/share`),
      await w.call('POST', '/terms/lookup', { body: { word: 'tarvox' } }),
      await w.call('POST', `/terms/${id}/share`, { body: { category: 'nope' } }),
      await w.call('POST', '/terms/lookup', { body: { word: 'unknownword' } }),
    ];
    for (const r of responses) {
      for (const s of secrets) expect(text(r), s).not.toContain(s);
      expect(Object.keys(r.headers ?? {}).sort()).toEqual(['cache-control']);
    }
    expect(text(responses[2])).not.toContain(OWN_WORD);
    expect(text(responses[3])).not.toContain(OWN_WORD);
    expect(text(w.logged)).not.toMatch(/fenriskz|tarvox|glarn|CLIENTKEY|203\.0\.113/);
    expect(text(w.audit())).not.toMatch(/fenriskz|tarvox|glarn|CLIENTKEY|203\.0\.113/);
  });
});
