import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { actWorld } from './aiActWorld.js';
import type { ActWorldOptions } from './aiActWorld.js';
import { renderHub } from './render.js';
import type { HubWorld } from './world.js';

// Settings > AI > the Act option (AI levels 3 and 4, release 2, design 9.2): the owner's dialog, the blocked reasons in words, Pause and Resume. On the real routes and the
// real kit. The hub decides nothing: the server checks the word and the role again, and a refusal is shown as the server sent it. In this release nothing writes a sanction.

afterEach(() => cleanup());

type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/ai' });
  await screen.findByRole('heading', { level: 2, name: 'AI' });
  await screen.findByRole('radio', { name: /^Act/ });
  return r;
}
const act = (): HTMLInputElement => screen.getByRole('radio', { name: /^Act/ }) as HTMLInputElement;
const posts = (w: HubWorld, path: string) => w.sent.filter((r) => r.method === 'POST' && r.path === path);

async function openDialog(user: User): Promise<HTMLElement> {
  await user.click(act());
  return screen.findByRole('dialog', { name: 'Switch on acting' });
}
async function fill(user: User, word: string, why: string): Promise<void> {
  const dialog = screen.getByRole('dialog', { name: 'Switch on acting' });
  const box = within(dialog).getByRole('textbox', { name: /Type ACT to confirm/ });
  if (word !== '') await user.type(box, word);
  const reason = within(dialog).getByRole('textbox', { name: /Why are you turning this on/ });
  if (why !== '') await user.type(reason, why);
}
const start = (): HTMLButtonElement => within(screen.getByRole('dialog', { name: 'Switch on acting' })).getByRole('button', { name: 'Start shadow mode' }) as HTMLButtonElement;

