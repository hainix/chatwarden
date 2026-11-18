import { describe, expect, it } from 'vitest';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import { APPEAL_PAGE_CSP } from '@chatwarden/http';
import { ALICE, BOB, bodyOf, errorOf } from './playerWorld.js';
import { bytesOf, htmlOf, landingWorld, ORIGIN } from './landingWorld.js';
import type { LandingWorld } from './landingWorld.js';

// The appeal landing routes: GET /appeal (the page), GET /appeal/case (the same case as JSON), POST /appeal/case (file) and OPTIONS /appeal/case. A signed link is the only
// credential: no identify call, no cookie. These tests drive the real routes over a real SQLite store and a real signed link.

const en = noticeWordsFor('en').words;
const es = noticeWordsFor('es').words;
const pt = noticeWordsFor('pt').words;
const T = (words: Record<string, string>, key: string): string => words[key] as string;

const HEADERS_ALL = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
} as const;

describe('GET /appeal with a good link', () => {
  it('answers 200 html with every header, no cookie, no identify call, and the notice as the person was given it', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned(ALICE, { kind: 'chat', durationMs: 6 * w.HOUR });
    const res = await w.page(s.token);
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(HEADERS_ALL)) expect(res.headers?.[name], name).toBe(value);
    expect(res.headers?.['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers?.['content-security-policy']).toBe(APPEAL_PAGE_CSP);
    expect(res.headers?.['x-frame-options']).toBe('DENY');
    expect(Object.keys(res.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(w.identifyCalls).toEqual([]);
    const html = htmlOf(res);
    expect(html).toContain(T(en, 'player.notice.title.chat'));
    expect(html).toContain(T(en, 'player.notice.body.chat'));
    expect(html).toContain(s.refCode);
    expect(html).toContain(T(en, 'player.notice.refHint'));
    expect(html).toContain(T(en, 'player.notice.rule'));
    expect(html).toContain(T(en, 'player.notice.until'));
    expect(html).toContain(T(en, 'delivery.times'));
    expect(html).toContain('<form method="post" action="appeal/case">');
    expect(html).toContain(`<input type="hidden" name="t" value="${s.token}">`);
    expect(html).toContain('name="statement" maxlength="1000"');
    expect(html).toContain('<html lang="en">');
    expect(w.logged).toEqual([]);
  });

  it('a warning and a ban (no end) show the right facts', async () => {
    const w = await landingWorld();
    const warn = await w.sanctioned(ALICE, { kind: 'warning' });
    expect(htmlOf(await w.page(warn.token))).toContain(T(en, 'player.notice.onRecordUntil'));
    const ban = await w.sanctioned(BOB, { kind: 'ban', durationMs: null });
    expect(htmlOf(await w.page(ban.token))).toContain(T(en, 'player.notice.noEnd'));
  });

  it('GET /appeal/case answers the case itself with the same headers, no wrapper', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const res = await w.caseJson(s.token);
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(HEADERS_ALL)) expect(res.headers?.[name], name).toBe(value);
    const body = bodyOf(res);
    expect(body).toMatchObject({ canAppeal: true, appeal: null, standing: null, statementMax: 1000 });
    expect((body.notice as { refCode: string }).refCode).toBe(s.refCode);
    expect(w.identifyCalls).toEqual([]);
  });
});

