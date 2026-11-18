import { describe, expect, it } from 'vitest';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import { ALICE, BOB, bodyOf, errorOf } from './playerWorld.js';
import { htmlOf, landingWorld, locationOf } from './landingWorld.js';

// The no-JavaScript path: a form posts urlencoded, the answer is 303 with an empty body, and a plain GET of the location shows the result. A refusal is a short code
// in the location, never text from the request. The json path (a game's own page) answers with status codes.

const en = noticeWordsFor('en').words;
const T = (key: string): string => en[key] as string;

describe('a urlencoded post', () => {
  it('files, answers 303 with an empty body and the location ../appeal?t=...&lang=en; following it shows the sent state; reading again does not file a second appeal', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const res = await w.postForm({ t: s.token, statement: 'It was not me.', lang: 'en' });
    expect(res.status).toBe(303);
    expect(res.body).toBe('');
    expect(locationOf(res)).toBe(`../appeal?t=${s.token}&lang=en`);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.headers?.['referrer-policy']).toBe('no-referrer');
    expect(Object.keys(res.headers ?? {})).not.toContain('set-cookie');
    expect(w.identifyCalls).toEqual([]);
    expect(w.appealRows()).toHaveLength(1);

    // the browser follows the location with a GET (the relative reference is resolved against /appeal/case)
    const url = new URL(locationOf(res), 'https://game.example/appeal/case');
    expect(url.pathname).toBe('/appeal');
    const followed = await w.page(url.searchParams.get('t') as string, { query: { lang: url.searchParams.get('lang') as string } });
    const html = htmlOf(followed);
    expect(html).toMatch(/Appeal sent [^<]*UTC\./);
    expect(html).not.toContain('<form');
    for (let i = 0; i < 3; i++) await w.page(s.token);
    expect(w.appealRows()).toHaveLength(1);
    expect(w.appealRows()[0]).toMatchObject({ noticeId: s.noticeId, status: 'open', statement: 'It was not me.' });
  });

  it('the lang field sets the language of the redirect, an unknown one is English, and no field means the accept-language header', async () => {
    const w = await landingWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanctioned(ALICE);
    const b = await w.sanctioned(BOB);
    const c = await w.sanctioned({ clientKey: 'raw-key-fred-0006-secret', ip: '203.0.113.16' });
    expect(locationOf(await w.postForm({ t: a.token, statement: 'It was not me.', lang: 'es' }))).toBe(`../appeal?t=${a.token}&lang=es`);
    expect(locationOf(await w.postForm({ t: b.token, statement: 'It was not me.', lang: 'zz' }))).toBe(`../appeal?t=${b.token}&lang=en`);
    expect(locationOf(await w.postForm({ t: c.token, statement: 'It was not me.' }, { headers: { 'accept-language': 'pt-BR,pt;q=0.9' } }))).toBe(`../appeal?t=${c.token}&lang=pt`);
  });

  it('the token in the location is the token that was posted, percent-encoded by URLSearchParams (a token charset never needs it)', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const res = await w.postForm({}, { raw: `statement=It+was+not+me.&t=${s.token}` });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`../appeal?t=${s.token}&lang=en`);
  });
});

