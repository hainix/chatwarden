import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';
import { FIXED, renderUi } from './render.js';

// axe runs in jsdom, which paints nothing, so `color-contrast` is off here (the stylesheet tokens are checked for contrast in
// static.test.ts and the chat entry is looked at in a browser). Every other rule runs and any violation fails.
const RULES = { 'color-contrast': { enabled: false } } as const;
async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

let w: ChatWorld;
beforeEach(async () => {
  w = await chatWorld();
});
afterEach(() => w.close());

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });

describe('the log', () => {
  it('role=log has a name and is focusable', async () => {
    renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(log()).toHaveAttribute('tabindex', '0');
    expect(log().tagName).toBe('DIV');
    expect(log().querySelector('ul')).not.toBeNull();
  });

  it('the first hello with 50 lines is not announced: the log is not live until ready', async () => {
    for (let i = 1; i <= 50; i += 1) w.say('lobby', `p${i}`, `line ${i}`);
    const seen: Array<{ type: string; added: number; old: string | null; now: string | null }> = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === 'aria-live') seen.push({ type: 'live', added: 0, old: r.oldValue, now: (r.target as Element).getAttribute('aria-live') });
        if (r.type === 'childList') seen.push({ type: 'children', added: [...r.addedNodes].filter((n) => (n as Element).tagName === 'LI').length, old: null, now: null });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-live'], attributeOldValue: true });
    renderUi(box(w.transportFor('snerp')));
    await within(await screen.findByRole('log')).findByText('line 50');
    await waitFor(() => expect(log()).toHaveAttribute('aria-live', 'polite'));
    observer.disconnect();
    // The attribute change from off to polite comes after the fifty lines were added, never before.
    const firstLines = seen.findIndex((s) => s.type === 'children' && s.added > 0);
    const turnedOn = seen.findIndex((s) => s.type === 'live' && s.now === 'polite');
    expect(firstLines).toBeGreaterThanOrEqual(0);
    expect(turnedOn).toBeGreaterThan(firstLines);
    expect(seen[turnedOn]?.old).toBe('off');
    expect(log()).toHaveAttribute('aria-relevant', 'additions');
  });

  it('is off before the first hello', async () => {
    const quiet = { open: () => ({ send: () => Promise.reject(new Error('x')), mute: () => Promise.resolve(false), report: () => Promise.reject(new Error('x')), close: () => undefined }) } as unknown as ChatTransport;
    renderUi(box(quiet));
    expect(log()).toHaveAttribute('aria-live', 'off');
  });

  it('a snapshot after a reconnect is not announced either', async () => {
    const transport = w.transportFor('snerp');
    renderUi(box(transport));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(log()).toHaveAttribute('aria-live', 'polite');
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.type === 'attributes') seen.push(r.oldValue ?? '');
    });
    observer.observe(log(), { attributes: true, attributeFilter: ['aria-live'], attributeOldValue: true });
    w.say('lobby', 'tarvo', 'while away');
    act(() => {
      transport.inject({
        type: 'hello',
        v: 1,
        epoch: 'other-epoch',
        room: 'lobby',
        you: { name: 'snerp' },
        maxLength: 200,
        summary: 's',
        restriction: null,
        lines: [{ id: '1', at: 1, name: 'tarvo', text: 'replayed' }],
        muted: [],
      });
    });
    await waitFor(() => expect(log()).toHaveAttribute('aria-live', 'polite'));
    observer.disconnect();
    expect(within(log()).getByText('replayed')).toBeInTheDocument();
    // off, then back on: the old values are polite (it went off) and off (it came back on)
    expect(seen).toEqual(['polite', 'off']);
  });

  it('a line after ready is announced: the log is live and the line is added to it', async () => {
    renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(log()).toHaveAttribute('aria-live', 'polite');
    await act(async () => {
      w.say('lobby', 'tarvo', 'new arrival');
    });
    const item = (await within(log()).findByText('new arrival')).closest('li');
    expect(log().contains(item)).toBe(true);
  });
});

describe('the status regions', () => {
  it('exist before they have text', async () => {
    renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    const regions = screen.getAllByRole('status');
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const region of regions) expect(region).toBeEmptyDOMElement();
  });
});