describe('the language', () => {
  const titleOf = (w: Record<string, string>) => T(w, 'player.appealPage.title');

  it('?lang=es, and accept-language es-MX, give the Spanish words and lang="es"', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (const res of [await w.page(s.token, { query: { lang: 'es' } }), await w.page(s.token, { headers: { 'accept-language': 'es-MX,es;q=0.9,en;q=0.5' } })]) {
      const html = htmlOf(res);
      expect(html).toContain('<html lang="es">');
      expect(html).toContain(titleOf(es));
      expect(html).toContain(T(es, 'player.notice.title.chat'));
      expect(html).not.toContain(titleOf(en));
    }
  });

  it('accept-language is read by q-value: "fr;q=0.9, pt;q=0.8" is Portuguese, "es;q=0, en" is English, and ?lang wins over the header', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': 'fr;q=0.9, pt;q=0.8' } }))).toContain(`<title>${titleOf(pt)}</title>`);
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': 'es;q=0, en' } }))).toContain('<html lang="en">');
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': 'es;q=0' } }))).toContain('<html lang="en">');
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': 'es;q=0.3, pt;q=0.9' } }))).toContain('<html lang="pt">');
    expect(htmlOf(await w.page(s.token, { query: { lang: 'pt' }, headers: { 'accept-language': 'es' } }))).toContain('<html lang="pt">');
  });

  it('?lang=xx, a 64-character lang, a long header and a header of garbage give English; lang is never echoed', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const evil = 'zz-evil<script>alert(1)</script>';
    for (const res of [
      await w.page(s.token, { query: { lang: 'xx' } }),
      await w.page(s.token, { query: { lang: 'e'.repeat(64) } }),
      await w.page(s.token, { query: { lang: evil } }),
      await w.page(s.token, { headers: { 'accept-language': `${'x'.repeat(600)},es` } }),
      await w.page(s.token, { headers: { 'accept-language': ';;;,,q=,\u0000' } }),
    ]) {
      const html = htmlOf(res);
      expect(html).toContain('<html lang="en">');
      expect(html).not.toContain('evil');
      expect(html).not.toContain('alert(1)');
    }
  });

  it('a tag over 35 characters is skipped, not fatal: the next one is read', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': `${'a'.repeat(40)}, es` } }))).toContain('<html lang="es">');
  });

  it('only the first ten tags of the header count', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const filler = Array.from({ length: 10 }, (_, i) => `x${String.fromCharCode(97 + i)}`).join(',');
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': `${filler},es` } }))).toContain('<html lang="en">');
    expect(htmlOf(await w.page(s.token, { headers: { 'accept-language': 'xa,xb,es' } }))).toContain('<html lang="es">');
  });

  it("a game's own language (appeals.words) is chosen and its words show", async () => {
    const w = await landingWorld({ appeals: { words: { de: { 'player.appealPage.title': 'Einspruch einlegen' } } } });
    const s = await w.sanctioned();
    const html = htmlOf(await w.page(s.token, { query: { lang: 'de' } }));
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('Einspruch einlegen');
  });
});

describe('a bad link is one answer', () => {
  it('forged, expired, erased, withdrawn, missing, too long and an array t all answer the same status, headers and bytes', async () => {
    const w = await landingWorld();
    const good = await w.sanctioned(ALICE, { kind: 'ban', durationMs: null });
    expect((await w.page(good.token)).status).toBe(200);
    const [payload, sig] = good.token.split('.') as [string, string];
    const forged = `${payload}.${sig.slice(0, 42)}${sig.endsWith('A') ? 'B' : 'A'}`;

    const gone = await w.sanctioned(BOB, { kind: 'ban', durationMs: null });
    await w.cw.privacy.erase(gone.subject, { keep: 'none', actor: 'owner_ann' });

    const lifted = await w.sanctioned({ clientKey: 'raw-key-dave-0004-secret', ip: '203.0.113.14' }, { kind: 'ban', durationMs: null });
    await w.cw.sanctions.revoke(lifted.groupId, 'mod_cy', 'lifted');

    const brief = await w.sanctioned({ clientKey: 'raw-key-erin-0005-secret', ip: '203.0.113.15' }, { kind: 'ban', durationMs: null });
    const expired = w.tokenFor(brief.noticeId, { ttlMs: w.HOUR });
    w.advance(2 * w.HOUR);

    const answers = new Map<string, string>();
    const bad: Array<[string, Awaited<ReturnType<LandingWorld['page']>>]> = [
      ['forged', await w.page(forged)],
      ['payload forged', await w.page(`${payload.slice(0, 4)}${payload[4] === 'A' ? 'B' : 'A'}${payload.slice(5)}.${sig}`)],
      ['junk', await w.page('not-a-token')],
      ['erased', await w.page(gone.token)],
      ['withdrawn by a revoke', await w.page(lifted.token)],
      ['expired', await w.page(expired)],
      ['missing', await w.page(undefined)],
      ['too long', await w.page('a'.repeat(600))],
      ['bad charset', await w.page('a b"<c>')],
      ['array', await w.call('GET', '/appeal', { query: { t: ['a', 'b'] as unknown as string } })],
      ['empty', await w.page('')],
    ];
    for (const [name, res] of bad) answers.set(name, bytesOf(res));
    for (const [name, res] of bad) expect(res.status, name).toBe(404);
    expect(new Set(answers.values()).size).toBe(1);
    const html = htmlOf(bad[0]![1]);
    expect(html).toContain(T(en, 'player.appealPage.invalid'));
    expect(html).not.toContain('<form');
    expect(html).not.toContain(T(en, 'player.notice.title.ban'));
    for (const [, res] of bad) {
      for (const [name, value] of Object.entries(HEADERS_ALL)) expect(res.headers?.[name], name).toBe(value);
      expect(res.headers?.['content-security-policy']).toBe(APPEAL_PAGE_CSP);
      expect(res.headers?.['x-frame-options']).toBe('DENY');
    }
    expect(w.identifyCalls).toEqual([]);
  });

  it('GET /appeal/case answers every bad link with the same 404 json', async () => {
    const w = await landingWorld();
    const good = await w.sanctioned();
    const [payload, sig] = good.token.split('.') as [string, string];
    const answers = [
      await w.caseJson(`${payload}.${sig.slice(0, 42)}${sig.endsWith('A') ? 'B' : 'A'}`),
      await w.caseJson('not-a-token'),
      await w.caseJson(undefined),
      await w.caseJson('a'.repeat(600)),
      await w.call('GET', '/appeal/case', { query: { t: ['a', 'b'] as unknown as string } }),
    ];
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(errorOf(a)).toBe('not_found');
    }
    expect(new Set(answers.map(bytesOf)).size).toBe(1);
  });

  it('a bad link does not reveal whether the notice exists: a real id signed with another secret reads like a forged one', async () => {
    const w = await landingWorld();
    const good = await w.sanctioned();
    const sig = good.token.split('.')[1] as string;
    const other = await landingWorld();
    const foreign = await other.sanctioned();
    expect(bytesOf(await w.page(foreign.token))).toBe(bytesOf(await w.page(`${good.token.split('.')[0]}.${sig.slice(0, 42)}${sig.endsWith('A') ? 'B' : 'A'}`)));
  });
});

