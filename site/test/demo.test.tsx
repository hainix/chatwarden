// The interactive demo: a chat room (left), a moderator console (right), a four-step tour and a "show me the code" drawer.
// These tests run it against KitEngine, the real Chatwarden kit. They never touch the network.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import { KitEngine } from '../src/demo/kitEngine';

const RUDE = "uninstall the game, you're hopeless";

function stubMatchMedia(stacked: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: /max-width/.test(q) ? stacked : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function setup(props: { scripted?: boolean; stacked?: boolean } = {}) {
  stubMatchMedia(props.stacked ?? false);
  const engine = new KitEngine();
  const user = userEvent.setup();
  const view = render(<Demo engine={engine} scripted={props.scripted ?? false} />);
  await screen.findByText(RUDE);
  return { engine, user, ...view };
}

const live = () => screen.getByTestId('demo-live');
const tour = () => screen.queryByRole('region', { name: /guided tour/i });
const stepText = () => tour()?.textContent ?? '';
const composer = () => screen.getByLabelText(/chat message/i) as HTMLInputElement;
const reportBtn = (re: RegExp) => screen.getByRole('button', { name: re });

async function sayBad(user: ReturnType<typeof userEvent.setup>) {
  await user.type(composer(), 'you absolute zorbak');
  await user.keyboard('{Enter}');
}
async function fileReport(user: ReturnType<typeof userEvent.setup>, category = /harassment/i, note = '') {
  await user.click(reportBtn(/report bo's line: uninstall/i));
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('radio', { name: category }));
  if (note) await user.type(within(dialog).getByLabelText(/note/i), note);
  await user.click(within(dialog).getByRole('button', { name: /send report/i }));
}

beforeEach(() => stubMatchMedia(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the room', () => {
  it('shows the game and the moderator panes, three seats, and the seeded conversation', async () => {
    await setup();
    expect(screen.getByRole('heading', { name: 'The game' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your moderator' })).toBeTruthy();
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    expect(within(seats).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('You'),
      expect.stringContaining('Ada'),
      expect.stringContaining('Bo'),
    ]);
    const log = screen.getByRole('log', { name: /lobby chat/i });
    expect(within(log).getByText('gg, that last clutch was wild')).toBeTruthy();
    expect(within(log).getByText(RUDE)).toBeTruthy();
    // Bo's blocked line is private to Bo: the room never shows it
    expect(within(log).queryByText(/absolute zorbak/)).toBeNull();
  });
  it('says the other two players are scripted', async () => {
    await setup();
    expect(screen.getAllByText(/scripted/i).length).toBeGreaterThan(0);
  });
  it('limits the composer to 200 characters and shows a counter', async () => {
    const { user } = await setup();
    expect(composer().maxLength).toBe(200);
    await user.type(composer(), 'hello');
    expect(screen.getByText('5/200')).toBeTruthy();
  });
  it('sends a delivered line to the room, clears the box, and refuses to send nothing', async () => {
    const { user } = await setup();
    const send = screen.getByRole('button', { name: /^send$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(composer(), 'good luck all');
    await user.keyboard('{Enter}');
    const log = screen.getByRole('log', { name: /lobby chat/i });
    expect(await within(log).findByText('good luck all')).toBeTruthy();
    expect(composer().value).toBe('');
    await user.keyboard('{Enter}');
    expect(within(log).getAllByText('good luck all')).toHaveLength(1);
  });
  it('the suggestion chips send gg and fill the composer with a blocked word to try', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'gg' }));
    const log = screen.getByRole('log', { name: /lobby chat/i });
    expect(await within(log).findByText('gg')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /try a blocked word/i }));
    expect(composer().value).toMatch(/zorbak/i);
    expect(document.activeElement).toBe(composer());
  });
});