describe('scrolling', () => {
  function metrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    const set: number[] = [];
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => m.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => m.clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => m.scrollTop,
      set: (v: number) => {
        set.push(v);
        m.scrollTop = v;
      },
    });
    return set;
  }

  it('the jump button appears only when scrolled up and returns to the bottom', async () => {
    renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    const m = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const sets = metrics(log(), m);
    expect(screen.queryByRole('button', { name: 'Jump to the latest message' })).toBeNull();
    // at the bottom (within 24 px): still no button
    m.scrollTop = 780;
    fireEvent.scroll(log());
    expect(screen.queryByRole('button', { name: 'Jump to the latest message' })).toBeNull();
    // scrolled up
    m.scrollTop = 300;
    fireEvent.scroll(log());
    const jump = screen.getByRole('button', { name: 'Jump to the latest message' });
    // a new line does not yank the view
    await act(async () => {
      w.say('lobby', 'tarvo', 'while you read');
    });
    await within(log()).findByText('while you read');
    expect(sets).toEqual([]);
    fireEvent.click(jump);
    expect(sets.at(-1)).toBe(1000);
    m.scrollTop = 800;
    fireEvent.scroll(log());
    expect(screen.queryByRole('button', { name: 'Jump to the latest message' })).toBeNull();
  });

  it('stays pinned to the bottom while the reader is at the bottom', async () => {
    renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    const m = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const sets = metrics(log(), m);
    await act(async () => {
      w.say('lobby', 'tarvo', 'one more');
    });
    await within(log()).findByText('one more');
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.at(-1)).toBe(1000);
  });

  it('the jump button is in the tab order, after the log', async () => {
    const { user } = renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    const m = { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 };
    metrics(log(), m);
    fireEvent.scroll(log());
    await user.tab();
    expect(log()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Jump to the latest message' })).toHaveFocus();
  });
});

describe('keyboard', () => {
  it('focus order is log, input, Send', async () => {
    const { user } = renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    await user.tab();
    expect(log()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();
  });

  it('does not take focus on its own, unless asked', async () => {
    renderUi(box(w.transportFor('snerp')));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toHaveFocus();
  });

  it('autoFocus focuses the input', async () => {
    renderUi(box(w.transportFor('snerp'), { autoFocus: true }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveFocus();
  });

  it('the input has a label that screen readers read, and the counter is described', async () => {
    renderUi(box(w.transportFor('snerp')));
    const field = await screen.findByRole('textbox', { name: 'Message' });
    expect(field.closest('form')).not.toBeNull();
    fireEvent.change(field, { target: { value: 'x'.repeat(190) } });
    const counter = screen.getByText('10 characters left');
    expect(field.getAttribute('aria-describedby')).toContain(counter.id);
  });
});

describe.each(['light', 'dark'] as const)('axe, %s theme', (theme) => {
  it('the open box with lines', async () => {
    w.say('lobby', 'tarvo', 'anyone for a round?');
    const { container } = renderUi(box(w.transportFor('snerp'), { theme }));
    await within(await screen.findByRole('log')).findByText('anyone for a round?');
    expect(container.querySelector('.cw-player')).toHaveAttribute('data-cw-theme', theme);
    expect(await violations(container)).toEqual([]);
  });

  it('the empty box', async () => {
    const { container } = renderUi(box(w.transportFor('snerp'), { theme }));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(await violations(container)).toEqual([]);
  });

  it('restricted', async () => {
    await w.sanction('chat', 'lobby', 'snerp');
    const { container } = renderUi(box(w.transportFor('snerp'), { theme }));
    await screen.findByText(/turned off your chat/);
    expect(await violations(container)).toEqual([]);
  });

  it('reconnecting', async () => {
    const transport = w.transportFor('snerp');
    const { container } = renderUi(box(transport, { theme }));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.status('reconnecting'));
    expect(await violations(container)).toEqual([]);
  });

  it('closed', async () => {
    const transport = w.transportFor('snerp');
    const { container } = renderUi(box(transport, { theme }));
    await screen.findByRole('textbox', { name: 'Message' });
    act(() => transport.status('closed', 'banned'));
    await screen.findByText(/You are banned/);
    expect(await violations(container)).toEqual([]);
  });

  it('a refusal showing, and the counter showing', async () => {
    const { container } = renderUi(box(w.transportFor('snerp'), { theme }));
    const field = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(field, { target: { value: 'you zorbak' + 'x'.repeat(180) } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    await screen.findByText(/community rule/);
    expect(await violations(container)).toEqual([]);
  });

  it('hostile text', async () => {
    w.say('lobby', 'tarvo', '<script>alert(1)</script> javascript:alert(1) ‮abc​​​');
    const { container } = renderUi(box(w.transportFor('snerp'), { theme }));
    await within(await screen.findByRole('log')).findByText(/javascript:alert/);
    expect(await violations(container)).toEqual([]);
  });
});
