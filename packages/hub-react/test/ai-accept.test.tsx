import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetHiddenAi } from '../src/ai/hide.js';
import { QUICK_KEYS_KEY, resetQuickKeysVisit, writeQuickKeys } from '../src/quickKeys.js';
import { aiBar, aiCase, aiWorld, decides, decision, flushHold, lastDecide, open, reads, rewrite, settle, strip } from './aiHub.js';
import { MOVING_ATTRIBUTE } from '../src/case/actGuard.js';

// Level 2: A accepts the AI's suggestion into the existing 5 second Undo hold, E opens the editor. The keys act where Quick keys act (1, 2, 3),
// never while typing, never on a case somebody else holds, never on a stale read, and never with more than the AI may fill.

afterEach(() => {
  forgetHiddenAi();
  resetQuickKeysVisit();
  window.localStorage.removeItem(QUICK_KEYS_KEY);
  cleanup();
});

/** A key pressed where focus is (the body when nothing is focused). */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
};
const accept = (bar: HTMLElement): HTMLElement => within(bar).getByRole('button', { name: /^Accept AI suggestion/ });
const heldNotice = (): HTMLElement | null => within(decision()).queryByText('Decision queued.');

/** The case open in Detailed with Quick keys on (the keys act), `stay` so the page is still there to look at. */
async function quick(o: Parameters<typeof aiCase>[0] = {}) {
  writeQuickKeys(true);
  return aiCase({ level: 2, stay: true, ...o });
}

describe('A accepts', () => {
  it('A accepts and enters the Undo hold; Undo restores the form', async () => {
    const { w, user } = await quick();
    const bar = await aiBar();
    expect(w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/decide'))).toHaveLength(0);
    press('a');
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    // Held for five seconds: nothing has been sent yet.
    expect(decides(w)).toHaveLength(0);
    await user.click(within(decision()).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(heldNotice()).toBeNull());
    // Undo puts the form back as it was: still the AI's suggestion, the same fields.
    const back = await aiBar();
    expect(within(back).getByText('Suggested by AI')).toBeInTheDocument();
    expect(within(decision()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(within(decision()).getByText('Warning')).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    expect(bar.isConnected || back.isConnected).toBe(true);
  });

  it('the hold goes on to send what the AI suggested, with the echo of the read', async () => {
    const { w, f } = await quick();
    const read = (await w.client.getReport(f.id)).ai!;
    await aiBar();
    press('a');
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    const body = lastDecide(w) as { verdict: string; reason: string; actions: Array<Record<string, unknown>>; ai: Record<string, unknown> };
    expect(body.verdict).toBe('upheld');
    expect(body.reason).not.toBe('');
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ kind: 'warning', durationMs: null, rule: 2 });
    expect(body.actions[0]!['lineIds']).toHaveLength(1);
    expect(body.ai).toEqual({ readId: read.id, accepted: true, severity: 'rude' });
    // The server recorded it as the AI's suggestion, accepted as it stood.
    const stats = await w.client.aiStatus();
    expect(stats.stats).toMatchObject({ decided: 1, agree: 1, oneClick: 1 });
  });

  it('a recommendation of no action is accepted as a dismissal with no reason', async () => {
    const { w, f } = await quick({
      script: reads({ severity: 'banter', rule: null, evidence: [], recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] } }),
    });
    const read = (await w.client.getReport(f.id)).ai!;
    await aiBar();
    press('a');
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(lastDecide(w)).toEqual({ verdict: 'no_action', actions: [], ai: { readId: read.id, accepted: true, severity: 'banter' } });
  });

  it('the button does the same as the key, and a double click is one accept', async () => {
    const { w } = await quick();
    const bar = await aiBar();
    const button = accept(bar);
    fireEvent.click(button, { detail: 1 });
    fireEvent.click(button, { detail: 2 });
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((lastDecide(w) as { ai: { accepted: boolean } }).ai.accepted).toBe(true);
  });

  it('the Accept button\'s name says the step', async () => {
    await quick();
    const bar = await aiBar();
    expect(accept(bar)).toHaveAccessibleName('Accept AI suggestion: Send a warning');
    expect(accept(bar)).toHaveAttribute('aria-keyshortcuts', 'A');
  });

  it('a held key is one accept, not a series', async () => {
    const { w } = await quick();
    await aiBar();
    press('a');
    press('a', { repeat: true });
    press('a', { repeat: true });
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    await settle(30);
    expect(decides(w)).toHaveLength(1);
  });

  it('a capital A and a key with a modifier: A accepts, Ctrl+A and Alt+A do not', async () => {
    const { w } = await quick();
    await aiBar();
    press('a', { ctrlKey: true });
    press('a', { metaKey: true });
    press('a', { altKey: true });
    await settle(30);
    expect(heldNotice()).toBeNull();
    press('A', { shiftKey: true });
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    expect(decides(w)).toHaveLength(0);
  });

  it('A does nothing while typing in a field', async () => {
    const { w, user } = await quick();
    await aiBar();
    const box = within(decision()).getByRole('textbox', { name: 'Reason' });
    await user.click(box);
    await user.keyboard('a');
    await user.keyboard('e');
    expect((box as HTMLTextAreaElement).value.endsWith('ae')).toBe(true);
    await settle(30);
    expect(heldNotice()).toBeNull();
    expect(decides(w)).toHaveLength(0);
  });

  it('A does nothing with Quick keys off in Detailed, where the digits only choose; the button still works', async () => {
    const { w } = await aiCase({ level: 2, stay: true });
    const bar = await aiBar();
    press('a');
    await settle(30);
    expect(heldNotice()).toBeNull();
    fireEvent.click(accept(bar), { detail: 1 });
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    expect(decides(w)).toHaveLength(0);
  });

  it('A does nothing when shortcuts are off', async () => {
    writeQuickKeys(true);
    await aiCase({ level: 2, stay: true, shortcuts: false });
    await aiBar();
    press('a');
    await settle(30);
    expect(heldNotice()).toBeNull();
  });
});

