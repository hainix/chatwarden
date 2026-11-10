import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoticeQueue } from '../src/NoticeQueue.js';
import type { NoticeQueueProps } from '../src/NoticeQueue.js';
import { createT, en } from '../src/i18n.js';
import { dayText, timeLeft, untilText } from '../src/format.js';
import { renderUi, FIXED } from './render.js';
import { ALICE, BOB, DAY, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

const props = (w: PlayerWorld, more: Partial<NoticeQueueProps> = {}): NoticeQueueProps => ({ client: w.client, now: w.now, ...FIXED, ...more });
const posts = (w: PlayerWorld) => w.sent.filter((r) => r.method === 'POST');
const dialog = () => screen.findByRole('dialog');
const ok = (body: unknown = { ok: true }) => ({ status: 200, body });

describe('nothing to show', () => {
  it('renders nothing at all when the player has no notices (no dialog, no wrapper)', async () => {
    const w = await playerWorld();
    const { container } = renderUi(<NoticeQueue {...props(w)} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container).toBeEmptyDOMElement();
    expect(w.sent[0]).toMatchObject({ method: 'GET', path: '/notices' });
  });

  it('shows nothing while the list is loading (no flash of an empty dialog)', async () => {
    const w = await playerWorld();
    await w.warn();
    let release: () => void = () => undefined;
    w.intercept.fn = () => new Promise((resolve) => (release = () => resolve(undefined)));
    const { container } = renderUi(<NoticeQueue {...props(w)} />);
    expect(container).toBeEmptyDOMElement();
    release();
    expect(await dialog()).toBeInTheDocument();
  });

  it('a player with only a report outcome sees the thank-you notice, not a sanction', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    w.caller.key = BOB.key;
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'Thanks for your report' })).toBeInTheDocument();
  });
});

describe('a warning', () => {
  it('is a labelled modal dialog named by its heading, and says what happened, until when and what to do', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { rule: 2, lines: ['you play like a snerp', 'honestly tarvo'] });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleName('You have a warning');
    const heading = within(d).getByRole('heading', { level: 2, name: 'You have a warning' });
    expect(d).toHaveAttribute('aria-labelledby', heading.id);
    expect(d).toHaveTextContent('A moderator gave you a warning for something you wrote. You can keep playing.');
    // The rule, as the kit labels it.
    const rule = w.pending()[0]?.ruleLabel as string;
    expect(rule).toMatch(/^Community Rule 2/);
    expect(within(d).getByText(rule)).toBeInTheDocument();
    // Until when: a warning stays on the record 90 days from when it was made.
    const made = (w.pending()[0]?.createdAt as number) + 90 * DAY;
    expect(d).toHaveTextContent(`On your record until${untilText(made, 'en', 'UTC')}`);
    expect(d).toHaveTextContent('Press Acknowledge to confirm you saw this.');
    expect(within(d).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('shows the player own lines with their day, and the reference code', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { lines: ['you play like a snerp', 'honestly tarvo'] });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    const list = within(d).getByRole('list', { name: 'Your messages that led to this' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      `${dayText('2027-01-15', 'en')}you play like a snerp`,
      `${dayText('2027-01-15', 'en')}honestly tarvo`,
    ]);
    const code = w.pending()[0]?.refCode as string;
    expect(code).toMatch(/^M-[A-Z0-9]{5}$/);
    expect(d).toHaveTextContent(`Reference${code}`);
    expect(d).toHaveTextContent('Quote this code if you contact us.');
  });

  it('has no excerpt section when the notice carries no lines', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { lines: [] });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(within(d).queryByRole('list')).toBeNull();
    expect(d).not.toHaveTextContent('Your messages');
  });

  it('shows a rule the kit calls uncovered in the kit own words', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { rule: 'uncovered' });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(d).toHaveTextContent('Not covered by a rule yet');
  });
});

