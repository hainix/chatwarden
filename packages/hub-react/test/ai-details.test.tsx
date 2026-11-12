import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import { forgetHiddenAi } from '../src/ai/hide.js';
import { aiCase, aiWorld, noStrip, open, openPlain, reads, settle, strip } from './aiHub.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The AI details menu: the one door behind the strip. What it lists, how it opens and closes, what Read again does and how it fails,
// and the local "hide the AI on this case".

afterEach(() => {
  forgetHiddenAi();
  cleanup();
});

const details = async (): Promise<HTMLButtonElement> => within(await strip()).getByRole('button', { name: 'AI details' }) as HTMLButtonElement;
const menu = (): HTMLElement | null => screen.queryByRole('group', { name: 'AI details' });
const readPosts = (w: HubWorld): number => w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/ai/read')).length;

/** Answers the next "read again" itself: the real routes would say ready (nothing changed). */
function answer(w: HubWorld, status: number, body: unknown, headers: Record<string, string> = {}): void {
  w.intercept.fn = (req) => (req.method === 'POST' && req.path.endsWith('/ai/read') ? { status, headers, body } : undefined);
}

describe('opening and closing', () => {
  it('details menu opens with keyboard, lists the fields, closes on Escape', async () => {
    const { user } = await aiCase({ level: 1 });
    const button = await details();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(menu()).toBeNull();
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = menu() as HTMLElement;
    expect(panel).not.toBeNull();
    // The fields: the model, when it read, how sure, and nothing else of the evidence.
    expect(within(panel).getByText('Model')).toBeInTheDocument();
    expect(within(panel).getByText(/fake/)).toBeInTheDocument();
    expect(within(panel).getByText('Read')).toBeInTheDocument();
    expect(within(panel).getByText('Confidence')).toBeInTheDocument();
    expect(within(panel).getByText('Medium')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Read again' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Hide the AI on this case' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(menu()).toBeNull();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // Focus is back on the button, and the hub's own Escape did not also move it to the queue.
    expect(document.activeElement).toBe(button);
  });

  it('opens with Space too, and the button toggles it closed', async () => {
    const { user } = await aiCase({ level: 1 });
    const button = await details();
    button.focus();
    await user.keyboard(' ');
    expect(menu()).not.toBeNull();
    await user.click(button);
    expect(menu()).toBeNull();
  });

  it('a click elsewhere closes it', async () => {
    const { user } = await aiCase({ level: 1 });
    await user.click(await details());
    expect(menu()).not.toBeNull();
    await user.click(document.body);
    expect(menu()).toBeNull();
  });

  it('lists nothing of the evidence: no summary again, no line, no person', async () => {
    const { user } = await aiCase({ level: 1 });
    await user.click(await details());
    const panel = menu() as HTMLElement;
    expect(panel.textContent).not.toContain('The reported player was rude in chat.');
    expect(panel.textContent).not.toMatch(/you are trash|Mallory/);
  });

  it('has nothing to say about older rules or instructions on a clean read', async () => {
    const { user } = await aiCase({ level: 1 });
    await user.click(await details());
    expect(within(menu() as HTMLElement).queryByText(/older rules/i)).toBeNull();
    expect(within(menu() as HTMLElement).queryByText(/instruct/i)).toBeNull();
  });
});

describe('the notes', () => {
  it('an injection-suspected read shows the plain note in details and the strip says nothing alarming', async () => {
    const { user } = await aiCase({ level: 1, script: reads({ injectionSuspected: true }) });
    const region = await strip();
    expect(region.textContent).not.toMatch(/instruct|injection|suspect/i);
    await user.click(await details());
    const note = within(menu() as HTMLElement).getByText(/tried to give the AI instructions/i);
    expect(note).toBeInTheDocument();
    // Plain: not a warning box, no alert role.
    expect(note.closest('[role="alert"], .cw-notice--warn, .cw-notice--bad')).toBeNull();
  });

  it('a stale read shows the older-rules note only in details', async () => {
    // The first read lands; a follow-up then makes it stale, and the second read hangs so the old one stays on the card.
    const { w, f } = await aiWorld({ level: 1, script: [{ usage: {} }, { hang: true }] });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { note: 'it went on for a while' })).toEqual({ ok: true });
    const { user } = await (async () => {
      const r = await open(w, f.id);
      return r;
    })();
    const region = await strip();
    expect(region.textContent).not.toMatch(/older|stale/i);
    await user.click(await details());
    expect(within(menu() as HTMLElement).getByText(/older rules or an older version of the case/i)).toBeInTheDocument();
  });
});

