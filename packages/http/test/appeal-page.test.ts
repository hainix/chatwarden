import { describe, expect, it } from 'vitest';
import type { AppealCase } from '@chatwarden/core';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import { APPEAL_PAGE_CSP, renderAppealPage } from '../src/appealPage.js';
import type { AppealPageView } from '../src/appealPage.js';

// The appeal page template alone: a pure function of its view. The states in each language and with a game's own words, the placeholders filled, the stylesheet's dark
// and narrow rules, valid HTML, and every dynamic value escaped.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const base: AppealCase = {
  notice: {
    kind: 'chat',
    rule: 2,
    ruleLabel: 'No harassment',
    until: NOW + 6 * HOUR,
    refCode: 'M-ABCDE',
    createdAt: NOW,
    excerpt: [{ text: 'you ****', day: '2027-01-14' }],
  } as unknown as AppealCase['notice'],
  canAppeal: true,
  appeal: null,
  standing: null,
  expiresAt: NOW + 30 * 24 * HOUR,
  emailsOutcome: false,
  contact: null,
  statementMax: 1000,
};
const caseView = (locale: string, over: Partial<AppealCase> = {}, extra: Partial<Extract<AppealPageView, { state: 'case' }>> = {}, overrides?: Record<string, Record<string, string>>): AppealPageView => ({
  state: 'case',
  locale,
  words: noticeWordsFor(locale, overrides).words,
  token: 'abc.def',
  case: { ...base, ...over },
  now: NOW,
  ...extra,
});
const plainView = (state: 'invalid' | 'busy', locale = 'en', contact: string | null = null): AppealPageView => ({ state, locale, words: noticeWordsFor(locale).words, contact });

/** A small structural check: tags are balanced in order (void elements have no end tag). */
function balanced(html: string): string | null {
  const voids = new Set(['meta', 'input', 'br', 'hr', 'link', 'img']);
  const stack: string[] = [];
  const body = html.replace(/<style>[\s\S]*?<\/style>/, '<style></style>').replace(/<!doctype html>/i, '');
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*>/g)) {
    const [, close, name] = m;
    const tag = (name as string).toLowerCase();
    if (voids.has(tag)) continue;
    if (close === '') stack.push(tag);
    else if (stack.pop() !== tag) return `unexpected </${tag}>`;
  }
  // every `<` is part of a tag matched above
  const stray = body.replace(/<\/?[a-zA-Z][^>]*>/g, '').includes('<');
  if (stray) return 'a stray <';
  return stack.length === 0 ? null : `unclosed <${stack.join('>, <')}>`;
}

const LANGS = ['en', 'es', 'pt'] as const;

