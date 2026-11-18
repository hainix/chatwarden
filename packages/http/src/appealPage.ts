import type { AppealCase, PlayerNotice } from '@chatwarden/core';
import { noticeView, timeLeft, titleKey, untilText } from '@chatwarden/core/notice-copy';
import type { NoticeWords } from '@chatwarden/core/notice-copy';
import { escapeHtml, fillWords } from '@chatwarden/core/notice-locales';

// The appeal page, as one HTML document (0.2.1). Pure: a function of its view, with no Node built-in module, so it runs wherever the router does. It holds what the
// signed link opens and nothing more: the sanction on the notice (as `noticeView` words it), the appeal form or the state of the appeal, and a line about when the
// link stops working. Every dynamic value, the words and the player's own lines included, goes through `escapeHtml`. There is no script, no remote resource and no
// `style` attribute: the one inline stylesheet is all the page loads, and `APPEAL_PAGE_CSP` says so to the browser.

/**
 * The `content-security-policy` of the appeal page: nothing may load and nothing may run; the one inline style block is allowed, a form may post only back to this
 * origin, there is no base URL, and no page may frame it. Exported so a server that serves the page itself uses this value, not a copy.
 */
export const APPEAL_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** What the page says went wrong with the last send (the `e` of the redirect), or that the person must wait. */
export type AppealPageError = 'invalid' | 'already' | 'rate' | 'busy' | 'not_appealable' | 'failed';

type Words = Readonly<Record<string, string>>;

/** What to draw. `case` is a link that opened; `invalid` one that did not (one page for every reason, so it cannot be told apart); `busy` a request over the read limit. */
export type AppealPageView =
  | { state: 'invalid'; locale: string; words: Words; contact: string | null }
  | { state: 'busy'; locale: string; words: Words; contact: string | null }
  | { state: 'case'; locale: string; words: Words; token: string; case: AppealCase; now: number; error?: AppealPageError; retryAfterMs?: number };

const STYLE = `:root{color-scheme:light dark;--bg:#ffffff;--fg:#1b1f24;--muted:#5b6570;--line:#d0d7de;--card:#f6f8fa;--accent:#0b5cd5;--accent-fg:#ffffff;--err:#b3261e;--err-bg:#fdecea}
@media (prefers-color-scheme: dark){:root{--bg:#14181d;--fg:#e8ecf0;--muted:#a0aab4;--line:#38414b;--card:#1d232a;--accent:#6aa6ff;--accent-fg:#0b1220;--err:#ff8a80;--err-bg:#3a1c1a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;line-height:1.25;margin:.5rem 0 1rem}
h2{font-size:1.2rem;line-height:1.3;margin:0 0 .5rem}
p{margin:.5rem 0;overflow-wrap:anywhere}
.card{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:1rem;margin:0 0 1rem}
.facts{margin:.75rem 0;display:grid;grid-template-columns:max-content 1fr;gap:.25rem .75rem}
.facts dt{color:var(--muted)}
.facts dd{margin:0;overflow-wrap:anywhere}
.lines{margin:.25rem 0 0;padding-left:1.25rem}
.lines li{margin:.25rem 0;overflow-wrap:anywhere}
.day{color:var(--muted);margin-right:.5rem}
.muted{color:var(--muted);font-size:.9rem}
.error{color:var(--err);background:var(--err-bg);border:1px solid var(--err);border-radius:.5rem;padding:.5rem .75rem}
form{margin:1rem 0}
label{display:block;font-weight:600;margin:0 0 .5rem}
textarea{display:block;width:100%;min-height:9rem;padding:.5rem;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.5rem;resize:vertical}
textarea:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{margin-top:.75rem;min-height:2.75rem;padding:.5rem 1.25rem;font:inherit;font-weight:600;color:var(--accent-fg);background:var(--accent);border:0;border-radius:.5rem;cursor:pointer}
@media (max-width:30rem){.facts{grid-template-columns:1fr;gap:0}.facts dd{margin-bottom:.5rem}button{width:100%}}`;

const OUTCOME_STATUS = new Set(['upheld', 'reduced', 'revoked']);

const esc = escapeHtml;

/** One complete HTML document for the view. Never throws for a well-typed view. */
export function renderAppealPage(view: AppealPageView): string {
  const word = (key: string): string => {
    const own = Object.hasOwn(view.words, key) ? view.words[key] : undefined;
    return typeof own === 'string' && own !== '' ? own : key;
  };
  const body = view.state === 'case' ? caseBody(view, word) : plainBody(view, word);
  return (
    '<!doctype html>\n' +
    `<html lang="${esc(view.locale)}">\n<head>\n<meta charset="utf-8">\n` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    `<title>${esc(word('player.appealPage.title'))}</title>\n` +
    `<style>\n${STYLE}\n</style>\n</head>\n<body>\n<main>\n${body}</main>\n</body>\n</html>\n`
  );
}

/** The contact line (the game's own words with its line filled in), or nothing. */
function contactLine(contact: string | null, word: (key: string) => string): string {
  return contact === null ? '' : `<p class="muted">${esc(fillWords(word('player.appealPage.contact'), { contact }))}</p>\n`;
}

