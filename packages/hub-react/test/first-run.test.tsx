import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PRESETS, recommendFor } from '@chatwarden/core';
import { useHub } from '../src/context.js';
import { LazyFirstRun } from '../src/lazyParts.js';
import { HubProvider } from '../src/provider.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The first-run panel (0.2.2): "What kind of game is this?" at the top of the Overview and of the Simple home, for the owner of a kit nobody has configured yet. Four plain choices, none
// selected, a preview of what a choice would set up, "Use these principles" (off until a choice is made) and "Keep the current ones". It talks to the real /setup routes.

afterEach(() => cleanup());

const WAIT = { timeout: 4000 };
const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
const setupReqs = (w: HubWorld, method?: string) => w.sent.filter((r) => r.path.startsWith('/setup') && (method === undefined || r.method === method));
const TITLE = 'What kind of game is this?';
const CHOICES = ['Competitive or PvP games, with trash talk expected', 'Social or casual games, with mixed ages', 'Games for kids or teens', 'Creator and streaming communities'];
const USE = 'Use these principles';
const KEEP = 'Keep the current ones';
const radios = (): HTMLElement[] => screen.getAllByRole('radio');
const panel = (): HTMLElement => screen.getByRole('region', { name: TITLE });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(w: HubWorld, mode: 'detailed' | 'simple' = 'detailed', extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { mode, ...extra });
  await screen.findByRole('heading', { level: 2, name: mode === 'simple' ? 'Cases' : 'Overview' });
  return r;
}