describe('the states', () => {
  it.each(LANGS)('invalid (%s): the invalid sentence, then the contact when set, and nothing of a case', (lang) => {
    const w = noticeWordsFor(lang).words;
    const html = renderAppealPage(plainView('invalid', lang, 'help@game.example'));
    expect(html).toContain(w['player.appealPage.invalid'] as string);
    expect(html).toContain((w['player.appealPage.contact'] as string).replace('{contact}', 'help@game.example'));
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<dl');
    expect(html).not.toContain(w['player.notice.title.chat'] as string);
    expect(renderAppealPage(plainView('invalid', lang))).not.toContain('help@game.example');
  });

  it.each(LANGS)('busy (%s): the busy sentence as an alert, no form', (lang) => {
    const html = renderAppealPage(plainView('busy', lang));
    expect(html).toContain(`role="alert"`);
    expect(html).toContain(noticeWordsFor(lang).words['player.appealPage.refused.busy'] as string);
    expect(html).not.toContain('<form');
  });

  it.each(LANGS)('can appeal (%s): the notice, the facts, the lines, the form with the token and language, the hint, the expiry', (lang) => {
    const w = noticeWordsFor(lang).words;
    const html = renderAppealPage(caseView(lang));
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(w['player.notice.title.chat'] as string);
    expect(html).toContain(w['player.notice.body.chat'] as string);
    expect(html).toContain('No harassment');
    expect(html).toContain('M-ABCDE');
    expect(html).toContain('you ****');
    expect(html).toContain(w['delivery.times'] as string);
    expect(html).toContain('<form method="post" action="appeal/case">');
    expect(html).toContain('<input type="hidden" name="t" value="abc.def">');
    expect(html).toContain(`<input type="hidden" name="lang" value="${lang}">`);
    expect(html).toContain('<label for="statement">');
    expect(html).toContain('<textarea id="statement" name="statement" maxlength="1000" rows="6" required></textarea>');
    expect(html).toContain((w['player.appealPage.form.hint'] as string).replace('{max}', '1000'));
    expect(html).toContain(w['player.appealPage.form.send'] as string);
    expect(html).toMatch(/UTC\.<\/p>/);
  });

  it.each(LANGS)('an open appeal (%s): sent with the date and the return line (or the email line), no form', (lang) => {
    const w = noticeWordsFor(lang).words;
    const open = { canAppeal: false, appeal: { status: 'open' as const, createdAt: NOW, decidedAt: null, reason: null } };
    const ret = renderAppealPage(caseView(lang, open));
    expect(ret).toContain(w['player.appealPage.sent.return'] as string);
    expect(ret).not.toContain(w['player.appealPage.sent.email'] as string);
    expect(ret).not.toContain('<form');
    const mail = renderAppealPage(caseView(lang, { ...open, emailsOutcome: true }));
    expect(mail).toContain(w['player.appealPage.sent.email'] as string);
    expect(mail).not.toContain(w['player.appealPage.sent.return'] as string);
    expect(ret).not.toMatch(/\{[a-z]+\}/);
  });

  it.each(LANGS)('decided (%s): the outcome sentence, the fixed reason sentence, and the standing sanction or nothing', (lang) => {
    const w = noticeWordsFor(lang).words;
    const done = (status: 'upheld' | 'reduced' | 'revoked', reason: AppealCase['appeal'] extends infer A ? (A extends { reason: infer R } ? R : never) : never, standing: AppealCase['standing']) =>
      renderAppealPage(caseView(lang, { canAppeal: false, appeal: { status, createdAt: NOW, decidedAt: NOW + HOUR, reason }, standing }));
    const up = done('upheld', 'rule_applies', { kind: 'chat', until: NOW + 6 * HOUR, state: 'active' });
    expect(up).toContain(w['player.appealPage.outcome.upheld'] as string);
    expect(up).toContain(w['player.appeal.reason.upheld.rule_applies'] as string);
    expect(up).toContain(w['player.appealPage.standing'] as string);
    expect(up).toMatch(new RegExp(`<h2>${w['player.appealPage.standing']}</h2>\\s*<p><strong>${w['player.notice.title.chat']}</strong></p>`));
    expect(up).not.toContain(w['player.appealPage.standing.none'] as string);
    const red = done('reduced', 'first_offence', { kind: 'warning', until: null, state: 'active' });
    expect(red).toContain(w['player.appealPage.outcome.reduced'] as string);
    expect(red).toContain(w['player.appeal.reason.reduced.first_offence'] as string);
    expect(red).toContain(w['player.notice.title.warning'] as string);
    const rev = done('revoked', 'not_a_violation', null);
    expect(rev).toContain(w['player.appealPage.outcome.revoked'] as string);
    expect(rev).toContain(w['player.appeal.reason.revoked.not_a_violation'] as string);
    expect(rev).toContain(w['player.appealPage.standing.none'] as string);
    // no reason stored: no reason sentence, the outcome stays
    const quiet = done('upheld', null, { kind: 'chat', until: NOW + 6 * HOUR, state: 'active' });
    expect(quiet).toContain(w['player.appealPage.outcome.upheld'] as string);
    expect(quiet).not.toContain(w['player.appeal.reason.upheld.rule_applies'] as string);
  });

  it('a standing that ended or was lifted reads as nothing on the record; an active one with no end says so', () => {
    const w = noticeWordsFor('en').words;
    const done = (standing: AppealCase['standing']) => renderAppealPage(caseView('en', { canAppeal: false, appeal: { status: 'upheld', createdAt: NOW, decidedAt: NOW, reason: 'rule_applies' }, standing }));
    for (const state of ['ended', 'lifted'] as const) {
      const html = done({ kind: 'chat', until: NOW - HOUR, state });
      expect(html).toContain(w['player.appealPage.standing.none'] as string);
      expect(html).not.toMatch(new RegExp(`<strong>${w['player.notice.title.chat']}</strong>`));
    }
    expect(done({ kind: 'ban', until: null, state: 'active' })).toContain(w['player.notice.noEnd'] as string);
  });

  it('a case that cannot be appealed and has no appeal says so', () => {
    const html = renderAppealPage(caseView('en', { canAppeal: false }));
    expect(html).toContain(noticeWordsFor('en').words['player.appealPage.refused.not_appealable'] as string);
    expect(html).not.toContain('<form');
  });

  it('a contact is shown on a case page too, and the expiry line names a UTC time', () => {
    const html = renderAppealPage(caseView('en', { contact: 'help@game.example' }));
    expect(html).toContain('Need help? help@game.example');
    expect(html).toMatch(/This link works until [^<]*UTC\./);
  });
});