/** The two states with no case behind them: a link that does not open, and a request that is over the limit. */
function plainBody(view: Extract<AppealPageView, { state: 'invalid' | 'busy' }>, word: (key: string) => string): string {
  const text = view.state === 'invalid' ? word('player.appealPage.invalid') : word('player.appealPage.refused.busy');
  return `<h1>${esc(word('player.appealPage.title'))}</h1>\n<p${view.state === 'busy' ? ' role="alert" class="error"' : ''}>${esc(text)}</p>\n${contactLine(view.contact, word)}`;
}

/** The error line of the last send, or nothing. */
function errorLine(view: Extract<AppealPageView, { state: 'case' }>, word: (key: string) => string): string {
  const e = view.error;
  if (e === undefined) return '';
  let text: string;
  switch (e) {
    case 'invalid':
      text = fillWords(word('player.appealPage.refused.invalid'), { max: String(view.case.statementMax) });
      break;
    case 'rate': {
      const wait = typeof view.retryAfterMs === 'number' && view.retryAfterMs > 0 ? timeLeft(view.now + view.retryAfterMs, view.now, view.locale) : null;
      text = wait === null ? word('player.appealPage.refused.busy') : fillWords(word('player.appealPage.refused.rate'), { when: wait });
      break;
    }
    default:
      text = word(`player.appealPage.refused.${e}`);
  }
  return `<p role="alert" class="error">${esc(text)}</p>\n`;
}

/** The sanction standing after a decision: its title and end while it is in force, else the words for nothing. */
function standingBlock(c: AppealCase, view: Extract<AppealPageView, { state: 'case' }>, word: (key: string) => string): string {
  const s = c.standing;
  let line: string;
  if (s !== null && s.state === 'active') {
    const end = s.kind === 'warning' ? '' : s.until === null ? word('player.notice.noEnd') : `${untilText(s.until, view.locale, 'UTC')} UTC`;
    line =
      `<p><strong>${esc(word(titleKey(s.kind)))}</strong></p>\n` +
      (end === '' ? '' : `<dl class="facts"><dt>${esc(word('player.notice.until'))}</dt><dd>${esc(end)}</dd></dl>\n`);
  } else {
    line = `<p>${esc(word('player.appealPage.standing.none'))}</p>\n`;
  }
  return `<h2>${esc(word('player.appealPage.standing'))}</h2>\n${line}`;
}

function caseBody(view: Extract<AppealPageView, { state: 'case' }>, word: (key: string) => string): string {
  const c = view.case;
  const notice: PlayerNotice = { ...c.notice, id: '', mustAcknowledge: false };
  const nv = noticeView(notice, { words: view.words as unknown as NoticeWords, locale: view.locale, timeZone: 'UTC', now: () => view.now });
  let out = `<h1>${esc(word('player.appealPage.title'))}</h1>\n<section class="card">\n<h2>${esc(nv.title)}</h2>\n<p>${esc(nv.body)}</p>\n`;
  if (nv.facts.length > 0) {
    out += '<dl class="facts">\n';
    for (const f of nv.facts) out += `<dt>${esc(f.term)}</dt><dd>${esc(f.value)}</dd>\n`;
    out += '</dl>\n';
  }
  if (nv.refHint !== null) out += `<p class="muted">${esc(nv.refHint)}</p>\n`;
  if (nv.linesLabel !== null) {
    out += `<p>${esc(nv.linesLabel)}</p>\n<ul class="lines">\n`;
    for (const l of nv.lines) out += `<li><span class="day">${esc(l.day)}</span>${esc(l.text)}</li>\n`;
    out += '</ul>\n';
  }
  out += `<p class="muted">${esc(word('delivery.times'))}</p>\n</section>\n`;
  out += errorLine(view, word);
  const a = c.appeal;
  if (c.canAppeal) {
    out +=
      '<form method="post" action="appeal/case">\n' +
      `<input type="hidden" name="t" value="${esc(view.token)}">\n` +
      `<input type="hidden" name="lang" value="${esc(view.locale)}">\n` +
      `<label for="statement">${esc(word('player.appealPage.form.label'))}</label>\n` +
      `<textarea id="statement" name="statement" maxlength="${String(c.statementMax)}" rows="6" required></textarea>\n` +
      `<p class="muted">${esc(fillWords(word('player.appealPage.form.hint'), { max: String(c.statementMax) }))}</p>\n` +
      `<button type="submit">${esc(word('player.appealPage.form.send'))}</button>\n</form>\n`;
  } else if (a !== null && a.status === 'open') {
    const when = `${untilText(a.createdAt, view.locale, 'UTC')} UTC`;
    out += `<p>${esc(fillWords(word('player.appealPage.sent'), { when }))}</p>\n`;
    out += `<p>${esc(c.emailsOutcome ? word('player.appealPage.sent.email') : word('player.appealPage.sent.return'))}</p>\n`;
  } else if (a !== null && OUTCOME_STATUS.has(a.status)) {
    out += `<h2>${esc(word('player.appealPage.decided'))}</h2>\n<p>${esc(word(`player.appealPage.outcome.${a.status}`))}</p>\n`;
    if (a.reason !== null) out += `<p>${esc(word(`player.appeal.reason.${a.status}.${a.reason}`))}</p>\n`;
    out += standingBlock(c, view, word);
  } else {
    out += `<p>${esc(word('player.appealPage.refused.not_appealable'))}</p>\n`;
  }
  const until = `${untilText(c.expiresAt, view.locale, 'UTC')} UTC`;
  out += `<p class="muted">${esc(fillWords(word('player.appealPage.expires'), { when: until }))}</p>\n`;
  return out + contactLine(c.contact, word);
}