describe('a refused line', () => {
  it('is struck through with the REFUSED! stamp and a note that only you see it', async () => {
    const { user } = await setup();
    await sayBad(user);
    const log = screen.getByRole('log', { name: /lobby chat/i });
    const refused = await waitFor(() => {
      const el = log.querySelector('[data-verdict="refused"]');
      if (!el) throw new Error('not yet');
      return el as HTMLElement;
    });
    expect(within(refused).getByText(/refused!/i)).toBeTruthy();
    expect(within(refused).getByText('you absolute zorbak')).toBeTruthy();
    expect(refused.textContent).toMatch(/Community Rule 1/);
    expect(refused.textContent).toMatch(/only you/i);
  });
  it('is announced in the polite live region', async () => {
    const { user } = await setup();
    const region = live();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    await sayBad(user);
    await waitFor(() => expect(live().textContent).toMatch(/blocked.*community rule 1/i));
  });
  it('cannot be reported (you cannot report your own line)', async () => {
    const { user } = await setup();
    await sayBad(user);
    await screen.findByText(/refused!/i);
    expect(screen.queryByRole('button', { name: /report you/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /report your/i })).toBeNull();
  });
  it('catches the look-alike forms too, and delivers a near miss', async () => {
    const { user } = await setup();
    await user.type(composer(), 'z0rbak!!');
    await user.keyboard('{Enter}');
    await screen.findByText(/refused!/i);
    await user.type(composer(), 'zorbaking along');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('zorbaking along')).toBeTruthy();
  });
  it('a flood is slowed down with a plain message (no stamp)', async () => {
    const { user } = await setup();
    for (let i = 0; i < 8; i++) {
      await user.type(composer(), `spam ${i}`);
      await user.keyboard('{Enter}');
    }
    await waitFor(() => expect(live().textContent).toMatch(/too fast|slow down/i));
  });
});

