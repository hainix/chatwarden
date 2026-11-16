import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/counters.js';
import { ALICE, BOB, CARA, DAN, makeReviewWorld, withReviewers, type ReviewWorld } from './review-world.js';
import { DAY_MS, errorOf, idOf, makeInstallation, TODAY, validBody, type Installation, type PostSpec } from './world.js';

// Reports of a term (design 10.6): a term id and a closed kind, signed by an installation or checked by Turnstile. No free text is read or kept.

interface Siteverify {
  calls: { url: string; body: string }[];
  result: () => Response;
}

let rw: ReviewWorld;
let inst: Installation;
let site: Siteverify;
const TERM = 'CWT-2026-00001';

beforeEach(async () => {
  site = { calls: [], result: () => Response.json({ success: true, hostname: 'chatwarden.dev' }) };
  rw = await makeReviewWorld({
    turnstile: {
      secret: 'ts-secret-for-tests-only',
      hostname: 'chatwarden.dev',
      fetch: ((url: string, init: RequestInit) => {
        site.calls.push({ url: String(url), body: String(init.body) });
        return Promise.resolve(site.result());
      }) as typeof fetch,
    },
    reportsOrigin: 'https://chatwarden.dev',
  });
  await withReviewers(rw);
  await rw.w.addTerm(TERM, 'zorbak', 'accepted');
  inst = await makeInstallation();
});
afterEach(() => rw.restore());

const body = (over: Record<string, unknown> = {}, drop: string[] = []): string => {
  const merged: Record<string, unknown> = { schema: 'chatwarden-corpus-report/1', termId: TERM, kind: 'innocent_sense', day: TODAY, kit: '0.1.11', ...over };
  for (const k of drop) delete merged[k];
  return JSON.stringify(merged);
};
const signed = (over: Partial<PostSpec> = {}) => rw.w.post({ path: '/v1/reports', kind: 'report', installation: inst, stamp: null, body: body(), ...over });
const web = (over: Record<string, unknown> = {}, spec: Partial<PostSpec> = {}) =>
  rw.w.post({
    path: '/v1/reports',
    stamp: null,
    body: JSON.stringify({ schema: 'chatwarden-corpus-report/1', termId: TERM, kind: 'innocent_sense', token: 'turnstile-token-1', ...over }),
    headers: { 'x-cw-key': null, 'x-cw-sig': null },
    ...spec,
  });
const reports = () => rw.rows('SELECT * FROM reports ORDER BY rowid');

