// The demo's moderator pane is the REAL hub (@chatwarden/hub-react) over the real staff routes, and its player side is
// player-react's NoticeQueue and ReportDialog. These tests play the whole loop through them: the scripted chat, a one-tap report,
// the case in the hub, the decision (with its Undo), and the notice the player acknowledges.
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { caseLink, closeReport, composer, gamePane, hubRoot, live, modPane, noticeBtn, oneTapReport, openCase, pickRule, reportBtn, RUDE, screen, sendHeldDecision, setup, stubMatchMedia, waitFor, within } from './helpers/demoUi';

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe('the moderator pane is the real hub', () => {
  it('draws @chatwarden/hub-react in Simple mode, with the Simple/Detailed switch showing', async () => {
    await setup();
    const hub = hubRoot();
    expect(hub).toBeTruthy();
    expect(within(modPane()).getByRole('heading', { level: 3, name: 'Your moderator' })).toBeTruthy();
    const view = within(hub).getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'Simple' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(view).getByRole('button', { name: 'Detailed' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(hub).getByRole('heading', { name: 'Moderation' })).toBeTruthy();
    expect(hub.textContent).toMatch(/nothing is waiting/i);
  });

  it('has none of the old hand-built console: no Warn/Timeout buttons, no evidence list, no My record tab', async () => {
    await setup();
    expect(document.querySelector('.decide-bar, .evidence, .mod-tabs, .pframe')).toBeNull();
    expect(screen.queryByRole('button', { name: /my record/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Warn' })).toBeNull();
  });

  it('is signed in as a made-up owner, so every screen opens, and says so', async () => {
    await setup();
    const who = within(hubRoot()).getByRole('group', { name: 'Signed in' });
    expect(who.textContent).toMatch(/demo-mod/);
    expect(who.textContent).toMatch(/owner/i);
  });

  it('follows the page theme, and the toggle', async () => {
    document.documentElement.dataset.theme = 'light';
    await setup();
    expect(hubRoot().getAttribute('data-cw-theme')).toBe('light');
    document.documentElement.dataset.theme = 'dark';
    await waitFor(() => expect(hubRoot().getAttribute('data-cw-theme')).toBe('dark'));
  });

  it('never touches the page address (its router is in memory)', async () => {
    const before = window.location.hash;
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await openCase(user);
    expect(window.location.hash).toBe(before);
  });
});

describe('the hub’s keys never fire while the visitor types in the game', () => {
  async function withReport() {
    const ctx = await setup();
    await oneTapReport(ctx.user);
    await closeReport(ctx.user);
    await caseLink(ctx.user);
    return ctx;
  }

  it('typing n, j and k in the chat box opens no case (focus is outside the hub)', async () => {
    const { user } = await withReport();
    composer().focus();
    await user.keyboard('njk n');
    expect(composer().value).toBe('njk n');
    expect(within(modPane()).queryByRole('region', { name: /case against/i })).toBeNull();
    expect(live().textContent).not.toMatch(/claim/i);
  });

  it('control: the same key with focus inside the hub does take the case', async () => {
    const { user } = await withReport();
    within(modPane()).getAllByRole('button', { name: /take next case/i })[0]?.focus();
    await user.keyboard('n');
    await within(modPane()).findByRole('region', { name: /case against bo/i });
  });

  it('typing in the report dialog’s note field is never taken either', async () => {
    const { user, engine } = await setup();
    vi.spyOn(engine.reports, 'submit');
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('nnn');
    expect(within(modPane()).queryByRole('region', { name: /case against/i })).toBeNull();
  });

  it('with nothing focused the hub answers only once the visitor has worked in the demo (primary follows the visitor)', async () => {
    const { engine } = await setup();
    // A report filed behind the page's back, so nobody has pressed anything in the demo yet.
    const sent = await engine.chat.accept('bo', 'one more rude line, honestly');
    await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: 'deliver' in sent ? sent.deliver.lineId : '' });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    // A key on a page the visitor has not touched: not the hub's.
    fireEvent.keyDown(document.body, { key: 'n' });
    await new Promise((r) => setTimeout(r, 80));
    expect(within(modPane()).queryByRole('region', { name: /case against/i })).toBeNull();
    // The visitor presses on the demo's empty space: now the hub is primary and answers.
    fireEvent.pointerDown(gamePane().querySelector('.pane-head') as HTMLElement);
    fireEvent.keyDown(document.body, { key: 'n' });
    await within(modPane()).findByRole('region', { name: /case against bo/i });
  });

  it('the keys are off once focus moves into the chat box (even if the box is later left with nothing focused), and on again when the visitor presses in the hub', async () => {
    const { engine } = await setup();
    const sent = await engine.chat.accept('bo', 'a rude line for the keys test');
    await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: 'deliver' in sent ? sent.deliver.lineId : '' });
    // the visitor works in the hub (keys on), then clicks into the chat box (keys off)
    fireEvent.pointerDown(hubRoot());
    composer().focus();
    fireEvent.focusIn(composer());
    // leaving the box with nothing focused must not hand the page's keys back to the hub
    composer().blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'n' });
    await new Promise((r) => setTimeout(r, 80));
    expect(within(modPane()).queryByRole('region', { name: /case against/i })).toBeNull();
    // pressing in the hub turns them on again
    fireEvent.pointerDown(hubRoot());
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'n' });
    await within(modPane()).findByRole('region', { name: /case against bo/i });
  });

  it('the composer’s quick lines count as the chat box too', async () => {
    const { engine } = await setup();
    const sent = await engine.chat.accept('bo', 'another rude line for the keys test');
    await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: 'deliver' in sent ? sent.deliver.lineId : '' });
    fireEvent.pointerDown(hubRoot());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'gg' }));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'n' });
    await new Promise((r) => setTimeout(r, 80));
    expect(within(modPane()).queryByRole('region', { name: /case against/i })).toBeNull();
  });

  it('a press outside the demo hands the keys back to the page', async () => {
    const { engine } = await setup();
    const sent = await engine.chat.accept('bo', 'yet another rude line');
    await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: 'deliver' in sent ? sent.deliver.lineId : '' });
    fireEvent.pointerDown(gamePane().querySelector('.pane-head') as HTMLElement);
    fireEvent.pointerDown(document.body); // somewhere else on the page
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'n' });
    await new Promise((r) => setTimeout(r, 80));
    expect(within(modPane()).queryByRole('region', { name: /case against/i })).toBeNull();
  });
});