describe('the Act option', () => {
  it.each(['senior', 'moderator'] as const)('is disabled for a %s with the reason in words', async (role) => {
    const { w } = await actWorld({ role, actor: `${role}@example.test` });
    await open(w);
    expect(act()).toBeDisabled();
    expect(screen.getByText('Only the owner can switch acting on.')).toBeInTheDocument();
    // the reason is tied to the option for a screen reader
    expect(act().getAttribute('aria-describedby')).toBeTruthy();
  });

  it('for the owner it is enabled and opens the dialog', async () => {
    const { w } = await actWorld();
    const { user } = await open(w);
    expect(act()).toBeEnabled();
    const dialog = await openDialog(user);
    expect(dialog).toBeInTheDocument();
    // opening it sends nothing
    expect(posts(w, '/ai/acting/shadow')).toHaveLength(0);
  });

  it.each([
    ['appeals are not on', { appeals: false }, 'Appeals must be on first: a player has to be able to ask a person to look again.'],
    ['the code does not allow it', { maxLevel: 2 }, "Acting is off in this server's code."],
    ['no adapter is set up', { noAdapter: true }, 'Acting needs an AI adapter, which is set in your server code.'],
    ['the level is below Recommend', { level: 1 }, 'Set the level to Recommend and save first.'],
  ] as Array<[string, ActWorldOptions, string]>)('is disabled for the owner when %s, and says so in words', async (_name, options, reason) => {
    const { w } = await actWorld(options);
    await open(w);
    expect(act()).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it('shows only the first blocking reason, not a list', async () => {
    const { w } = await actWorld({ appeals: false, level: 1 });
    await open(w);
    expect(screen.getByText(/Appeals must be on first/)).toBeInTheDocument();
    expect(screen.queryByText(/Set the level to Recommend/)).toBeNull();
  });

  it('is not selected while acting is off, and Off, Read and Recommend keep their meaning', async () => {
    const { w } = await actWorld();
    await open(w);
    expect(act().checked).toBe(false);
    expect((screen.getByRole('radio', { name: /^Recommend/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });
});

describe('the dialog', () => {
  it('lists, in order, what it will do, what it will not, what the player is told, what the team must do, and that the first days are shadow', async () => {
    const { w } = await actWorld();
    const { user } = await open(w);
    const dialog = await openDialog(user);
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent(/^What it will do/);
    expect(items[0]).toHaveTextContent('at most 24 hours');
    expect(items[1]).toHaveTextContent(/^What it will not do/);
    expect(items[1]).toHaveTextContent('never bans');
    expect(items[2]).toHaveTextContent(/^What the player is told/);
    expect(items[2]).toHaveTextContent('appeal to a person');
    expect(items[3]).toHaveTextContent(/^What your team must do/);
    expect(items[3]).toHaveTextContent('within 72 hours');
    expect(items[4]).toHaveTextContent(/^The first days are shadow/);
    expect(items[4]).toHaveTextContent('nothing is sent to any player');
  });

  it('the button stays disabled until ACT and a reason are right', async () => {
    const { w } = await actWorld();
    const { user } = await open(w);
    await openDialog(user);
    expect(start()).toBeDisabled();
    await fill(user, 'ACT', '');
    expect(start()).toBeDisabled();
  });

  it.each(['act', 'Act', ' ACT', 'ACT ', 'ACTT', 'AC'])('the word %j is not the word', async (word) => {
    const { w } = await actWorld();
    const { user } = await open(w);
    await openDialog(user);
    await fill(user, word, 'We want to see what it would do');
    expect(start()).toBeDisabled();
  });

  it('a reason of spaces is no reason', async () => {
    const { w } = await actWorld();
    const { user } = await open(w);
    await openDialog(user);
    await fill(user, 'ACT', '   ');
    expect(start()).toBeDisabled();
  });

  it('with ACT and a reason it sends the word and the reason once, closes, and the status line says shadow', async () => {
    const { w } = await actWorld();
    const { user } = await open(w);
    await openDialog(user);
    await fill(user, 'ACT', 'We want to see what it would do');
    expect(start()).toBeEnabled();
    await user.click(start());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch on acting' })).toBeNull());
    const sent = posts(w, '/ai/acting/shadow');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ confirm: 'ACT', reason: 'We want to see what it would do' });
    expect(w.cw.ai.acting.state().mode).toBe('shadow');
    expect(await screen.findByText(/^Shadow since .*: would have acted 0 times\.$/)).toBeInTheDocument();
    // the option now shows where acting stands
    expect(act().checked).toBe(true);
  });

  it('Cancel and Escape close it and send nothing', async () => {
    const { w } = await actWorld();
    const { user } = await open(w);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await openDialog(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(w, '/ai/acting/shadow')).toHaveLength(0);
    expect(w.cw.ai.acting.state().mode).toBe('off');
  });

  it('a refusal from the server is shown in words, and the dialog stays open with what was typed', async () => {
    const { w } = await actWorld();
    w.intercept.fn = async (req) => (req.method === 'POST' && req.path === '/ai/acting/shadow' ? { status: 409, headers: {}, body: { error: 'no_appeals', message: 'x' } } : undefined);
    const { user } = await open(w);
    await openDialog(user);
    await fill(user, 'ACT', 'We want to see what it would do');
    await user.click(start());
    expect(await screen.findByRole('alert')).toHaveTextContent('Appeals must be on first');
    const dialog = screen.getByRole('dialog', { name: 'Switch on acting' });
    expect(within(dialog).getByRole('textbox', { name: /Why are you turning this on/ })).toHaveValue('We want to see what it would do');
    expect(w.cw.ai.acting.state().mode).toBe('off');
  });

  it.each([
    [409, 'wrong_state', 'Acting is not in a state this step starts from. Reload the page.'],
    [409, 'acting_unavailable', "Acting is off in this server's code."],
    [409, 'ai_level', 'Set the level to Recommend and save first.'],
    [400, 'invalid_request', 'The word or the reason was not accepted.'],
    [403, 'forbidden', 'Only the owner can switch acting on.'],
    [500, 'unexpected', 'Could not change acting. Try again.'],
  ])('a %i %s is said in words, never in the server\'s own', async (status, code, text) => {
    const { w } = await actWorld();
    w.intercept.fn = async (req) => (req.method === 'POST' && req.path === '/ai/acting/shadow' ? { status, headers: {}, body: { error: code, message: 'server words' } } : undefined);
    const { user } = await open(w);
    await openDialog(user);
    await fill(user, 'ACT', 'A reason');
    await user.click(start());
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText('server words')).toBeNull();
  });
});

describe('the server refuses a wrong word and a non-owner even if the button is forced', () => {
  it('a wrong word is a 400, a senior is a 403, and neither moves the state', async () => {
    const { w } = await actWorld();
    const wrong = await w.raw({ method: 'POST', path: '/ai/acting/shadow', body: { confirm: 'act', reason: 'Because' } });
    expect(wrong.status).toBe(400);
    const senior = await actWorld({ role: 'senior', actor: 'sam@example.test' });
    const forced = await senior.w.raw({ method: 'POST', path: '/ai/acting/shadow', body: { confirm: 'ACT', reason: 'Because' } });
    expect(forced.status).toBe(403);
    expect(w.cw.ai.acting.state().mode).toBe('off');
    expect(senior.w.cw.ai.acting.state().mode).toBe('off');
  });
});

describe('Pause and Resume', () => {
  it('Pause is one click for a senior with no typed word and no dialog', async () => {
    const { w, startShadow } = await actWorld({ role: 'senior', actor: 'sam@example.test' });
    startShadow();
    const { user } = renderHub(w, { path: '/settings/ai' });
    const pause = await screen.findByRole('button', { name: 'Pause acting' });
    await user.click(pause);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Type ACT/ })).toBeNull();
    const sent = posts(w, '/ai/acting/pause');
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.body as object)).toEqual(['reason']);
    await waitFor(() => expect(w.cw.ai.acting.state().paused).toBe(true));
    expect(await screen.findByText('Acting is paused.')).toBeInTheDocument();
    // a senior cannot resume
    expect(screen.queryByRole('button', { name: 'Resume acting' })).toBeNull();
  });

  it('a moderator has no Pause', async () => {
    const { w, startShadow } = await actWorld({ role: 'moderator', actor: 'mia@example.test' });
    startShadow();
    renderHub(w, { path: '/settings/ai' });
    await screen.findByText(/^Shadow since /);
    expect(screen.queryByRole('button', { name: 'Pause acting' })).toBeNull();
  });

  it('Pause is not offered when acting is off or already paused', async () => {
    const { w, startShadow } = await actWorld({ role: 'senior', actor: 'sam@example.test' });
    renderHub(w, { path: '/settings/ai' });
    await screen.findByRole('radio', { name: /^Act/ });
    expect(screen.queryByRole('button', { name: 'Pause acting' })).toBeNull();
    cleanup();
    startShadow();
    w.cw.ai.acting.pause('sam@example.test', { reason: 'Looking' });
    renderHub(w, { path: '/settings/ai' });
    await screen.findByText('Acting is paused.');
    expect(screen.queryByRole('button', { name: 'Pause acting' })).toBeNull();
  });

  it("Resume is the owner's: one click, and the status line goes back to shadow", async () => {
    const { w, startShadow } = await actWorld();
    startShadow();
    w.cw.ai.acting.pause('sam@example.test', { reason: 'Looking' });
    const { user } = renderHub(w, { path: '/settings/ai' });
    await user.click(await screen.findByRole('button', { name: 'Resume acting' }));
    expect(posts(w, '/ai/acting/resume')).toHaveLength(1);
    await waitFor(() => expect(w.cw.ai.acting.state().paused).toBe(false));
    expect(await screen.findByText(/^Shadow since /)).toBeInTheDocument();
  });

  it('a refused Pause says so in words and leaves the state', async () => {
    const { w, startShadow } = await actWorld({ role: 'senior', actor: 'sam@example.test' });
    startShadow();
    w.intercept.fn = async (req) => (req.method === 'POST' && req.path === '/ai/acting/pause' ? { status: 409, headers: {}, body: { error: 'wrong_state', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/settings/ai' });
    await user.click(await screen.findByRole('button', { name: 'Pause acting' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Acting is not in a state this step starts from. Reload the page.');
    expect(w.cw.ai.acting.state().paused).toBe(false);
  });

  it('the owner can switch acting off, and the option goes back to unselected', async () => {
    const { w, startShadow } = await actWorld();
    startShadow();
    const { user } = renderHub(w, { path: '/settings/ai' });
    await user.click(await screen.findByRole('button', { name: 'Switch acting off' }));
    expect(posts(w, '/ai/acting/off')).toHaveLength(1);
    await waitFor(() => expect(w.cw.ai.acting.state().mode).toBe('off'));
    await waitFor(() => expect(act().checked).toBe(false));
  });
});

describe('the status line', () => {
  it('says what this version does when acting is on: it records and applies nothing', async () => {
    const { w, startShadow } = await actWorld();
    startShadow();
    // the shadow period is over
    w.clock.t += 15 * 24 * 60 * 60 * 1000;
    expect(w.cw.ai.acting.startActing('owen@example.test', { confirm: 'ACT', reason: 'Shadow was fine' }).ok).toBe(true);
    renderHub(w, { path: '/settings/ai' });
    expect(await screen.findByText(/Nothing is applied to a player/)).toBeInTheDocument();
    // there is no button to start acting in this release
    expect(screen.queryByRole('button', { name: /start acting/i })).toBeNull();
  });

  it('a server from before 0.1.14 has no Act option at all', async () => {
    const { w } = await actWorld();
    w.intercept.fn = async (req) => (req.path === '/ai/acting' ? { status: 404, headers: {}, body: { error: 'not_found', message: 'x' } } : undefined);
    renderHub(w, { path: '/settings/ai' });
    await screen.findByRole('radio', { name: /^Recommend/ });
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3));
  });
});
