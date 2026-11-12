// Shared steps for the demo tests: render the demo over the real kit, file a one-tap report through the player dialog, open the
// case in the real hub, and send a held decision at once.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import Demo from '../../src/demo/Demo';
import { KitEngine } from '../../src/demo/kitEngine';

export const RUDE = "uninstall the game, you're hopeless";
export type User = ReturnType<typeof userEvent.setup>;

/** `compact` is the phone query (under 600px, the tour is a bar); `stacked` is the one-pane-at-a-time query (under 1152px). */
export function stubMatchMedia(stacked: boolean, reduced = false, compact = false): void {
  window.matchMedia = ((q: string) => ({
    matches: /reduced-motion/.test(q) ? reduced : /599px/.test(q) ? compact : /max-width/.test(q) ? stacked : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

export interface SetupOptions {
  stacked?: boolean;
  reduced?: boolean;
  /** A phone: the tour is a bar at the bottom. Implies stacked. */
  compact?: boolean;
  scripted?: boolean;
  engine?: KitEngine;
}

/** The demo over the real kit, once the seeded chat and the hub are on screen. */
export async function setup(opts: SetupOptions = {}) {
  stubMatchMedia(opts.stacked ?? opts.compact ?? false, opts.reduced ?? false, opts.compact ?? false);
  try {
    localStorage.clear(); // the hub keeps the moderator's Simple/Detailed choice there
  } catch {
    // storage blocked: the hub then starts in Simple, which is what the tests want
  }
  const engine = opts.engine ?? new KitEngine();
  const user = userEvent.setup();
  const view = render(<Demo engine={engine} scripted={opts.scripted ?? false} />);
  await screen.findByText(RUDE);
  await screen.findByRole('navigation', { name: /moderator hub sections/i, hidden: true }); // hidden: on a phone the pane may not be showing
  return { engine, user, ...view };
}

export const live = () => screen.getByTestId('demo-live');
export const tour = () => screen.queryByRole('region', { name: /guided tour/i });
export const stepText = () => tour()?.textContent ?? '';
export const composer = () => screen.getByLabelText(/chat message/i) as HTMLInputElement;
export const reportBtn = (re: RegExp) => screen.getByRole('button', { name: re });
export const modPane = () => document.querySelector('[data-pane="mod"]') as HTMLElement;
export const gamePane = () => document.querySelector('[data-pane="game"]') as HTMLElement;
export const hubRoot = () => modPane().querySelector('.cw-hub') as HTMLElement;

/** Reports a line with one tap, through the player-react dialog, and waits for "Report sent". */
export async function oneTapReport(user: User, line: RegExp = /report bo's message: "uninstall/i): Promise<HTMLElement> {
  await user.click(reportBtn(line));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Report' }));
  await within(dialog).findByRole('heading', { name: 'Report sent' });
  return dialog;
}

/**
 * Reports a line in the one step with a reason: the "Why?" select, the first real reason in it (or `reason`, an option's value),
 * then Report. Waits for "Report sent". Returns the dialog and the id chosen.
 */
export async function reasonedReport(user: User, line: RegExp = /report bo's message: "uninstall/i, reason?: string): Promise<{ dialog: HTMLElement; reason: string }> {
  await user.click(reportBtn(line));
  const dialog = await screen.findByRole('dialog');
  const select = within(dialog).getByRole('combobox', { name: /^why\?/i }) as HTMLSelectElement;
  const options = [...select.querySelectorAll('option')].filter((o) => o.value !== '');
  const id = reason ?? (options[0] as HTMLOptionElement).value;
  await user.selectOptions(select, id);
  await user.click(within(dialog).getByRole('button', { name: 'Report' }));
  await within(dialog).findByRole('heading', { name: 'Report sent' });
  return { dialog, reason: id };
}

/** Closes the report dialog (the thank-you stays up until the player closes it). */
export async function closeReport(user: User): Promise<void> {
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/**
 * The link to a case in the hub's queue. A case that arrives after the list was shown waits behind the hub's "1 new case" pill
 * (the list never moves under the cursor), so this presses the pill first when it is there.
 */
export async function caseLink(user: User, name: RegExp = /^Bo/): Promise<HTMLElement> {
  const hub = within(modPane());
  await waitFor(() => {
    if (hub.queryByRole('link', { name }) === null && hub.queryByRole('button', { name: /new cases?$/i }) === null) throw new Error('the case has not reached the hub yet');
  });
  const pill = hub.queryByRole('button', { name: /new cases?$/i });
  if (pill !== null) await user.click(pill);
  return hub.findByRole('link', { name });
}

/** Opens the case against Bo from the hub's queue. */
export async function openCase(user: User): Promise<HTMLElement> {
  await user.click(await caseLink(user));
  return within(modPane()).findByRole('region', { name: /case against bo/i });
}

/** A one-tap report has no reason, so the Simple card asks which rule it breaks: pick Rule 2, and wait for the ladder's suggestion. */
export async function pickRule(user: User, rule = '2'): Promise<void> {
  await user.selectOptions(await within(modPane()).findByRole('combobox', { name: /which rule does this break/i }), rule);
  await within(modPane()).findByText(/the ladder suggests/i);
  await cardSettles();
}

/**
 * A card accepts a click or an act key only a moment (300 ms, on the real clock) after it appeared, so the second tap of a double
 * tap cannot land on the next case. A person reading the card is slower than that; the test waits it out.
 */
export const cardSettles = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 350));

/** The Undo hold passes at once (the hub sends a held decision when the page hides). */
export async function sendHeldDecision(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
}

/** The notice button in the game pane: "See Bo's screen", or "See your screen" for the visitor. */
export const noticeBtn = (name = 'Bo') => screen.findByRole('button', { name: name.toLowerCase() === 'you' ? /see your screen/i : new RegExp(`see ${name}'s screen`, 'i') });

// Silence the "not wrapped in act" noise of the hub's own timers only where a test asks to.
export { act, waitFor, within, screen };
