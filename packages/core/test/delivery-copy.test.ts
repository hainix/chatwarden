import { describe, expect, it } from 'vitest';
import { untilText } from '../src/noticeCopy.js';
import { APPEAL_REASONS } from '../src/appeals.js';
import type { AppealReasonCode } from '../src/appeals.js';
import { buildDeliveryContent, escapeHtml, noticeWordsFor } from '../src/noticeLocales.js';
import type { NoticeKind } from '../src/types.js';

// The delivery text: what a game sends by email (or any channel) when a sanction is given and when an appeal is decided. Plain text and a
// small HTML body; nothing from the player's own lines; every word escaped in the HTML.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const URL = 'https://game.example/appeal?t=abc.def';

type Input = Parameters<typeof buildDeliveryContent>[0];
type NoticeIn = Input['notice'];
const notice = (over: Partial<NoticeIn> = {}): NoticeIn => ({ kind: 'chat', rule: 2, ruleLabel: 'Community Rule 2: No insulting players', until: NOW + 24 * HOUR, refCode: 'M-ABCDE', createdAt: NOW, ...over });
const sanction = (locale: string, over: Partial<NoticeIn> = {}, appealUrl: string | null = URL): Input => ({
  words: noticeWordsFor(locale).words,
  locale,
  kind: 'sanction',
  notice: notice(over),
  appealUrl,
});
const outcome = (
  locale: string,
  status: 'upheld' | 'reduced' | 'revoked',
  reason: AppealReasonCode,
  standing: Input['standing'],
  appealUrl: string | null = URL,
): Input => ({
  words: noticeWordsFor(locale).words,
  locale,
  kind: 'appeal_outcome',
  notice: notice({ kind: `appeal_${status}` as NoticeKind, until: null }),
  outcome: { status, reason },
  standing,
  appealUrl,
});
const lines = (text: string): string[] => text.split('\n');
const utc = (at: number, locale = 'en'): string => `${untilText(at, locale, 'UTC')} UTC`;

describe('the subject', () => {
  it('a 24-hour chat restriction in English', () => {
    expect(buildDeliveryContent(sanction('en')).subject).toBe('Your chat has been restricted for 24 hours');
  });

  it('every kind, timed and without an end', () => {
    expect(buildDeliveryContent(sanction('en', { kind: 'chat', until: null })).subject).toBe('Your chat has been restricted');
    expect(buildDeliveryContent(sanction('en', { kind: 'ban', until: null })).subject).toBe('You have been banned');
    expect(buildDeliveryContent(sanction('en', { kind: 'ban', until: NOW + 72 * HOUR })).subject).toBe('You have been banned for 72 hours');
    expect(buildDeliveryContent(sanction('en', { kind: 'ban', until: NOW + 7 * DAY })).subject).toBe('You have been banned for 7 days');
    expect(buildDeliveryContent(sanction('en', { kind: 'warning', until: null })).subject).toBe('You have received a warning');
    expect(buildDeliveryContent(sanction('en', { kind: 'area', until: NOW + HOUR })).subject).toBe('You cannot join public rooms');
    expect(buildDeliveryContent(sanction('en', { kind: 'area', until: null })).subject).toBe('You cannot join public rooms');
  });

  it('the length is read against when the notice was made', () => {
    expect(buildDeliveryContent(sanction('en', { createdAt: NOW - 5 * HOUR, until: NOW + HOUR })).subject).toBe('Your chat has been restricted for 6 hours');
    expect(buildDeliveryContent(sanction('en', { until: NOW + 30 * 60_000 })).subject).toBe('Your chat has been restricted for 30 minutes');
  });

  it('es and pt have a subject for every kind, with no placeholder left unfilled', () => {
    for (const locale of ['es', 'pt']) {
      for (const kind of ['warning', 'chat', 'area', 'ban'] as const) {
        for (const until of [null, NOW + 24 * HOUR]) {
          const subject = buildDeliveryContent(sanction(locale, { kind, until: kind === 'warning' ? null : until })).subject;
          expect(subject.length, `${locale} ${kind}`).toBeGreaterThan(3);
          expect(subject, `${locale} ${kind}`).not.toMatch(/[{}]/);
          expect(subject, `${locale} ${kind}`).not.toBe(buildDeliveryContent(sanction('en', { kind, until: kind === 'warning' ? null : until })).subject);
        }
      }
    }
    expect(buildDeliveryContent(sanction('es')).subject).toContain('24 horas');
    expect(buildDeliveryContent(sanction('pt')).subject).toContain('24 horas');
  });

  it('an appeal outcome has its own subject', () => {
    expect(buildDeliveryContent(outcome('en', 'upheld', 'rule_applies', null)).subject).toBe('We reviewed your appeal: the decision stands');
    expect(buildDeliveryContent(outcome('en', 'reduced', 'lighter_fits', null)).subject).toBe('We reviewed your appeal: the decision was made lighter');
    expect(buildDeliveryContent(outcome('en', 'revoked', 'mistake', null)).subject).toBe('We reviewed your appeal: the decision was lifted');
  });
});

