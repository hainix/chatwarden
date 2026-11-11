import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../src/client.js';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { errorText } from '../src/labels.js';
import { Empty, ErrorBlock, Fetched, Link, Loading, Notice, Panel, PersonChip, Scroll, Segmented, Tag, Time } from '../src/ui.js';

// The shared parts, on their own: they will carry Tasks 4 to 6, so they get their own checks.

const t = createT(en, 'en');

function ctx(over: Partial<HubContextValue> = {}): HubContextValue {
  return {
    client: {} as HubContextValue['client'],
    t,
    locale: 'en',
    now: () => 1_800_000_000_000,
    router: { path: '/', navigate: () => undefined },
    me: { actor: 'ann', role: 'moderator', can: {} as HubContextValue['me']['can'] },
    can: () => true,
    session: {} as HubContextValue['session'],
    shortcuts: true,
    go: () => undefined,
    href: (r) => `#${r.name}`,
    ...over,
  };
}
const wrap = (node: ReactNode, value: HubContextValue = ctx()) => render(<HubContext.Provider value={value}>{node}</HubContext.Provider>);

describe('Scroll', () => {
  it('is a labelled region that the keyboard can reach, so a wide table scrolls without a mouse', async () => {
    const { container } = wrap(
      <Scroll label="Audit rows">
        <table>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </table>
      </Scroll>,
    );
    const region = screen.getByRole('region', { name: 'Audit rows' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('cw-scroll');
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});

describe('Segmented', () => {
  it('marks the chosen option pressed and reports a choice', async () => {
    const onChange = vi.fn();
    wrap(<Segmented label="Pick" value="b" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'B' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.setup().click(screen.getByRole('button', { name: 'A' }));
    expect(onChange).toHaveBeenCalledWith('a');
  });
});

describe('Link', () => {
  it('moves on a plain click, and leaves a middle click, a modified click and a right click to the browser', async () => {
    const go = vi.fn();
    wrap(<Link to={{ name: 'terms' }}>Terms</Link>, ctx({ go }));
    const a = screen.getByRole('link', { name: 'Terms' });
    expect(a).toHaveAttribute('href', '#terms');
    const user = userEvent.setup();
    await user.click(a);
    expect(go).toHaveBeenCalledTimes(1);
    for (const mods of ['{Shift>}', '{Meta>}', '{Alt>}']) {
      await user.keyboard(mods);
      await user.click(a);
      await user.keyboard(mods.replace('>', '').replace('{', '{/'));
    }
    await user.pointer({ keys: '[MouseRight]', target: a });
    expect(go).toHaveBeenCalledTimes(1);
  });
});

describe('Time', () => {
  it('shows how long ago in words, the exact time on hover and a machine time', () => {
    const at = 1_800_000_000_000 - 3 * 60 * 60 * 1000;
    wrap(<Time at={at} />);
    const el = screen.getByText('3 hours ago');
    expect(el.tagName).toBe('TIME');
    expect(el).toHaveAttribute('datetime', new Date(at).toISOString());
    expect(el.getAttribute('title')).toMatch(/\d/);
  });
  it('renders nothing for a time that is not a number', () => {
    const { container } = wrap(<Time at={Number.NaN} />);
    expect(container.textContent).toBe('');
  });
});

describe('PersonChip', () => {
  it('shows the first 8 characters only, with Person for a screen reader', () => {
    const { container } = wrap(<PersonChip person={'abcdefghijklmnopqrstuvwxyz0123456789'} />);
    expect(container.textContent).toBe('Person abcdefgh');
    expect(container.textContent).not.toContain('abcdefghi');
  });
});

describe('Panel, Tag, Notice, Empty, Loading', () => {
  it('a panel is a region named by its heading', () => {
    wrap(
      <Panel title="Things" action={<a href="#x">More</a>}>
        body
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Things' });
    expect(region).toHaveTextContent('body');
    expect(screen.getByRole('heading', { level: 2, name: 'Things' })).toBeInTheDocument();
  });
  it('a tag carries its tone as a class and its meaning as words', () => {
    wrap(<Tag tone="bad">Hate</Tag>);
    expect(screen.getByText('Hate')).toHaveClass('cw-tag', 'cw-tag--bad');
  });
  it('a notice announces when given a role', () => {
    wrap(<Notice tone="bad" role="alert">Oops</Notice>);
    expect(screen.getByRole('alert')).toHaveTextContent('Oops');
  });
  it('loading is a polite status', () => {
    wrap(<Loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });
  it('empty has an optional title', () => {
    wrap(<Empty title="All clear">Nothing here.</Empty>);
    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });
});

describe('errors and Fetched', () => {
  const err = (status: number, code: string, retryAfter?: number) =>
    new HubError({ status, code, message: 'server words', ...(retryAfter === undefined ? {} : { retryAfter }) });

  it.each([
    [err(0, 'network'), 'Could not reach the server. Check your connection and try again.'],
    [err(401, 'unauthorized'), 'You are signed out. Sign in again to continue.'],
    [err(403, 'forbidden'), 'Your role cannot do this.'],
    [err(404, 'not_found'), 'That no longer exists.'],
    [err(429, 'rate_limited'), 'Too many requests. Try again in a moment.'],
    [err(429, 'rate_limited', 1), 'Too many requests. Try again in 1 second.'],
    [err(429, 'rate_limited', 30), 'Too many requests. Try again in 30 seconds.'],
    [err(500, 'internal'), 'The server had a problem. Try again in a moment.'],
    [err(503, 'http_503'), 'The server had a problem. Try again in a moment.'],
    [err(400, 'invalid_request'), 'Something went wrong.'],
    [err(0, 'unexpected'), 'Something went wrong.'],
  ])('%s is one plain sentence, never the server text', (e, text) => {
    expect(errorText(t, e)).toBe(text);
    expect(errorText(t, e)).not.toContain('server words');
  });

  it('ErrorBlock names what failed, says why and retries', async () => {
    const onRetry = vi.fn();
    wrap(<ErrorBlock error={err(500, 'internal')} what="the reports" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the reports. The server had a problem.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('Fetched: loading, then data; error with no data; error beside kept data', () => {
    const reload = vi.fn();
    const base = { reload, loading: false };
    const { rerender } = wrap(<Fetched state={{ ...base, data: undefined, error: null, loading: true }} what="x">{() => <p>data</p>}</Fetched>);
    expect(screen.getByRole('status')).toBeInTheDocument();
    const again = (state: Parameters<typeof Fetched<string>>[0]['state']) =>
      rerender(
        <HubContext.Provider value={ctx()}>
          <Fetched state={state} what="x">{(d) => <p>{d}</p>}</Fetched>
        </HubContext.Provider>,
      );
    again({ ...base, data: 'kept', error: null });
    expect(screen.getByText('kept')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    again({ ...base, data: undefined, error: err(500, 'internal') });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('kept')).not.toBeInTheDocument();
    again({ ...base, data: 'kept', error: err(0, 'network') });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('kept')).toBeInTheDocument();
  });
});