describe('scripted chat to a report to a case in the hub', () => {
  it('a one-tap report of Bo’s scripted line lands in the hub queue with the chat as its evidence', async () => {
    const { user, engine } = await setup();
    expect(within(modPane()).queryByRole('link', { name: /^Bo/ })).toBeNull();
    await oneTapReport(user);
    await closeReport(user);
    const link = await caseLink(user);
    expect(link.textContent).toMatch(/no reason given/i);
    expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(1);
    const card = await openCase(user);
    expect(card.textContent).toContain(RUDE);
    expect(card.textContent).toMatch(/reported by you/i);
    // staff see the line the filter refused, in the evidence, hidden until shown
    await user.click(within(card).getByRole('button', { name: /show the whole chat/i }));
    expect(card.textContent).toMatch(/blocked words, hidden|blocked/i);
    expect(card.textContent).not.toMatch(/zorbak/i);
  });

  it('is announced politely', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await waitFor(() => expect(live().textContent).toMatch(/report filed against bo/i));
  });

  it('a case for each of two reported people', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await caseLink(user);
    await oneTapReport(user, /report ada's line: ok that was close/i);
    await closeReport(user);
    await caseLink(user, /^Ada/);
    expect(within(modPane()).getAllByRole('link', { name: /^(Bo|Ada)/ })).toHaveLength(2);
  });
});