describe('a refusal is a code in the location', () => {
  it('an empty statement is e=invalid; the page then shows the message with the limit', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const res = await w.postForm({ t: s.token, statement: '   ' });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`../appeal?t=${s.token}&lang=en&e=invalid`);
    expect(w.appealRows()).toEqual([]);
    const html = htmlOf(await w.page(s.token, { query: { e: 'invalid' } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(T('player.appealPage.refused.invalid').replace('{max}', '1000'));
    expect(html).toContain('<form');
  });

  it('the same notice again is e=already', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    expect(locationOf(await w.postForm({ t: s.token, statement: 'It was not me.' }))).toBe(`../appeal?t=${s.token}&lang=en`);
    const again = await w.postForm({ t: s.token, statement: 'It was not me, really.' });
    expect(locationOf(again)).toBe(`../appeal?t=${s.token}&lang=en&e=already`);
    expect(htmlOf(await w.page(s.token, { query: { e: 'already' } }))).toContain(T('player.appealPage.refused.already'));
    expect(w.appealRows()).toHaveLength(1);
  });

  it('the weekly cap is e=rate with the seconds to wait in r, and the page says when', async () => {
    const w = await landingWorld({ appeals: { perPlayerPerWeek: 1 } });
    const first = await w.sanctioned(ALICE);
    const second = await w.sanctioned(ALICE);
    expect(locationOf(await w.postForm({ t: first.token, statement: 'It was not me.' }))).toBe(`../appeal?t=${first.token}&lang=en`);
    const res = await w.postForm({ t: second.token, statement: 'It was not me either.' });
    const url = new URL(locationOf(res), 'https://game.example/appeal/case');
    expect(url.searchParams.get('e')).toBe('rate');
    const r = Number(url.searchParams.get('r'));
    expect(Number.isInteger(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(7 * 24 * 3600);
    expect(Array.from(url.searchParams.keys())).toEqual(['t', 'lang', 'e', 'r']);
    const html = htmlOf(await w.page(second.token, { query: { e: 'rate', r: String(r) } }));
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/Try again in \d+ (days?|hours?|minutes?)\./);
  });

  it('a notice that is only a decided view (a revoked group) is e=not_appealable', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned(ALICE, { kind: 'chat', durationMs: 6 * w.HOUR });
    const filed = w.cw.appeals.fileByLink(s.token, { statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    await w.cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'revoke', actor: 'senior_bea', reason: 'r', reasonCode: 'mistake' });
    const res = await w.postForm({ t: s.token, statement: 'again' });
    expect(locationOf(res)).toBe(`../appeal?t=${s.token}&lang=en&e=not_appealable`);
    // a notice that was withdrawn with no appeal is no link at all: nothing to redirect for
    const lifted = await w.sanctioned(BOB);
    await w.cw.sanctions.revoke(lifted.groupId, 'mod_cy', 'lifted');
    expect(locationOf(await w.postForm({ t: lifted.token, statement: 'x' }))).toBe(`../appeal?t=${lifted.token}&lang=en`);
  });

  it('over the write limit is e=busy', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (let i = 0; i < 10; i++) await w.postForm({ t: s.token, statement: '' }, { remoteAddress: '198.51.100.30' });
    const res = await w.postForm({ t: s.token, statement: 'It was not me.' }, { remoteAddress: '198.51.100.30' });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`../appeal?t=${s.token}&lang=en&e=busy`);
    expect(w.appealRows()).toEqual([]);
    expect(htmlOf(await w.page(s.token, { query: { e: 'busy' } }))).toContain(T('player.appealPage.refused.busy'));
  });

  it('a bad token redirects with no e, and the page it lands on says the link is invalid', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const [p, sig] = s.token.split('.') as [string, string];
    const forged = `${p}.${sig.slice(0, 42)}${sig.endsWith('A') ? 'B' : 'A'}`;
    const res = await w.postForm({ t: forged, statement: 'It was not me.' });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`../appeal?t=${forged}&lang=en`);
    const landed = await w.page(forged);
    expect(landed.status).toBe(404);
    expect(htmlOf(landed)).toContain(T('player.appealPage.invalid'));
    // no token at all
    expect(locationOf(await w.postForm({ statement: 'x' }))).toBe('../appeal?lang=en');
  });

  it('a hostile e and r in the query are ignored: not whitelisted, no alert', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const queries: Array<Record<string, string>> = [{ e: 'script' }, { e: '<b>' }, { e: 'INVALID' }, { e: '' }, { e: 'toString' }, { e: '__proto__' }, { e: 'rate', r: 'abc' }, { e: 'rate', r: '12345678' }, { e: 'rate', r: '-5' }, { r: '5' }];
    for (const query of queries) {
      const html = htmlOf(await w.page(s.token, { query }));
      if (query.e === 'rate') {
        // a whitelisted code with a bad r: the alert is the busy sentence (no time to quote), never the garbage
        expect(html).toContain(T('player.appealPage.refused.busy'));
      } else {
        expect(html, JSON.stringify(query)).not.toContain('role="alert"');
      }
      expect(html).not.toContain('12345678');
    }
    // a good r is used: 90 seconds is two minutes
    expect(htmlOf(await w.page(s.token, { query: { e: 'rate', r: '90' } }))).toContain('Try again in 2 minutes.');
  });

  it('the location never contains the statement, the notice id or the person', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (const statement of ['', 'secret words here', 'x'.repeat(2000)]) {
      const res = await w.postForm({ t: s.token, statement });
      expect(locationOf(res)).not.toContain('secret');
      expect(locationOf(res)).not.toContain(s.noticeId);
      expect(locationOf(res)).not.toContain(s.subject);
      expect(locationOf(res).length).toBeLessThan(700);
    }
  });
});

describe('the statement as the core cleans it', () => {
  it('CRLF newlines in the form are stored as newlines; 1000 characters is fine and 1001 is e=invalid with nothing cut', async () => {
    const w = await landingWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanctioned(ALICE);
    expect(locationOf(await w.postForm({ t: a.token, statement: 'line one\r\nline two' }))).toBe(`../appeal?t=${a.token}&lang=en`);
    const stored = w.appealRows().find((r) => r.noticeId === a.noticeId)?.statement as string;
    expect(stored).not.toContain('\r');
    expect(stored).toBe('line one\nline two');

    const b = await w.sanctioned(BOB);
    const thousand = 'a'.repeat(1000);
    expect(locationOf(await w.postForm({ t: b.token, statement: thousand }))).toBe(`../appeal?t=${b.token}&lang=en`);
    expect(w.appealRows().find((r) => r.noticeId === b.noticeId)?.statement).toBe(thousand);

    const c = await w.sanctioned({ clientKey: 'raw-key-gina-0007-secret', ip: '203.0.113.17' });
    expect(locationOf(await w.postForm({ t: c.token, statement: 'a'.repeat(1001) }))).toBe(`../appeal?t=${c.token}&lang=en&e=invalid`);
    expect(w.appealRows().find((r) => r.noticeId === c.noticeId)).toBeUndefined();
  });
});