describe('when A is disabled it says why', () => {
  it('A is disabled while another moderator holds the case, with the reason', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    const { person } = await w.client.getReport(f.id).then((d) => ({ person: d.report.targetPerson }));
    await w.clientFor('maya@example.test', 'moderator').claimCase(person);
    writeQuickKeys(true);
    await open(w, f.id, { stay: true });
    const bar = await aiBar();
    expect(within(bar).getByText('Another moderator has this case, so it cannot be accepted.')).toBeInTheDocument();
    expect(accept(bar)).toHaveAttribute('aria-disabled', 'true');
    press('a');
    fireEvent.click(accept(bar), { detail: 1 });
    await settle(40);
    expect(decides(w)).toHaveLength(0);
    expect(heldNotice()).toBeNull();
  });

  it('A is disabled for a stale read, and a re-read is queued', async () => {
    // The first read lands; a follow-up makes it stale and queues the second read, which hangs so the old one stays on the card.
    const { w, f } = await aiWorld({ level: 2, script: (input, ctx) => (ctx.call === 1 ? reads({ rule: 2 })(input) : { hang: true }) });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { note: 'it went on for a while' })).toEqual({ ok: true });
    writeQuickKeys(true);
    await open(w, f.id, { stay: true });
    const bar = await aiBar();
    expect(within(bar).getByText('This read is out of date. A new one is on its way.')).toBeInTheDocument();
    expect(accept(bar)).toHaveAttribute('aria-disabled', 'true');
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
    expect(decides(w)).toHaveLength(0);
    // The server queued the new read (the follow-up did); the hub did not ask for one itself.
    await settle(60);
    expect(w.adapter?.callCount).toBe(2);
    expect(w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/ai/read'))).toHaveLength(0);
  });

  it('a stale read on the wire is not accepted even if the page says nothing else', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    rewrite(w, f.id, (b) => {
      b.ai.stale = true;
    });
    writeQuickKeys(true);
    await open(w, f.id, { stay: true });
    await aiBar();
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
  });

  it('A does nothing for a role that cannot apply the step', async () => {
    const { w, f } = await aiWorld({ level: 2, world: { permissions: { 'sanctions.apply': 'owner' } } });
    writeQuickKeys(true);
    await open(w, f.id, { stay: true });
    const bar = await aiBar();
    expect(within(bar).getByText('Your role cannot apply this step.')).toBeInTheDocument();
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
    expect(decides(w)).toHaveLength(0);
  });

  it('A does nothing when the AI\'s step is over the ceilings, whatever the wire says', async () => {
    const { w, f } = await aiWorld({ level: 2 });
    rewrite(w, f.id, (b) => {
      const r = b.ai.recommendation as { step: unknown; stepWithinCeiling: boolean };
      r.step = { kind: 'ban', durationMs: null, label: 'Ban, permanent' };
      r.stepWithinCeiling = true;
    });
    writeQuickKeys(true);
    await open(w, f.id, { stay: true });
    await aiBar();
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
    expect(decides(w)).toHaveLength(0);
  });

  it('A does nothing after the form has been edited: it is no longer the AI\'s', async () => {
    const { w, user } = await quick();
    await aiBar();
    await user.type(within(decision()).getByRole('textbox', { name: 'Reason' }), ' More.');
    // Focus leaves the field (a key typed in a field is typing).
    (document.activeElement as HTMLElement).blur();
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
    expect(decides(w)).toHaveLength(0);
  });
});