describe('Read again', () => {
  it('read again calls the client once and shows pending', async () => {
    const { w, user } = await aiCase({ level: 1 });
    answer(w, 202, { status: 'pending' });
    await user.click(await details());
    const again = within(menu() as HTMLElement).getByRole('button', { name: 'Read again' });
    await user.click(again);
    await user.click(again);
    await waitFor(() => expect(readPosts(w)).toBe(1));
    await settle();
    expect(readPosts(w)).toBe(1);
    // Pending: the strip says so (a polite status), and the button waits.
    expect(within(await strip()).getByText('Reading again')).toBeInTheDocument();
    expect(again).toHaveAttribute('aria-disabled', 'true');
    // And the menu shows no error.
    expect(within(menu() as HTMLElement).queryByRole('alert')).toBeNull();
  });

  it('ready means nothing changed: it says so and reads the case again for the latest', async () => {
    const { w, user } = await aiCase({ level: 1 });
    await user.click(await details());
    await user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Read again' }));
    await within(menu() as HTMLElement).findByText('Nothing has changed since this read, so it stands.');
    expect(readPosts(w)).toBe(1);
  });

  it.each([
    ['ai_final', 409, 'The AI has nothing more to add to this case.', {}],
    ['ai_budget', 429, 'The AI has reached its limit for today.', {}],
    ['ai_unavailable', 503, 'The AI is not available right now.', { 'retry-after': '30' }],
    ['ai_off', 409, 'The AI is off.', {}],
  ])('a failed read again (%s) shows the hub\'s normal error block inside the menu only', async (code, status, text, headers) => {
    const { w, user } = await aiCase({ level: 1 });
    answer(w, status, { error: code, message: 'server words that are never shown' }, headers);
    await user.click(await details());
    await user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Read again' }));
    const alert = await within(menu() as HTMLElement).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent('server words that are never shown');
    // The error is in the menu, not on the case: every alert on the page is inside the menu, and no toast was raised.
    for (const a of screen.getAllByRole('alert')) expect(menu()?.contains(a)).toBe(true);
    expect(document.querySelector('.cw-toast')).toBeNull();
    expect(document.querySelector('.cw-ai-summary')?.textContent).toBe('The reported player was rude in chat.');
  });

  it('a network failure has Try again, which asks once more', async () => {
    const { w, user } = await aiCase({ level: 1 });
    let n = 0;
    w.intercept.fn = (req) => {
      if (req.method === 'POST' && req.path.endsWith('/ai/read')) {
        n += 1;
        return n === 1 ? { status: 503, headers: {}, body: { error: 'unavailable', message: 'x' } } : { status: 202, headers: {}, body: { status: 'pending' } };
      }
      return undefined;
    };
    await user.click(await details());
    await user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Read again' }));
    const alert = await within(menu() as HTMLElement).findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(readPosts(w)).toBe(2));
    await waitFor(() => expect(within(menu() as HTMLElement).queryByRole('alert')).toBeNull());
  });

  it('a role that cannot decide is not offered it', async () => {
    const { w, f } = await aiWorld({ level: 1, world: { permissions: { 'reports.decide': 'owner' } } });
    const { user } = await openPlain(w, f.id);
    await user.click(await details());
    expect(within(menu() as HTMLElement).queryByRole('button', { name: 'Read again' })).toBeNull();
    expect(within(menu() as HTMLElement).getByRole('button', { name: 'Hide the AI on this case' })).toBeInTheDocument();
  });
});

