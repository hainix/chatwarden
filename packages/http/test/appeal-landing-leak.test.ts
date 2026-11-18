import { describe, expect, it } from 'vitest';
import type { RawWho } from '@chatwarden/core';
import { APPEAL_PAGE_CSP } from '@chatwarden/http';
import { ALICE, BOB, bodyOf, CAROL, HOUR, RAW_VALUES } from './playerWorld.js';
import { htmlOf, ID_RE, landingWorld, locationOf } from './landingWorld.js';
import type { LandingWorld } from './landingWorld.js';

// What the landing page and its json may carry: one sanction, as the person was given it, and the state of its one appeal. Nothing else the kit holds: no staff
// field, no id, no private reason, no other person's notice, no other rule's text. The page is fed seeded values that must never come out.

const PRIVATE = ['private moderator reason text', 'mod_ann', 'senior_bea', 'private decision reason'];

/** Plant a sanction group and its notice straight into the store (for values the live path would not produce). */
function plant(w: LandingWorld, subject: string, id: string, o: { excerpt?: Array<{ text: string; day: string }>; rule?: string; kind?: 'chat' | 'ban'; withdrawnAt?: number | null } = {}) {
  const kind = o.kind ?? 'chat';
  w.store.insertSanctionGroup([
    {
      id: `row-${id}`,
      groupId: `g-${id}`,
      refCode: `M-${id.toUpperCase().padEnd(5, 'X').slice(0, 5)}`,
      kind,
      targetType: 'subject',
      value: subject,
      startsAt: w.clock.t,
      endsAt: kind === 'ban' ? null : w.clock.t + 6 * HOUR,
      reason: 'private moderator reason text',
      rule: o.rule ?? '2',
      gapNote: null,
      gapStatus: null,
      roomId: null,
      actor: 'mod_ann',
      source: 'moderator',
      automated: false,
      pending: false,
    },
  ]);
  w.store.insertNotice({
    id: `n-${id}`,
    subject,
    groupId: `g-${id}`,
    kind,
    rule: o.rule ?? '2',
    until: kind === 'ban' ? null : w.clock.t + 6 * HOUR,
    refCode: `M-${id.toUpperCase().padEnd(5, 'X').slice(0, 5)}`,
    excerpt: o.excerpt ?? [],
    createdAt: w.clock.t,
    ackedAt: null,
    withdrawnAt: o.withdrawnAt ?? null,
  });
  return { noticeId: `n-${id}`, groupId: `g-${id}` };
}

describe('the keys of the case json', () => {
  it('has exactly the AppealCase key sets, in every state of the appeal', async () => {
    const w = await landingWorld();
    const none = await w.sanctioned(ALICE, { kind: 'chat' });
    const open = await w.sanctioned(BOB, { kind: 'chat' });
    const upheld = await w.sanctioned(CAROL, { kind: 'chat' });
    await w.postJson({ t: open.token, statement: 'It was not me.' });
    const f = w.cw.appeals.fileByLink(upheld.token, { statement: 'It was not me.' });
    if (!f.ok) throw new Error('filing refused');
    await w.cw.appeals.decide({ appealId: f.appeal.id, outcome: 'uphold', actor: 'senior_bea', reason: 'private decision reason', reasonCode: 'rule_applies' });

    const CASE = ['appeal', 'canAppeal', 'contact', 'emailsOutcome', 'expiresAt', 'notice', 'standing', 'statementMax'];
    const NOTICE = ['createdAt', 'excerpt', 'kind', 'refCode', 'rule', 'ruleLabel', 'until'];
    for (const [name, token] of [['none', none.token], ['open', open.token], ['upheld', upheld.token]] as const) {
      const body = bodyOf(await w.caseJson(token));
      expect(Object.keys(body).sort(), name).toEqual(CASE);
      expect(Object.keys(body.notice as object).sort(), name).toEqual(NOTICE);
      if (name === 'none') {
        expect(body.appeal).toBeNull();
        expect(body.standing).toBeNull();
      } else {
        expect(Object.keys(body.appeal as object).sort(), name).toEqual(['createdAt', 'decidedAt', 'reason', 'status']);
      }
      if (name === 'upheld') expect(Object.keys(body.standing as object).sort()).toEqual(['kind', 'state', 'until']);
    }
  });
});