describe('the text', () => {
  it('holds the title, the body, the rule label, the end in UTC, the reference, the appeal hint and the URL, and the footer', () => {
    const { text } = buildDeliveryContent(sanction('en'));
    const l = lines(text);
    expect(l[0]).toBe('Your chat is turned off');
    expect(l).toContain('A moderator turned off your chat. You can still play.');
    expect(l).toContain('Rule: Community Rule 2: No insulting players');
    expect(l).toContain(`Until: ${utc(NOW + 24 * HOUR)}`);
    expect(l).toContain('Reference: M-ABCDE');
    const hint = l.indexOf('If you think this was a mistake, you can appeal it here.');
    expect(hint).toBeGreaterThan(0);
    expect(l[hint + 1]).toBe(URL);
    expect(l).toContain('Times are in UTC.');
    expect(l[l.length - 1]).toBe('You are receiving this message because of a moderation decision about your account.');
  });

  it('a warning says when it leaves the record; a ban with no end says so', () => {
    expect(lines(buildDeliveryContent(sanction('en', { kind: 'warning', until: null })).text)).toContain(`On your record until: ${utc(NOW + 90 * DAY)}`);
    expect(lines(buildDeliveryContent(sanction('en', { kind: 'ban', until: null })).text)).toContain('Until: No end date');
  });

  it('leaves out the rule and the reference when the notice has none', () => {
    const text = buildDeliveryContent(sanction('en', { rule: null, ruleLabel: null, refCode: null })).text;
    expect(text).not.toContain('Rule:');
    expect(text).not.toContain('Reference:');
  });

  it('reads in the language: es and pt', () => {
    const es = buildDeliveryContent(sanction('es')).text;
    expect(lines(es)[0]).toBe('Tu chat est\u00e1 desactivado');
    expect(es).toContain(' UTC');
    expect(es).toContain(URL);
    expect(es).not.toContain('Times are in UTC.');
    expect(buildDeliveryContent(sanction('pt')).text).not.toContain('Times are in UTC.');
  });

  it('with no appeal link there is no hint and no URL anywhere, in the text or the HTML', () => {
    const c = buildDeliveryContent(sanction('en', {}, null));
    for (const part of [c.text, c.html]) {
      expect(part).not.toContain('appeal it here');
      expect(part).not.toContain('http');
      expect(part).not.toContain('Appeal this decision');
    }
    expect(c.html).not.toContain('<a ');
    const o = buildDeliveryContent(outcome('en', 'upheld', 'rule_applies', null, null));
    for (const part of [o.text, o.html]) {
      expect(part).not.toContain('You can see the decision here.');
      expect(part).not.toContain('http');
    }
  });

  it('has no trailing whitespace on any line, no carriage return, and ends with the footer', () => {
    for (const input of [sanction('en'), sanction('es', { kind: 'ban', until: null }), sanction('pt', { kind: 'warning', until: null }, null), outcome('en', 'reduced', 'lighter_fits', { kind: 'chat', until: NOW + HOUR })]) {
      const { text } = buildDeliveryContent(input);
      for (const line of lines(text)) expect(line, JSON.stringify(line)).toBe(line.trimEnd());
      expect(text).not.toContain('\r');
      expect(text.endsWith(input.words['delivery.footer'] as string)).toBe(true);
    }
  });

  it('is the same every time for the same input', () => {
    expect(buildDeliveryContent(sanction('en'))).toEqual(buildDeliveryContent(sanction('en')));
  });
});