describe('E and the other keys', () => {
  it('E opens the editor', async () => {
    await quick();
    const bar = await aiBar();
    expect(within(decision()).queryByRole('group', { name: 'Action 1' })).toBeNull();
    press('e');
    await waitFor(() => expect(within(decision()).getByRole('group', { name: 'Action 1' })).toBeInTheDocument());
    expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
  });

  it('pressing 1, 2 or 3 counts as an edit', async () => {
    // Quick keys off (the default in Detailed): the digits choose a verdict, and choosing one by hand is an edit even when it is the same.
    for (const [key, name] of [['1', 'Fair'], ['2', 'Not a problem'], ['3', 'Bad faith']] as const) {
      cleanup();
      resetQuickKeysVisit();
      await aiCase({ level: 2, stay: true });
      const bar = await aiBar();
      expect(within(bar).getByText('Suggested by AI')).toBeInTheDocument();
      press(key);
      await waitFor(() => expect(within(bar).getByText('Edited'), name).toBeInTheDocument());
      expect(within(decision()).getByRole('radio', { name })).toBeChecked();
    }
  });

  it('J and K still move through the queue', async () => {
    const { w } = await aiWorld({ level: 2 });
    for (const [i, target] of ['Alpha', 'Bravo'].entries()) {
      await w.fileRich({ target, reporter: `Rep${i}`, room: `room-x${i}` });
      w.clock.t += 1000;
    }
    await w.aiIdle();
    writeQuickKeys(false);
    const { f } = { f: { id: (await w.client.listReports({ status: 'open' })).items[0]!.id } };
    await open(w, f.id, { stay: true });
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).getAllByRole('link').length).toBeGreaterThanOrEqual(3));
    const rows = within(pane).getAllByRole('link');
    rows[0]!.focus();
    press('j');
    expect(document.activeElement).toBe(rows[1]);
    press('k');
    expect(document.activeElement).toBe(rows[0]);
    // And neither accepted anything.
    expect(decides(w)).toHaveLength(0);
  });
});

