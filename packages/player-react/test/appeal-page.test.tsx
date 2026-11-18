import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppealCase, AppealReasonCode } from '@chatwarden/core';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import { renderAppealPage } from '../../http/src/appealPage.js';
import type { AppealPageView } from '../../http/src/appealPage.js';
import { AppealPage } from '../src/appeal/AppealPage.js';
import type { AppealPageProps } from '../src/appeal/AppealPage.js';
import type { AppealPageClient } from '../src/appeal/appealClient.js';
import { PlayerError } from '../src/client.js';
import { renderUi } from './render.js';

// The appeal page as a component (appeals landing, 3.3 and 3.4): the same states, in the same order and the same words, as the page the server serves for the same case.
// It reads and sends through an injected client here, so no network is touched; the client has its own tests.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOKEN = 'tok.en-1_2';
const ENDPOINT = 'https://game.example/appeal/case';

const BASE: AppealCase = {
  notice: {
    kind: 'chat',
    rule: 2,
    ruleLabel: 'Community Rule 2: No insulting players',
    until: NOW + DAY,
    refCode: 'M-ABC12',
    createdAt: NOW - HOUR,
    excerpt: [
      { text: 'you are a *****', day: '2027-01-15' },
      { text: 'honestly tarvo', day: '2027-01-16' },
    ],
  },
  canAppeal: true,
  appeal: null,
  standing: null,
  expiresAt: NOW + 30 * DAY,
  emailsOutcome: false,
  contact: null,
  statementMax: 1000,
};
const make = (more: Partial<AppealCase>): AppealCase => ({ ...BASE, ...more });
const decided = (status: 'upheld' | 'reduced' | 'revoked', reason: AppealReasonCode | null, standing: AppealCase['standing'], more: Partial<AppealCase> = {}): AppealCase =>
  make({ canAppeal: false, appeal: { status, createdAt: NOW - 2 * HOUR, decidedAt: NOW - HOUR, reason }, standing, ...more });

/** Every state of a case the page draws, by name. */
const CASES: Array<[string, AppealCase]> = [
  ['the form', BASE],
  ['the form, with a contact', make({ contact: 'help@game.example' })],
  ['the form for a warning', make({ notice: { ...BASE.notice, kind: 'warning', until: null, excerpt: [] } })],
  ['the form for a ban with no end', make({ notice: { ...BASE.notice, kind: 'ban', until: null, rule: 'uncovered', ruleLabel: 'Not covered by a rule yet' } })],
  ['the form for an area restriction without a reference or a rule', make({ notice: { ...BASE.notice, kind: 'area', rule: null, ruleLabel: null, refCode: null, excerpt: [] } })],
  ['an open appeal, no email', make({ canAppeal: false, appeal: { status: 'open', createdAt: NOW - HOUR, decidedAt: null, reason: null } })],
  ['an open appeal, with email', make({ canAppeal: false, emailsOutcome: true, appeal: { status: 'open', createdAt: NOW - HOUR, decidedAt: null, reason: null } })],
  ['upheld, the sanction still in force', decided('upheld', 'rule_applies', { kind: 'chat', until: NOW + DAY, state: 'active' })],
  ['upheld, a ban with no end in force', decided('upheld', 'evidence_clear', { kind: 'ban', until: null, state: 'active' })],
  ['reduced to a warning', decided('reduced', 'first_offence', { kind: 'warning', until: null, state: 'active' })],
  ['reduced, the replacement ended', decided('reduced', 'lighter_fits', { kind: 'chat', until: NOW - HOUR, state: 'ended' })],
  ['revoked, lifted', decided('revoked', 'mistake', { kind: 'chat', until: NOW + DAY, state: 'lifted' })],
  ['revoked with a different reason and a contact', decided('revoked', 'not_a_violation', { kind: 'chat', until: NOW + DAY, state: 'lifted' }, { contact: 'help@game.example' })],
  ['decided with no reason and no standing', decided('upheld', null, null)],
  ['no appeal and no way to appeal', make({ canAppeal: false })],
];