describe('appeals off', () => {
  it('all four routes answer the 404 not_found json, the identify hook is never called and nothing is counted', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    w.cw.policy.save({ appeals: { enabled: false } }, { version: 0, actor: 'owner', reason: 'off' });
    const off = [
      await w.page(s.token),
      await w.caseJson(s.token),
      await w.postJson({ t: s.token, statement: 'it was not me' }),
      await w.postForm({ t: s.token, statement: 'it was not me' }),
      await w.options(ORIGIN),
    ];
    for (const res of off) {
      expect(res.status).toBe(404);
      expect(errorOf(res)).toBe('not_found');
      expect(res.headers?.['cache-control']).toBe('no-store');
    }
    // the answers differ only in the headers the CORS routes add (vary, allow-origin): the body is the one 404 json
    expect(new Set(off.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(w.identifyCalls).toEqual([]);
    expect(w.appealRows()).toEqual([]);
    // Hammer it far past every limit while off, then turn appeals on: the limiters were never touched.
    for (let i = 0; i < 80; i++) await w.page(s.token, { remoteAddress: '198.51.100.9' });
    for (let i = 0; i < 20; i++) await w.postJson({ t: s.token, statement: 'x' }, { remoteAddress: '198.51.100.9' });
    w.cw.policy.save({ appeals: { enabled: true } }, { version: 1, actor: 'owner', reason: 'on' });
    expect((await w.page(s.token, { remoteAddress: '198.51.100.9' })).status).toBe(200);
    expect((await w.postJson({ t: s.token, statement: 'It was not me.' }, { remoteAddress: '198.51.100.9' })).status).toBe(200);
  });
});

describe('after filing through the link', () => {
  it('the page shows "Appeal sent <date>" with the return line and no form (or the email line when the game emails outcomes)', async () => {
    for (const emailsOutcome of [false, true]) {
      const w = await landingWorld({ appeals: { emailsOutcome } });
      const s = await w.sanctioned();
      const filed = await w.postJson({ t: s.token, statement: 'It was not me.' });
      expect(filed.status).toBe(200);
      expect(bodyOf(filed)).toMatchObject({ canAppeal: false, appeal: { status: 'open', decidedAt: null, reason: null } });
      const html = htmlOf(await w.page(s.token));
      expect(html).toMatch(/Appeal sent [^<]*UTC\./);
      expect(html).toContain(emailsOutcome ? T(en, 'player.appealPage.sent.email') : T(en, 'player.appealPage.sent.return'));
      expect(html).not.toContain(emailsOutcome ? T(en, 'player.appealPage.sent.return') : T(en, 'player.appealPage.sent.email'));
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<textarea');
    }
  });
});

describe('after the decision', () => {
  async function decided(outcome: 'uphold' | 'reduce' | 'revoke', code: string) {
    const w = await landingWorld();
    const s = await w.sanctioned(ALICE, { kind: 'chat', durationMs: 6 * w.HOUR });
    const filed = w.cw.appeals.fileByLink(s.token, { statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    const res = await w.cw.appeals.decide({
      appealId: filed.appeal.id,
      outcome,
      actor: 'senior_bea',
      reason: 'private decision reason',
      reasonCode: code,
      ...(outcome === 'reduce' ? { to: { kind: 'warning', durationMs: null } } : {}),
    } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    return { w, s };
  }

  it('uphold: the outcome, the fixed reason, and the sanction still standing with its end', async () => {
    const { w, s } = await decided('uphold', 'rule_applies');
    const html = htmlOf(await w.page(s.token));
    expect(html).toContain(T(en, 'player.appealPage.decided'));
    expect(html).toContain(T(en, 'player.appealPage.outcome.upheld'));
    expect(html).toContain(T(en, 'player.appeal.reason.upheld.rule_applies'));
    expect(html).toMatch(new RegExp(`${T(en, 'player.appealPage.standing')}</h2>\\s*<p><strong>${T(en, 'player.notice.title.chat')}</strong></p>`));
    expect(html).not.toContain(T(en, 'player.appealPage.standing.none'));
    expect(html).not.toContain('<form');
    expect(html).not.toContain('private decision reason');
    expect(html).not.toContain('senior_bea');
  });

  it('reduce (the notice is now withdrawn, the link still opens): the outcome, the reason, the lighter sanction', async () => {
    const { w, s } = await decided('reduce', 'lighter_fits');
    const res = await w.page(s.token);
    expect(res.status).toBe(200);
    const html = htmlOf(res);
    expect(html).toContain(T(en, 'player.appealPage.outcome.reduced'));
    expect(html).toContain(T(en, 'player.appeal.reason.reduced.lighter_fits'));
    expect(html).toMatch(new RegExp(`${T(en, 'player.appealPage.standing')}</h2>\\s*<p><strong>${T(en, 'player.notice.title.warning')}</strong></p>`));
  });

  it('revoke: the outcome, the reason and "nothing from this decision is on your record"', async () => {
    const { w, s } = await decided('revoke', 'mistake');
    const res = await w.page(s.token);
    expect(res.status).toBe(200);
    const html = htmlOf(res);
    expect(html).toContain(T(en, 'player.appealPage.outcome.revoked'));
    expect(html).toContain(T(en, 'player.appeal.reason.revoked.mistake'));
    expect(html).toContain(T(en, 'player.appealPage.standing.none'));
    expect(html).not.toContain('<form');
  });

  it('the Spanish page carries the Spanish outcome and reason sentences', async () => {
    const { w, s } = await decided('revoke', 'not_a_violation');
    const html = htmlOf(await w.page(s.token, { query: { lang: 'es' } }));
    expect(html).toContain(T(es, 'player.appealPage.outcome.revoked'));
    expect(html).toContain(T(es, 'player.appeal.reason.revoked.not_a_violation'));
  });
});

describe('the read limit', () => {
  it('the 61st GET in an hour from one address is 429 with retry-after and the busy words; another address is unaffected; the hour reopens it', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (let i = 0; i < 60; i++) expect((await w.page(s.token, { remoteAddress: '198.51.100.1' })).status, `get ${i + 1}`).toBe(200);
    const over = await w.page(s.token, { remoteAddress: '198.51.100.1' });
    expect(over.status).toBe(429);
    expect(Number(over.headers?.['retry-after'])).toBeGreaterThanOrEqual(1);
    for (const [name, value] of Object.entries(HEADERS_ALL)) expect(over.headers?.[name], name).toBe(value);
    expect(over.headers?.['content-security-policy']).toBe(APPEAL_PAGE_CSP);
    const html = htmlOf(over);
    expect(html).toContain(T(en, 'player.appealPage.refused.busy'));
    expect(html).not.toContain('<form');
    expect(html).not.toContain(T(en, 'player.notice.title.chat'));
    // another address is its own bucket (a read of another token, since the 61st read of this token is limited whoever sends it)
    const other = await w.sanctioned(BOB);
    expect((await w.page(other.token, { remoteAddress: '198.51.100.2' })).status).toBe(200);
    expect((await w.page(s.token, { remoteAddress: '198.51.100.2' })).status).toBe(429);
    w.advance(w.HOUR);
    expect((await w.page(s.token, { remoteAddress: '198.51.100.1' })).status).toBe(200);
  });

  it('bad tokens count too (a flood of forged ones is limited), and so does GET /appeal/case with a json 429', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (let i = 0; i < 60; i++) expect((await w.page(`forged.${i}`, { remoteAddress: '198.51.100.3' })).status).toBe(404);
    expect((await w.page(`forged.x`, { remoteAddress: '198.51.100.3' })).status).toBe(429);
    for (let i = 0; i < 60; i++) await w.caseJson(s.token, { remoteAddress: '198.51.100.4' });
    const over = await w.caseJson(s.token, { remoteAddress: '198.51.100.4' });
    expect(over.status).toBe(429);
    expect(errorOf(over)).toBe('rate_limited');
    expect(Number(over.headers?.['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('with no remote address the reads of one token share its bucket (never a global one), and an own read limit is taken from the options', async () => {
    const w = await landingWorld({ routeOptions: { landingReadRateLimit: { max: 2, windowMs: 60_000 } } });
    const s = await w.sanctioned();
    expect((await w.page(s.token)).status).toBe(200);
    expect((await w.page(s.token)).status).toBe(200);
    expect((await w.page(s.token)).status).toBe(429);
  });
});

describe('the write limit', () => {
  it('10 POSTs an hour per address, then 429 rate_limited with retry-after; another address is unaffected', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (let i = 0; i < 10; i++) {
      const res = await w.postJson({ t: s.token, statement: '' }, { remoteAddress: '198.51.100.5' });
      expect(res.status, `post ${i + 1}`).toBe(400);
      expect(errorOf(res)).toBe('invalid_statement');
    }
    const over = await w.postJson({ t: s.token, statement: '' }, { remoteAddress: '198.51.100.5' });
    expect(over.status).toBe(429);
    expect(errorOf(over)).toBe('rate_limited');
    expect(Number(over.headers?.['retry-after'])).toBeGreaterThanOrEqual(1);
    // another address is unaffected by the address limit (with another token: the token has its own limit)
    const other = await w.sanctioned(BOB);
    expect((await w.postJson({ t: other.token, statement: '' }, { remoteAddress: '198.51.100.6' })).status).toBe(400);
  });

  it('10 POSTs an hour per token too: a second address with the same token is limited by the token', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (let i = 0; i < 10; i++) expect((await w.postJson({ t: s.token, statement: '' }, { remoteAddress: `198.51.100.${20 + i}` })).status).toBe(400);
    const over = await w.postJson({ t: s.token, statement: '' }, { remoteAddress: '198.51.100.99' });
    expect(over.status).toBe(429);
    // another token from that same fresh address is fine (control)
    const other = await w.sanctioned(BOB);
    expect((await w.postJson({ t: other.token, statement: '' }, { remoteAddress: '198.51.100.99' })).status).toBe(400);
  });

  it('a forged token is counted against the address even though it is not valid', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 10; i++) expect((await w.postJson({ t: `forged.${i}`, statement: 'x' }, { remoteAddress: '198.51.100.7' })).status).toBe(404);
    expect((await w.postJson({ t: 'forged.z', statement: 'x' }, { remoteAddress: '198.51.100.7' })).status).toBe(429);
  });

  it('malformed bodies count too', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 10; i++) expect((await w.postJson({ junk: 1 }, { remoteAddress: '198.51.100.8' })).status).toBe(400);
    expect((await w.postJson({ junk: 1 }, { remoteAddress: '198.51.100.8' })).status).toBe(429);
  });
});

describe('the method and the table', () => {
  it('the four routes exist and other methods are 405 with allow', async () => {
    const w = await landingWorld();
    for (const key of ['GET /appeal', 'GET /appeal/case', 'POST /appeal/case', 'OPTIONS /appeal/case']) expect(Object.keys(w.routes), key).toContain(key);
    const put = await w.call('PUT', '/appeal/case');
    expect(put.status).toBe(405);
    expect(put.headers?.allow).toBe('GET, HEAD, OPTIONS, POST');
    expect((await w.call('POST', '/appeal')).status).toBe(405);
  });
});