describe('what the decide body says', () => {
  it('the decide body carries ai readId and accepted; accepted is false after an edit', async () => {
    const { w, f, user } = await aiCase({ level: 2, stay: true });
    const read = (await w.client.getReport(f.id)).ai!;
    await aiBar();
    await user.type(within(decision()).getByRole('textbox', { name: 'Reason' }), ' Also repeated.');
    await user.click(within(decision()).getByRole('button', { name: 'Decide' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    const body = lastDecide(w) as { ai: Record<string, unknown>; reason: string };
    expect(body.ai).toMatchObject({ readId: read.id, accepted: false });
    expect(body.reason).toMatch(/Also repeated\./);
    // The server filed it as the human's own decision on the AI's read: an agreement, but not a one-click accept.
    const stats = await w.client.aiStatus();
    expect(stats.stats).toMatchObject({ decided: 1, oneClick: 0 });
  });

  it('deciding the untouched suggestion by hand (Decide, not A) still says accepted', async () => {
    const { w, f, user } = await aiCase({ level: 2, stay: true });
    const read = (await w.client.getReport(f.id)).ai!;
    await aiBar();
    await user.click(within(decision()).getByRole('button', { name: 'Decide' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((lastDecide(w) as { ai: unknown }).ai).toEqual({ readId: read.id, accepted: true, severity: 'rude' });
  });

  it('Nothing wrong here sends the echo with accepted false', async () => {
    const { w, f, user } = await aiCase({ level: 2, stay: true });
    const read = (await w.client.getReport(f.id)).ai!;
    await aiBar();
    await user.click(within(decision()).getByRole('button', { name: 'Nothing wrong here' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((lastDecide(w) as { ai: unknown }).ai).toEqual({ readId: read.id, accepted: false });
  });

  it('at level 1 a read that was shown is echoed too, as not accepted', async () => {
    const { w, f, user } = await aiCase({ level: 1, stay: true });
    const read = (await w.client.getReport(f.id)).ai!;
    await strip();
    await user.click(within(decision()).getByRole('button', { name: 'Nothing wrong here' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((lastDecide(w) as { ai: unknown }).ai).toEqual({ readId: read.id, accepted: false });
  });

  it('with the AI off, the body has no ai key at all', async () => {
    const { w, user } = await aiCase({ level: 0, stay: true });
    await user.click(within(decision()).getByRole('button', { name: 'Nothing wrong here' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(Object.keys(lastDecide(w) as object)).not.toContain('ai');
  });

  it('with the AI hidden on the case, the echo is left out', async () => {
    const { w, user } = await aiCase({ level: 2, stay: true });
    await aiBar();
    await user.click(within(await strip()).getByRole('button', { name: 'AI details' }));
    await user.click(screen.getByRole('button', { name: 'Hide the AI on this case' }));
    await user.click(within(decision()).getByRole('button', { name: 'Nothing wrong here' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(Object.keys(lastDecide(w) as object)).not.toContain('ai');
  });

  it('a conduct level picked by hand is the level the echo carries', async () => {
    const { w, user } = await aiCase({ level: 2, stay: true });
    await aiBar();
    await user.click(within(decision()).getByRole('button', { name: 'Change' }));
    await user.click(within(decision()).getByRole('button', { name: 'Hostile' }));
    await waitFor(() => expect(within(decision()).getByRole('button', { name: 'Hostile', pressed: true })).toBeInTheDocument());
    await user.click(within(decision()).getByRole('button', { name: 'Decide' }));
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    await flushHold();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((lastDecide(w) as { ai: { severity: string } }).ai.severity).toBe('hostile');
  });
});

describe('the act guard', () => {
  it('a move in progress holds the key (the hub root says it is moving)', async () => {
    const { w } = await quick();
    await aiBar();
    const root = document.querySelector('.cw-hub') as HTMLElement;
    root.setAttribute(MOVING_ATTRIBUTE, '');
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
    root.removeAttribute(MOVING_ATTRIBUTE);
    press('a');
    await waitFor(() => expect(heldNotice()).not.toBeNull());
    expect(decides(w)).toHaveLength(0);
  });

  it('a window asked for holds the key too', async () => {
    await quick();
    await aiBar();
    const root = document.querySelector('.cw-hub') as HTMLElement;
    root.setAttribute('data-cw-window', '');
    press('a');
    await settle(40);
    expect(heldNotice()).toBeNull();
    root.removeAttribute('data-cw-window');
  });

  it('a key held down while the page was loading is not an accept (repeat)', async () => {
    await quick();
    await aiBar();
    await act(async () => void press('a', { repeat: true }));
    await settle(30);
    expect(heldNotice()).toBeNull();
  });
});