describe('an appeal outcome', () => {
  const pairs: Array<['upheld' | 'reduced' | 'revoked', AppealReasonCode]> = [
    ...APPEAL_REASONS.uphold.map((c) => ['upheld', c] as ['upheld', AppealReasonCode]),
    ...APPEAL_REASONS.reduce.map((c) => ['reduced', c] as ['reduced', AppealReasonCode]),
    ...APPEAL_REASONS.revoke.map((c) => ['revoked', c] as ['revoked', AppealReasonCode]),
  ];

  it('carries the reason sentence of its outcome and code, all 9 pairs, in every language', () => {
    expect(pairs).toHaveLength(9);
    for (const locale of ['en', 'es', 'pt']) {
      const words = noticeWordsFor(locale).words;
      for (const [status, code] of pairs) {
        const sentence = words[`player.appeal.reason.${status}.${code}`] as string;
        const { text } = buildDeliveryContent(outcome(locale, status, code, null));
        expect(lines(text), `${locale} ${status} ${code}`).toContain(`${words['delivery.reason']}: ${sentence}`);
      }
    }
  });

  it('a code that does not belong to the outcome reads as the context sentence of that outcome', () => {
    const { text } = buildDeliveryContent(outcome('en', 'upheld', 'mistake', null));
    expect(text).toContain('Reason: We looked at the whole situation, and the decision stands.');
  });

  it('the title and body are the outcome notice words, and the link is the outcome hint', () => {
    const { text } = buildDeliveryContent(outcome('en', 'revoked', 'mistake', null));
    const l = lines(text);
    expect(l[0]).toBe('We looked again and removed the decision');
    expect(l).toContain('A moderator read your appeal and took the decision off your record.');
    const hint = l.indexOf('You can see the decision here.');
    expect(hint).toBeGreaterThan(0);
    expect(l[hint + 1]).toBe(URL);
    expect(text).not.toContain('appeal it here');
  });

  it('a reduce shows the standing sanction; a revoke shows none; an uphold shows no standing line', () => {
    const reduced = buildDeliveryContent(outcome('en', 'reduced', 'lighter_fits', { kind: 'chat', until: NOW + 2 * HOUR })).text;
    expect(lines(reduced)).toContain(`On your record now: Your chat is turned off (Until: ${utc(NOW + 2 * HOUR)})`);
    const toWarning = buildDeliveryContent(outcome('en', 'reduced', 'first_offence', { kind: 'warning', until: null })).text;
    expect(lines(toWarning)).toContain('On your record now: You have a warning');
    const noEnd = buildDeliveryContent(outcome('en', 'reduced', 'first_offence', { kind: 'ban', until: null })).text;
    expect(lines(noEnd)).toContain('On your record now: You are banned (No end date)');
    const revoked = buildDeliveryContent(outcome('en', 'revoked', 'mistake', null)).text;
    expect(revoked).not.toContain('On your record now');
    const upheld = buildDeliveryContent(outcome('en', 'upheld', 'rule_applies', { kind: 'chat', until: NOW + HOUR })).text;
    expect(upheld).not.toContain('On your record now');
    const revokedWithStanding = buildDeliveryContent(outcome('en', 'revoked', 'mistake', { kind: 'chat', until: NOW + HOUR })).text;
    expect(revokedWithStanding).toContain('On your record now');
  });

  it('the reference is the original sanction reference, and no end fact is shown for the message itself', () => {
    const { text } = buildDeliveryContent(outcome('en', 'upheld', 'rule_applies', null));
    expect(lines(text)).toContain('Reference: M-ABCDE');
    expect(text).not.toContain('Until:');
  });
});