type Spy = { client: AppealPageClient; load: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
function fake(load: () => Promise<AppealCase | 'invalid'>, send: AppealPageClient['send'] = () => Promise.resolve({ ok: false, refused: 'failed' })): Spy {
  const l = vi.fn(load);
  const s = vi.fn(send);
  return { client: { load: l, send: s } as unknown as AppealPageClient, load: l, send: s };
}
const served = (c: AppealCase) => fake(() => Promise.resolve(c));

const props = (spy: Spy, more: Partial<AppealPageProps> = {}): AppealPageProps => ({ endpoint: ENDPOINT, token: TOKEN, client: spy.client, now: () => NOW, timeZone: 'UTC', locale: 'en', ...more });

/** What a reader gets, block by block and in order: headings, paragraphs, facts, lines, the label and the button. The live count (the page's only extra) is left out. */
function blocks(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll('h1, h2, p, dt, dd, li, label, button')) {
    if (el.closest('.cw-count') !== null || el.matches('.cw-count')) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '') out.push(text);
  }
  return out;
}
function servedBlocks(view: AppealPageView): string[] {
  const doc = new DOMParser().parseFromString(renderAppealPage(view), 'text/html');
  return blocks(doc.body);
}
const caseView = (locale: string, c: AppealCase, more: Partial<Extract<AppealPageView, { state: 'case' }>> = {}): AppealPageView => {
  const { locale: chosen, words } = noticeWordsFor(locale);
  return { state: 'case', locale: chosen, words, token: TOKEN, case: c, now: NOW, ...more };
};

describe('the same words as the served page, in the same order', () => {
  it.each(['en', 'es', 'pt'])('%s: every state of a case', async (locale) => {
    for (const [name, c] of CASES) {
      const spy = served(c);
      const view = render(<AppealPage {...props(spy, { locale })} />);
      await screen.findByRole('heading', { level: 1 });
      await waitFor(() => expect(view.container.querySelector('[role="status"]')).toBeEmptyDOMElement());
      const expected = servedBlocks(caseView(locale, c));
      expect(expected.length, `${name} (${locale}) is a real page`).toBeGreaterThan(5);
      expect(blocks(view.container), `${name} (${locale})`).toEqual(expected);
      view.unmount();
    }
  });

  it.each(['en', 'es', 'pt'])('%s: the invalid link is one sentence, and the contact when the game gave one', async (locale) => {
    for (const contact of [null, 'help@game.example']) {
      const spy = fake(() => Promise.resolve('invalid'));
      const view = render(<AppealPage {...props(spy, { locale, ...(contact === null ? {} : { contact }) })} />);
      await waitFor(() => expect(view.container.querySelector('[role="status"]')).toBeEmptyDOMElement());
      const { locale: chosen, words } = noticeWordsFor(locale);
      expect(blocks(view.container)).toEqual(servedBlocks({ state: 'invalid', locale: chosen, words, contact }));
      view.unmount();
    }
  });

  it.each([
    ['invalid', {}],
    ['rate', { retryAfterMs: 90_000 }],
    ['rate', { retryAfterMs: 7_000 }],
    ['already', {}],
    ['failed', {}],
  ] as const)('%s refusal (%j) reads as the served page says it, in en, es and pt, and keeps the statement', async (refused, extra) => {
    for (const locale of ['en', 'es', 'pt']) {
      const spy = fake(() => Promise.resolve(BASE), () => Promise.resolve({ ok: false, refused, ...extra }));
      const { user, container, unmount } = renderUi(<AppealPage {...props(spy, { locale })} />);
      const box = await screen.findByRole('textbox');
      await user.type(box, 'It was a joke');
      await user.click(screen.getByRole('button', { name: noticeWordsFor(locale).words['player.appealPage.form.send'] as string }));
      const alert = await screen.findByRole('alert');
      const error = refused === 'already' ? 'already' : refused;
      const expected = servedBlocks(caseView(locale, BASE, { error, ...extra }));
      expect(blocks(container)).toEqual(expected);
      expect(expected).toContain(alert.textContent);
      expect(box).toHaveValue('It was a joke');
      unmount();
    }
  });
});