describe('the report dialog', () => {
  it('has a report button on the other players’ lines and none on yours', async () => {
    const { user } = await setup();
    expect(reportBtn(/report bo's line: uninstall/i)).toBeTruthy();
    expect(reportBtn(/report ada's line: gg/i)).toBeTruthy();
    await user.type(composer(), 'mine');
    await user.keyboard('{Enter}');
    await screen.findByText('mine');
    expect(screen.queryByRole('button', { name: /report you/i })).toBeNull();
  });
  it('opens as a modal dialog with a category, an optional note, and focus inside', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = screen.getByRole('dialog', { name: /report bo/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([
      'harassment',
      'hate',
      'cheating',
      'spam',
      'disruption',
      'other',
    ]);
    expect(within(dialog).getByLabelText(/note/i)).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText(RUDE)).toBeTruthy(); // you see which line you are reporting
  });
  it('asks for a category before sending, and stays open', async () => {
    const { user, engine } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/pick a category/i);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((await engine.reports.list()).items).toHaveLength(0);
  });
  it('asks for a note when the category is "Something else"', async () => {
    const { user, engine } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await user.click(screen.getByRole('radio', { name: /something else/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/tell the moderator|add a note/i);
    expect((await engine.reports.list()).items).toHaveLength(0);
    await user.type(screen.getByLabelText(/note/i), 'they keep doing it');
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await engine.reports.list()).items).toHaveLength(1);
  });
  it('limits the note to 140 characters', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    expect((screen.getByLabelText(/note/i) as HTMLTextAreaElement).maxLength).toBe(140);
  });
  it('cancel and Escape close it without filing, and focus goes back to the report button', async () => {
    const { user, engine } = await setup();
    const opener = reportBtn(/report bo's line: uninstall/i);
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect((await engine.reports.list()).items).toHaveLength(0);
  });
  it('keeps Tab inside the dialog', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: uninstall/i));
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 14; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 14; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
  it('files the report, closes, announces it, and puts one report in the moderator queue', async () => {
    const { user } = await setup();
    await fileReport(user, /harassment/i, 'kept going');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(live().textContent).toMatch(/report filed against bo/i));
    expect(screen.getByRole('button', { name: /reports, 1 open/i })).toBeTruthy();
  });
  it('says so when the same line is reported twice', async () => {
    const { user } = await setup();
    await fileReport(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(reportBtn(/report bo's line: uninstall/i));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already reported/i));
  });
});

describe('the moderator console', () => {
  it('starts with an empty queue and an invitation to report', async () => {
    await setup();
    expect(screen.getByRole('button', { name: /reports, 0 open/i })).toBeTruthy();
    expect(screen.getByText(/no open reports/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^warn$/i })).toBeNull();
  });
  it('shows the report: category, reporter, evidence with the reported line marked, and the ladder suggestion', async () => {
    const { user } = await setup();
    await fileReport(user, /harassment/i, 'kept going');
    const detail = await screen.findByRole('region', { name: /report from you about bo/i });
    expect(within(detail).getByText(/harassment/i)).toBeTruthy();
    expect(within(detail).getByText(/kept going/)).toBeTruthy();
    const evidence = within(detail).getByRole('list', { name: /evidence/i });
    const items = within(evidence).getAllByRole('listitem');
    expect(items.length).toBeLessThanOrEqual(6);
    const reported = items.filter((li) => li.getAttribute('data-reported') === 'true');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.textContent).toContain(RUDE);
    const blocked = items.filter((li) => li.getAttribute('data-blocked') === 'true');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.textContent).toMatch(/refused/i);
    expect(within(detail).getByText(/suggested: warning/i)).toBeTruthy();
    expect(within(detail).getByText(/standard profile: first aggressive message with a clean record gets a warning/i)).toBeTruthy(); // the kit's own sentence
  });
  it('offers Warn, Timeout 10m, Note and No action, and marks the suggested one', async () => {
    const { user } = await setup();
    await fileReport(user);
    for (const name of ['Warn', 'Timeout 10m', 'Note', 'No action']) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Warn' }).getAttribute('data-suggested')).toBe('true');
    expect(screen.getByRole('button', { name: 'Timeout 10m' }).getAttribute('data-suggested')).toBeNull();
  });
  it('suggests no action for plain trash talk', async () => {
    const { user } = await setup();
    await user.click(reportBtn(/report bo's line: ez/i));
    await user.click(screen.getByRole('radio', { name: /harassment/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    expect(await screen.findByText(/suggested: no action/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No action' }).getAttribute('data-suggested')).toBe('true');
  });
  it('lets the moderator pick the line to show the player, defaulting to the reported line', async () => {
    const { user } = await setup();
    await fileReport(user);
    const group = await screen.findByRole('group', { name: /line to show the player/i });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.length).toBe(4); // none + Bo's three lines (one of them blocked, shown to staff only)
    expect(radios.find((r) => r.checked)?.closest('label')?.textContent).toContain(RUDE);
    expect(within(group).getByLabelText(/don.t quote a line/i)).toBeTruthy();
  });
  it('switches between reports when there are several', async () => {
    const { user } = await setup();
    await fileReport(user);
    await user.click(reportBtn(/report ada's line: ok that was close/i));
    await user.click(screen.getByRole('radio', { name: /spam/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /reports, 2 open/i })).toBeTruthy());
    const list = screen.getByRole('list', { name: /open reports/i });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
  });
});

describe('decide, notice, acknowledge', () => {
  async function toDecision(user: ReturnType<typeof userEvent.setup>) {
    await fileReport(user);
    await screen.findByRole('button', { name: 'Warn' });
  }

  it('Warn closes the report, announces it, and shows Bo a notice in a "player’s screen" frame', async () => {
    const { user } = await setup();
    await toDecision(user);
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    await waitFor(() => expect(live().textContent).toMatch(/decision made.*warning.*bo/i));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(within(frame).getByText(/what bo sees/i)).toBeTruthy();
    expect(within(frame).getByText(/warning/i)).toBeTruthy();
    expect(within(frame).getByText(/community rule 2/i)).toBeTruthy();
    expect(within(frame).getByText(RUDE)).toBeTruthy();
    expect(within(frame).getByRole('button', { name: /acknowledge/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reports, 0 open/i })).toBeTruthy();
    expect(screen.getByText(/no open reports/i)).toBeTruthy();
    await waitFor(() => expect(live().textContent).toMatch(/notice|bo/i));
  });
  it('announces that the notice is shown', async () => {
    const { user } = await setup();
    await toDecision(user);
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(live().textContent ?? ''));
    mo.observe(live(), { childList: true, characterData: true, subtree: true });
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    await screen.findByRole('region', { name: /bo.s screen/i });
    await waitFor(() => expect(seen.join('|')).toMatch(/notice shown on bo/i));
    mo.disconnect();
  });
  it('quotes the chosen line with blocked words starred out; the word never reaches the player frame', async () => {
    const { user } = await setup();
    await toDecision(user);
    const group = screen.getByRole('group', { name: /line to show the player/i });
    await user.click(within(group).getByLabelText(/absolute zorbak/i));
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(within(frame).getByText('you absolute ******')).toBeTruthy();
    expect(frame.textContent).not.toMatch(/zorbak/i);
  });
  it('with no line chosen the notice quotes nothing', async () => {
    const { user } = await setup();
    await toDecision(user);
    await user.click(screen.getByLabelText(/don.t quote a line/i));
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(within(frame).queryByText(RUDE)).toBeNull();
  });
  it('the notice never shows the moderator’s private note or the reporter', async () => {
    const { user } = await setup();
    await toDecision(user);
    const note = screen.getByLabelText(/private note/i) as HTMLInputElement;
    await user.clear(note);
    await user.type(note, 'secret staff words');
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(frame.textContent).not.toMatch(/secret staff words/);
    expect(frame.textContent).not.toMatch(/\bYou\b/);
  });
  it('Acknowledge clears the notice, announces it, and moves it to the record', async () => {
    const { user } = await setup();
    await toDecision(user);
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    await user.click(await screen.findByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /bo.s screen/i })).toBeNull());
    await waitFor(() => expect(live().textContent).toMatch(/bo acknowledged/i));
    await user.click(screen.getByRole('button', { name: /my record/i }));
    const record = await screen.findByRole('list', { name: /bo.s record/i });
    expect(within(record).getAllByRole('listitem')).toHaveLength(1);
    expect(record.textContent).toMatch(/warning/i);
    expect(record.textContent).toMatch(/community rule 2/i);
  });
  it('Timeout 10m shows a timeout notice with when it ends, and Bo sits out', async () => {
    const { user } = await setup();
    await toDecision(user);
    await user.click(screen.getByRole('button', { name: 'Timeout 10m' }));
    const frame = await screen.findByRole('region', { name: /bo.s screen/i });
    expect(frame.textContent).toMatch(/chat timeout|timed out/i);
    expect(frame.textContent).toMatch(/10 minutes/i);
    const seats = screen.getByRole('list', { name: /players in the lobby/i });
    await waitFor(() => expect(within(seats).getByText(/bo/i).closest('li')?.textContent).toMatch(/timed out/i));
  });
  it('Note tells the player nothing; No action closes the report quietly', async () => {
    const { user } = await setup();
    await toDecision(user);
    await user.click(screen.getByRole('button', { name: 'Note' }));
    await waitFor(() => expect(live().textContent).toMatch(/note/i));
    expect(screen.queryByRole('region', { name: /bo.s screen/i })).toBeNull();
    expect(screen.getByText(/no open reports/i)).toBeTruthy();
    // a second report, dismissed
    await user.click(reportBtn(/report ada's line: gg/i));
    await user.click(screen.getByRole('radio', { name: /spam/i }));
    await user.click(screen.getByRole('button', { name: /send report/i }));
    await user.click(await screen.findByRole('button', { name: 'No action' }));
    await waitFor(() => expect(live().textContent).toMatch(/no action/i));
    expect(screen.queryByRole('region', { name: /ada.s screen/i })).toBeNull();
  });
  it('a second decision on the same report is impossible (the buttons go with the report)', async () => {
    const { user } = await setup();
    await toDecision(user);
    await user.click(screen.getByRole('button', { name: 'Warn' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Warn' })).toBeNull());
  });
});

describe('the guided tour', () => {
  it('starts at step 1 of 4 with progress pips, Skip and Next, anchored to the composer', async () => {
    await setup();
    const t = tour()!;
    expect(t).toBeTruthy();
    expect(t.textContent).toMatch(/step 1 of 4/i);
    expect(t.textContent).toMatch(/say something bad/i);
    expect(t.querySelectorAll('[data-pip]')).toHaveLength(4);
    expect(t.querySelectorAll('[data-pip="done"]')).toHaveLength(0);
    expect(within(t).getByRole('button', { name: /skip tour/i })).toBeTruthy();
    expect(within(t).getByRole('button', { name: /^next$/i })).toBeTruthy();
    expect(composer().closest('form')?.hasAttribute('data-tour-target')).toBe(true);
  });
  it('Next moves on without doing the action, and the demo is never blocked', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    expect(stepText()).toMatch(/step 2 of 4/i);
    expect(stepText()).toMatch(/report a line/i);
    // still usable
    await user.type(composer(), 'hello');
    expect(composer().value).toBe('hello');
  });
  it('advances by itself: refusal, then report, then a decision, then the acknowledge', async () => {
    const { user } = await setup();
    await sayBad(user);
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    await fileReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
    await user.click(await screen.findByRole('button', { name: 'Warn' }));
    await waitFor(() => expect(stepText()).toMatch(/step 4 of 4/i));
    await user.click(await screen.findByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(stepText()).toMatch(/whole loop|you played both sides/i));
    expect(tour()!.querySelectorAll('[data-pip="done"]')).toHaveLength(4);
  });
  it('points step 2 at the report button of one of Bo’s rude lines', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    const target = document.querySelector('[data-tour-target]') as HTMLElement;
    expect(target.getAttribute('aria-label')).toMatch(/report bo's line: uninstall/i);
  });
  it('doing a later step first jumps ahead (report before saying anything bad)', async () => {
    const { user } = await setup();
    await fileReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
  });
  it('a decision that tells the player nothing sends you back to report another line, with a hint', async () => {
    const { user } = await setup();
    await sayBad(user);
    await fileReport(user);
    await user.click(await screen.findByRole('button', { name: 'Note' }));
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    expect(stepText()).toMatch(/tells the player nothing|no notice/i);
  });
  it('Skip hides the tour; the demo keeps working, and the tour can be restarted', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /skip tour/i }));
    expect(tour()).toBeNull();
    expect(document.querySelector('[data-tour-target]')).toBeNull();
    await sayBad(user);
    await screen.findByText(/refused!/i);
    await user.click(screen.getByRole('button', { name: /restart tour/i }));
    expect(stepText()).toMatch(/step 1 of 4/i);
  });
  it('Escape in the tour card skips it', async () => {
    const { user } = await setup();
    within(tour()!).getByRole('button', { name: /^next$/i }).focus();
    await user.keyboard('{Escape}');
    expect(tour()).toBeNull();
  });
  it('announces each step change politely', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    await waitFor(() => expect(live().textContent).toMatch(/step 2 of 4.*report a line/i));
  });
});

describe('Show me the code', () => {
  it('toggles the real kit lines for the current step, and says where they come from', async () => {
    const { user } = await setup();
    const toggle = within(tour()!).getByRole('button', { name: /show me the code/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: /kit code/i })).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const drawer = screen.getByRole('region', { name: /kit code for step 1/i });
    expect(drawer.textContent).toContain("cw.chat.accept('lobby', 'seat-1', 'hello everyone');");
    expect(drawer.textContent).toMatch(/packages\/core\/README\.md/);
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    expect(screen.getByRole('region', { name: /kit code for step 2/i }).textContent).toContain('cw.reports.submit(');
    await user.click(toggle);
    expect(screen.queryByRole('region', { name: /kit code/i })).toBeNull();
  });
  it('shows the cw.decide and player-view lines on steps 3 and 4', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /show me the code/i }));
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    expect(screen.getByRole('region', { name: /kit code for step 3/i }).textContent).toContain('await cw.decide(');
    await user.click(within(tour()!).getByRole('button', { name: /^next$/i }));
    expect(screen.getByRole('region', { name: /kit code for step 4/i }).textContent).toContain('/api/notices');
  });
  it('is still available from the toolbar after the tour is skipped', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /skip tour/i }));
    await user.click(screen.getByRole('button', { name: /show me the code/i }));
    expect(screen.getByRole('region', { name: /kit code/i })).toBeTruthy();
  });
});