describe('the error line', () => {
  const w = noticeWordsFor('en').words;
  it.each([
    ['invalid', (w['player.appealPage.refused.invalid'] as string).replace('{max}', '1000')],
    ['already', w['player.appealPage.refused.already'] as string],
    ['busy', w['player.appealPage.refused.busy'] as string],
    ['not_appealable', w['player.appealPage.refused.not_appealable'] as string],
    ['failed', w['player.appealPage.refused.failed'] as string],
  ] as const)('%s is a role=alert paragraph with the sentence', (error, text) => {
    const html = renderAppealPage(caseView('en', {}, { error }));
    expect(html).toContain(`<p role="alert" class="error">${text}</p>`);
  });

  it('rate fills {when} from retryAfterMs ("in 2 minutes"); without a usable wait it falls back to the busy sentence', () => {
    expect(renderAppealPage(caseView('en', {}, { error: 'rate', retryAfterMs: 90_000 }))).toContain('Try again in 2 minutes.');
    expect(renderAppealPage(caseView('en', {}, { error: 'rate', retryAfterMs: 3 * 24 * HOUR }))).toContain('Try again in 3 days.');
    for (const retryAfterMs of [undefined, 0, -5, Number.NaN]) {
      const html = renderAppealPage(caseView('en', {}, { error: 'rate', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }));
      expect(html).toContain(w['player.appealPage.refused.busy'] as string);
      expect(html).not.toMatch(/\{[a-z]+\}/);
    }
  });

  it('no error line when there is no error', () => {
    expect(renderAppealPage(caseView('en'))).not.toContain('role="alert"');
  });
});

describe("a game's own words", () => {
  it('replace the shipped ones in their language, fill their placeholders, and leave the others', () => {
    const overrides = { en: { 'player.appealPage.title': 'Dispute a ruling', 'player.appealPage.form.hint': 'At most {max} characters, please.', 'player.appealPage.contact': 'Write to {contact}' } };
    const html = renderAppealPage(caseView('en', { contact: 'us@game.example' }, {}, overrides));
    expect(html).toContain('<title>Dispute a ruling</title>');
    expect(html).toContain('At most 1000 characters, please.');
    expect(html).toContain('Write to us@game.example');
    expect(html).toContain(noticeWordsFor('en').words['player.appealPage.form.send'] as string);
    const own = renderAppealPage({ ...caseView('de', {}, {}, { de: { 'player.appealPage.title': 'Einspruch' } }) });
    expect(own).toContain('<html lang="de">');
    expect(own).toContain('<title>Einspruch</title>');
  });

  it('a word that is missing from the set reads as its key, never as undefined or empty', () => {
    const view = caseView('en');
    const html = renderAppealPage({ ...view, words: { 'player.appealPage.title': 'Only a title' } });
    expect(html).toContain('Only a title');
    expect(html).not.toContain('undefined');
    expect(html).toContain('player.appealPage.form.send');
  });
});

