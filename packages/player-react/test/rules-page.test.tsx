import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RulesPage } from '../src/RulesPage.js';
import type { RulesPageProps } from '../src/RulesPage.js';
import { createT, en } from '../src/i18n.js';
import { FIXED, renderUi } from './render.js';
import { playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

const props = (w: PlayerWorld, more: Partial<RulesPageProps> = {}): RulesPageProps => ({ client: w.client, now: w.now, ...FIXED, ...more });

describe('RulesPage', () => {
  it('says it is loading, then shows the summary and the rules as a numbered list', async () => {
    const w = await playerWorld();
    let release: () => void = () => undefined;
    w.intercept.fn = () => new Promise((resolve) => (release = () => resolve(undefined)));
    renderUi(<RulesPage {...props(w)} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Community rules' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the rules');
    release();
    const list = await screen.findByRole('list', { name: 'Community rules' });
    expect(list.tagName).toBe('OL');
    const rules = w.cw.rules.active();
    expect(screen.getByText(w.cw.summary)).toBeInTheDocument();
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(rules.length);
    rules.forEach((rule, i) => {
      expect(rows[i]).toHaveAttribute('value', String(rule.number));
      expect(within(rows[i] as HTMLElement).getByText(rule.title)).toBeInTheDocument();
      expect(rows[i]).toHaveTextContent(rule.text);
    });
    expect(w.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /rules']);
  });

  it('keeps the kit numbers when a rule is retired: 1, 3, 4, not 1, 2, 3', async () => {
    const w = await playerWorld({ retire: [2] });
    renderUi(<RulesPage {...props(w)} />);
    const list = await screen.findByRole('list', { name: 'Community rules' });
    const numbers = within(list).getAllByRole('listitem').map((r) => r.getAttribute('value'));
    expect(numbers).not.toContain('2');
    expect(numbers.slice(0, 2)).toEqual(['1', '3']);
  });

  it('shows rule text as text: markup in a title or a rule is not run', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => ({
      status: 200,
      body: { summary: 'Be <b>kind</b>.', rules: [{ number: 1, title: '<img src=x onerror="window.__r=1">', text: 'No <script>window.__r=2</script> here & there.' }] },
    });
    const { container } = renderUi(<RulesPage {...props(w)} />);
    await screen.findByRole('list', { name: 'Community rules' });
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(container).toHaveTextContent('Be <b>kind</b>.');
    expect(container).toHaveTextContent('No <script>window.__r=2</script> here & there.');
    expect((window as unknown as { __r?: number }).__r).toBeUndefined();
  });

  it('an empty list of rules is a sentence, and the summary still shows', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => ({ status: 200, body: { summary: 'Play nicely.', rules: [] } });
    renderUi(<RulesPage {...props(w)} />);
    expect(await screen.findByText('No rules are published yet.')).toBeInTheDocument();
    expect(screen.getByText('Play nicely.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('a summary that is empty is left out', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => ({ status: 200, body: { summary: '', rules: [{ number: 1, title: 'Be kind', text: 'Treat people well.' }] } });
    const { container } = renderUi(<RulesPage {...props(w)} />);
    await screen.findByRole('list', { name: 'Community rules' });
    expect(container.querySelector('.cw-summary')).toBeNull();
  });

  it.each([
    ['a 401', { status: 401, body: { error: 'unauthorized', message: 'x' } }, 'You are signed out. Sign in again, then try again.'],
    ['a 403', { status: 403, body: { error: 'forbidden', message: 'x' } }, 'This account cannot do that.'],
    ['a 404', { status: 404, body: { error: 'not_found', message: 'x' } }, 'That could not be found.'],
    ['a 500', { status: 500, body: { error: 'internal', message: 'x' } }, 'The server had a problem. Try again in a moment.'],
    ['a 200 with no rules', { status: 200, body: { summary: 's' } }, 'Something went wrong.'],
  ])('%s: an alert with the reason and Try again, which loads it again', async (_name, answer, text) => {
    const w = await playerWorld();
    w.intercept.fn = () => answer;
    const { user } = renderUi(<RulesPage {...props(w)} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`We could not load the rules. ${text}`);
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Community rules' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a dropped connection says so in plain words', async () => {
    const w = await playerWorld();
    w.intercept.fn = () => Promise.reject(new TypeError('fetch failed'));
    renderUi(<RulesPage {...props(w)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server. Check your connection and try again.');
  });

  it('takes its words from t, and its theme and className from props', async () => {
    const w = await playerWorld();
    const t = createT({ ...en, 'player.rules.title': 'Regeln' }, 'de');
    const { container } = renderUi(<RulesPage {...props(w, { t, theme: 'dark', className: 'y' })} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Regeln' })).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Regeln' });
    const root = container.querySelector('.cw-player') as HTMLElement;
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    expect(root).toHaveClass('y');
  });

  it('refreshKey loads it again', async () => {
    const w = await playerWorld();
    const { rerender } = renderUi(<RulesPage {...props(w, { refreshKey: 0 })} />);
    await screen.findByRole('list', { name: 'Community rules' });
    rerender(<RulesPage {...props(w, { refreshKey: 1 })} />);
    await waitFor(() => expect(w.sent.filter((r) => r.path === '/rules')).toHaveLength(2));
  });
});