describe('the whole loop: report, decide in the hub, the player’s notice', () => {
  it('apply the suggestion: Undo shows, the decision is sent, the kit has the sanction, and Bo’s notice appears and is acknowledged', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    const apply = within(card).getByRole('button', { name: /^restrict chat, 24 hours/i });
    await user.click(apply);
    // the hold: an Undo toast, and nothing sent yet
    expect(await within(modPane()).findByText(/sending the decision on bo in 5 s/i)).toBeTruthy();
    expect(within(modPane()).getAllByRole('button', { name: 'Undo' }).length).toBeGreaterThan(0);
    expect(await engine.notices.pending('bo')).toEqual([]);
    await sendHeldDecision();
    // the player's side: a button for the notice, then the real dialog
    const see = await noticeBtn('Bo');
    expect(live().textContent).toMatch(/bo has a notice waiting/i);
    expect((await engine.notices.pending('bo')).map((n) => n.kind)).toEqual(['chat']);
    await user.click(see);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /chat/i })).toBeTruthy();
    expect(dialog.textContent).toContain(RUDE); // the line the moderator chose to show
    expect(dialog.textContent).toMatch(/rule 2/i);
    await user.click(within(dialog).getByRole('button', { name: /got it/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect((await engine.notices.record('bo')).map((n) => n.kind)).toEqual(['chat']);
    // and Bo sits out: the seat says so
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    await waitFor(() => expect(within(seats).getByText('Bo').closest('li')?.textContent).toMatch(/timed out until/i));
  });

  it('Send a warning (the light tap): Bo gets a warning to acknowledge', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await user.click(await noticeBtn('Bo'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /warning/i })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect(live().textContent).toMatch(/bo acknowledged/i);
  });

  it('Undo takes the decision back: nothing is sent, nothing reaches Bo', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    const undo = (await within(modPane()).findAllByRole('button', { name: 'Undo' }))[0] as HTMLElement;
    await user.click(undo);
    await sendHeldDecision();
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect(screen.queryByRole('button', { name: /see what bo sees/i })).toBeNull();
    expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(1);
  });

  it('No action needed tells the player nothing: no notice button', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^no action needed/i }));
    await sendHeldDecision();
    await waitFor(async () => expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(0));
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect(screen.queryByRole('button', { name: /see what/i })).toBeNull();
  });

  it('a notice for the visitor (the kit’s own automatic timeout) has its own button, and says "you"', async () => {
    const { user } = await setup();
    for (const w of ['zorbak', 'vlemmo', 'snerp']) {
      await user.clear(composer());
      await user.type(composer(), `you ${w}`);
      await user.keyboard('{Enter}');
    }
    const see = await screen.findByRole('button', { name: /see what you see/i });
    await user.click(see);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /chat/i })).toBeTruthy();
    expect(dialog.textContent).toMatch(/rule 1/i);
  });

  it('the notice dialog opens only when the visitor asks (it never interrupts the hub)', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await noticeBtn('Bo');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the report dialog is player-react’s, on the kit’s own reporting settings', () => {
  it('one tap by default: a question, the line, Report and Cancel; no category list', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = await screen.findByRole('dialog', { name: /report this message/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain(RUDE);
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Report' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('Cancel and Escape close it without filing, and focus goes back to the report button', async () => {
    const { user, engine } = await setup();
    const opener = reportBtn(/report bo's line: uninstall/i);
    await user.click(opener);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await engine.kit()).reports.list({ status: 'open' }).items).toHaveLength(0);
  });

  it('after the report, the optional "Add a reason" step adds a reason to the same report (onAddDetail -> cw.reports.addDetail)', async () => {
    const { user, engine } = await setup();
    const dialog = await oneTapReport(user);
    expect(within(dialog).getByRole('status').textContent).toMatch(/thank/i);
    const add = vi.spyOn(engine.reports, 'addDetail');
    await user.click(within(dialog).getByRole('button', { name: 'Add a reason' }));
    const reasons = within(dialog).getAllByRole('radio');
    expect(reasons.length).toBeGreaterThan(2);
    await user.click(reasons[0] as HTMLElement);
    await user.click(within(dialog).getByRole('button', { name: /add to my report/i }));
    await within(dialog).findByText(/added\. thanks/i);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[1]).toBe('you');
    const report = (await engine.kit()).reports.list({ status: 'open' }).items[0];
    expect(report?.reportedReason).toBeTruthy();
    await closeReport(user);
    // the hub shows the reason now
    const link = await caseLink(user);
    await waitFor(() => expect(link.textContent).not.toMatch(/no reason given/i));
  });

  it('follows the studio’s settings live: switch to "pick a reason first" in the kit and the dialog lists the reasons', async () => {
    const { user, engine } = await setup();
    const cw = await engine.kit();
    const saved = cw.policy.save({ reporting: { flow: 'reason_first' } }, { version: cw.policy.get().version, actor: 'demo-mod', reason: 'test' });
    expect(saved.ok).toBe(true);
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = await screen.findByRole('dialog', { name: /report bo/i });
    expect(within(dialog).getAllByRole('radio').length).toBeGreaterThan(2);
    expect(within(dialog).getByRole('button', { name: /skip and report/i })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('a refusal is a result, in the player’s words: reporting the same player twice', async () => {
    const { user } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already reported this player/i);
  });

  it('shows the dialog in the page theme', async () => {
    document.documentElement.dataset.theme = 'light';
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await screen.findByRole('dialog');
    expect(document.querySelector('.cw-player')?.getAttribute('data-cw-theme')).toBe('light');
  });
});

describe('reset', () => {
  it('builds a new kit and a new hub: the queue, the notice button and the dialogs are gone', async () => {
    const { user, engine } = await setup();
    await oneTapReport(user);
    await closeReport(user);
    const card = await openCase(user);
    await pickRule(user);
    await user.click(within(card).getByRole('button', { name: /^send a warning/i }));
    await sendHeldDecision();
    await noticeBtn('Bo');
    const before = await engine.kit();
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /see what bo sees/i })).toBeNull());
    expect(await engine.kit()).not.toBe(before);
    await waitFor(() => expect(hubRoot().textContent).toMatch(/nothing is waiting/i));
    expect(within(modPane()).queryByRole('link', { name: /^Bo/ })).toBeNull();
    expect(await engine.notices.pending('bo')).toEqual([]);
  });

  it('puts the hub back in Simple, even if the visitor switched to Detailed', async () => {
    const { user } = await setup();
    await user.click(within(hubRoot()).getByRole('button', { name: 'Detailed' }));
    expect(within(hubRoot()).getByRole('button', { name: 'Detailed' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await waitFor(() => expect(within(hubRoot()).getByRole('button', { name: 'Simple' }).getAttribute('aria-pressed')).toBe('true'));
  });
});