describe('the content types', () => {
  it('json with an extra key, a missing key or a non-string value is 400 invalid_request; so is no body, an array and text', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const bad: unknown[] = [
      { t: s.token, statement: 'x', extra: 1 },
      { t: s.token },
      { statement: 'x' },
      { t: 7, statement: 'x' },
      { t: s.token, statement: 7 },
      { t: s.token, statement: null },
      [s.token, 'x'],
      'just a string',
      null,
    ];
    for (const body of bad) {
      const res = await w.postJson(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    const empty = await w.call('POST', '/appeal/case', { headers: { 'content-type': 'application/json' } });
    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toBe('invalid_request');
    expect(w.appealRows()).toEqual([]);
  });

  it('invalid json is 400 invalid_json and a forbidden key 400 forbidden_key (the kit parser)', async () => {
    const w = await landingWorld();
    expect(errorOf(await w.call('POST', '/appeal/case', { raw: '{nope', headers: { 'content-type': 'application/json' } }))).toBe('invalid_json');
    expect(errorOf(await w.call('POST', '/appeal/case', { raw: '{"__proto__":{"x":1},"t":"a","statement":"b"}', headers: { 'content-type': 'application/json' } }))).toBe('forbidden_key');
  });

  it('text/plain, multipart, no content-type and a made-up one are 400 invalid_request', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/xml', undefined]) {
      const res = await w.call('POST', '/appeal/case', { raw: JSON.stringify({ t: s.token, statement: 'x' }), ...(type === undefined ? {} : { headers: { 'content-type': type } }) });
      expect(res.status, String(type)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
  });

  it('the content type is read by its media type: case and a charset parameter are fine', async () => {
    const w = await landingWorld({ appeals: { perPlayerPerWeek: 20 } });
    const a = await w.sanctioned(ALICE);
    const res = await w.call('POST', '/appeal/case', { raw: JSON.stringify({ t: a.token, statement: 'It was not me.' }), headers: { 'content-type': 'Application/JSON; charset=utf-8' } });
    expect(res.status).toBe(200);
    const b = await w.sanctioned(BOB);
    const form = await w.call('POST', '/appeal/case', { raw: new URLSearchParams({ t: b.token, statement: 'It was not me.' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    expect(form.status).toBe(303);
  });

  it('a urlencoded body over 64 KiB is 413 payload_too_large; a json one too', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const big = await w.postForm({}, { raw: `t=${s.token}&statement=${'a'.repeat(65_536)}` });
    expect(big.status).toBe(413);
    expect(errorOf(big)).toBe('payload_too_large');
    const json = await w.call('POST', '/appeal/case', { raw: JSON.stringify({ t: s.token, statement: 'a'.repeat(65_536) }), headers: { 'content-type': 'application/json' } });
    expect(json.status).toBe(413);
    expect(w.appealRows()).toEqual([]);
  });
});

describe('the json answers', () => {
  it('ok is 200 with the fresh case; statement_invalid 400 invalid_statement; already 409; the weekly cap 429 with retry-after; not found and not appealable 404', async () => {
    const w = await landingWorld({ appeals: { perPlayerPerWeek: 1 } });
    const first = await w.sanctioned(ALICE);
    const second = await w.sanctioned(ALICE);
    const empty = await w.postJson({ t: first.token, statement: '' });
    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toBe('invalid_statement');
    const ok = await w.postJson({ t: first.token, statement: 'It was not me.' });
    expect(ok.status).toBe(200);
    expect(bodyOf(ok)).toMatchObject({ canAppeal: false, appeal: { status: 'open' } });
    const again = await w.postJson({ t: first.token, statement: 'again' });
    expect(again.status).toBe(409);
    expect(errorOf(again)).toBe('already_appealed');
    const rate = await w.postJson({ t: second.token, statement: 'It was not me.' });
    expect(rate.status).toBe(429);
    expect(errorOf(rate)).toBe('rate_limited');
    expect(Number(rate.headers?.['retry-after'])).toBeGreaterThanOrEqual(1);
    const forged = await w.postJson({ t: 'forged.token', statement: 'x' });
    expect(forged.status).toBe(404);
    expect(errorOf(forged)).toBe('not_found');
    for (const res of [empty, ok, again, rate, forged]) expect(res.headers?.['cache-control']).toBe('no-store');
    expect(w.identifyCalls).toEqual([]);
  });
});

describe('one answer for what the person cannot act on', () => {
  it('json: a decided view (not appealable) is the same 404 not_found as a forged link', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned(ALICE);
    const filed = w.cw.appeals.fileByLink(s.token, { statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    await w.cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'revoke', actor: 'senior_bea', reason: 'r', reasonCode: 'mistake' });
    const decidedView = await w.postJson({ t: s.token, statement: 'again' }, { remoteAddress: '198.51.100.40' });
    const forged = await w.postJson({ t: 'forged.token', statement: 'again' }, { remoteAddress: '198.51.100.41' });
    expect(decidedView.status).toBe(404);
    expect(JSON.stringify(decidedView.body)).toBe(JSON.stringify(forged.body));
  });
});