describe('Hide the AI on this case', () => {
  it('hide on this case persists for the session and is per moderator', async () => {
    const first = await aiCase({ level: 1 });
    await first.user.click(await details());
    await first.user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Hide the AI on this case' }));
    // The strip and the ticks are gone; one quiet line says so and offers the way back.
    expect(noStrip()).toBeNull();
    expect(document.querySelectorAll('.cw-aitick')).toHaveLength(0);
    const line = screen.getByText('The AI is hidden on this case.');
    expect(within(line.parentElement as HTMLElement).getByRole('button', { name: 'Show' })).toBeInTheDocument();

    // The same moderator, the case opened again in the same session: still hidden.
    cleanup();
    await open(first.w, first.f.id);
    expect(await screen.findByText('The AI is hidden on this case.')).toBeInTheDocument();
    expect(noStrip()).toBeNull();

    // Another moderator sees the strip.
    cleanup();
    first.w.session.who = { actor: 'maya@example.test', role: 'moderator' };
    await open(first.w, first.f.id);
    expect(await strip()).toBeInTheDocument();
    expect(screen.queryByText('The AI is hidden on this case.')).toBeNull();
  });

  it('Show brings it back', async () => {
    const { user } = await aiCase({ level: 1 });
    await user.click(await details());
    await user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Hide the AI on this case' }));
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await strip()).toBeInTheDocument();
    expect(screen.queryByText('The AI is hidden on this case.')).toBeNull();
  });

  it('hiding one case does not hide another', async () => {
    const first = await aiCase({ level: 1 });
    const other = await first.w.fileRich({ target: 'Other', reporter: 'Someone', room: 'room-x' });
    await first.w.aiIdle();
    await first.user.click(await details());
    await first.user.click(within(menu() as HTMLElement).getByRole('button', { name: 'Hide the AI on this case' }));
    cleanup();
    await open(first.w, other.id, { mode: 'detailed' }).catch(() => undefined);
    expect(await strip()).toBeInTheDocument();
  });
});

describe('the menu in Simple mode', () => {
  it('is the same door, with the same keyboard way in', async () => {
    const { user } = await aiCase({ level: 1, mode: 'simple' });
    const button = await details();
    button.focus();
    await user.keyboard('{Enter}');
    expect(menu()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(menu()).toBeNull();
  });
});

describe('the signal context line (menu only)', () => {
  const KINDS = {
    muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
    commended: { label: 'Commended by other players', polarity: 'positive' as const },
  };
  const FEED = { ai: { kinds: ['muted_by_player', 'commended'], windowDays: 14 } };

  /** A world with the AI on, signals declared, and `counts` kinds of signals already recorded about the person the case is against. */
  async function withSignals(feeds: Record<string, unknown> | null, counts: Array<'muted_by_player' | 'commended'>) {
    const w = await hubWorld({
      actor: 'ann@example.test',
      store: withMemorySignals(withMemoryAi(new MemoryStore())),
      overrides: { signals: { kinds: KINDS, ...(feeds === null ? {} : { feeds }) } } as never,
      ai: { level: 1 },
    });
    // The person is known before the report: seat them (the same key as the report's target), then record the signals.
    w.cw.rooms.seat('pre-room', 'p2', { clientKey: 'key-target-Mallory' }, 'Mallory');
    const subject = w.cw.rooms.subjectAt('pre-room', 'p2') as string;
    counts.forEach((kind, i) => {
      for (let k = 0; k < 2; k += 1) {
        w.cw.rooms.seat(`pre-${kind}-${i}-${k}`, 'p1', { clientKey: `key-${kind}-${k}` }, `H${k}`);
        w.cw.signals.record({ kind, subject, by: w.cw.rooms.subjectAt(`pre-${kind}-${i}-${k}`, 'p1') as string });
      }
    });
    const f = await w.fileRich({ note: 'Keeps following me.' });
    await w.aiIdle();
    return { w, f };
  }

  it('shows "Context included: 2 signal counts" when the read was shown two counts', async () => {
    const { w, f } = await withSignals(FEED, ['muted_by_player', 'commended']);
    const { user } = await open(w, f.id);
    await user.click(await details());
    expect(within(menu() as HTMLElement).getByText('Context included: 2 signal counts')).toBeInTheDocument();
  });

  it('one count reads in the singular', async () => {
    const { w, f } = await withSignals(FEED, ['muted_by_player']);
    const { user } = await open(w, f.id);
    await user.click(await details());
    expect(within(menu() as HTMLElement).getByText('Context included: 1 signal count')).toBeInTheDocument();
  });

  it('is not there when no signals were sent (feed off, or no counts), and the strip shows nothing of it either way', async () => {
    for (const [feeds, counts] of [[null, ['muted_by_player']], [FEED, []]] as const) {
      const { w, f } = await withSignals(feeds, [...counts]);
      const { user } = await open(w, f.id);
      expect(within(await strip()).queryByText(/Context included|signal/i)).toBeNull();
      await user.click(await details());
      expect(within(menu() as HTMLElement).queryByText(/Context included/)).toBeNull();
      cleanup();
    }
  });
});