describe('the HTML', () => {
  it('is a small document: a title, a heading, a paragraph, the facts as a list, the link and the footer', () => {
    const { html } = buildDeliveryContent(sanction('en'));
    expect(html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Your chat has been restricted for 24 hours</title></head><body>')).toBe(true);
    expect(html).toContain('<h1>Your chat is turned off</h1>');
    expect(html).toContain('<p>A moderator turned off your chat. You can still play.</p>');
    expect(html).toContain('<ul><li>Rule: Community Rule 2: No insulting players</li>');
    expect(html).toContain(`<a href="${URL}">Appeal this decision</a>`);
    expect(html).toContain('<p>Times are in UTC.</p>');
    expect(html.endsWith('</body></html>')).toBe(true);
    // no script, no remote resource, no style
    for (const needle of ['<script', 'src=', '<link', '<img', '<style', 'style=', 'onerror', 'onclick', '<iframe']) expect(html, needle).not.toContain(needle);
  });

  it('is escaped: a game word with a script and a quote, a hostile locale and a hostile url never make a tag or break an attribute', () => {
    const words = noticeWordsFor('en', { en: { 'delivery.footer': '<script>alert("x")</script>', 'delivery.appealLink': '"><img src=x onerror=alert(1)>', 'player.notice.body.chat': "it's <b>bold</b> & more" } }).words;
    const hostileUrl = 'https://x.test/?a=1&b="><script>alert(1)</script>';
    const { html, text } = buildDeliveryContent({
      words,
      locale: 'en"><script>alert(2)</script>',
      kind: 'sanction',
      notice: notice({ ruleLabel: '<i>rule</i>', refCode: '"><script>' }),
      appealUrl: hostileUrl,
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('lang="en&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"');
    expect(html).toContain('<a href="https://x.test/?a=1&amp;b=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
    expect(html).toContain('it&#39;s &lt;b&gt;bold&lt;/b&gt; &amp; more');
    // the text is plain text: words are as they are
    expect(text).toContain('<script>alert("x")</script>');
  });

  it('a link that is not http or https gets no href, and no hint, in the text or the HTML', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.test/', ' https://x.test/', 'HTTPS://X.TEST/', '//x.test/', '/appeal', '', 'https:/x']) {
      const c = buildDeliveryContent(sanction('en', {}, url));
      expect(c.html, url).not.toContain('href');
      expect(c.html, url).not.toContain('<a ');
      expect(c.text, url).not.toContain('appeal it here');
    }
    expect(buildDeliveryContent(sanction('en', {}, 'http://localhost:3000/appeal?t=x')).html).toContain('<a href="http://localhost:3000/appeal?t=x">');
  });

  it('every language declares itself in lang', () => {
    for (const locale of ['en', 'es', 'pt']) expect(buildDeliveryContent(sanction(locale)).html).toContain(`<html lang="${locale}">`);
  });
});

describe('escapeHtml', () => {
  it('escapes & < > " and the apostrophe, ampersand first', () => {
    expect(escapeHtml('<a href="x">it\'s & that</a>')).toBe('&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; that&lt;/a&gt;');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml('plain text')).toBe('plain text');
    expect(escapeHtml('')).toBe('');
  });
});

describe('no excerpt line can reach the email', () => {
  it('the input type has no excerpt, and a notice that carries one is ignored', () => {
    const dirty = notice({ kind: 'chat' }) as NoticeIn & { excerpt: Array<{ text: string; day: string }> };
    dirty.excerpt = [{ text: 'a line of the player with snerp in it', day: '2027-01-15' }];
    const base = sanction('en');
    const withLines = buildDeliveryContent({ ...base, notice: dirty });
    expect(withLines.text).not.toContain('snerp');
    expect(withLines.html).not.toContain('snerp');
    expect(withLines.text).not.toContain('Your messages that led to this');
    expect(withLines).toEqual(buildDeliveryContent(base));
    // for every kind and for an outcome too
    for (const kind of ['warning', 'chat', 'area', 'ban'] as const) {
      const n = { ...notice({ kind, until: kind === 'warning' ? null : NOW + HOUR }), excerpt: [{ text: 'secret snerp line', day: '2027-01-15' }] };
      const c = buildDeliveryContent({ ...base, notice: n });
      expect(c.text + c.html).not.toContain('snerp');
    }
    const o = outcome('en', 'upheld', 'rule_applies', null);
    const c = buildDeliveryContent({ ...o, notice: { ...o.notice, excerpt: [{ text: 'secret snerp line', day: 'x' }] } as NoticeIn });
    expect(c.text + c.html).not.toContain('snerp');
  });
});