describe('the form', () => {
  it('has a label tied to the field, the hint with the limit, a live count, and Send', async () => {
    const spy = served(BASE);
    const { user } = renderUi(<AppealPage {...props(spy)} />);
    const box = await screen.findByLabelText('Why do you think this was a mistake?');
    expect(box.tagName).toBe('TEXTAREA');
    expect(screen.getByText('Up to 1000 characters. A different moderator will review it, and the decision is final.')).toBeInTheDocument();
    const count = screen.getByText('0 of 1,000 characters');
    expect(box).toHaveAccessibleDescription(/Up to 1000 characters.*0 of 1,000 characters/);
    await user.type(box, 'abc');
    expect(count).toHaveTextContent('3 of 1,000 characters');
    expect(screen.getByRole('button', { name: 'Send appeal' })).toBeInTheDocument();
    expect(box).not.toHaveAttribute('maxlength');
  });

  it('sending shows the sent state from the returned case, with no reload', async () => {
    const after = make({ canAppeal: false, appeal: { status: 'open', createdAt: NOW, decidedAt: null, reason: null } });
    const spy = fake(() => Promise.resolve(BASE), () => Promise.resolve({ ok: true, case: after }));
    const { user, container } = renderUi(<AppealPage {...props(spy)} />);
    await user.type(await screen.findByRole('textbox'), '  It was a joke between friends  ');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(/^Appeal sent /);
    expect(spy.send).toHaveBeenCalledTimes(1);
    expect(spy.send).toHaveBeenCalledWith(TOKEN, '  It was a joke between friends  ');
    expect(spy.load).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send appeal' })).toBeNull();
    expect(blocks(container)).toEqual(servedBlocks(caseView('en', after)));
  });

  it('a refusal shows its words in an alert, keeps the text, and the form stays', async () => {
    const spy = fake(() => Promise.resolve(BASE), () => Promise.resolve({ ok: false, refused: 'rate', retryAfterMs: 120_000 }));
    const { user } = renderUi(<AppealPage {...props(spy)} />);
    const box = await screen.findByRole('textbox');
    await user.type(box, 'keep this text');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You have sent too many appeals this week. Try again in 2 minutes.');
    expect(box).toHaveValue('keep this text');
    // A new try clears the old refusal first.
    spy.send.mockResolvedValueOnce({ ok: false, refused: 'failed' });
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a little while.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('an empty or over-long statement is refused in words without a request, and keeps the text', async () => {
    const spy = served(make({ statementMax: 10 }));
    const { user } = renderUi(<AppealPage {...props(spy)} />);
    const box = await screen.findByRole('textbox');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your appeal is empty or too long. Write up to 10 characters.');
    await user.type(box, '   ');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(spy.send).not.toHaveBeenCalled();
    await user.clear(box);
    await user.type(box, 'a statement of 11');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(spy.send).not.toHaveBeenCalled();
    expect(box).toHaveValue('a statement of 11');
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });

  it('counts code points of the trimmed text, so an emoji is one', async () => {
    const spy = served(BASE);
    renderUi(<AppealPage {...props(spy)} />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '  \u{1F600}\u{1F600}a  ' } });
    expect(screen.getByText('3 of 1,000 characters')).toBeInTheDocument();
  });

  it('a second click while sending sends once, and the button says it is busy without leaving the tab order', async () => {
    let finish: (v: Awaited<ReturnType<AppealPageClient['send']>>) => void = () => undefined;
    const spy = fake(
      () => Promise.resolve(BASE),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = renderUi(<AppealPage {...props(spy)} />);
    await user.type(await screen.findByRole('textbox'), 'once');
    const button = screen.getByRole('button', { name: 'Send appeal' });
    await user.click(button);
    await user.click(button);
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    expect(spy.send).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await act(async () => finish({ ok: false, refused: 'failed' }));
    await screen.findByRole('alert');
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  it("a 'link' refusal replaces the page with the invalid state", async () => {
    const spy = fake(() => Promise.resolve(BASE), () => Promise.resolve({ ok: false, refused: 'link' }));
    const { user, container } = renderUi(<AppealPage {...props(spy, { contact: 'help@game.example' })} />);
    await user.type(await screen.findByRole('textbox'), 'x');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText('This link is no longer valid.');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(blocks(container)).toEqual(['Appeal a decision', 'This link is no longer valid.', 'Need help? help@game.example']);
  });

  it('a thrown send is a failure in words, not a crash', async () => {
    const spy = fake(() => Promise.resolve(BASE), () => Promise.reject(new Error('boom with ' + TOKEN)));
    const { user, container } = renderUi(<AppealPage {...props(spy)} />);
    await user.type(await screen.findByRole('textbox'), 'x');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a little while.');
    expect(container.innerHTML).not.toContain('boom');
    expect(container.innerHTML).not.toContain(TOKEN);
  });
});

describe('loading and failing to load', () => {
  it('says Loading while the case is on its way, then the case', async () => {
    let resolve: (c: AppealCase) => void = () => undefined;
    const spy = fake(() => new Promise((r) => (resolve = r)));
    const { container } = renderUi(<AppealPage {...props(spy)} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Appeal a decision' })).toBeInTheDocument();
    expect(within(container).getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('textbox')).toBeNull();
    await act(async () => resolve(BASE));
    await screen.findByRole('textbox');
    expect(screen.queryByText('Loading')).toBeNull();
  });

  it.each([
    [new PlayerError({ status: 500, code: 'http_500', message: 'x' }), 'Something went wrong. Try again in a little while.'],
    [new PlayerError({ status: 0, code: 'network', message: 'x' }), 'Something went wrong. Try again in a little while.'],
    [new PlayerError({ status: 429, code: 'rate_limited', message: 'x', retryAfter: 5 }), 'Too many requests. Try again in a little while.'],
  ])('a failed load says so in an alert and shows no form (%#)', async (error, sentence) => {
    const spy = fake(() => Promise.reject(error));
    renderUi(<AppealPage {...props(spy)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});

describe('focus', () => {
  it('goes to the heading after the case loads, to the alert after a refusal, and to the sent line after success', async () => {
    const after = make({ canAppeal: false, appeal: { status: 'open', createdAt: NOW, decidedAt: null, reason: null } });
    const spy = fake(() => Promise.resolve(BASE), vi.fn().mockResolvedValueOnce({ ok: false, refused: 'invalid' }).mockResolvedValueOnce({ ok: true, case: after }));
    const { user } = renderUi(<AppealPage {...props(spy)} />);
    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(heading).toHaveFocus(), { timeout: 3000 });
    await user.type(await screen.findByRole('textbox'), 'a statement');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert).toHaveFocus(), { timeout: 3000 });
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    const sent = await screen.findByText(/^Appeal sent /);
    await waitFor(() => expect(sent).toHaveFocus(), { timeout: 3000 });
  });

  it('goes to the heading when the link is invalid too', async () => {
    const spy = fake(() => Promise.resolve('invalid'));
    renderUi(<AppealPage {...props(spy)} />);
    const heading = await screen.findByRole('heading', { level: 1 });
    await screen.findByText('This link is no longer valid.');
    await waitFor(() => expect(heading).toHaveFocus(), { timeout: 3000 });
  });

  it('the first Tab stop after the heading is the field, then Send: the keyboard reaches the whole form in order', async () => {
    const spy = served(BASE);
    const { user } = renderUi(<AppealPage {...props(spy)} />);
    const box = await screen.findByRole('textbox');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    await user.tab();
    expect(box).toHaveFocus();
    await user.type(box, 'x');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Send appeal' })).toHaveFocus();
  });
});

describe('the words', () => {
  it("a game's own words override a shipped sentence, and an unknown override key is ignored", async () => {
    const spy = served(BASE);
    const { container } = renderUi(<AppealPage {...props(spy, { words: { en: { 'player.appealPage.title': 'Contest this', 'player.appealPage.form.send': 'Contest', 'not.a.key': 'Injected' } } })} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Contest this' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Contest' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('Injected');
    expect(screen.getByText('Why do you think this was a mistake?')).toBeInTheDocument();
  });

  it("a game's own language is used when asked for, with English under it", async () => {
    const spy = fake(() => Promise.resolve('invalid'));
    renderUi(<AppealPage {...props(spy, { locale: 'de', words: { de: { 'player.appealPage.invalid': 'Dieser Link gilt nicht mehr.' } } })} />);
    expect(await screen.findByText('Dieser Link gilt nicht mehr.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Appeal a decision' })).toBeInTheDocument();
  });

  it('a regional locale picks the shipped language, and the lang attribute is not touched by the component', async () => {
    const spy = fake(() => Promise.resolve('invalid'));
    renderUi(<AppealPage {...props(spy, { locale: 'es-MX' })} />);
    expect(await screen.findByText(noticeWordsFor('es').words['player.appealPage.invalid'] as string)).toBeInTheDocument();
  });

  it('an injected t replaces the shipped words', async () => {
    const spy = fake(() => Promise.resolve('invalid'));
    renderUi(<AppealPage {...props(spy, { t: ((key: string) => `[${key}]`) as AppealPageProps['t'] })} />);
    expect(await screen.findByText('[player.appealPage.invalid]')).toBeInTheDocument();
  });

  it('honours the theme, the class name and the time zone', async () => {
    const spy = served(make({ canAppeal: false, appeal: { status: 'open', createdAt: Date.UTC(2027, 0, 15, 23, 30), decidedAt: null, reason: null } }));
    const { container } = renderUi(<AppealPage {...props(spy, { theme: 'dark', className: 'mine', timeZone: 'Asia/Tokyo' })} />);
    await screen.findByText(/^Appeal sent /);
    const root = container.querySelector('.cw-player') as HTMLElement;
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    expect(root).toHaveClass('mine');
    expect(screen.getByText(/^Appeal sent /).textContent).toMatch(/Jan 16, 2027/);
    expect(screen.getByText(/^Appeal sent /).textContent).not.toMatch(/UTC/);
    expect(container.textContent).not.toContain('Times are in UTC.');
  });
});

describe('hostile content', () => {
  it('a line with <img onerror> and a contact with a script tag are text', async () => {
    const spy = served(make({ contact: '<script>alert(1)</script>', notice: { ...BASE.notice, excerpt: [{ text: '<img src=x onerror=alert(1)>', day: '2027-01-15' }], ruleLabel: '<b>bold</b> rule' } }));
    const { container } = renderUi(<AppealPage {...props(spy)} />);
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(screen.getByText('Need help? <script>alert(1)</script>')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('<img');
  });
});

describe('the network', () => {
  it('no call is made before mount, one after, and none after unmount', async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(BASE), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const element = <AppealPage endpoint={ENDPOINT} token={TOKEN} fetch={f as unknown as typeof fetch} now={() => NOW} timeZone="UTC" />;
    expect(f).not.toHaveBeenCalled();
    const view = render(element);
    await screen.findByRole('textbox');
    expect(calls).toEqual([`${ENDPOINT}?t=${TOKEN}`]);
    view.unmount();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
  });

  it('an unmount while the case is loading drops the answer and sends nothing', async () => {
    let resolve: (c: AppealCase) => void = () => undefined;
    const spy = fake(() => new Promise((r) => (resolve = r)));
    const view = renderUi(<AppealPage {...props(spy)} />);
    view.unmount();
    await act(async () => resolve(BASE));
    expect(spy.send).not.toHaveBeenCalled();
    expect(spy.load).toHaveBeenCalledTimes(1);
  });

  it('a new token loads again, and the old answer never shows under the new one', async () => {
    const first = served(BASE);
    const { rerender } = render(<AppealPage {...props(first)} />);
    await screen.findByRole('textbox');
    const other = fake(() => Promise.resolve('invalid'));
    rerender(<AppealPage {...props(other, { token: 'other-token' })} />);
    await screen.findByText('This link is no longer valid.');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe.each(['light', 'dark'] as const)('axe, %s theme', (theme) => {
  const RULES = { 'color-contrast': { enabled: false } } as const;
  const clean = async (container: HTMLElement): Promise<string[]> => {
    const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
  };

  it.each(CASES)('%s has no violations', async (_name, c) => {
    const spy = served(c);
    const { container } = renderUi(<AppealPage {...props(spy, { theme })} />);
    await waitFor(() => expect(blocks(container).length).toBeGreaterThan(2));
    expect(await clean(container)).toEqual([]);
  });

  it('loading, invalid, a failed load and each refusal have no violations', async () => {
    const pending = fake(() => new Promise(() => undefined));
    const a = renderUi(<AppealPage {...props(pending, { theme })} />);
    expect(await clean(a.container)).toEqual([]);
    a.unmount();
    const invalid = fake(() => Promise.resolve('invalid'));
    const b = renderUi(<AppealPage {...props(invalid, { theme, contact: 'help@game.example' })} />);
    await screen.findByText('This link is no longer valid.');
    expect(await clean(b.container)).toEqual([]);
    b.unmount();
    const failed = fake(() => Promise.reject(new PlayerError({ status: 500, code: 'x', message: 'x' })));
    const c = renderUi(<AppealPage {...props(failed, { theme })} />);
    await screen.findByRole('alert');
    expect(await clean(c.container)).toEqual([]);
    c.unmount();
    for (const refused of ['invalid', 'already', 'failed'] as const) {
      const spy = fake(() => Promise.resolve(BASE), () => Promise.resolve({ ok: false, refused }));
      const d = renderUi(<AppealPage {...props(spy, { theme })} />);
      await d.user.type(await screen.findByRole('textbox'), 'x');
      await d.user.click(screen.getByRole('button', { name: 'Send appeal' }));
      await screen.findByRole('alert');
      expect(await clean(d.container), refused).toEqual([]);
      d.unmount();
    }
  });
});

describe('no leak: the page never holds the token, an id or a staff field', () => {
  it('through the real client, a hostile answer shows none of its extra fields, and the token is in no attribute or text', async () => {
    const hostile = {
      ...BASE,
      staff: { actor: 'ann@example.test', role: 'senior' },
      privateReason: 'the private moderator reason',
      notice: { ...BASE.notice, id: 'notice-id-1', groupId: 'group-id-1', person: 's_aaaaaaaaaaaaaaaaaaaaaa', accountId: 'acct-42' },
      appeal: { status: 'upheld', createdAt: NOW, decidedAt: NOW + HOUR, reason: 'rule_applies', id: 'appeal-id-1', decidedBy: 'ann@example.test', statement: 'what the player wrote' },
      canAppeal: false,
      standing: { kind: 'chat', until: NOW + DAY, state: 'active', groupId: 'group-id-1' },
    };
    const f = vi.fn(async () => new Response(JSON.stringify(hostile), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { container } = render(<AppealPage endpoint={ENDPOINT} token={TOKEN} fetch={f as unknown as typeof fetch} now={() => NOW} timeZone="UTC" />);
    await screen.findByText('We kept the decision.');
    const html = container.innerHTML;
    for (const secret of [TOKEN, 'notice-id-1', 'group-id-1', 's_aaaa', 'acct-42', 'ann@example.test', 'private moderator reason', 'appeal-id-1', 'what the player wrote', 'game.example']) expect(html, secret).not.toContain(secret);
    expect(html).not.toMatch(/\b[0-9a-f]{24,}\b/i);
    expect(html).not.toMatch(/\bs_[A-Za-z0-9_-]{22}\b/);
    // Only the player's own reference code of the sanction is on the page.
    expect(html).toContain('M-ABC12');
  });

  it('the form holds no hidden field and no data attribute: nothing of the link is written into the page', async () => {
    const spy = served(BASE);
    const { container } = renderUi(<AppealPage {...props(spy)} />);
    await screen.findByRole('textbox');
    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.querySelector('a[href], form[action]')).toBeNull();
  });
});
