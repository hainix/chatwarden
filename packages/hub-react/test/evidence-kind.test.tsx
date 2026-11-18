import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The case screens follow the evidence kind (0.2.2, audit P3, S4, S5, C1): an AFK report attaches no chat line, says so, and the words of the
// transcript and the rule hint do not pretend the report is about chat. Real routes, real kit. The Moxgate repro is the first test.

const HELLO: RichLine[] = [
  { who: 'reporter', text: 'good game everyone' },
  { who: 'target', text: 'Hello' },
  { who: 'target', text: 'back in a minute' },
];
const SILENT: RichLine[] = [{ who: 'reporter', text: 'he left the match' }];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const sendNow = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

async function openDetailed(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  return r;
}
async function decideFair(user: ReturnType<typeof renderHub>['user']): Promise<void> {
  await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
  await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Left the game.');
  await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
  await sendNow();
}

describe('the Moxgate repro: an AFK report in the full editor', () => {
  it('the pre-filled action shows no lines and says so; deciding sends no lineIds; the player sees no line and a neutral warning', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    const { user } = await openDetailed(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    const action = within(panel()).getByRole('group', { name: 'Action 1' });
    expect(within(action).queryByRole('group', { name: 'Show the player these lines' })).toBeNull();
    expect(within(action).getByText('Nothing from the chat is shown. The player sees the rule only.')).toBeInTheDocument();
    expect(within(action).getByRole('button', { name: 'Add a line' })).toBeInTheDocument();
    await decideFair(user);
    const [sent] = decides(w);
    const body = (sent?.body) as { actions: Array<Record<string, unknown>> } & Record<string, unknown>;
    expect(body.actions[0]).not.toHaveProperty('lineIds');
    expect(body).not.toHaveProperty('evidenceKind');
    const notices = w.cw.notices.pending({ clientKey: 'key-target-Mallory' });
    expect(notices[0]).toMatchObject({ kind: 'warning', evidence: 'play', excerpt: [] });
  });

  it('a chat report is as it was: the lines are listed and the latest are ticked', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: HELLO, reason: 'harassment', cite: 1 });
    const { user } = await openDetailed(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    const action = within(panel()).getByRole('group', { name: 'Action 1' });
    const picks = within(action).getByRole('group', { name: 'Show the player these lines' });
    expect(within(picks).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(2);
    expect(within(action).queryByRole('button', { name: 'Add a line' })).toBeNull();
    await decideFair(user);
    const body = (decides(w)[0]?.body) as { actions: Array<{ lineIds?: string[] }> };
    expect(body.actions[0]?.lineIds).toHaveLength(2);
  });

  it('"Add a line" brings the lines back as the moderator\'s own choice: the decision says it is about chat and the player gets the line', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    const { user } = await openDetailed(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    const action = within(panel()).getByRole('group', { name: 'Action 1' });
    await user.click(within(action).getByRole('button', { name: 'Add a line' }));
    const picks = within(action).getByRole('group', { name: 'Show the player these lines' });
    const boxes = within(picks).getAllByRole('checkbox');
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    await user.click(boxes[0] as HTMLElement);
    await decideFair(user);
    const body = (decides(w)[0]?.body) as { evidenceKind?: string; actions: Array<{ lineIds?: string[] }> };
    expect(body.evidenceKind).toBe('chat');
    expect(body.actions[0]?.lineIds).toHaveLength(1);
    expect(w.cw.notices.pending({ clientKey: 'key-target-Mallory' })[0]).toMatchObject({ evidence: 'chat' });
  });
});

describe('the Simple card (S5, C1)', () => {
  const open = async (w: HubWorld, id: string) => {
    const r = renderHub(w, { path: `/reports/${id}`, mode: 'simple', stay: true });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    await screen.findByRole('button', { name: /^No action needed/ });
    w.clock.t += 400;
    return r;
  };
  it('an AFK report: the chat block is headed as context, the rule hint says no chat is attached, and one click sends no lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    const { user } = await open(w, f.id);
    expect(screen.getByRole('region', { name: 'The chat around this report' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What they said' })).toBeNull();
    expect(screen.getByText(/This is about play, so no chat is attached/)).toBeInTheDocument();
    const decision = screen.getByRole('region', { name: 'Decision' });
    await user.click(within(decision).getAllByRole('button').find((b) => /^Send a warning/.test(b.textContent ?? '')) as HTMLElement);
    await sendNow();
    const body = (decides(w)[0]?.body) as { actions: Array<Record<string, unknown>> };
    expect(body.actions[0]).not.toHaveProperty('lineIds');
  });
  it('a chat report is unchanged: "What they said" and no clause about chat', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: HELLO, reason: 'harassment', cite: 1 });
    await open(w, f.id);
    expect(screen.getByRole('region', { name: 'What they said' })).toBeInTheDocument();
    expect(screen.queryByText(/so no chat is attached/)).toBeNull();
  });
});

