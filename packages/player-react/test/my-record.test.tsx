import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MyRecord } from '../src/MyRecord.js';
import type { MyRecordProps } from '../src/MyRecord.js';
import { createT, en } from '../src/i18n.js';
import { dayText, untilText } from '../src/format.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, BOB, DAY, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

const props = (w: PlayerWorld, more: Partial<MyRecordProps> = {}): MyRecordProps => ({ client: w.client, now: w.now, ...FIXED, ...more });
// The record items only: a notice's own lines are list items too, one list deeper.
const items = () => [...screen.getByRole('list', { name: 'Your record' }).children] as HTMLElement[];

describe('MyRecord states', () => {
  it('says it is loading while the list is on its way', async () => {
    const w = await playerWorld();
    let release: () => void = () => undefined;
    w.intercept.fn = () => new Promise((resolve) => (release = () => resolve(undefined)));
    renderUi(<MyRecord {...props(w)} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Your record' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your record');
    release();
    await screen.findByText('Your record is clear. Nothing is on it right now.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an empty record is a calm sentence, not an empty list', async () => {
    const w = await playerWorld();
    renderUi(<MyRecord {...props(w)} />);
    expect(await screen.findByText('Your record is clear. Nothing is on it right now.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(w.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /record']);
  });

  it('a player who only reported someone has an empty record (the thank-you is not on it)', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    w.caller.key = BOB.key;
    renderUi(<MyRecord {...props(w)} />);
    expect(await screen.findByText('Your record is clear. Nothing is on it right now.')).toBeInTheDocument();
  });

  it.each([
    ['a 401', { status: 401, body: { error: 'unauthorized', message: 'x' } }, 'You are signed out. Sign in again, then try again.'],
    ['a 403', { status: 403, body: { error: 'forbidden', message: 'x' } }, 'This account cannot do that.'],
    ['a 404', { status: 404, body: { error: 'not_found', message: 'x' } }, 'That could not be found.'],
    ['a 500', { status: 500, body: { error: 'internal', message: 'x' } }, 'The server had a problem. Try again in a moment.'],
    ['a 200 with a body that is not a list', { status: 200, body: { record: 'x' } }, 'Something went wrong.'],
  ])('%s: an alert with the reason and Try again, which loads it again', async (_name, answer, text) => {
    const w = await playerWorld();
    await w.warn();
    w.intercept.fn = () => answer;
    const { user } = renderUi(<MyRecord {...props(w)} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`We could not load your record. ${text}`);
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Your record' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a dropped connection says so in plain words', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => Promise.reject(new TypeError('fetch failed'));
    renderUi(<MyRecord {...props(w)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server. Check your connection and try again.');
  });

  it('a failed refresh keeps the list that is already on screen and says it could not refresh', async () => {
    const w = await playerWorld();
    await w.warn();
    const { rerender } = renderUi(<MyRecord {...props(w, { refreshKey: 0 })} />);
    await screen.findByRole('list', { name: 'Your record' });
    w.intercept.fn = () => ({ status: 500, body: { error: 'internal', message: 'x' } });
    rerender(<MyRecord {...props(w, { refreshKey: 1 })} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Your record' })).toBeInTheDocument();
  });

  it('refreshKey loads it again and shows a sanction that arrived since', async () => {
    const w = await playerWorld();
    const { rerender } = renderUi(<MyRecord {...props(w, { refreshKey: 0 })} />);
    await screen.findByText('Your record is clear. Nothing is on it right now.');
    await w.warn();
    rerender(<MyRecord {...props(w, { refreshKey: 1 })} />);
    expect(await screen.findByRole('list', { name: 'Your record' })).toBeInTheDocument();
  });
});

describe('MyRecord items', () => {
  async function record() {
    const w = await playerWorld();
    await w.warn(ALICE, { rule: 2, lines: ['you play like a snerp'] });
    w.clock.t += DAY;
    await w.sanction(ALICE, 'chat', { rule: 1, durationMs: 2 * DAY, lines: ['glarn glarn'] });
    w.clock.t += DAY;
    await w.sanction(ALICE, 'ban', { rule: 3, durationMs: null, lines: ['vlemmo'] });
    return w;
  }

  it('lists the newest first, with a card and the kind written out beside it', async () => {
    const w = await record();
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    const rows = items();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => within(r).getByRole('heading', { level: 3 }).textContent)).toEqual(['Ban', 'Chat restriction', 'Warning']);
    expect(rows[0]?.querySelector('.cw-card')).toHaveClass('cw-card--ban');
    expect(rows[1]?.querySelector('.cw-card')).toHaveClass('cw-card--restriction');
    expect(rows[2]?.querySelector('.cw-card')).toHaveClass('cw-card--warning');
    for (const r of rows) expect(r.querySelector('.cw-card')).toHaveAttribute('aria-hidden', 'true');
  });

  it('each item says what, which rule, when it was given, until when and the reference code', async () => {
    const w = await record();
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    const [ban, chat, warning] = items();
    const all = w.record();
    const of = (kind: string) => all.find((n) => n.kind === kind)!;
    expect(ban).toHaveTextContent(of('ban').ruleLabel as string);
    expect(ban).toHaveTextContent(`Given${untilText(of('ban').createdAt, 'en', 'UTC')}`);
    expect(ban).toHaveTextContent('UntilNo end date');
    expect(ban).toHaveTextContent(`Reference${of('ban').refCode}`);
    expect(chat).toHaveTextContent(`Until${untilText(of('chat').until as number, 'en', 'UTC')}`);
    expect(warning).toHaveTextContent(`On your record until${untilText(of('warning').createdAt + 90 * DAY, 'en', 'UTC')}`);
    expect(warning).toHaveTextContent(of('warning').ruleLabel as string);
  });

  it('a restriction that has ended but is still on the record says when it ended', async () => {
    const w = await record();
    w.clock.t += 5 * DAY;
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    const chat = items()[1] as HTMLElement;
    const until = w.record().find((n) => n.kind === 'chat')?.until as number;
    expect(chat).toHaveTextContent(`Ended${untilText(until, 'en', 'UTC')}`);
    expect(chat).not.toHaveTextContent('in 0');
  });

  it('shows the player own lines with their day, as text', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { lines: ['<i>italic</i> & "quotes"', 'second snerp'] });
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    const lines = within(items()[0] as HTMLElement).getByRole('list', { name: 'Your messages that led to this' });
    expect(within(lines).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      `${dayText('2027-01-15', 'en')}<i>italic</i> & "quotes"`,
      `${dayText('2027-01-15', 'en')}second snerp`,
    ]);
    expect(lines.querySelector('i')).toBeNull();
  });

  it('a notice with no lines has no lines list', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { lines: [] });
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    expect(within(items()[0] as HTMLElement).queryByRole('list')).toBeNull();
  });

  it('an acknowledged warning is still on the record', async () => {
    const w = await playerWorld();
    await w.warn(ALICE);
    await w.client.ack(w.pending()[0]?.id as string);
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    expect(items()).toHaveLength(1);
  });

  it('a kind this version does not know is listed under a plain label, with no card', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => ({
      status: 200,
      body: { record: [{ id: 'n1', kind: 'future_kind', rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: w.now(), mustAcknowledge: false }] },
    });
    renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    expect(within(items()[0] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('Notice');
    expect(items()[0]?.querySelector('.cw-card')).toBeNull();
  });

  it('never shows the notice id, only the reference code', async () => {
    const w = await record();
    const { container } = renderUi(<MyRecord {...props(w)} />);
    await screen.findByRole('list', { name: 'Your record' });
    for (const n of w.record()) expect(container.innerHTML).not.toContain(n.id);
  });
});