describe('nothing seeded comes out, in any state', () => {
  it('the page and the json carry none of the staff fields, ids, credentials, other notices or other rules, before, during and after an appeal', async () => {
    const w = await landingWorld();
    const mine = await w.sanctioned(ALICE, { kind: 'chat', rule: 2 });
    // another person's notice and a third appeal (Bob files his own through the same routes)
    const bobs = await w.sanctioned(BOB, { kind: 'ban', durationMs: null, rule: 3 });
    const filedByBob = w.cw.appeals.fileByLink(bobs.token, { statement: 'Bob statement unique-bob-marker' });
    expect(filedByBob.ok).toBe(true);
    const other = w.cw.rules.active().find((r) => r.number === 5) ?? w.cw.rules.active().find((r) => r.number !== 2 && r.number !== 3);
    expect(other).toBeDefined();
    const reporterKey = 'raw-key-reporter-1-secret';
    const secrets: string[] = [
      ...PRIVATE,
      ...RAW_VALUES,
      reporterKey,
      mine.noticeId,
      mine.groupId,
      mine.subject,
      mine.reportId,
      bobs.noticeId,
      bobs.groupId,
      bobs.subject,
      bobs.refCode,
      'unique-bob-marker',
      (other as { title: string }).title,
      (other as { text: string }).text,
    ].filter((s): s is string => typeof s === 'string' && s !== '');

    const scan = async (label: string) => {
      const answers = [await w.page(mine.token), await w.caseJson(mine.token)];
      for (const res of answers) {
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        const head = JSON.stringify(res.headers ?? {});
        for (const secret of secrets) {
          expect(text, `${label}: ${secret}`).not.toContain(secret);
          expect(head, `${label} headers: ${secret}`).not.toContain(secret);
        }
        // The token (the one thing meant to be there) is random text: it is taken out before the shape scans.
        const bare = text.replaceAll(mine.token, '');
        expect(bare, label).not.toMatch(ID_RE);
        expect(bare, label).not.toMatch(/\b[0-9a-f]{32,}\b/);
      }
    };

    await scan('no appeal');
    expect((await w.postJson({ t: mine.token, statement: 'my own statement marker-xyz' })).status).toBe(200);
    await scan('open');
    // decide it three ways on three notices of the same person is not possible (one appeal per notice): decide this one, then check the other outcomes on new people
    const mineAppeal = w.appealRows().find((a) => a.noticeId === mine.noticeId);
    expect(mineAppeal).toBeDefined();
    await w.cw.appeals.decide({ appealId: (mineAppeal as { id: string }).id, outcome: 'reduce', actor: 'senior_bea', reason: 'private decision reason', reasonCode: 'first_offence', to: { kind: 'warning', durationMs: null } });
    await scan('reduced');

    for (const [outcome, code] of [['uphold', 'rule_applies'], ['revoke', 'mistake']] as const) {
      const who: RawWho = { clientKey: `raw-key-leak-${outcome}-secret`, ip: '203.0.113.77' };
      const s = await w.sanctioned(who);
      const f = w.cw.appeals.fileByLink(s.token, { statement: 'st' });
      if (!f.ok) throw new Error('filing refused');
      await w.cw.appeals.decide({ appealId: f.appeal.id, outcome, actor: 'senior_bea', reason: 'private decision reason', reasonCode: code });
      for (const res of [await w.page(s.token), await w.caseJson(s.token)]) {
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        for (const secret of [...PRIVATE, ...RAW_VALUES, s.noticeId, s.groupId, s.subject, who.clientKey as string]) expect(text, `${outcome}: ${secret}`).not.toContain(secret);
        expect(text.replaceAll(s.token, '')).not.toMatch(ID_RE);
      }
    }
  });

  it('the redirect, the 303 and the 404 carry none of them either', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const res = await w.postForm({ t: s.token, statement: 'a statement marker-abc', lang: 'en' });
    expect(res.status).toBe(303);
    const text = JSON.stringify(res);
    for (const secret of [...PRIVATE, ...RAW_VALUES, s.noticeId, s.groupId, s.subject, 'marker-abc']) expect(text, secret).not.toContain(secret);
    expect(locationOf(res)).toBe(`../appeal?t=${s.token}&lang=en`);
  });
});

