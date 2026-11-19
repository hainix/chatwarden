import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NoticeQueue } from '../src/NoticeQueue.js';
import { MyRecord } from '../src/MyRecord.js';
import { ReportDialog } from '../src/ReportDialog.js';
import { createT, en } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, BOB, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

// The player's own screens follow the evidence kind of a notice (0.2.2, audit P1, P2, P6, P10, P11): a warning for AFK does not say "something you wrote" and shows no
// "Your messages", the chat variant keeps both, and the report picker's group headings are in the player's language. Real routes, real kit.

const props = (w: PlayerWorld) => ({ client: w.client, now: w.now, ...FIXED });
const queue = async (w: PlayerWorld): Promise<HTMLElement> => {
  renderUi(<NoticeQueue {...props(w)} />);
  return screen.findByRole('dialog');
};

describe('NoticeQueue words', () => {
  it('the Moxgate repro: a warning for AFK says how you played, shows no line, and has no "Your messages" label', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { reason: 'afk', rule: 6, noLines: true });
    const d = await queue(w);
    expect(d).toHaveTextContent('A moderator gave you a warning for how you played. You can keep playing.');
    expect(d).not.toHaveTextContent(/something you wrote|Your messages|What led to this/);
    expect(within(d).queryByRole('list')).toBeNull();
  });
  it('a warning about a name says so', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { reason: 'name', rule: 7, noLines: true });
    expect(await queue(w)).toHaveTextContent('A moderator gave you a warning about your name. You can keep playing.');
  });
  it('a chat warning keeps "something you wrote" and "Your messages that led to this"', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { reason: 'harassment', rule: 2, lines: ['you play like a snerp'] });
    const d = await queue(w);
    expect(d).toHaveTextContent('A moderator gave you a warning for something you wrote. You can keep playing.');
    expect(within(d).getByRole('list', { name: 'Your messages that led to this' })).toBeInTheDocument();
  });
  it('a neutral warning (the reason other) reads neutral, and a line the moderator added is "What led to this"', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { reason: 'other', rule: 2, lines: ['you play like a snerp'] });
    const d = await queue(w);
    expect(d).toHaveTextContent('A moderator gave you a warning for breaking a community rule. You can keep playing.');
    expect(within(d).getByRole('list', { name: 'What led to this' })).toBeInTheDocument();
  });
  it('a restriction for AFK words the action only (it never named the conduct)', async () => {
    const w = await playerWorld();
    await w.sanction(ALICE, 'area', { reason: 'afk', rule: 6, noLines: true });
    expect(await queue(w)).toHaveTextContent('A moderator stopped you joining public rooms and matchmaking.');
  });
});

describe('My record words', () => {
  it('shows neutral words for play', async () => {
    const w = await playerWorld();
    await w.warn(ALICE, { reason: 'afk', rule: 6, noLines: true });
    renderUi(<MyRecord client={w.client} now={w.now} {...FIXED} />);
    await screen.findByText('Warning');
    await waitFor(() => expect(document.body.textContent).toMatch(/Rule/));
    expect(document.body.textContent).not.toMatch(/something you wrote|Your messages/);
  });
  it('a chat warning on the record keeps its lines label', async () => {
    const w = await playerWorld();
    await w.warn(BOB, { reason: 'harassment', rule: 2, reporter: ALICE, lines: ['you play like a snerp'] });
    w.caller.key = BOB.key;
    renderUi(<MyRecord client={w.client} now={w.now} {...FIXED} />);
    expect(await screen.findByRole('list', { name: 'Your messages that led to this' })).toBeInTheDocument();
  });
});

describe('the client keeps the kind (P11)', () => {
  const body = (evidence: unknown) => ({
    notices: [{ id: 'n1', kind: 'warning', rule: 6, ruleLabel: 'Rule 6', until: null, refCode: 'M-AAAAA', excerpt: [], createdAt: 1, mustAcknowledge: true, ...(evidence === undefined ? {} : { evidence }) }],
  });
  it.each(['chat', 'play', 'name'])('%s is kept', async (kind) => {
    const w = await playerWorld();
    w.intercept.fn = () => ({ status: 200, body: body(kind) });
    expect((await w.client.notices())[0]?.evidence).toBe(kind);
  });
  it.each([['moon'], [4], [null], [{}], [undefined]])('%j is dropped: no key at all', async (value) => {
    const w = await playerWorld();
    w.intercept.fn = () => ({ status: 200, body: body(value) });
    const n = (await w.client.notices())[0] as object;
    expect(Object.hasOwn(n, 'evidence')).toBe(false);
  });
});

describe('the report picker headings (P10)', () => {
  const reporting = (group: string) => ({
    flow: 'reason_first' as const,
    thanks: "Thanks for the report. We'll look into it.",
    resources: [],
    reasons: [
      { id: 'name', label: 'Inappropriate name', hint: 'An offensive or inappropriate player name', group, asksNote: false, thanks: null, showResources: false },
      { id: 'other', label: 'Something else', hint: 'Anything else you want us to look at', group: '', asksNote: true, thanks: null, showResources: false },
    ],
  });
  const labels = (): string[] => [...document.querySelectorAll('optgroup')].map((g) => g.label);
  const mount = (group: string, t: ReturnType<typeof createT>, locale: string) =>
    renderUi(<ReportDialog onSubmit={() => Promise.resolve({ ok: false, refused: 'off' } as never)} onClose={() => undefined} reporting={reporting(group)} t={t} locale={locale} timeZone="UTC" now={() => 0} />);
  it('the English default headings read as they are', () => {
    mount('Players', createT(en, 'en'), 'en');
    expect(labels()).toEqual(['Players']);
  });
  it('the default headings are translated in es and pt, and a heading the owner wrote is shown as sent', () => {
    const a = mount('Players', createT(es, 'es'), 'es');
    expect(labels()).toEqual(['Jugadores']);
    a.unmount();
    const b = mount('Gameplay', createT(pt, 'pt'), 'pt');
    expect(labels()).toEqual(['Jogo']);
    b.unmount();
    mount('Tournament', createT(es, 'es'), 'es');
    expect(labels()).toEqual(['Tournament']);
  });
  it('the catalogue has the three headings in every language', () => {
    for (const cat of [en, es, pt] as Array<Record<string, string>>) for (const k of ['chat', 'gameplay', 'players']) expect(cat[`player.report.group.${k}`], k).toBeTruthy();
  });
});