describe('MyRecord appeal link', () => {
  it('shows "Think this is a mistake?" once, above the list, when there is an address and something to contest', async () => {
    const w = await playerWorld();
    await w.warn();
    await w.sanction(ALICE, 'chat');
    renderUi(<MyRecord {...props(w, { appealUrl: 'https://game.test/appeal' })} />);
    await screen.findByRole('list', { name: 'Your record' });
    const links = screen.getAllByRole('link', { name: 'Think this is a mistake?' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://game.test/appeal');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('is left out with no address, with an unsafe address, and on an empty record', async () => {
    const w = await playerWorld();
    const { unmount } = renderUi(<MyRecord {...props(w, { appealUrl: 'https://game.test/appeal' })} />);
    await screen.findByText('Your record is clear. Nothing is on it right now.');
    expect(screen.queryByRole('link')).toBeNull();
    unmount();
    await w.warn();
    for (const url of [undefined, 'javascript:alert(1)', '//evil.test']) {
      const r = renderUi(<MyRecord {...props(w, url === undefined ? {} : { appealUrl: url })} />);
      await screen.findByRole('list', { name: 'Your record' });
      expect(screen.queryByRole('link')).toBeNull();
      r.unmount();
    }
  });
});

describe('MyRecord words and theme', () => {
  it('takes its words from t and its look from theme and className', async () => {
    const w = await playerWorld();
    await w.warn();
    const t = createT({ ...en, 'player.record.title': 'Dein Verlauf' }, 'de');
    const { container } = renderUi(<MyRecord {...props(w, { t, theme: 'light', className: 'x' })} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Dein Verlauf' })).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Dein Verlauf' });
    const root = container.querySelector('.cw-player') as HTMLElement;
    expect(root).toHaveAttribute('data-cw-theme', 'light');
    expect(root).toHaveClass('x');
  });
});