describe('reset', () => {
  it('clears the room, the queue, the notices and the tour, and reseeds the conversation', async () => {
    const { user, engine } = await setup();
    await sayBad(user);
    await fileReport(user);
    await user.click(await screen.findByRole('button', { name: 'Warn' }));
    await screen.findByRole('region', { name: /bo.s screen/i });
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /bo.s screen/i })).toBeNull());
    await waitFor(() => expect(screen.queryByText(/refused!/i)).toBeNull());
    expect(screen.getByRole('button', { name: /reports, 0 open/i })).toBeTruthy();
    expect(screen.getByText(/no open reports/i)).toBeTruthy();
    expect(stepText()).toMatch(/step 1 of 4/i);
    expect(composer().value).toBe('');
    expect(await screen.findByText(RUDE)).toBeTruthy();
    expect((await engine.reports.list()).items).toHaveLength(0);
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect(await engine.notices.record('bo')).toEqual([]);
    await waitFor(() => expect(live().textContent).toMatch(/demo reset/i));
  });
  it('brings back a skipped tour and closes the code drawer and any open dialog', async () => {
    const { user } = await setup();
    await user.click(within(tour()!).getByRole('button', { name: /show me the code/i }));
    await user.click(within(tour()!).getByRole('button', { name: /skip tour/i }));
    await user.click(reportBtn(/report bo's line: uninstall/i));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    expect(tour()).toBeTruthy();
    expect(screen.queryByRole('region', { name: /kit code/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('does not leave stale reports in the queue when pressed repeatedly', async () => {
    const { user } = await setup();
    await fileReport(user);
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await screen.findByText(RUDE);
    expect(screen.getAllByText(RUDE)).toHaveLength(1);
    expect(screen.getByText(/no open reports/i)).toBeTruthy();
  });
});

describe('the whole tour by keyboard alone', () => {
  it('can be finished without a pointer', async () => {
    const { user } = await setup();
    // Step 1: type in the composer, Enter.
    composer().focus();
    await user.keyboard('you absolute zorbak{Enter}');
    await waitFor(() => expect(stepText()).toMatch(/step 2 of 4/i));
    // Step 2: tab to Bo's report button (it shows on focus), Enter opens the dialog.
    reportBtn(/report bo's line: uninstall/i).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLInputElement).type).toBe('radio');
    await user.keyboard(' '); // pick the focused category
    await user.tab(); // out of the radio group, into the note
    await user.tab(); // Cancel? no: Send report comes after Cancel, so find it by walking
    for (let i = 0; i < 4 && !/send report/i.test(document.activeElement?.textContent ?? ''); i++) await user.tab();
    expect(document.activeElement?.textContent).toMatch(/send report/i);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
    expect(document.activeElement?.tagName).not.toBe('BODY'); // focus went somewhere sensible, not lost
    // Step 3: decide with the keyboard.
    const warn = await screen.findByRole('button', { name: 'Warn' });
    warn.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(stepText()).toMatch(/step 4 of 4/i));
    // Step 4: acknowledge.
    const ack = await screen.findByRole('button', { name: /acknowledge/i });
    ack.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(stepText()).toMatch(/whole loop/i));
    expect(live().textContent).toMatch(/bo acknowledged/i);
  });
  it('every button has a name a screen reader can read', async () => {
    await setup();
    const root = screen.getByRole('group', { name: /chatwarden interactive demo/i });
    for (const b of within(root).getAllByRole('button')) expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length).toBeGreaterThan(0);
  });
});

describe('the scripted players', () => {
  it('chat on a gentle timer, about every 4 to 6 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    render(<Demo engine={engine} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    const before = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(count()).toBe(before); // not before 4 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2700);
    });
    expect(count()).toBe(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(count()).toBeGreaterThanOrEqual(before + 3);
  });
  it('pause stops them, resume starts them again, and the button says which', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    render(<Demo engine={new KitEngine()} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    fireEvent.click(screen.getByRole('button', { name: /pause chat/i }));
    expect(screen.getByRole('button', { name: /resume chat/i })).toBeTruthy();
    const frozen = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(count()).toBe(frozen);
    fireEvent.click(screen.getByRole('button', { name: /resume chat/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(count()).toBeGreaterThan(frozen);
  });
  it('wait while you are typing, and while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    render(<Demo engine={new KitEngine()} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => screen.getByRole('log', { name: /lobby chat/i }).querySelectorAll('.msg').length;
    const before = count();
    // typing: a focused, non-empty composer
    const box = composer();
    box.focus();
    fireEvent.change(box, { target: { value: 'half a thou' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(count()).toBe(before);
    fireEvent.change(box, { target: { value: '' } });
    box.blur();
    // hidden tab
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(count()).toBe(before);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(count()).toBeGreaterThan(before);
  });
  it('stop for good when the demo unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    stubMatchMedia(false);
    const engine = new KitEngine();
    const spy = vi.spyOn(engine.chat, 'accept');
    const { unmount } = render(<Demo engine={engine} scripted />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    unmount();
    const calls = spy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(spy.mock.calls.length).toBe(calls);
  });
});

describe('layout', () => {
  it('is side by side on a wide screen: no stacked class, no pane tabs', async () => {
    const { container } = await setup({ stacked: false });
    expect(container.querySelector('.demo')?.classList.contains('is-stacked')).toBe(false);
    expect(screen.queryByRole('group', { name: /switch pane/i })).toBeNull();
  });
  it('stacks below the breakpoint, game first, with a sticky mini-tab to switch to the moderator', async () => {
    const { container, user } = await setup({ stacked: true });
    expect(container.querySelector('.demo')?.classList.contains('is-stacked')).toBe(true);
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    const [game, mod] = within(tabs).getAllByRole('button');
    expect(game?.textContent).toMatch(/game/i);
    expect(mod?.textContent).toMatch(/moderator/i);
    expect(game?.getAttribute('aria-pressed')).toBe('true');
    expect(mod?.getAttribute('aria-pressed')).toBe('false');
    expect(tabs.querySelector('[role="tab"]')).toBeNull(); // a plain toggle pair, not a half-built tab widget
    const panes = container.querySelectorAll('.demo-panes > section');
    expect([...panes].map((p) => p.getAttribute('data-pane'))).toEqual(['game', 'mod']);
    expect((panes[1] as HTMLElement).hidden).toBe(true);
    await user.click(mod!);
    expect(mod?.getAttribute('aria-pressed')).toBe('true');
    expect((panes[0] as HTMLElement).hidden).toBe(true);
    expect((panes[1] as HTMLElement).hidden).toBe(false);
  });
  it('the moderator tab carries the open-report count', async () => {
    const { user } = await setup({ stacked: true });
    await fileReport(user);
    const tabs = screen.getByRole('group', { name: /switch pane/i });
    await waitFor(() => expect(within(tabs).getAllByRole('button')[1]?.textContent).toMatch(/1/));
  });
  it('moves to the moderator pane by itself when the tour reaches the decision (and says so)', async () => {
    const { user, container } = await setup({ stacked: true });
    await sayBad(user);
    await fileReport(user);
    await waitFor(() => expect(stepText()).toMatch(/step 3 of 4/i));
    await waitFor(() => expect((container.querySelectorAll('.demo-panes > section')[1] as HTMLElement).hidden).toBe(false));
    expect(live().textContent).toMatch(/moderator/i);
  });
});