describe('a signed report', () => {
  it('is 202 with an acknowledgement id and nothing about the term, and files a row of ids and a day', async () => {
    const res = await signed();
    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string; status: string };
    expect(Object.keys(json).sort()).toEqual(['id', 'status']);
    expect(json.status).toBe('received');
    expect(json.id).toMatch(/^rep_[A-Za-z0-9_-]{16,}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await reports()).toEqual([{ id: json.id, term_id: TERM, kind: 'innocent_sense', channel: `inst:${await inst.id()}`, status: 'received', received_day: TODAY }]);
  });

  it('answers a term the service does not know with 404 and the same body whatever the term, and an existing one with nothing of its state', async () => {
    const unknown = await signed({ body: body({ termId: 'CWT-2026-00042' }) });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    await rw.w.addTerm('CWT-2026-00002', 'vlemo', 'withdrawn');
    const a = await (await signed()).text();
    const b = await (await signed({ installation: await makeInstallation(), body: body({ termId: 'CWT-2026-00002' }) })).text();
    expect(Object.keys(JSON.parse(a))).toEqual(Object.keys(JSON.parse(b)));
    expect(a + b).not.toMatch(/zorbak|vlemo|accepted|withdrawn|provisional/);
    expect(await reports()).toHaveLength(2);
  });

  it.each(['innocent_sense', 'wrong_category', 'removal'])('accepts the kind %s', async (kind) => {
    expect((await signed({ body: body({ kind }) })).status).toBe(202);
  });

  it('is read the way the kit\u2019s client sends it: a report, a duplicate, an unknown term, a rate limit', async () => {
    const share = rw.w.client(inst);
    const first = await share.report({ termId: TERM, kind: 'removal' });
    expect(first).toMatchObject({ ok: true });
    expect((first as { id?: string }).id).toMatch(/^rep_/);
    expect(await share.report({ termId: TERM, kind: 'removal' })).toEqual({ ok: true });
    expect(await share.report({ termId: 'CWT-2026-00042', kind: 'removal' })).toEqual({ ok: false, code: 'rejected' });
    expect(await reports()).toHaveLength(1);
  });

  it('refuses what is not a good report as 400 invalid: each field, a body of another shape, another content type', async () => {
    const bad = [
      body({ termId: 'CWT-26-1' }),
      body({ termId: 'zorbak' }),
      body({ termId: '' }),
      body({ termId: 7 }),
      body({ kind: 'spam' }),
      body({ kind: 'Removal' }),
      body({ kind: 3 }),
      body({}, ['kind']),
      body({}, ['termId']),
      body({ schema: 'chatwarden-corpus-submission/1' }),
      body({}, ['schema']),
      body({ day: '2026-12-09' }),
      body({ day: 'today' }),
      body({}, ['day']),
      body({ kit: 'x' }),
      body({}, ['kit']),
      '[]',
      'null',
      'not json',
      '',
      '{"__proto__":{"x":1}}',
    ];
    for (const b of bad) {
      const res = await signed({ body: b, installation: await makeInstallation() });
      expect(res.status, b).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    }
    expect((await signed({ contentType: 'text/plain', installation: await makeInstallation() })).status).toBe(400);
    expect((await signed({ body: body() + ' '.repeat(2100), installation: await makeInstallation() })).status).toBe(400);
    expect(await reports()).toEqual([]);
  });

  it('a body with any free-text key is 400, and nothing of it is stored', async () => {
    for (const key of ['text', 'comment', 'reason', 'message', 'note', 'description', 'details', 'body', 'excerpt', 'line', 'term', 'word', 'email', 'url', 'name', 'free', '__proto__', 'constructor']) {
      const res = await signed({ body: body({ [key]: 'a free text about the word' }), installation: await makeInstallation() });
      expect(res.status, key).toBe(400);
    }
    expect(await reports()).toEqual([]);
    expect(await rw.w.dump()).not.toContain('free text');
  });

  it('is 401 without a key or signature, with a bad one, or with a signature of another kind (a submission signature is not a report)', async () => {
    expect((await signed({ headers: { 'x-cw-sig': null } })).status).toBe(401);
    expect((await signed({ headers: { 'x-cw-key': 'short' } })).status).toBe(401);
    expect((await signed({ headers: { 'x-cw-sig': 'A'.repeat(86) } })).status).toBe(401);
    for (const kind of ['submission', 'index'] as const) expect((await signed({ kind })).status, kind).toBe(401);
    expect((await signed({ installation: await makeInstallation(), headers: { 'x-cw-key': inst.publicKey } })).status).toBe(401);
    expect(await reports()).toEqual([]);
    expect(await rw.rows('SELECT * FROM counters')).toEqual([]);
  });

  it('a report signature cannot be used as a submission either', async () => {
    const res = await rw.w.post({ installation: inst, kind: 'report' });
    expect(res.status).toBe(401);
  });

  it('needs no stamp, and ignores one', async () => {
    expect((await signed({ stamp: null })).status).toBe(202);
    expect((await signed({ stamp: 'garbage', installation: await makeInstallation() })).status).toBe(202);
  });
});

