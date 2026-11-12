import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outcomeChoice } from '../src/decision.js';
import { createT, en } from '../src/i18n.js';
import { stepLabel } from '../src/simple.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// Fix round 1 for Simple mode: the suggestion is never older than the case (a newer report re-reads it), the keys stay quiet in three
// more places, and a runtime `mode` that is not a mode falls back to the default.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
const words = createT(en, 'en');

describe('a newer report re-reads the case, so one click never sends an older suggestion', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await tick(0);
  };
  const reads = (w: HubWorld, id: string): number => w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${id}`).length;
  const labelOf = async (w: HubWorld, id: string): Promise<string> => {
    const outcome = (await w.direct.getReport(id)).suggest.outcome;
    return stepLabel(words, 'en', outcomeChoice(outcome)!);
  };
  const primaries = (): HTMLElement[] => within(screen.getByRole('region', { name: 'Decision' })).queryAllByRole('button', { name: /^(Restrict|Ban|Send a warning)/ }).filter((b) => b.getAttribute('aria-keyshortcuts') === '1');

  /** An open card, then: another report about the person arrives and somebody acts on them (so the ladder moves). */
  async function cardThatGoesStale() {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await settle();
    expect(primaries().map((b) => b.textContent)).toEqual([expect.stringMatching(/^Restrict chat, 24 hours/)]);
    const later = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Another', room: 'r-later' });
    expect(later.person).toBe(f.person);
    await w.sanction(f.person, 'chat', 1);
    const fresh = await labelOf(w, f.id);
    expect(fresh).not.toBe('Restrict chat, 24 hours');
    return { w, f, fresh };
  }

  it('the button follows the ladder once the queue sees the newer report', async () => {
    const { w, f, fresh } = await cardThatGoesStale();
    const before = reads(w, f.id);
    await tick(5_100);
    await settle();
    expect(reads(w, f.id)).toBe(before + 1);
    expect(primaries().map((b) => b.textContent)).toEqual([expect.stringContaining(fresh)]);
    expect(screen.getByText('2 reports: Insults or harassment.')).toBeInTheDocument();
  });

  it('what a click sends is the fresh step', async () => {
    const { w, f } = await cardThatGoesStale();
    // What the ladder says now, asked before anything is decided (a decision moves it again).
    const outcome = (await w.direct.getReport(f.id)).suggest.outcome as { kind: string; durationMs: number | null };
    expect(outcome).not.toEqual({ kind: 'chat', durationMs: 86_400_000 });
    await tick(5_100);
    await settle();
    fireEvent.click(primaries()[0]!);
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toMatchObject({ actions: [{ kind: outcome.kind, durationMs: outcome.durationMs }] });
  });

  it('while the re-read is out the button does nothing, and the old suggestion is never sent', async () => {
    const { w, f, fresh } = await cardThatGoesStale();
    let release: () => void = () => undefined;
    let hold = true;
    w.intercept.fn = (req) =>
      hold && req.method === 'GET' && req.path === `/reports/${f.id}` ? new Promise((resolve) => (release = () => resolve(undefined))) : undefined;
    await tick(5_100);
    await settle();
    const stale = primaries()[0]!;
    expect(stale).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(stale);
    fireEvent.keyDown(document, { key: '1' });
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    expect(screen.queryByText('Decision queued.')).toBeNull();
    hold = false;
    release();
    await settle();
    expect(primaries()[0]).not.toHaveAttribute('aria-disabled', 'true');
    expect(primaries()[0]!.textContent).toContain(fresh);
  });

  it('an unchanged count reads the case once, and a decision of your own does not read it again', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await settle();
    await tick(16_000);
    await settle();
    expect(reads(w, f.id)).toBe(1);
    fireEvent.click(primaries()[0]!);
    await pageHides();
    await settle();
    await tick(6_000);
    await settle();
    expect(reads(w, f.id)).toBe(1);
  });
});

describe('the keys stay quiet in three more places', () => {
  async function card() {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    // The page stays where it is (a quick action would move on): these are about the decision on this case.
    const r = renderHub(w, { mode: 'simple', path: `/reports/${f.id}`, stay: true });
    await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    w.clock.t += 400;
    return { w, f, ...r };
  }

  it('while a decision is waiting: 1, 2 and Ctrl+Enter send nothing more', async () => {
    const { w, user } = await card();
    await user.click(screen.getByRole('button', { name: /^Restrict chat, 24 hours/ }));
    await screen.findByText('Decision queued.');
    await user.keyboard('1');
    await user.keyboard('2');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'upheld' });
  });

  it('while typing in a field: 1 and 2 are characters, not decisions', async () => {
    const { w, user } = await card();
    const field = document.createElement('input');
    document.body.append(field);
    try {
      field.focus();
      await user.keyboard('12');
      expect(field).toHaveValue('12');
      await pageHides();
      expect(decides(w)).toHaveLength(0);
    } finally {
      field.remove();
    }
    // Control: with the field gone the same key acts, so the zero above was the field's doing.
    await user.keyboard('2');
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });

  it('inside the command bar: typing 1 or 2, or Ctrl+Enter, decides nothing', async () => {
    const { w, user } = await card();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), '12');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });
});

describe('a mode that is not a mode', () => {
  it('falls back to the default, with the switch shown', async () => {
    window.localStorage.clear();
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: 'compact' as never });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument();
  });

  it('and then follows what the moderator chose, like no prop at all', async () => {
    window.localStorage.setItem('chatwarden.hub.mode', 'detailed');
    try {
      const w = await hubWorld();
      const { container, user } = renderHub(w, { mode: '' as never });
      await screen.findByRole('region', { name: 'Open cases' });
      expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
      await user.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'Simple' }));
      expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
    } finally {
      window.localStorage.clear();
    }
  });
});

describe('the More menu names only what exists', () => {
  it('has no aria-controls while closed, and one that points at the list while open', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    const nav = screen.getByRole('navigation', { name: 'Moderator hub sections' });
    const more = within(nav).getByRole('button', { name: 'More' });
    expect(more).not.toHaveAttribute('aria-controls');
    await user.click(more);
    const id = more.getAttribute('aria-controls');
    expect(id).not.toBeNull();
    expect(document.getElementById(id as string)).not.toBeNull();
    expect(document.getElementById(id as string)).toContainElement(within(nav).getByRole('link', { name: 'Audit' }));
  });
});