describe('the transcript when the reported person wrote nothing (S5)', () => {
  it('chat: a warning-toned notice, as before', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: SILENT, reason: 'harassment', cite: null });
    await openDetailed(w, f.id);
    expect(await screen.findByText(/sent no messages in this excerpt/)).toBeInTheDocument();
  });
  it('play: a plain hint instead, and no warning that looks like a data problem', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: SILENT, reason: 'afk', cite: null });
    await openDetailed(w, f.id);
    expect(await screen.findByText('This report is about play, not chat. The chat is shown for context.')).toBeInTheDocument();
    expect(screen.queryByText(/sent no messages in this excerpt/)).toBeNull();
  });
  it('name: the same, for a name', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: SILENT, reason: 'name', cite: null });
    await openDetailed(w, f.id);
    expect(await screen.findByText('This report is about a name, not chat. The chat is shown for context.')).toBeInTheDocument();
  });
  it('the transcript heading follows the kind', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    await openDetailed(w, f.id);
    expect(screen.getByRole('heading', { level: 3, name: 'The chat around this report' })).toBeInTheDocument();
  });
});

describe('the reasons editor (S11)', () => {
  const owner = () => hubWorld({ role: 'owner', actor: 'owen@example.test' });
  const row = (name: string): HTMLElement => screen.getByRole('group', { name: `Reason: ${name}` });
  async function expand(user: ReturnType<typeof renderHub>['user'], name: string): Promise<HTMLElement> {
    await user.click(within(row(name)).getByRole('button', { name: `More about ${name}` }));
    return within(row(name)).getByRole('group', { name: `After a report about ${name}` });
  }
  const open = async (w: HubWorld) => {
    const r = renderHub(w, { path: '/settings/reporting' });
    await screen.findByRole('heading', { level: 2, name: 'Reporting' });
    await screen.findByRole('list', { name: 'Reasons' });
    return r;
  };

  it('is behind the reason\'s own disclosure, closed by default, and shows each default kind', async () => {
    const w = await owner();
    const { user } = await open(w);
    expect(within(row('Leaving or AFK')).queryByRole('combobox', { name: 'What it is about' })).toBeNull();
    expect(within(await expand(user, 'Leaving or AFK')).getByRole('combobox', { name: 'What it is about' })).toHaveValue('play');
    expect(within(await expand(user, 'Inappropriate name')).getByRole('combobox', { name: 'What it is about' })).toHaveValue('name');
    expect(within(await expand(user, 'Hate')).getByRole('combobox', { name: 'What it is about' })).toHaveValue('chat');
    expect(within(await expand(user, 'Something else')).getByRole('combobox', { name: 'What it is about' })).toHaveValue('');
  });

  it('lists the four choices in words and saves a change with the kind', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Leaving or AFK');
    const select = within(box).getByRole('combobox', { name: 'What it is about' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not set', 'Chat', 'Play', 'A name']);
    await user.selectOptions(select, 'chat');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Leaving is in chat for us');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const put = w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile')[0];
    const layer = ((put?.body) as { layer: { reporting: { reasons: Array<{ id: string; evidence: unknown }> } } }).layer;
    expect(layer.reporting.reasons.find((r) => r.id === 'afk')?.evidence).toBe('chat');
    expect(layer.reporting.reasons.find((r) => r.id === 'name')?.evidence).toBe('name');
    expect(layer.reporting.reasons.find((r) => r.id === 'other')?.evidence).toBeNull();
  });
});

describe('the AI reads chat only (ruling 2)', () => {
  it('a case about play says so in one line where the AI read would be; a chat case does not', async () => {
    const w = await hubWorld({ ai: { level: 1 } });
    const play = await w.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    await openDetailed(w, play.id);
    expect(await screen.findByText('AI reads chat only. This report is about play or a name, so there is no AI read.')).toBeInTheDocument();
  });
  it('a chat case has no such line, and neither has one with the AI off', async () => {
    const w = await hubWorld({ ai: { level: 1 } });
    const chat = await w.fileRich({ lines: HELLO, reason: 'harassment', cite: 1 });
    await openDetailed(w, chat.id);
    expect(screen.queryByText(/AI reads chat only/)).toBeNull();
    const off = await hubWorld();
    const play = await off.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    const r2 = renderHub(off, { path: `/reports/${play.id}` });
    await screen.findAllByRole('heading', { level: 2, name: /report against/ });
    expect(screen.queryByText(/AI reads chat only/)).toBeNull();
    r2.unmount();
  });
});