describe('the other kinds', () => {
  it.each([
    ['chat', 'Your chat is turned off', 'A moderator turned off your chat. You can still play.'],
    ['area', 'You cannot join public rooms', 'A moderator stopped you joining public rooms and matchmaking. You can still play in private rooms.'],
    ['ban', 'You are banned', 'A moderator banned you from playing.'],
  ] as const)('a %s notice: heading, what happened, until when, and a Got it button', async (kind, heading, body) => {
    const w = await playerWorld();
    await w.sanction(ALICE, kind, { durationMs: DAY });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(d).toHaveTextContent(body);
    const until = w.pending()[0]?.until as number;
    expect(d).toHaveTextContent(`Until${untilText(until, 'en', 'UTC')} (${timeLeft(until, w.now(), 'en')})`);
    expect(within(d).getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('a restriction with no end says so, in plain words', async () => {
    const w = await playerWorld();
    await w.sanction(ALICE, 'ban', { durationMs: null });
    renderUi(<NoticeQueue {...props(w)} />);
    expect(await dialog()).toHaveTextContent('UntilNo end date');
  });

  it('a restriction whose end has passed says when it ended, not "in 0 minutes"', async () => {
    const w = await playerWorld();
    await w.sanction(ALICE, 'chat', { durationMs: DAY });
    w.clock.t += 3 * DAY;
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    const until = w.pending()[0]?.until as number;
    expect(d).toHaveTextContent(`Ended${untilText(until, 'en', 'UTC')}`);
    expect(d).not.toHaveTextContent('in 0');
  });

  it('a report outcome has no rule, reference, excerpt or appeal link, and no promise about what was done', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    w.caller.key = BOB.key;
    renderUi(<NoticeQueue {...props(w, { appealUrl: 'https://game.test/appeal' })} />);
    const d = await dialog();
    expect(d).toHaveTextContent('A moderator looked at your report and took action. We do not share what was done.');
    expect(within(d).queryByRole('list')).toBeNull();
    expect(d).not.toHaveTextContent('Reference');
    expect(within(d).queryByRole('link')).toBeNull();
    expect(within(d).getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('a kind this version does not know is still shown, with a plain heading', async () => {
    const w = await playerWorld();
    w.intercept.fn = () =>
      ok({ notices: [{ id: 'n1', kind: 'future_kind', rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: w.now(), mustAcknowledge: false }] });
    renderUi(<NoticeQueue {...props(w)} />);
    expect(within(await dialog()).getByRole('heading', { name: 'A message from the moderators' })).toBeInTheDocument();
  });
});

describe('"Think this is a mistake?"', () => {
  it.each(['warning', 'chat', 'ban'] as const)('is a link to the adopter address on a %s notice', async (kind) => {
    const w = await playerWorld();
    await w.sanction(ALICE, kind);
    renderUi(<NoticeQueue {...props(w, { appealUrl: 'https://game.test/appeal?x=1' })} />);
    const link = within(await dialog()).getByRole('link', { name: 'Think this is a mistake?' });
    expect(link).toHaveAttribute('href', 'https://game.test/appeal?x=1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('is not shown when there is no appeal address', async () => {
    const w = await playerWorld();
    await w.warn();
    renderUi(<NoticeQueue {...props(w)} />);
    expect(within(await dialog()).queryByRole('link')).toBeNull();
  });

  it('accepts a path on the same site', async () => {
    const w = await playerWorld();
    await w.warn();
    renderUi(<NoticeQueue {...props(w, { appealUrl: '/help/appeal' })} />);
    expect(within(await dialog()).getByRole('link', { name: 'Think this is a mistake?' })).toHaveAttribute('href', '/help/appeal');
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.test/x', 'ftp://x.test/a', 'mailto:a@b.test', '', 'appeal', '\\\\evil.test'])(
    'refuses the address %j (the link is left out, never rendered)',
    async (url) => {
      const w = await playerWorld();
      await w.warn();
      renderUi(<NoticeQueue {...props(w, { appealUrl: url })} />);
      const d = await dialog();
      expect(within(d).queryByRole('link')).toBeNull();
      expect(d.innerHTML).not.toMatch(/javascript:|data:text|vbscript:/i);
    },
  );
});

describe('own lines are text, never HTML', () => {
  it('renders markup in a line as the characters the player typed', async () => {
    const w = await playerWorld();
    const lines = ['<b>bold</b> <img src=x onerror="window.__pwned=1"> & <script>window.__pwned=2</script>', '"quoted" & more'];
    await w.warn(ALICE, { lines });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    const items = within(within(d).getByRole('list', { name: 'Your messages that led to this' })).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.cw-line-text')?.textContent)).toEqual(w.pending()[0]?.excerpt.map((l) => l.text));
    expect(d.querySelector('img, script, b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(items[0]?.textContent).toContain('<b>bold</b>');
  });

  it('shows a blocked line as the kit masked it, and the blocked word is nowhere in the page', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { lines: ['you are a zorbak'] });
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(d.innerHTML.toLowerCase()).not.toContain('zorbak');
    expect(d).toHaveTextContent('you are a ******');
  });
});

describe('acknowledging', () => {
  it('sends one POST /notices/:id/ack, closes the dialog and the server no longer lists it', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    const id = w.pending()[0]?.id as string;
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(w).map((r) => r.path)).toEqual([`/notices/${id}/ack`]);
    expect(w.pending()).toEqual([]);
    expect(w.record()).toHaveLength(1);
  });

  it('works from the keyboard: Enter on the focused button', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(w.pending()).toEqual([]);
  });

  it('a Got it on a restriction acknowledges it too, so it does not come back', async () => {
    const w = await playerWorld();
    await w.sanction(ALICE, 'chat');
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(w.pending()).toEqual([]);
  });

  it('tells the page which notice was acknowledged, once, and not when it failed', async () => {
    const w = await playerWorld();
    await w.warn();
    const onAcknowledged = vi.fn();
    w.intercept.fn = (req) => (req.method === 'POST' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderUi(<NoticeQueue {...props(w, { onAcknowledged })} />);
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await screen.findByRole('alert');
    expect(onAcknowledged).not.toHaveBeenCalled();
    w.intercept.fn = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
    expect(onAcknowledged.mock.calls[0]?.[0]).toMatchObject({ kind: 'warning' });
  });

  describe('double submit', () => {
    it('three clicks in one tick send one request', async () => {
      const w = await playerWorld();
      await w.warn();
      renderUi(<NoticeQueue {...props(w)} />);
      await dialog();
      const button = screen.getByRole('button', { name: 'Acknowledge' });
      act(() => {
        button.click();
        button.click();
        button.click();
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(posts(w)).toHaveLength(1);
    });

    it('clicks while the request is in flight send nothing more, and the button says it is busy without losing focus', async () => {
      const w = await playerWorld();
      await w.warn();
      let release: () => void = () => undefined;
      w.intercept.fn = (req) => (req.method === 'POST' ? new Promise((resolve) => (release = () => resolve(undefined))) : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await dialog();
      const button = screen.getByRole('button', { name: 'Acknowledge' });
      await user.click(button);
      await user.click(button);
      await user.keyboard('{Enter}');
      expect(posts(w)).toHaveLength(1);
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).not.toBeDisabled();
      release();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(posts(w)).toHaveLength(1);
    });

    it('the guard is cleared after a failure, so the next attempt is sent', async () => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await dialog();
      await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
      await screen.findByRole('alert');
      await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
      await waitFor(() => expect(posts(w)).toHaveLength(2));
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(posts(w)).toHaveLength(3));
    });

    it('the guard is cleared after a dropped connection too', async () => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? Promise.reject(new TypeError('fetch failed')) : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await dialog();
      await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
      await screen.findByRole('alert');
      w.intercept.fn = null;
      await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(w.pending()).toEqual([]);
    });
  });

  describe('a failed acknowledge keeps the notice and says why, inline, with Try again', () => {
    const failures: Array<[string, () => { status: number; body: unknown } | Promise<never>, string]> = [
      ['a 500', () => ({ status: 500, body: { error: 'internal', message: 'x' } }), 'The server had a problem. Try again in a moment.'],
      ['a 401', () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }), 'You are signed out. Sign in again, then try again.'],
      ['a 403', () => ({ status: 403, body: { error: 'forbidden', message: 'x' } }), 'This account cannot do that.'],
      ['a 429', () => ({ status: 429, body: { error: 'rate_limited', message: 'x' } }), 'Too many requests. Try again in a moment.'],
      ['a proxy page (502)', () => ({ status: 502, body: '<html>bad</html>' }), 'The server had a problem. Try again in a moment.'],
      ['a 400 the server does not explain', () => ({ status: 400, body: { error: 'invalid_request', message: 'x' } }), 'Something went wrong.'],
      ['a dropped connection', () => Promise.reject(new TypeError('fetch failed')), 'Could not reach the server. Check your connection and try again.'],
    ];
    it.each(failures)('%s', async (_name, fail, text) => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? (fail() as never) : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      const d = await dialog();
      await user.click(within(d).getByRole('button', { name: 'Acknowledge' }));
      const alert = await within(d).findByRole('alert');
      expect(alert).toHaveTextContent(`Your notice is still here. ${text}`);
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      // The notice is still there, and still unacknowledged on the server.
      expect(screen.getByRole('dialog')).toBe(d);
      expect(within(d).getByRole('heading', { name: 'You have a warning' })).toBeInTheDocument();
      expect(w.pending()).toHaveLength(1);
    });

    it('a 429 with Retry-After says how long, in seconds, and the server message is never shown', async () => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? { status: 429, headers: { 'retry-after': '7' }, body: { error: 'rate_limited', message: 'SECRET server text' } } : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Too many requests. Try again in 7 seconds.');
      expect(document.body.innerHTML).not.toContain('SECRET');
    });

    it('the error goes away when the next attempt starts, and a success closes the dialog', async () => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
      await screen.findByRole('alert');
      w.intercept.fn = null;
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  describe('already done counts as done', () => {
    it('a 404 closes the notice', async () => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? { status: 404, body: { error: 'not_found', message: 'x' } } : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('{ ok: false } (withdrawn or not the caller own) closes the notice too', async () => {
      const w = await playerWorld();
      await w.warn();
      w.intercept.fn = (req) => (req.method === 'POST' ? ok({ ok: false }) : undefined);
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a notice that was acknowledged elsewhere in the meantime closes on the real route as well', async () => {
      const w = await playerWorld();
      await w.warn();
      const { user } = renderUi(<NoticeQueue {...props(w)} />);
      await dialog();
      const id = w.pending()[0]?.id as string;
      await w.client.ack(id);
      await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });
});

describe('several notices', () => {
  async function three() {
    const w = await playerWorld();
    await w.warn(ALICE, { rule: 2, lines: ['first line snerp'] });
    w.clock.t += 60_000;
    await w.sanction(ALICE, 'chat', { rule: 1, lines: ['second line glarn'] });
    w.clock.t += 60_000;
    await w.sanction(ALICE, 'ban', { rule: 3, lines: ['third line fenrisk'] });
    return w;
  }

  it('shows the oldest first, with "Notice 1 of 3", then the next, in order', async () => {
    const w = await three();
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    let d = await dialog();
    expect(within(d).getByRole('heading', { name: 'You have a warning' })).toBeInTheDocument();
    expect(d).toHaveTextContent('Notice 1 of 3');
    await user.click(within(d).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Notice 1 of 2'));
    d = screen.getByRole('dialog');
    expect(within(d).getByRole('heading', { name: 'Your chat is turned off' })).toBeInTheDocument();
    expect(d).toHaveTextContent('second line glarn');
    expect(d).not.toHaveTextContent('first line snerp');
    await user.click(within(d).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('You are banned'));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Notice');
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(w.pending()).toEqual([]);
  });

  it('orders by when they were made, even if the server lists them in another order', async () => {
    const w = await playerWorld();
    const base = { rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], mustAcknowledge: false };
    w.intercept.fn = (req) =>
      req.method === 'GET'
        ? ok({
            notices: [
              { id: 'late', kind: 'ban', createdAt: 3000, ...base },
              { id: 'early', kind: 'warning', createdAt: 1000, ...base },
              { id: 'mid', kind: 'chat', createdAt: 2000, ...base },
            ],
          })
        : undefined;
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = await screen.findByRole('dialog');
      seen.push(within(d).getByRole('heading', { level: 2 }).textContent as string);
      w.intercept.fn = (req) => (req.method === 'POST' ? ok() : undefined);
      await user.click(within(d).getByRole('button', { name: /Acknowledge|Got it/ }));
      await waitFor(() => expect(screen.queryByText(seen[i] as string)).toBeNull());
    }
    expect(seen).toEqual(['You have a warning', 'Your chat is turned off', 'You are banned']);
  });

  it('moves focus to the heading of each next notice', async () => {
    const w = await three();
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'You have a warning' })).toHaveFocus();
    await user.click(within(d).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your chat is turned off' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'You are banned' })).toHaveFocus());
  });

  it('a failed acknowledge on the first leaves the second hidden, and the error does not carry over to the next notice', async () => {
    const w = await three();
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    w.intercept.fn = (req) => (req.method === 'POST' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('dialog')).toHaveTextContent('Notice 1 of 3');
    w.intercept.fn = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Notice 1 of 2'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Got it' })).not.toHaveAttribute('aria-busy');
  });
});