describe('hostile data is escaped', () => {
  const HOSTILE = '<script>alert(1)</script> "quoted" & \'single\' <img src=x onerror=alert(2)>';

  it('an excerpt line, a contact and a game word with markup, quotes and ampersands come out escaped and the page has no script', async () => {
    const w = await landingWorld({
      appeals: { contact: HOSTILE, words: { en: { 'player.appealPage.title': `T ${HOSTILE}`, 'player.notice.rule': `R ${HOSTILE}` } } },
    });
    const s = await w.sanctioned(ALICE);
    const p = plant(w, s.subject, 'hostile', { excerpt: [{ text: HOSTILE, day: '2027-01-15' }] });
    const token = w.tokenFor(p.noticeId);
    const html = htmlOf(await w.page(token));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img');
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&#39;single&#39;');
    // the same data in the json is data (JSON.stringify is the escape there) and is the real text
    const body = bodyOf(await w.caseJson(token));
    expect(body.contact).toBe(HOSTILE);
    expect(JSON.stringify(body)).toContain('alert(1)');
  });

  it('a token with a quote, an angle bracket or a space never reaches the html: the route refuses the charset first', async () => {
    const w = await landingWorld();
    for (const t of ['"><script>alert(1)</script>', 'a"b', "a'b", 'a<b', 'a b', 'a/b', 'a\u00e9b', `${'a'.repeat(513)}`]) {
      const res = await w.page(t);
      expect(res.status, t).toBe(404);
      expect(htmlOf(res), t).not.toContain(t.slice(0, 20));
      expect(htmlOf(res)).not.toContain('<form');
      const post = await w.postForm({ t, statement: 'x' });
      expect(post.status, t).toBe(303);
      expect(locationOf(post), t).toBe('../appeal?lang=en');
    }
  });

  it('a hostile e and r in the query are ignored (not whitelisted), and a hostile lang is not echoed', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const html = htmlOf(await w.page(s.token, { query: { e: '<script>alert(1)</script>', r: '<b>', lang: '"><i>' } }));
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/<script|<i>|<b>/);
  });
});

describe('the statement is never echoed', () => {
  const MARK = 'SECRET-STATEMENT-MARKER-0042';

  it('not in the page after filing, not in the redirect, not in the json, not in any log', async () => {
    for (const mode of ['json', 'form'] as const) {
      const w = await landingWorld();
      const s = await w.sanctioned();
      const res = mode === 'json' ? await w.postJson({ t: s.token, statement: `It was not me. ${MARK}` }) : await w.postForm({ t: s.token, statement: `It was not me. ${MARK}` });
      expect(JSON.stringify(res), mode).not.toContain(MARK);
      for (const answer of [await w.page(s.token), await w.caseJson(s.token), res]) expect(JSON.stringify(answer), mode).not.toContain(MARK);
      expect(JSON.stringify(w.logged), mode).not.toContain(MARK);
      // the statement is stored (the moderator reads it), and only there
      expect(w.appealRows().map((a) => a.statement)).toEqual([`It was not me. ${MARK}`]);
    }
  });

  it('a refused statement is not echoed either', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const res = await w.postForm({ t: s.token, statement: MARK.repeat(60) });
    expect(res.status).toBe(303);
    expect(JSON.stringify(res)).not.toContain(MARK);
    expect(locationOf(res)).toContain('e=invalid');
    expect(JSON.stringify(await w.page(s.token, { query: { e: 'invalid' } }))).not.toContain(MARK);
  });
});

describe('the page loads and runs nothing', () => {
  it('no script, no style attribute, no link or image or frame, no address, and the CSP is exactly APPEAL_PAGE_CSP, in every state', async () => {
    const w = await landingWorld({ appeals: { contact: 'help-desk-line' } });
    const a = await w.sanctioned(ALICE);
    const b = await w.sanctioned(BOB);
    await w.postJson({ t: b.token, statement: 'It was not me.' });
    const pages = [await w.page(a.token), await w.page(b.token), await w.page('forged'), await w.page(a.token, { query: { e: 'busy' } }), await w.page(undefined)];
    for (const res of pages) {
      const html = htmlOf(res);
      expect(res.headers?.['content-security-policy']).toBe(APPEAL_PAGE_CSP);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/<(link|img|iframe|object|embed|video|audio|source|base)\b/i);
      expect(html).not.toMatch(/\b(src|href)\s*=/i);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toMatch(/url\(|@import/i);
      expect(html.match(/<style/g)?.length).toBe(1);
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
    }
    expect(APPEAL_PAGE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  });
});