describe('who sees it, and when', () => {
  it.each(['detailed', 'simple'] as const)('an owner on a fresh kit sees the panel on the %s home, with four choices and no choice selected; "Use these principles" is off', async (mode) => {
    const w = await owner();
    await open(w, mode);
    expect(await screen.findByRole('heading', { level: 2, name: TITLE }, WAIT)).toBeInTheDocument();
    expect(radios().map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(CHOICES);
    for (const r of radios()) expect(r).not.toBeChecked();
    expect(within(panel()).getByRole('button', { name: USE })).toHaveAttribute('aria-disabled', 'true');
    expect(within(panel()).getByRole('button', { name: KEEP })).toHaveAttribute('aria-disabled', 'false');
    expect(within(panel()).getByText('You can change all of this afterwards in Settings.')).toBeInTheDocument();
    expect(setupReqs(w, 'GET')).toHaveLength(1);
  });

  it('the panel sits above the numbers: right after the screen title', async () => {
    const w = await owner();
    await open(w);
    await screen.findByRole('heading', { level: 2, name: TITLE }, WAIT);
    const title = screen.getByRole('heading', { level: 2, name: 'Overview' });
    expect(title.compareDocumentPosition(panel()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const stats = document.querySelector('.cw-stats');
    if (stats !== null) expect(panel().compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ['a senior', { role: 'senior' as const }],
    ['a moderator', { role: 'moderator' as const }],
    ['a scoped moderator', { role: 'moderator' as const, scope: ['arena'] }],
    ['a senior whose policy.write was lowered to senior', { role: 'senior' as const, permissions: { 'policy.write': 'senior' as const } }],
  ])('%s: no request to /setup is sent and nothing is rendered', async (_who, options) => {
    const w = await hubWorld({ ...options, actor: 'someone@example.test' });
    await open(w);
    await wait(400);
    expect(setupReqs(w)).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('a kit where a layer was already saved renders nothing (show false) and sends no apply', async () => {
    const w = await owner();
    w.cw.policy.save({ pace: { slowModeMs: 2000 } }, { version: 0, actor: 'x', reason: 'seed' });
    await open(w);
    await waitFor(() => expect(setupReqs(w, 'GET')).toHaveLength(1), WAIT);
    await wait(200);
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();
    expect(setupReqs(w, 'POST')).toHaveLength(0);
  });

  it('while GET /setup is in flight nothing renders and the screen does not move; it then appears', async () => {
    const w = await owner();
    let release: (v: undefined) => void = () => undefined;
    w.intercept.fn = (req) => (req.path === '/setup' ? new Promise<undefined>((res) => (release = res)) : undefined);
    await open(w);
    await waitFor(() => expect(setupReqs(w, 'GET')).toHaveLength(1), WAIT);
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();
    expect(document.querySelector('.cw-setup')).toBeNull();
    release(undefined);
    expect(await screen.findByRole('heading', { level: 2, name: TITLE }, WAIT)).toBeInTheDocument();
  });

  it('a failed GET /setup renders nothing, with no error shown and no layout change', async () => {
    const w = await owner();
    w.intercept.fn = (req) => (req.path === '/setup' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await open(w);
    await waitFor(() => expect(setupReqs(w, 'GET')).toHaveLength(1), WAIT);
    await wait(200);
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('choosing', () => {
  it('choosing Kids shows the strict preset principles and a one-line ladder summary; nothing is sent', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Games for kids or teens' }, WAIT));
    expect(screen.getByRole('radio', { name: 'Games for kids or teens' })).toBeChecked();
    const region = panel();
    for (const tier of PRESETS.strict.guidelines) expect(within(region).getByText(tier.title)).toBeInTheDocument();
    const summary = within(region).getByText(/^First offences:/);
    expect(summary.textContent).toContain('Rude, ');
    expect(summary.textContent).toContain(PRESETS.strict.ladder.at(-1)!.high.label);
    expect(within(region).queryByText(/Protect the creator/)).toBeNull();
    expect(within(region).getByRole('button', { name: USE })).toHaveAttribute('aria-disabled', 'false');
    expect(setupReqs(w, 'POST')).toHaveLength(0);
  });

  it('choosing Creator also shows the note "Protect the creator and their guests from targeted abuse"', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Creator and streaming communities' }, WAIT));
    expect(within(panel()).getByText(/Protect the creator and their guests from targeted abuse/)).toBeInTheDocument();
    for (const tier of PRESETS.standard.guidelines) expect(within(panel()).getByText(tier.title)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Games for kids or teens' }));
    expect(within(panel()).queryByText(/Protect the creator/)).toBeNull();
  });

  it('the preview is a polite live region that holds what the choice sets up', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Competitive or PvP games, with trash talk expected' }, WAIT));
    const live = panel().querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live!.textContent).toContain(PRESETS.relaxed.guidelines[0]!.title);
  });

  it('arrow keys move the choice, as in any radio group, and the group is named', async () => {
    const w = await owner();
    const { user } = await open(w);
    await screen.findByRole('radio', { name: CHOICES[0]! }, WAIT);
    expect(within(panel()).getByRole('group', { name: 'Kind of game' })).toBeInTheDocument();
    radios()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(radios()[1]).toBeChecked();
    await user.keyboard('{ArrowDown}');
    expect(radios()[2]).toBeChecked();
    await user.keyboard('{ArrowUp}');
    expect(radios()[1]).toBeChecked();
  });
});

describe('using the recommendation', () => {
  it('Use these principles sends POST /setup/apply { game, version } once (a double click sends once), then the panel is gone, a toast shows and focus is on the screen title', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Games for kids or teens' }, WAIT));
    await user.dblClick(within(panel()).getByRole('button', { name: USE }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    expect(setupReqs(w, 'POST')).toHaveLength(1);
    expect(setupReqs(w, 'POST')[0]).toMatchObject({ method: 'POST', path: '/setup/apply', body: { game: 'kids', version: 0 } });
    expect(Object.keys(setupReqs(w, 'POST')[0]!.body as object).sort()).toEqual(['game', 'version']);
    expect(await within(screen.getByRole('region', { name: 'Notifications' })).findByText('The principles are set up. You can change them in Settings.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toHaveFocus(), WAIT);
    // the server now holds the recommendation, and the panel is not read again
    expect(w.cw.policy.get().effective.guidelines).toEqual(PRESETS.strict.guidelines);
    expect(setupReqs(w, 'GET')).toHaveLength(1);
    expect(w.cw.policy.setup().show).toBe(false);
  });

  it('on the Simple home focus lands on its title', async () => {
    const w = await owner();
    const { user } = await open(w, 'simple');
    await user.click(await screen.findByRole('radio', { name: 'Social or casual games, with mixed ages' }, WAIT));
    await user.click(within(panel()).getByRole('button', { name: USE }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Cases' })).toHaveFocus(), WAIT);
  });

  it('the creator choice saves the team note too', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Creator and streaming communities' }, WAIT));
    await user.click(within(panel()).getByRole('button', { name: USE }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    expect(w.cw.policy.get().effective.teamNotes).toEqual(recommendFor('creator').layer.teamNotes);
  });

  it('a 409 shows the conflict text and a Reload that re-reads GET /setup; the choice survives the refused apply', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Games for kids or teens' }, WAIT));
    // someone saves settings first
    w.cw.policy.save({ pace: { slowModeMs: 2000 } }, { version: 0, actor: 'x', reason: 'seed' });
    await user.click(within(panel()).getByRole('button', { name: USE }));
    const alert = await within(panel()).findByRole('alert', undefined, WAIT);
    expect(alert).toHaveTextContent('Someone saved settings first. Reload to see them.');
    expect(screen.getByRole('radio', { name: 'Games for kids or teens' })).toBeChecked();
    expect(setupReqs(w, 'POST')).toHaveLength(1);
    // nothing was written
    expect(w.cw.policy.get().effective.guidelines).toEqual(PRESETS.standard.guidelines);
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(setupReqs(w, 'GET')).toHaveLength(2), WAIT);
    // the kit now has settings, so the panel is not offered again
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
  });

  it('any other error shows the hub text for it and keeps the choice and the panel', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(await screen.findByRole('radio', { name: 'Games for kids or teens' }, WAIT));
    w.intercept.fn = (req) => (req.path === '/setup/apply' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: USE }));
    expect(await within(panel()).findByRole('alert', undefined, WAIT)).toHaveTextContent('The server had a problem. Try again in a moment.');
    expect(screen.getByRole('radio', { name: 'Games for kids or teens' })).toBeChecked();
    expect(within(panel()).getByRole('button', { name: USE })).toHaveAttribute('aria-disabled', 'false');
    // a retry works
    w.intercept.fn = null;
    await user.click(within(panel()).getByRole('button', { name: USE }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
  });

  it('Use these principles does nothing while no choice is made', async () => {
    const w = await owner();
    const { user } = await open(w);
    await screen.findByRole('heading', { level: 2, name: TITLE }, WAIT);
    await user.click(within(panel()).getByRole('button', { name: USE }));
    expect(setupReqs(w, 'POST')).toHaveLength(0);
  });
});

describe('keeping the current ones', () => {
  it('sends POST /setup/dismiss with an empty body and the panel is gone; after a reload of the hub it is still gone', async () => {
    const w = await owner();
    const first = await open(w);
    await first.user.click(await screen.findByRole('button', { name: KEEP }, WAIT));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    expect(setupReqs(w, 'POST')).toHaveLength(1);
    expect(setupReqs(w, 'POST')[0]).toMatchObject({ path: '/setup/dismiss' });
    expect(setupReqs(w, 'POST')[0]!.body).toEqual({});
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toHaveFocus(), WAIT);
    // nothing was changed on the kit
    expect(w.cw.policy.get().version).toBe(0);
    first.unmount();
    await open(w);
    await waitFor(() => expect(setupReqs(w, 'GET')).toHaveLength(2), WAIT);
    await wait(200);
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();
  });

  it('a failing dismiss keeps the panel and says so', async () => {
    const w = await owner();
    const { user } = await open(w);
    const keep = await screen.findByRole('button', { name: KEEP }, WAIT);
    w.intercept.fn = (req) => (req.path === '/setup/dismiss' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(keep);
    expect(await within(panel()).findByRole('alert', undefined, WAIT)).toHaveTextContent('The server had a problem. Try again in a moment.');
    expect(screen.getByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument();
  });

  it('a store that cannot persist (persists false): the panel still works and still hides after dismissing', async () => {
    // the kit over a store with no setup methods keeps the dismissal for this process only
    const bare = await hubWorld({ role: 'owner', actor: 'owen@example.test', store: await noSetupStore() });
    expect(bare.cw.policy.setup().persists).toBe(false);
    const { user } = await open(bare);
    await user.click(await screen.findByRole('button', { name: KEEP }, WAIT));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    expect(bare.cw.policy.setup().show).toBe(false);
  });

  it('a store that cannot persist still applies a recommendation', async () => {
    const bare = await hubWorld({ role: 'owner', actor: 'owen@example.test', store: await noSetupStore() });
    const { user } = await open(bare);
    await user.click(await screen.findByRole('radio', { name: 'Games for kids or teens' }, WAIT));
    await user.click(within(panel()).getByRole('button', { name: USE }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    expect(bare.cw.policy.get().effective.guidelines).toEqual(PRESETS.strict.guidelines);
  });
});

async function noSetupStore() {
  const { MemoryStore, withMemoryAi } = await import('@chatwarden/store-memory');
  const store = withMemoryAi(new MemoryStore());
  Object.defineProperty(store, 'getSetupState', { value: undefined, configurable: true });
  Object.defineProperty(store, 'saveSetupState', { value: undefined, configurable: true });
  return store;
}

describe('the words', () => {
  it.each([
    ['es', { title: '\u00bfQu\u00e9 tipo de juego es este?', use: 'Usar estos principios', keep: 'Mantener los actuales' }],
    ['pt', { title: 'Que tipo de jogo \u00e9 este?', use: 'Usar estes princ\u00edpios', keep: 'Manter os atuais' }],
  ] as const)('%s renders the panel with translated words', async (locale, words) => {
    const w = await owner();
    renderHub(w, { mode: 'detailed', locale });
    expect(await screen.findByRole('heading', { level: 2, name: words.title }, WAIT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: words.use })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: words.keep })).toBeInTheDocument();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.queryByRole('button', { name: USE })).toBeNull();
  });
});

describe('applying forgets the kept policy', () => {
  it('after an apply the next session.policy() reads GET /policy again', async () => {
    const w = await owner();
    let session: ReturnType<typeof useHub>['session'] | null = null;
    function Probe() {
      session = useHub().session;
      return null;
    }
    const user = userEvent.setup();
    render(
      <HubProvider client={w.client}>
        <Probe />
        <div className="cw-screen">
          <h2 className="cw-screen-title" tabIndex={-1}>
            Screen
          </h2>
          <LazyFirstRun />
        </div>
      </HubProvider>,
    );
    await screen.findByRole('radio', { name: 'Games for kids or teens' }, WAIT);
    await session!.policy();
    await session!.policy();
    const reads = () => w.sent.filter((r) => r.method === 'GET' && r.path === '/policy').length;
    expect(reads()).toBe(1);
    await user.click(screen.getByRole('radio', { name: 'Games for kids or teens' }));
    await user.click(screen.getByRole('button', { name: USE }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: TITLE })).toBeNull(), WAIT);
    await session!.policy();
    expect(reads()).toBe(2);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Screen' })).toHaveFocus(), WAIT);
  });
});
