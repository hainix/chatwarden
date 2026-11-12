import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetHiddenAi } from '../src/ai/hide.js';
import type { AIReadInput } from '@chatwarden/core';
import { aiWorld, noStrip, openPlain, pageReads, reads, rewrite } from './aiHub.js';
import { renderHub } from './render.js';
import type { HubWorld } from './world.js';

// The review's fixes for the strip: Read again that never lands can be asked again, focus after Hide, and a part that breaks hides itself.

afterEach(() => {
  vi.useRealTimers();
  forgetHiddenAi();
  cleanup();
});

const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] };
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
// The AI parts are lazy chunks: a dynamic import settles on real I/O, not on the fake clock, so a loaded CI runner can still be
// importing after eight zero-ticks (Node 24, 2026-11-12). Wait for every pending import, then let React render what arrived.
const flush = async () => {
  for (let i = 0; i < 8; i += 1) {
    await vi.dynamicImportSettled();
    await tick(0);
  }
};
const posts = (w: HubWorld): number => w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/ai/read')).length;

function pending(w: HubWorld): void {
  w.intercept.fn = (req) => (req.method === 'POST' && req.path.endsWith('/ai/read') ? { status: 202, headers: {}, body: { status: 'pending' } } : undefined);
}

describe('Read again that never lands', () => {
  it('is asked again after the wait: the hint goes, the button is live, a second ask polls again', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    pending(w);
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await flush();
    const more = (): HTMLElement => within(screen.getByRole('region', { name: 'AI read' })).getByRole('button', { name: 'AI details' });
    fireEvent.click(more());
    const again = (): HTMLElement => screen.getByRole('button', { name: 'Read again' });
    await act(async () => void fireEvent.click(again()));
    await flush();
    expect(posts(w)).toBe(1);
    expect(within(screen.getByRole('region', { name: 'AI read' })).getByText('Reading again')).toBeInTheDocument();
    expect(again()).toHaveAttribute('aria-disabled', 'true');
    // The 20 seconds run out: nothing is left waiting.
    await tick(21_000);
    expect(within(screen.getByRole('region', { name: 'AI read' })).queryByText('Reading again')).toBeNull();
    expect(again()).toHaveAttribute('aria-disabled', 'false');
    const before = pageReads(w, f.id);
    await act(async () => void fireEvent.click(again()));
    await flush();
    expect(posts(w)).toBe(2);
    expect(within(screen.getByRole('region', { name: 'AI read' })).getByText('Reading again')).toBeInTheDocument();
    // The schedule starts again: a re-read of the case about 5 seconds later, and another at 15.
    await tick(5_100);
    expect(pageReads(w, f.id) - before).toBeGreaterThanOrEqual(1);
    await tick(10_000);
    expect(pageReads(w, f.id) - before).toBeGreaterThanOrEqual(2);
  });

  it('the server\'s answer to the second ask (ai_final) reaches the menu', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    let n = 0;
    w.intercept.fn = (req) => {
      if (req.method !== 'POST' || !req.path.endsWith('/ai/read')) return undefined;
      n += 1;
      return n === 1 ? { status: 202, headers: {}, body: { status: 'pending' } } : { status: 409, headers: {}, body: { error: 'ai_final', message: 'x' } };
    };
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await flush();
    fireEvent.click(within(screen.getByRole('region', { name: 'AI read' })).getByRole('button', { name: 'AI details' }));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Read again' })));
    await flush();
    await tick(21_000);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Read again' })));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('The AI has nothing more to add to this case.');
  });
});

describe('Hide the AI on this case', () => {
  it('puts focus on Show, so the keyboard is not dropped to the page', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    const { user } = await openPlain(w, f.id);
    await user.click(within(await screen.findByRole('region', { name: 'AI read' })).getByRole('button', { name: 'AI details' }));
    await user.click(screen.getByRole('button', { name: 'Hide the AI on this case' }));
    const show = screen.getByRole('button', { name: 'Show' });
    expect(document.activeElement).toBe(show);
  });
});

describe('a part that breaks', () => {
  it('hides itself: the case page is still there, without the strip', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    // A read from some other server: the lines it cited are not a list.
    rewrite(w, f.id, (b) => {
      (b.ai as unknown as { evidenceLineIds: unknown }).evidenceLineIds = null;
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await openPlain(w, f.id);
    await screen.findByRole('region', { name: 'Decision' });
    await new Promise((r) => setTimeout(r, 0));
    expect(noStrip()).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: /report against/ })).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('a read that arrives after the case opened (level 2)', () => {
  const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
  const gateScript = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release: () => release(), script: async (input: AIReadInput) => (await gate, reads({ rule: 2 })(input)) };
  };
  const bar = (): HTMLElement | null => screen.queryByRole('group', { name: 'AI suggestion' });

  it('is adopted while the form is still the ladder\'s: Suggested by AI, with a live Accept', async () => {
    const g = gateScript();
    const { w, f } = await aiWorld({ level: 2, script: g.script, noRead: true });
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await flush();
    expect(within(decision()).getByRole('radio', { name: 'Fair' })).not.toBeChecked();
    expect(bar()).toBeNull();
    g.release();
    await tick(10);
    await flush();
    await tick(5_100);
    await flush();
    await tick(1_000);
    const b = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(b).getByText('Suggested by AI')).toBeInTheDocument();
    expect(within(decision()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(within(b).getByRole('button', { name: /^Accept AI suggestion/ })).toHaveAttribute('aria-disabled', 'false');
  });

  it('is never put over what the moderator changed: the form stays theirs, and the bar says Edited', async () => {
    const g = gateScript();
    const { w, f } = await aiWorld({ level: 2, script: g.script, noRead: true });
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await flush();
    const reason = within(decision()).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement;
    await act(async () => void fireEvent.change(reason, { target: { value: 'Mine.' } }));
    g.release();
    await tick(10);
    await flush();
    await tick(5_100);
    await flush();
    await tick(1_000);
    const b = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(b).getByText('Edited')).toBeInTheDocument();
    expect(within(b).queryByRole('button', { name: /^Accept AI suggestion/ })).toBeNull();
    expect((within(decision()).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement).value).toBe('Mine.');
  });
});

describe('a part chunk that stalls', () => {
  it('releases the ladder form after about 4 seconds, and the form is usable', async () => {
    const { partLoaders, resetLazyParts } = await import('../src/lazyParts.js');
    const { w, f } = await aiWorld({ level: 2 });
    const real = partLoaders.aiParts;
    resetLazyParts();
    partLoaders.aiParts = () => new Promise(() => undefined);
    try {
      vi.useFakeTimers(FAKE);
      renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
      await flush();
      await tick(3_000);
      expect(screen.queryByRole('radio', { name: 'Fair' })).toBeNull();
      await tick(1_500);
      await flush();
      expect(screen.getByRole('radio', { name: 'Fair' })).not.toBeChecked();
    } finally {
      partLoaders.aiParts = real;
      resetLazyParts();
    }
  });
});

describe('the echo of a read that was not shown', () => {
  it('level 1, hidden by the moderator: the decision carries none', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    const { user } = await openPlain(w, f.id);
    await user.click(within(await screen.findByRole('region', { name: 'AI read' })).getByRole('button', { name: 'AI details' }));
    await user.click(screen.getByRole('button', { name: 'Hide the AI on this case' }));
    await user.click(await screen.findByRole('button', { name: 'Nothing wrong here' }));
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/decide'))).toHaveLength(1));
    expect(Object.keys(w.sent.filter((r) => r.path.endsWith('/decide'))[0]!.body as object)).not.toContain('ai');
  });
});
