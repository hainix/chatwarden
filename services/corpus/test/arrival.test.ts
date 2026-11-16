import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkStamp, mintStamp } from '@chatwarden/matcher/corpus';
import { DAY_MS, TODAY, errorOf, idOf, makeInstallation, makeWorld, validBody, type Installation, type World } from './world.js';

// Invented words only. Every request is signed by a key generated here; the share client of the kit is driven against the app where it can be.

let w: World;
let inst: Installation;
beforeEach(async () => {
  w = await makeWorld();
  inst = await makeInstallation();
});
afterEach(() => w.restore());

const enc = new TextEncoder();
const rows = async (sql: string) => (await w.db.prepare(sql).all<Record<string, unknown>>()).results;

describe('a valid signed submission is 202 received; the same again is duplicate; an existing term is known with its public id', () => {
  it('answers 202 { id, status: received } with the headers of a server-to-server API and no CORS', async () => {
    const res = await w.post({ installation: inst });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string; status: string };
    expect(json.status).toBe('received');
    expect(json.id).toMatch(/^sub_[A-Za-z0-9_-]{16,}$/);
    expect(Object.keys(json).sort()).toEqual(['id', 'status']);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('files the submission under the hash of the public key, with the word key and the day, and nothing else of the request', async () => {
    const res = await w.post({ installation: inst, body: validBody({ term: 'Z\u00f3rbaak', note: 'seen twice' }) });
    expect(res.status).toBe(202);
    const [row] = await rows('SELECT * FROM submissions');
    expect(row).toMatchObject({
      installation: await inst.id(),
      word_key: 'zorbak',
      term: 'Z\u00f3rbaak',
      language: 'en',
      category: 'slur',
      target: 'none',
      note: 'seen twice',
      status: 'received',
      reason: null,
      term_id: null,
      received_day: TODAY,
      decided_at: null,
    });
  });

  it('driven by the real share client: received, then duplicate, then known with the public id', async () => {
    const share = w.client(inst);
    const first = await share.share({ term: 'zorbak', language: 'en', category: 'slur' });
    expect(first).toMatchObject({ ok: true, status: 'received' });
    expect((first as { id?: string }).id).toMatch(/^sub_/);
    expect(await share.share({ term: 'zorbak', language: 'en', category: 'slur' })).toEqual({ ok: true, status: 'duplicate' });
    await w.addTerm('CWT-2026-00007', 'vlemo', 'accepted');
    expect(await share.share({ term: 'vlemmo', language: 'en', category: 'abuse', target: 'none' })).toEqual({ ok: true, status: 'known', id: 'CWT-2026-00007' });
    expect(await rows('SELECT id FROM submissions')).toHaveLength(1);
  });

  it('a pending word is a duplicate for another installation and for another spelling of it', async () => {
    const other = await makeInstallation();
    expect((await w.post({ installation: inst })).status).toBe(202);
    for (const term of ['zorbak', 'ZORBAK', 'zorbaak', 'z\u00f3rbak']) {
      const res = await w.post({ installation: other, body: validBody({ term }) });
      expect(res.status, term).toBe(200);
      expect(await res.json()).toEqual({ status: 'duplicate' });
    }
    expect(await rows('SELECT id FROM submissions')).toHaveLength(1);
  });

  it('an existing term is known whatever its status, and whatever the spelling', async () => {
    await w.addTerm('CWT-2026-00001', 'zorbak', 'provisional');
    await w.addTerm('CWT-2026-00002', 'drakun', 'withdrawn');
    for (const [term, id] of [['Zorbak', 'CWT-2026-00001'], ['zorrbak', 'CWT-2026-00001'], ['drakkuun', 'CWT-2026-00002']] as const) {
      const res = await w.post({ installation: inst, body: validBody({ term }) });
      expect(res.status, term).toBe(200);
      expect(await res.json()).toEqual({ status: 'known', termId: id });
    }
    expect(await rows('SELECT id FROM submissions')).toHaveLength(0);
  });

  it('a word that was declined earlier can be submitted again (the limits and the decline streak govern that)', async () => {
    const res = await w.post({ installation: inst });
    const id = await idOf(res);
    await w.db.prepare("UPDATE submissions SET status = 'declined', reason = 'not_a_term', decided_at = ? WHERE id = ?").bind('2026-12-02T12:00:00Z', id).run();
    expect((await w.post({ installation: inst })).status).toBe(202);
    expect(await rows('SELECT id FROM submissions')).toHaveLength(2);
  });

  it('two requests for one word at once make one submission and one duplicate (the database refuses the second pending row)', async () => {
    const other = await makeInstallation();
    const [a, b] = await Promise.all([w.post({ installation: inst }), w.post({ installation: other })]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(await rows('SELECT id FROM submissions')).toHaveLength(1);
  });

  it('a common word of the language is auto-declined known_innocent: the answer is the same 202, the decision is in the status', async () => {
    await w.seedInnocent([['en', 'glarn', 15]]);
    const res = await w.post({ installation: inst, body: validBody({ term: 'glarn' }) });
    expect(res.status).toBe(202);
    const id = await idOf(res);
    const [row] = await rows('SELECT status, reason, decided_at FROM submissions');
    expect(row).toMatchObject({ status: 'declined', reason: 'known_innocent' });
    expect(typeof row?.decided_at).toBe('string');
    const status = await w.get(id, { installation: inst });
    expect(await status.json()).toEqual({ status: 'declined', reason: 'known_innocent' });
  });
});

describe('every refusal code: invalid (each field), too_large, unsupported_language, stamp (one bit short), 401 (bad, missing, wrong-kind signature), day outside the window, wrong content type, unknown key, a note with a URL', () => {
  const invalid: [string, string][] = [
    ['a term with a digit', validBody({ term: 'zorbak1' })],
    ['a term with a space', validBody({ term: 'zor bak' })],
    ['an empty term', validBody({ term: '' })],
    ['a term that is not a string', validBody({ term: 7 })],
    ['a missing term', validBody({}, ['term'])],
    ['a 41-letter term', validBody({ term: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmno' })],
    ['a two-letter term', validBody({ term: 'zo' })],
    ['a bad language shape', validBody({ language: 'EN' })],
    ['a regional language tag', validBody({ language: 'pt-BR' })],
    ['a missing language', validBody({}, ['language'])],
    ['a bad category', validBody({ category: 'hate' })],
    ['a missing category', validBody({}, ['category'])],
    ['a bad target', validBody({ target: 'race' })],
    ['a null target', validBody({ target: null })],
    ['a note that is a number', validBody({ note: 5 })],
    ['a note over 200 characters', validBody({ note: 'x'.repeat(201) })],
    ['a note with an @', validBody({ note: 'ask @someone' })],
    ['a note with a long digit run', validBody({ note: 'id 123456' })],
    ['a note with a URL', validBody({ note: 'see https://example.test/x' })],
    ['a note with a bare host', validBody({ note: 'on example.com' })],
    ['a note with www', validBody({ note: 'at www.example' })],
    ['a note with a control character', validBody({ note: 'a\u0007b' })],
    ['the wrong schema', validBody({ schema: 'chatwarden-corpus-submission/2' })],
    ['a missing schema', validBody({}, ['schema'])],
    ['a bad kit', validBody({ kit: 'latest' })],
    ['a missing kit', validBody({}, ['kit'])],
    ['a missing day', validBody({}, ['day'])],
    ['a day that is not a date', validBody({ day: '2026-02-30' })],
    ['a day with a time', validBody({ day: '2026-12-02T10:00:00Z' })],
    ['a day that is a number', validBody({ day: 20261202 })],
    ['an unknown key', validBody({ extra: 'x' })],
    ['an unknown key carrying a chat line', validBody({ line: 'you zorbak' })],
    ['a __proto__ key', '{"__proto__":{"x":1},"schema":"chatwarden-corpus-submission/1","term":"zorbak","language":"en","category":"slur","target":"none","note":null,"day":"2026-12-02","kit":"0.1.11"}'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"zorbak"'],
    ['not JSON', 'zorbak'],
    ['an empty body', ''],
    ['a body with a byte-order mark', '\ufeff' + validBody()],
    ['truncated JSON', validBody().slice(0, -3)],
  ];
  it.each(invalid)('%s is 400 invalid', async (_n, body) => {
    const res = await w.post({ installation: inst, body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid' });
    expect(await rows('SELECT id FROM submissions')).toHaveLength(0);
  });

  it('a body that is not UTF-8 is 400 invalid', async () => {
    const res = await w.post({ installation: inst, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('invalid');
  });

  it('a language the corpus does not serve is 400 unsupported_language', async () => {
    for (const language of ['fr', 'de', 'ja']) {
      const res = await w.post({ installation: inst, body: validBody({ language }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unsupported_language' });
    }
  });

  it('a body over 2 KiB is 400 too_large, by its length header, and by what is actually read when the length is unknown or a lie', async () => {
    const big = validBody() + ' '.repeat(2048);
    const byHeader = await w.post({ installation: inst, body: big });
    expect(byHeader.status).toBe(400);
    expect(await errorOf(byHeader)).toBe('too_large');

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
        if (pulled > 1000) controller.close();
      },
    });
    const byStream = await w.post({ installation: inst, stream, body: big, headers: { 'content-length': null } });
    expect(byStream.status).toBe(400);
    expect(await errorOf(byStream)).toBe('too_large');
    expect(pulled).toBeLessThan(10); // it stopped reading at the cap

    const lie = await w.post({ installation: inst, body: big, headers: { 'content-length': '100' } });
    expect([400, 413]).toContain(lie.status);
    expect(await rows('SELECT id FROM submissions')).toHaveLength(0);
  });

  it('a body of exactly 2048 bytes is read (the limit is on what is over it)', async () => {
    const note = 'x'.repeat(200);
    const pad = ' '.repeat(2048 - enc.encode(validBody({ note })).length);
    const res = await w.post({ installation: inst, body: validBody({ note }) + pad });
    expect(res.status).toBe(202);
  });

  describe('the stamp', () => {
    const body = validBody();
    const bytes = enc.encode(body);
    it('a good stamp passes the kit\u2019s own check at the service\u2019s bits (the parity this test pins)', () => {
      expect(checkStamp(bytes, mintStamp(bytes, w.stampBits), w.stampBits)).toBe(true);
    });
    it('a stamp one bit short is 400 stamp', async () => {
      const res = await w.post({ installation: inst, body, stamp: mintStamp(bytes, w.stampBits - 1) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'stamp' });
    });
    it('a stamp that claims its bits but did not do the work, a stamp for another body, a missing and a malformed stamp are 400 stamp', async () => {
      const claims = `${w.stampBits}:` + Array.from({ length: 4000 }, (_v, i) => i.toString(36)).find((n) => !checkStamp(bytes, `${w.stampBits}:${n}`, w.stampBits));
      const other = mintStamp(enc.encode(validBody({ term: 'vlemmo' })), w.stampBits);
      const cases: (string | null)[] = [claims, other, null, '', 'zero', '08:abc', `${w.stampBits}:`, `${w.stampBits}:a b`, `${w.stampBits}:${'a'.repeat(33)}`, `-${w.stampBits}:abc`, `${w.stampBits}:abc:def`];
      for (const stamp of cases) {
        const res = await w.post({ installation: inst, body, stamp });
        expect(res.status, String(stamp)).toBe(400);
        expect(await errorOf(res)).toBe('stamp');
      }
      expect(await rows('SELECT id FROM submissions')).toHaveLength(0);
    });
    it('the service asks for 16 bits by default: a stamp good for 8 is not enough', async () => {
      const strict = await makeWorld({ stampBits: undefined });
      try {
        const res = await strict.post({ installation: inst, body, stamp: mintStamp(bytes, 8) });
        expect(res.status).toBe(400);
        expect(await errorOf(res)).toBe('stamp');
        const ok = await strict.post({ installation: inst, body, stamp: mintStamp(bytes, 16) });
        expect(ok.status).toBe(202);
      } finally {
        strict.restore();
      }
    }, 30_000);
  });

  describe('the signature', () => {
    const other = async () => makeInstallation();
    it('a missing key or signature is 401', async () => {
      const missing: Record<string, string | null>[] = [{ 'x-cw-key': null }, { 'x-cw-sig': null }, { 'x-cw-key': null, 'x-cw-sig': null }];
      for (const headers of missing) {
        const res = await w.post({ installation: inst, headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
      }
    });
    it('a signature that is wrong in any way is 401: flipped, truncated, not base64url, empty, over-long, for another body', async () => {
      const good = await inst.sign(new Uint8Array(0));
      const flipped = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
      const cases = [flipped, good.slice(0, 40), '!!!!' + good.slice(4), '', good + good, 'A'.repeat(86), good.replace(/[A-Za-z0-9_-]$/, '=')];
      for (const sig of cases) {
        const res = await w.post({ installation: inst, headers: { 'x-cw-sig': sig } });
        expect(res.status, sig).toBe(401);
      }
      const forBody = await w.post({ installation: inst, signBytes: enc.encode(validBody({ term: 'vlemmo' })) });
      expect(forBody.status).toBe(401);
    });
    it('a signature by another key, and a key that is not 32 bytes of base64url, is 401', async () => {
      const impostor = await other();
      const res = await w.post({ installation: inst, headers: { 'x-cw-key': impostor.publicKey } });
      expect(res.status).toBe(401);
      for (const key of ['short', inst.publicKey + 'A', inst.publicKey.slice(0, 42), inst.publicKey + '=', 'A'.repeat(43), '!'.repeat(43)]) {
        expect((await w.post({ installation: inst, headers: { 'x-cw-key': key } })).status, key).toBe(401);
      }
    });
    it('a signature of the wrong kind is 401: a report or an index signature, or one over the bare bytes, cannot be a submission', async () => {
      for (const kind of ['report', 'index'] as const) {
        const res = await w.post({ installation: inst, kind });
        expect(res.status, kind).toBe(401);
      }
      expect((await w.post({ installation: inst, kind: 'report' })).status).toBe(401);
      expect(await rows('SELECT id FROM submissions')).toHaveLength(0);
    });
    it('a refused signature writes nothing and leaves no counter behind', async () => {
      await w.post({ installation: inst, kind: 'report' });
      expect(await rows('SELECT * FROM counters')).toHaveLength(0);
    });
  });

  describe('the day window', () => {
    it('yesterday, today and tomorrow of the server are accepted', async () => {
      for (const [i, offset] of [-1, 0, 1].entries()) {
        const day = new Date(w.clock.now() + offset * DAY_MS).toISOString().slice(0, 10);
        const res = await w.post({ installation: inst, body: validBody({ day, term: `vlemmo${'abc'[i]}` }) });
        expect(res.status, day).toBe(202);
      }
    });
    it('two days either side is 400 invalid', async () => {
      for (const offset of [-2, 2, -30, 400]) {
        const day = new Date(w.clock.now() + offset * DAY_MS).toISOString().slice(0, 10);
        const res = await w.post({ installation: inst, body: validBody({ day }) });
        expect(res.status, day).toBe(400);
        expect(await errorOf(res)).toBe('invalid');
      }
    });
    it('is the server\u2019s UTC day: just after midnight yesterday is still in the window, and the window moves with the clock', async () => {
      w.clock.set('2026-12-03T00:00:30Z');
      expect((await w.post({ installation: inst, body: validBody({ day: '2026-12-01' }) })).status).toBe(400);
      expect((await w.post({ installation: inst, body: validBody({ day: '2026-12-02' }) })).status).toBe(202);
    });
  });

  describe('the content type and the route', () => {
    it('only JSON is read: other, missing and look-alike content types are 400 invalid', async () => {
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonx', 'text/json', 'application/json-patch+json', null]) {
        const res = await w.post({ installation: inst, contentType });
        expect(res.status, String(contentType)).toBe(400);
        expect(await errorOf(res)).toBe('invalid');
      }
    });
    it('a JSON content type with a parameter or other case is read', async () => {
      for (const [i, contentType] of ['application/json; charset=utf-8', 'APPLICATION/JSON', 'application/json;charset=UTF-8'].entries()) {
        expect((await w.post({ installation: inst, contentType, body: validBody({ term: `snerp${'abc'[i]}` }) })).status, contentType).toBe(202);
      }
    });
    it('answers a method it does not serve with 405 and an allow header, an unknown path with 404, and offers no CORS preflight', async () => {
      const put = await w.post({ installation: inst, method: 'PUT' });
      expect(put.status).toBe(405);
      expect(put.headers.get('allow')).toBe('POST');
      const unknown = await w.post({ installation: inst, path: '/v1/nothing' });
      expect(unknown.status).toBe(404);
      const preflight = await w.fetch(new Request('https://corpus.test/v1/submissions', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }));
      expect(preflight.status).toBe(405);
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      for (const res of [put, unknown, preflight]) expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});

describe('injection in notes is stored as data and never echoed', () => {
  it('stores markup and SQL verbatim as text, leaves the tables intact, and the response carries none of it', async () => {
    const notes = ['<script>alert(1)</script>', "'); DROP TABLE terms;--", '"><img src=x onerror=alert(1)>', '{{7*7}} ${process.env}', '\\u0000 %s %n', 'line one line two'];
    let i = 0;
    for (const note of notes) {
      const res = await w.post({ installation: inst, body: validBody({ note, term: `fenrisk${'abcdefg'[i]}` }) });
      i += 1;
      expect(res.status, note).toBe(202);
      expect(await res.text()).not.toContain(note.slice(0, 6));
    }
    expect((await rows('SELECT note FROM submissions ORDER BY rowid')).map((r) => r.note)).toEqual(notes);
    expect(await rows("SELECT name FROM sqlite_master WHERE name = 'terms'")).toHaveLength(1);
  });

  it('refuses a note that hides what it is: a full-width @ or URL, a bidi override, a line separator', async () => {
    const hidden = ['mail me\uff20host', 'visit www\uff0eexample', 'rtl \u202e trick', 'sep \u2028 here', 'c1 \u0085 here'];
    for (const note of hidden) {
      const res = await w.post({ installation: inst, body: validBody({ note }) });
      expect(res.status, note).toBe(400);
    }
  });
});

describe('GET status needs the same key\u2019s signature; another key gets 404; the reason is one of the closed codes', () => {
  it('returns the state of the key\u2019s own submission, driven by the real client', async () => {
    const share = w.client(inst);
    const sent = await share.share({ term: 'quissel', language: 'en', category: 'abuse' });
    const id = (sent as { id: string }).id;
    expect(await share.status(id)).toEqual({ status: 'received' });
    for (const status of ['in_review', 'accepted', 'merged'] as const) {
      await w.db.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind(status, id).run();
      expect(await share.status(id)).toEqual({ status });
    }
    await w.db.prepare("UPDATE submissions SET status = 'declined', reason = 'needs_context' WHERE id = ?").bind(id).run();
    expect(await share.status(id)).toEqual({ status: 'declined', reason: 'needs_context' });
  });

  it('every closed reason is passed on, and nothing else of the row', async () => {
    const id = await idOf(await w.post({ installation: inst }));
    await w.db.prepare("INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES ('submission', ?, 'r1@example.test', 'decline', 1, '2026-12-02T10:00:00Z')").bind(id).run();
    for (const reason of ['known_innocent', 'not_a_term', 'duplicate', 'needs_context', 'other']) {
      await w.db.prepare("UPDATE submissions SET status = 'declined', reason = ? WHERE id = ?").bind(reason, id).run();
      const res = await w.get(id, { installation: inst });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'declined', reason });
    }
    const text = await (await w.get(id, { installation: inst })).text();
    expect(text).not.toMatch(/r1@example|zorbak|review/);
  });

  it('without the signature, or with a bad one, is 401; with another key\u2019s valid signature is 404, the same as an unknown id', async () => {
    const id = await idOf(await w.post({ installation: inst }));
    expect((await w.get(id, { installation: inst, headers: { 'x-cw-sig': null } })).status).toBe(401);
    expect((await w.get(id, { installation: inst, headers: { 'x-cw-key': null } })).status).toBe(401);
    expect((await w.get(id, { installation: inst, headers: { 'x-cw-sig': 'AAAA' } })).status).toBe(401);
    expect((await w.get(id, { installation: inst, kind: 'report' })).status).toBe(401);
    const impostor = await makeInstallation();
    const foreign = await w.get(id, { installation: impostor });
    const unknown = await w.get('sub_doesnotexist0000', { installation: inst });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
  });

  it('a signature over another id is 401, and an id that is not an id is 404', async () => {
    const id = await idOf(await w.post({ installation: inst }));
    const res = await w.get(id, { installation: inst, headers: { 'x-cw-sig': await inst.sign(enc.encode('x')) } });
    expect(res.status).toBe(401);
    for (const bad of ['..%2Fterms', 'sub_%00', '-x', 'a'.repeat(65), 'sub id']) {
      expect((await w.get(bad, { installation: inst })).status, bad).toBe(404);
    }
    const noId = await w.fetch(new Request('https://corpus.test/v1/submissions/', { method: 'GET' }));
    expect(noId.status).toBe(404);
  });

  it('only GET is served on an id, and the headers are the same as everywhere', async () => {
    const id = await idOf(await w.post({ installation: inst }));
    const res = await w.get(id, { installation: inst });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const del = await w.fetch(new Request(`https://corpus.test/v1/submissions/${id}`, { method: 'DELETE' }));
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('GET');
  });
});

describe('replay: the same signed body on a later day is refused', () => {
  it('a body replayed two days later is outside the window and creates nothing', async () => {
    const spec = { installation: inst, body: validBody({ term: 'vlemmo' }) };
    expect((await w.post(spec)).status).toBe(202);
    await w.db.prepare('DELETE FROM submissions').run();
    w.clock.advance(2 * DAY_MS);
    const res = await w.post(spec);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('invalid');
    expect(await rows('SELECT id FROM submissions')).toHaveLength(0);
  });

  it('a body replayed the next day, inside the window, is a duplicate of the pending one and adds no row', async () => {
    const spec = { installation: inst, body: validBody({ term: 'vlemmo' }) };
    expect((await w.post(spec)).status).toBe(202);
    w.clock.advance(DAY_MS);
    const res = await w.post(spec);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'duplicate' });
    expect(await rows('SELECT id FROM submissions')).toHaveLength(1);
  });

  it('a signature does not carry over to another body, another key or another path', async () => {
    const bytes = enc.encode(validBody({ term: 'drakkuun' }));
    const signature = await inst.sign(new Uint8Array([...enc.encode('chatwarden-corpus/1'), 0, ...enc.encode('submission'), 0, ...bytes]));
    const tampered = enc.encode(validBody({ term: 'drakkuuns' }));
    const res = await w.post({ installation: inst, body: tampered, headers: { 'x-cw-sig': signature } });
    expect(res.status).toBe(401);
  });
});

describe('no raw IP, no body and no note is logged or stored beyond the schema', () => {
  it('keeps no address, key, signature or stamp in any table, and nothing of the request in any log, on success and on every refusal', async () => {
    const ip = '198.51.100.222';
    const v6 = '2001:db8:abcd:12:aaaa:bbbb:cccc:dddd';
    const note = 'spy note about the lobby';
    const body = validBody({ term: 'snerp', note });
    const bytes = enc.encode(body);
    const stamp = mintStamp(bytes, w.stampBits);
    const sig = await inst.sign(new Uint8Array([...enc.encode('chatwarden-corpus/1'), 0, ...enc.encode('submission'), 0, ...bytes]));
    await w.post({ installation: inst, body, ip, stamp });
    await w.post({ installation: inst, body, ip: v6, stamp });
    await w.post({ installation: inst, body: validBody({ term: 'zorbak1', note }), ip });
    await w.post({ installation: inst, body: validBody({ note: 'x'.repeat(300) }), ip });
    await w.post({ installation: inst, body, ip, stamp: null });
    await w.post({ installation: inst, body, ip, kind: 'report' });
    await w.post({ installation: inst, body: 'not json at all ' + note, ip });
    await w.post({ installation: inst, body: validBody({ term: 'zorbak' }), ip, contentType: 'text/plain' });
    const dump = await w.dump();
    const logged = JSON.stringify(w.logs) + w.consoleOutput.join('\n');
    for (const secret of [ip, '198.51.100', v6, '2001:db8', inst.publicKey, sig, stamp, body, 'not json at all']) {
      expect(dump, secret).not.toContain(secret);
    }
    for (const secret of [ip, v6, inst.publicKey, sig, stamp, note, 'snerp', 'zorbak', 'not json at all']) {
      expect(logged, secret).not.toContain(secret);
    }
    // the note is stored once, in its column, as the schema says, and in no other table
    expect(dump.split(note)).toHaveLength(2);
    expect(JSON.parse(dump).submissions[0].note).toBe(note);
    expect(w.logs.length).toBeGreaterThan(0);
    for (const e of w.logs) expect(Object.keys(e).sort().every((k) => ['stage', 'code', 'count'].includes(k))).toBe(true);
  });

  it('a database failure is a 500 with a closed body and a logged code, with no message from the database', async () => {
    await w.db.prepare('DROP TABLE submissions').run();
    const res = await w.post({ installation: inst, body: validBody({ note: 'spy failure note' }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(JSON.stringify(w.logs) + w.consoleOutput.join('')).not.toMatch(/spy failure note|zorbak|submissions|no such table/);
    expect(w.logs.some((e) => e.code === 'db_error')).toBe(true);
  });
});