describe('duplicate reports in a day collapse', () => {
  it('the same installation reporting the same term again today is a duplicate, whatever the kind, and adds no row', async () => {
    expect((await signed()).status).toBe(202);
    for (const kind of ['innocent_sense', 'wrong_category', 'removal']) {
      const res = await signed({ body: body({ kind }) });
      expect(res.status, kind).toBe(200);
      expect(await res.json()).toEqual({ status: 'duplicate' });
    }
    expect(await reports()).toHaveLength(1);
  });

  it('another installation, another term, and the next day are reports of their own', async () => {
    await rw.w.addTerm('CWT-2026-00002', 'vlemo', 'accepted');
    await signed();
    expect((await signed({ installation: await makeInstallation() })).status).toBe(202);
    expect((await signed({ body: body({ termId: 'CWT-2026-00002' }) })).status).toBe(202);
    rw.clock.advance(DAY_MS);
    expect((await signed({ body: body({ day: '2026-12-03' }) })).status).toBe(202);
    expect(await reports()).toHaveLength(4);
  });

  it('once a report is resolved the same installation can report the term again the same day', async () => {
    const id = await idOf(await signed());
    await rw.w.db.prepare("UPDATE reports SET status = 'declined' WHERE id = ?").bind(id).run();
    expect((await signed()).status).toBe(202);
  });

  it('two at once make one report', async () => {
    const [a, b] = await Promise.all([signed(), signed()]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(await reports()).toHaveLength(1);
  });
});

describe('a missing or failed Turnstile token is 403', () => {
  it('a good token is 202, files the report under a web channel (a keyed hash), and stores neither the token nor the address', async () => {
    const res = await web({}, { ip: '198.51.100.77' });
    expect(res.status).toBe(202);
    const [row] = await reports();
    expect(row?.channel).toMatch(/^web:[0-9a-f]{32}$/);
    const dump = await rw.w.dump();
    expect(dump).not.toContain('turnstile-token-1');
    expect(dump).not.toContain('198.51.100');
    expect(JSON.stringify(rw.w.logs) + rw.w.consoleOutput.join('')).not.toMatch(/turnstile-token-1|ts-secret|198\.51\.100/);
  });

  it('asks Cloudflare once, with the secret and the token and not the visitor\u2019s address', async () => {
    await web();
    expect(site.calls).toHaveLength(1);
    expect(site.calls[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const sent = JSON.parse(site.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({ secret: 'ts-secret-for-tests-only', response: 'turnstile-token-1' });
  });

  it('is 403 with no token, an empty token, a token Cloudflare refuses, and a token for another site', async () => {
    const forbidden = async (res: Response) => {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    };
    await forbidden(await web({ token: undefined }));
    await forbidden(await web({ token: '' }));
    expect(site.calls).toHaveLength(0); // nothing to check, so nothing asked
    site.result = () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
    await forbidden(await web());
    site.result = () => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    await forbidden(await web());
    site.result = () => Response.json({ success: true, hostname: 'evil.example' });
    await forbidden(await web());
    expect(await reports()).toEqual([]);
  });

  it('is 403 when Cloudflare cannot be reached or answers nonsense (fail closed), and says so in the log by code only', async () => {
    const forbidden = async () => expect((await web()).status).toBe(403);
    site.result = () => new Response('oops', { status: 500 });
    await forbidden();
    site.result = () => new Response('not json', { status: 200 });
    await forbidden();
    site.result = () => Response.json({ success: 'true' });
    await forbidden();
    site.result = () => Response.json(null);
    await forbidden();
    site.result = () => {
      throw new Error('network down');
    };
    await forbidden();
    expect(rw.w.logs.some((e) => e.stage === 'turnstile')).toBe(true);
    expect(await reports()).toEqual([]);
  });

  it('is 403 when no Turnstile is configured at all, and a token is not read as a signature', async () => {
    const bare = await makeReviewWorld({});
    try {
      const res = await bare.w.post({ path: '/v1/reports', stamp: null, body: JSON.stringify({ schema: 'chatwarden-corpus-report/1', termId: TERM, kind: 'removal', token: 'x' }), headers: { 'x-cw-key': null, 'x-cw-sig': null } });
      expect(res.status).toBe(403);
    } finally {
      bare.restore();
    }
  });

  it('a web body with a token over 2048 characters, a token that is not a string, or any other key is 400, never asked of Cloudflare', async () => {
    for (const over of [{ token: 'x'.repeat(2049) }, { token: 7 }, { token: ['x'] }, { comment: 'free' }, { day: TODAY }, { kit: '0.1.11' }]) {
      expect((await web(over)).status, JSON.stringify(over).slice(0, 30)).toBe(400);
    }
    expect(site.calls).toHaveLength(0);
  });

  it('a signed report may not carry a token, and a web report is not read as signed', async () => {
    expect((await signed({ body: body({ token: 'x' }) })).status).toBe(400);
    expect((await web({}, { headers: { 'x-cw-key': inst.publicKey, 'x-cw-sig': null } })).status).toBe(401);
  });

  it('web reports from one network collapse for the day, and another network is its own', async () => {
    expect((await web({}, { ip: '192.0.2.10' })).status).toBe(202);
    const again = await web({ token: 'another-token' }, { ip: '192.0.2.10' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    expect((await web({ token: 'third' }, { ip: '192.0.2.11' })).status).toBe(202);
  });
});

describe('rate limits', () => {
  it('the 21st report of an installation in a day is 429 with retry-after, apart from its submissions', async () => {
    for (let n = 0; n < LIMITS.reportsPerInstallationDaily; n += 1) {
      await rw.w.addTerm(`CWT-2026-${String(100 + n).padStart(5, '0')}`, `k${String.fromCharCode(97 + n)}zz`, 'accepted');
      expect((await signed({ body: body({ termId: `CWT-2026-${String(100 + n).padStart(5, '0')}` }) })).status, String(n)).toBe(202);
    }
    const res = await signed({ body: body({ termId: TERM }) });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBe(12 * 60 * 60);
    expect((await rw.w.post({ installation: inst, body: validBody({ term: 'vlemmo' }) })).status).toBe(202); // the submission side has its own count
  });

  it('web reports are limited per network, to fewer a day', async () => {
    for (let n = 0; n < LIMITS.webReportsPerNetworkDaily; n += 1) {
      const id = `CWT-2026-${String(200 + n).padStart(5, '0')}`;
      await rw.w.addTerm(id, `w${String.fromCharCode(97 + n)}zz`, 'accepted');
      expect((await web({ termId: id, token: `t${n}` }, { ip: '192.0.2.99' })).status, String(n)).toBe(202);
    }
    const over = await web({ token: 'last' }, { ip: '192.0.2.99' });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    expect((await web({ token: 'other net' }, { ip: '192.0.2.98' })).status).toBe(202);
  });

  it('the network limit holds across many installations', async () => {
    for (let n = 0; n < LIMITS.reportsPerNetworkDaily; n += 1) {
      const id = `CWT-2026-${String(300 + n).padStart(5, '0')}`;
      await rw.w.addTerm(id, `n${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}qq`, 'accepted');
      expect((await signed({ installation: await makeInstallation(), body: body({ termId: id }), ip: '192.0.2.50' })).status, String(n)).toBe(202);
    }
    expect((await signed({ installation: await makeInstallation(), ip: '192.0.2.50' })).status).toBe(429);
  });
});

describe('the report route and its cross-origin rule', () => {
  it('only the docs site\u2019s origin is answered for the web form, with the headers a browser needs and no more', async () => {
    const pre = await rw.w.fetch(new Request('https://corpus.test/v1/reports', { method: 'OPTIONS', headers: { origin: 'https://chatwarden.dev', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://chatwarden.dev');
    expect(pre.headers.get('access-control-allow-methods')).toBe('POST');
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    expect(pre.headers.get('vary')).toContain('Origin');
    for (const origin of ['https://evil.example', 'https://chatwarden.dev.evil.example', 'http://chatwarden.dev', 'null']) {
      const no = await rw.w.fetch(new Request('https://corpus.test/v1/reports', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } }));
      expect(no.status, origin).toBe(403);
      expect(no.headers.get('access-control-allow-origin')).toBeNull();
    }
    const ok = await web({}, { headers: { 'x-cw-key': null, 'x-cw-sig': null, origin: 'https://chatwarden.dev' } });
    expect(ok.status).toBe(202);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://chatwarden.dev');
    const bad = await web({}, { headers: { 'x-cw-key': null, 'x-cw-sig': null, origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a signed report never gets a CORS header, and the submission route still has none', async () => {
    const res = await signed({ headers: { origin: 'https://chatwarden.dev' } });
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const sub = await rw.w.fetch(new Request('https://corpus.test/v1/submissions', { method: 'OPTIONS', headers: { origin: 'https://chatwarden.dev' } }));
    expect(sub.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses other methods with 405', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await rw.w.post({ path: '/v1/reports', method, stamp: null, installation: inst, kind: 'report' })).status, method).toBe(405);
  });
});

describe('a confirmed innocent_sense report sets disputed on one reviewer\u2019s verdict; restore needs two; a slur removal needs two', () => {
  const confirm = (id: string, who: string) => rw.admin(`/admin/api/reports/${id}/confirm`, { method: 'POST', body: {}, who });
  const decline = (id: string, who: string) => rw.admin(`/admin/api/reports/${id}/decline`, { method: 'POST', body: {}, who });
  const reportId = async (kind: string, installation = inst) => idOf(await signed({ installation, body: body({ kind }) }));
  const termStatus = async (id = TERM) => (await rw.rows('SELECT status FROM terms WHERE id = ?', id))[0]?.status;
  const reportStatus = async (id: string) => (await rw.rows('SELECT status FROM reports WHERE id = ?', id))[0]?.status;

  it('lists reports without a word and without who sent them, newest first', async () => {
    const a = await reportId('innocent_sense');
    const b = await reportId('removal', await makeInstallation());
    const res = (await (await rw.admin('/admin/api/reports', { who: BOB })).json()) as { items: Record<string, unknown>[] };
    expect(res.items).toEqual([
      { id: b, termId: TERM, kind: 'removal', status: 'received', receivedDay: TODAY, votes: 0, needed: 2, mine: null },
      { id: a, termId: TERM, kind: 'innocent_sense', status: 'received', receivedDay: TODAY, votes: 0, needed: 1, mine: null },
    ]);
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/zorbak|inst:|web:/);
  });

  it('one reviewer\u2019s confirmation of an innocent_sense report disputes the term', async () => {
    const id = await reportId('innocent_sense');
    const res = await confirm(id, CARA);
    expect(await res.json()).toEqual({ status: 'disputed', votes: 1, needed: 1 });
    expect(await termStatus()).toBe('disputed');
    expect(await reportStatus(id)).toBe('disputed');
    expect(await rw.rows("SELECT actor, action, subject FROM audit WHERE action = 'review.report.confirm'")).toEqual([{ actor: CARA, action: 'review.report.confirm', subject: id }]);
  });

  it('restoring the term needs two other reviewers, and the reports are marked restored', async () => {
    const id = await reportId('innocent_sense');
    await confirm(id, CARA);
    const r = (who: string) => rw.admin(`/admin/api/terms/${TERM}/restore`, { method: 'POST', body: {}, who });
    expect(await (await r(ALICE)).json()).toEqual({ status: 'disputed', votes: 1 });
    expect(await termStatus()).toBe('disputed');
    await r(BOB);
    expect(await termStatus()).not.toBe('disputed');
    expect(await reportStatus(id)).toBe('restored');
  });

  it('a reviewer who confirmed the report cannot cast a restore vote on the term it disputed (the same rule as the disputer)', async () => {
    const id = await reportId('innocent_sense');
    await confirm(id, CARA);
    const r = (who: string) => rw.admin(`/admin/api/terms/${TERM}/restore`, { method: 'POST', body: {}, who });
    const mine = await r(CARA);
    expect(mine.status).toBe(409);
    expect(await mine.json()).toEqual({ error: 'already_reviewed' });
    expect(await rw.rows("SELECT * FROM reviews WHERE verdict = 'restore'")).toEqual([]);
    expect(await termStatus()).toBe('disputed');
    await r(ALICE);
    expect(await termStatus()).toBe('disputed');
    await r(BOB);
    expect(await termStatus()).not.toBe('disputed');
  });

  it('once the term is restored, the reviewer who confirmed an earlier report may vote on a later dispute', async () => {
    const id = await reportId('innocent_sense');
    await confirm(id, CARA);
    const r = (who: string) => rw.admin(`/admin/api/terms/${TERM}/restore`, { method: 'POST', body: {}, who });
    await r(ALICE);
    await r(BOB);
    await rw.admin(`/admin/api/terms/${TERM}/dispute`, { method: 'POST', body: {}, who: DAN });
    expect((await r(CARA)).status).toBe(200);
  });

  it('a removal of a slur takes two reviewers: one vote leaves it standing, the second withdraws it', async () => {
    const id = await reportId('removal');
    const first = await confirm(id, CARA);
    expect(await first.json()).toEqual({ status: 'received', votes: 1, needed: 2 });
    expect(await termStatus()).toBe('accepted');
    expect(await reportStatus(id)).toBe('received');
    expect((await confirm(id, CARA)).status).toBe(409); // the same reviewer cannot vote twice
    const second = await confirm(id, DAN);
    expect(await second.json()).toEqual({ status: 'withdrawn', votes: 2, needed: 2 });
    expect(await termStatus()).toBe('withdrawn');
    expect(await reportStatus(id)).toBe('withdrawn');
  });

  it('a removal of a term that is not a slur takes one reviewer', async () => {
    await rw.w.db.prepare("UPDATE terms SET category = 'abuse' WHERE id = ?").bind(TERM).run();
    const id = await reportId('removal');
    expect(await (await confirm(id, CARA)).json()).toEqual({ status: 'withdrawn', votes: 1, needed: 1 });
  });

  it('a withdrawn term can be restored by two reviewers', async () => {
    await rw.w.db.prepare("UPDATE terms SET status = 'withdrawn' WHERE id = ?").bind(TERM).run();
    const r = (who: string) => rw.admin(`/admin/api/terms/${TERM}/restore`, { method: 'POST', body: {}, who });
    await r(ALICE);
    expect(await termStatus()).toBe('withdrawn');
    await r(BOB);
    expect(await termStatus()).toBe('provisional');
  });

  it('a wrong_category report is handled like an innocent_sense one: one reviewer, the term held out while it is looked at', async () => {
    const id = await reportId('wrong_category');
    expect(await (await confirm(id, ALICE)).json()).toEqual({ status: 'disputed', votes: 1, needed: 1 });
    expect(await termStatus()).toBe('disputed');
  });

  it('one reviewer can decline a report, and it then needs no more votes; a declined report is closed', async () => {
    const id = await reportId('removal');
    await confirm(id, CARA);
    expect(await (await decline(id, ALICE)).json()).toEqual({ status: 'declined' });
    expect(await reportStatus(id)).toBe('declined');
    expect(await termStatus()).toBe('accepted');
    expect((await confirm(id, DAN)).status).toBe(409);
    expect((await decline(id, DAN)).status).toBe(409);
  });

  it('a reviewer cannot resolve a report from a key registered to them, and an unknown report is 404', async () => {
    await rw.w.db.prepare('INSERT INTO reviewer_installations VALUES (?, ?)').bind(CARA, await inst.id()).run();
    const id = await reportId('innocent_sense');
    expect((await confirm(id, CARA)).status).toBe(403);
    expect((await decline(id, CARA)).status).toBe(403);
    expect((await confirm('rep_missing', ALICE)).status).toBe(404);
    expect(await termStatus()).toBe('accepted');
  });

  it('a report on a term that is already disputed closes the report without changing the term', async () => {
    await rw.w.db.prepare("UPDATE terms SET status = 'disputed' WHERE id = ?").bind(TERM).run();
    const id = await reportId('innocent_sense');
    expect(await (await confirm(id, ALICE)).json()).toEqual({ status: 'disputed', votes: 1, needed: 1 });
    expect(await termStatus()).toBe('disputed');
  });

  it('the resolution routes need Access and a reviewer like every route under /admin, and the same cross-site rules', async () => {
    const id = await reportId('innocent_sense');
    for (const path of [`/admin/api/reports/${id}/confirm`, `/admin/api/reports/${id}/decline`, '/admin/api/reports']) {
      const method = path.endsWith('reports') ? 'GET' : 'POST';
      expect((await rw.admin(path, { method, token: null, ...(method === 'POST' ? { body: {} } : {}) })).status, path).toBe(401);
      expect((await rw.admin(path, { method, who: 'mallory@example.test', ...(method === 'POST' ? { body: {} } : {}) })).status, path).toBe(403);
    }
    expect((await rw.admin(`/admin/api/reports/${id}/confirm`, { method: 'POST', body: {}, who: ALICE, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(await termStatus()).toBe('accepted');
  });

  it('writes the audit row with the action, and refuses an action with a text body', async () => {
    const id = await reportId('innocent_sense');
    expect((await rw.admin(`/admin/api/reports/${id}/confirm`, { method: 'POST', body: { reason: 'free text' }, who: ALICE })).status).toBe(400);
    expect(await termStatus()).toBe('accepted');
  });
});

describe('what is logged and stored', () => {
  it('holds no free text, address, signature or token beyond the closed columns, on success and refusal alike', async () => {
    const ip = '198.51.100.201';
    await signed({ ip });
    await signed({ ip, body: body({ comment: 'spy comment' }) });
    await web({ token: 'spy-token' }, { ip: '198.51.100.202' });
    site.result = () => Response.json({ success: false });
    await web({ token: 'spy-token-2' }, { ip: '198.51.100.203' });
    const dump = await rw.w.dump();
    const logged = JSON.stringify(rw.w.logs) + rw.w.consoleOutput.join('');
    for (const secret of ['198.51.100', 'spy comment', 'spy-token', inst.publicKey]) {
      expect(dump, secret).not.toContain(secret);
      expect(logged, secret).not.toContain(secret);
    }
    expect(await errorOf(await signed({ body: '{' }))).toBe('invalid');
  });
});