describe('focus', () => {
  function Page({ showMenu = true, ...p }: NoticeQueueProps & { showMenu?: boolean }) {
    return (
      <>
        {showMenu && <button type="button">Game menu</button>}
        <NoticeQueue {...p} />
        <button type="button">Settings</button>
      </>
    );
  }

  it('goes to the heading when the dialog opens, and the heading is focusable but not in the tab order', async () => {
    const w = await playerWorld();
    await w.warn();
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    const heading = within(d).getByRole('heading', { name: 'You have a warning' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('returns to the element that had focus before the dialog opened, when the last notice closes', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user } = renderUi(<Page {...props(w)} />);
    const menu = screen.getByRole('button', { name: 'Game menu' });
    menu.focus();
    await dialog();
    expect(screen.getByRole('heading', { name: 'You have a warning' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(menu).toHaveFocus();
  });

  it('returns focus only when the last notice closes, not between notices', async () => {
    const w = await playerWorld();
    await w.warn();
    await w.sanction(ALICE, 'chat');
    const { user } = renderUi(<Page {...props(w)} />);
    const menu = screen.getByRole('button', { name: 'Game menu' });
    menu.focus();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your chat is turned off' })).toHaveFocus());
    expect(menu).not.toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(menu).toHaveFocus();
  });

  it('does not fail when what had focus is gone by the time the dialog closes', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user, rerender } = renderUi(<Page {...props(w)} />);
    screen.getByRole('button', { name: 'Game menu' }).focus();
    await dialog();
    rerender(<Page {...props(w)} showMenu={false} />);
    expect(screen.queryByRole('button', { name: 'Game menu' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps Tab inside the dialog: forward from the last control wraps to the first, backward from the heading to the last', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user } = renderUi(<Page {...props(w, { appealUrl: 'https://game.test/appeal' })} />);
    screen.getByRole('button', { name: 'Game menu' }).focus();
    const d = await dialog();
    const link = within(d).getByRole('link', { name: 'Think this is a mistake?' });
    const button = within(d).getByRole('button', { name: 'Acknowledge' });
    await user.tab();
    expect(link).toHaveFocus();
    await user.tab();
    expect(button).toHaveFocus();
    await user.tab();
    expect(link).toHaveFocus();
    await user.tab({ shift: true });
    expect(button).toHaveFocus();
    // From the heading, Shift+Tab goes to the last control, never out of the dialog.
    within(d).getByRole('heading', { name: 'You have a warning' }).focus();
    await user.tab({ shift: true });
    expect(button).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveFocus();
  });

  it('Escape does not dismiss a notice: it has to be acknowledged', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(posts(w)).toHaveLength(0);
  });

  it('a click on the backdrop does not dismiss it either', async () => {
    const w = await playerWorld();
    await w.warn();
    const { container } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    fireEvent.mouseDown(container.querySelector('.cw-scrim') as HTMLElement);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('the hold (canShow)', () => {
  it('canShow=false holds the notice: nothing is shown, nothing is acknowledged, nothing is dropped', async () => {
    const w = await playerWorld();
    await w.warn();
    const onPendingChange = vi.fn();
    const { container, rerender } = renderUi(<NoticeQueue {...props(w, { canShow: false, onPendingChange })} />);
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container).toBeEmptyDOMElement();
    expect(posts(w)).toHaveLength(0);
    expect(w.pending()).toHaveLength(1);
    const gets = w.sent.filter((r) => r.method === 'GET').length;
    rerender(<NoticeQueue {...props(w, { canShow: true, onPendingChange })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    // The held notice was shown from what was already loaded: no new request was needed.
    expect(w.sent.filter((r) => r.method === 'GET')).toHaveLength(gets);
  });

  it('holds every notice in a queue and shows them in order when released', async () => {
    const w = await playerWorld();
    await w.warn();
    w.clock.t += 1000;
    await w.sanction(ALICE, 'ban');
    const onPendingChange = vi.fn();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { canShow: false, onPendingChange })} />);
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(2));
    rerender(<NoticeQueue {...props(w, { canShow: true, onPendingChange })} />);
    expect(await dialog()).toHaveTextContent('Notice 1 of 2');
  });

  it('a hold that starts while a notice is on screen hides it, keeps it, and brings it back when released', async () => {
    const w = await playerWorld();
    await w.warn();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { canShow: true })} />);
    await dialog();
    rerender(<NoticeQueue {...props(w, { canShow: false })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(w)).toHaveLength(0);
    rerender(<NoticeQueue {...props(w, { canShow: true })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    expect(w.pending()).toHaveLength(1);
  });

  it('an acknowledge that is in flight when the hold starts still finishes, and the notice is not shown again after', async () => {
    const w = await playerWorld();
    await w.warn();
    let release: () => void = () => undefined;
    w.intercept.fn = (req) => (req.method === 'POST' ? new Promise((resolve) => (release = () => resolve(undefined))) : undefined);
    const { rerender, user } = renderUi(<NoticeQueue {...props(w, { canShow: true })} />);
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    rerender(<NoticeQueue {...props(w, { canShow: false })} />);
    release();
    await waitFor(() => expect(w.pending()).toEqual([]));
    rerender(<NoticeQueue {...props(w, { canShow: true })} />);
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a load error is not shown while held', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => ({ status: 500, body: { error: 'internal', message: 'x' } });
    const { container } = renderUi(<NoticeQueue {...props(w, { canShow: false })} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('canShow defaults to true', async () => {
    const w = await playerWorld();
    await w.warn();
    renderUi(<NoticeQueue {...props(w)} />);
    expect(await dialog()).toBeInTheDocument();
  });
});

describe('when the list cannot be loaded', () => {
  const failures: Array<[string, () => { status: number; body: unknown } | Promise<never>, string]> = [
    ['a 401', () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }), 'You are signed out. Sign in again, then try again.'],
    ['a 403', () => ({ status: 403, body: { error: 'forbidden', message: 'x' } }), 'This account cannot do that.'],
    ['a 404', () => ({ status: 404, body: { error: 'not_found', message: 'x' } }), 'That could not be found.'],
    ['a 500', () => ({ status: 500, body: { error: 'internal', message: 'x' } }), 'The server had a problem. Try again in a moment.'],
    ['a dropped connection', () => Promise.reject(new TypeError('fetch failed')), 'Could not reach the server. Check your connection and try again.'],
    ['a 200 that is not a list', () => ({ status: 200, body: 'oops' }), 'Something went wrong.'],
  ];
  it.each(failures)('%s: a small alert says so with Try again, and it is not a dialog', async (_name, fail, text) => {
    const w = await playerWorld();
    await w.warn();
    w.intercept.fn = (req) => (req.method === 'GET' ? (fail() as never) : undefined);
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`We could not check for notices. ${text}`);
    expect(screen.queryByRole('dialog')).toBeNull();
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await dialog()).toHaveTextContent('You have a warning');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failure on a later refresh keeps the notice that is on screen', async () => {
    const w = await playerWorld();
    await w.warn();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { refreshKey: 0 })} />);
    await dialog();
    w.intercept.fn = () => ({ status: 500, body: { error: 'internal', message: 'x' } });
    rerender(<NoticeQueue {...props(w, { refreshKey: 1 })} />);
    await waitFor(() => expect(w.sent.filter((r) => r.method === 'GET')).toHaveLength(2));
    expect(screen.getByRole('dialog')).toHaveTextContent('You have a warning');
  });
});

describe('refreshKey', () => {
  it('asks again when it changes, and shows a notice that arrived since', async () => {
    const w = await playerWorld();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { refreshKey: 0 })} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
    await w.warn();
    rerender(<NoticeQueue {...props(w, { refreshKey: 1 })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    expect(w.sent.filter((r) => r.method === 'GET')).toHaveLength(2);
  });

  it('does not ask again when it stays the same', async () => {
    const w = await playerWorld();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { refreshKey: 3 })} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    rerender(<NoticeQueue {...props(w, { refreshKey: 3, canShow: true })} />);
    await act(async () => undefined);
    expect(w.sent).toHaveLength(1);
  });

  it('a late answer from an older request does not replace a newer one', async () => {
    const w = await playerWorld();
    await w.warn();
    const releases: Array<() => void> = [];
    let n = 0;
    w.intercept.fn = (req) => {
      if (req.method !== 'GET') return undefined;
      n += 1;
      if (n === 1) return new Promise((resolve) => releases.push(() => resolve(ok({ notices: [] }))));
      return undefined;
    };
    const { rerender } = renderUi(<NoticeQueue {...props(w, { refreshKey: 0 })} />);
    await waitFor(() => expect(releases).toHaveLength(1));
    rerender(<NoticeQueue {...props(w, { refreshKey: 1 })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    // The first request answers last, with nothing: the newer answer stands.
    await act(async () => releases[0]?.());
    expect(screen.getByRole('dialog')).toHaveTextContent('You have a warning');
  });
});

describe('words, theme and clean-up', () => {
  it('takes every word from the t prop: a translation reaches the page', async () => {
    const w = await playerWorld();
    await w.warn();
    const de = createT({ ...en, 'player.notice.title.warning': 'Du hast eine Verwarnung', 'player.notice.acknowledge': 'Verstanden' }, 'de');
    renderUi(<NoticeQueue {...props(w, { t: de, locale: 'de' })} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'Du hast eine Verwarnung' })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Verstanden' })).toBeInTheDocument();
  });

  it('a missing translation shows English from the spread catalog, never a bare key', async () => {
    const w = await playerWorld();
    await w.warn();
    const t = createT({ ...en }, 'fr');
    renderUi(<NoticeQueue {...props(w, { t, locale: 'fr' })} />);
    const d = await dialog();
    expect(d.textContent).not.toMatch(/player\.[a-z]/);
  });

  it('the root carries .cw-player, the theme prop and the className', async () => {
    const w = await playerWorld();
    await w.warn();
    const { container } = renderUi(<NoticeQueue {...props(w, { theme: 'dark', className: 'my-game' })} />);
    await dialog();
    const root = container.querySelector('.cw-player') as HTMLElement;
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    expect(root).toHaveClass('my-game');
  });

  it('has no theme attribute when no theme is given (the visitor setting decides)', async () => {
    const w = await playerWorld();
    await w.warn();
    const { container } = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    expect(container.querySelector('.cw-player')).not.toHaveAttribute('data-cw-theme');
  });

  it('unmounting while a request is in flight does not throw or warn', async () => {
    const w = await playerWorld();
    await w.warn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    w.intercept.fn = () => new Promise((resolve) => (release = () => resolve(undefined)));
    const { unmount } = renderUi(<NoticeQueue {...props(w)} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    unmount();
    release();
    await act(async () => undefined);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('shows the same notices again to a player who did not acknowledge them (a new page load)', async () => {
    const w = await playerWorld();
    await w.warn();
    const first = renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    first.unmount();
    renderUi(<NoticeQueue {...props(w)} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
  });
});