describe('the document', () => {
  const views: Array<[string, AppealPageView]> = [
    ['invalid', plainView('invalid', 'en', 'help')],
    ['busy', plainView('busy', 'es')],
    ['form', caseView('en')],
    ['sent', caseView('pt', { canAppeal: false, appeal: { status: 'open', createdAt: NOW, decidedAt: null, reason: null } })],
    ['decided', caseView('es', { canAppeal: false, appeal: { status: 'reduced', createdAt: NOW, decidedAt: NOW, reason: 'lighter_fits' }, standing: { kind: 'chat', until: NOW + HOUR, state: 'active' } })],
    ['error', caseView('en', {}, { error: 'invalid' })],
    ['warning', caseView('en', { notice: { ...base.notice, kind: 'warning', until: null } })],
  ];

  it.each(views)('%s is one complete, balanced html document with one style block and nothing external', (_name, view) => {
    const html = renderAppealPage(view);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(balanced(html)).toBeNull();
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(html.endsWith('</html>\n')).toBe(true);
  });

  it('the lang attribute is the chosen language, escaped', () => {
    expect(renderAppealPage(plainView('invalid', 'es'))).toContain('<html lang="es">');
    expect(renderAppealPage({ ...plainView('invalid'), locale: '"><script>' })).toContain('<html lang="&quot;&gt;&lt;script&gt;">');
  });

  it('the stylesheet has the dark-mode query, the colour-scheme, a 40rem column, a narrow-screen rule and an explicit body background', () => {
    const css = /<style>\n([\s\S]*?)\n<\/style>/.exec(renderAppealPage(caseView('en')))?.[1] ?? '';
    expect(css).toContain('color-scheme:light dark');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\{:root\{[^}]*--bg:#[0-9a-f]+/);
    expect(css).toMatch(/body\{[^}]*background:var\(--bg\)[^}]*color:var\(--fg\)/);
    expect(css).toMatch(/main\{max-width:40rem;margin:0 auto;padding:1rem\}/);
    expect(css).toMatch(/@media \(max-width:30rem\)\{/);
    expect(css).toMatch(/textarea\{[^}]*width:100%/);
    expect(css).toMatch(/overflow-wrap:anywhere/);
    expect(css).toMatch(/\.error\{color:var\(--err\)/);
    expect(css).toMatch(/font:16px\/1\.5 system-ui/);
    // colour only where it means something: the one accent is the button and focus, the red is the error
    expect(css).not.toMatch(/\.facts[^{]*\{[^}]*(--err|red)/);
  });

  it('the CSP is the exported value, and says nothing may load', () => {
    expect(APPEAL_PAGE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    expect(APPEAL_PAGE_CSP).not.toMatch(/https?:|\*|script-src|img-src|connect-src/);
  });
});

describe('every dynamic value is escaped', () => {
  const EVIL = '<script>alert(1)</script> "q" & \'s\'';
  it('the rule label, the reference, an excerpt line, the contact, the token and the words', () => {
    const html = renderAppealPage(
      caseView(
        'en',
        {
          notice: { ...base.notice, ruleLabel: EVIL, refCode: EVIL, excerpt: [{ text: EVIL, day: EVIL }] } as unknown as AppealCase['notice'],
          contact: EVIL,
        },
        { token: EVIL },
        { en: { 'player.appealPage.title': EVIL } },
      ),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(EVIL);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &amp; &#39;s&#39;');
    expect(html).toContain('<input type="hidden" name="t" value="&lt;script&gt;');
    expect(balanced(html)).toBeNull();
  });

  it('a contact on the invalid page, and a hostile word of the busy page', () => {
    const html = renderAppealPage({ ...plainView('invalid', 'en', EVIL), words: { ...noticeWordsFor('en').words, 'player.appealPage.invalid': EVIL } });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(balanced(html)).toBeNull();
  });
});
