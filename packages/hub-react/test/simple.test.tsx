import { CATEGORY_TO_RULE } from '@chatwarden/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNDO_MS } from '../src/toasts.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { DAY, hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The Simple case card, against the real routes: what is on it, what is not, what one click sends, and everything that must stay
// true of the decision underneath (the Undo, the claim, the failures).

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const RULE = CATEGORY_TO_RULE.harassment as number;
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const ruleTitle = (w: HubWorld, n = RULE): string => w.cw.rules.get(n)?.title ?? '?';

const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const primary = (): HTMLElement => within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ });
const noAction = (): HTMLElement => within(decision()).getByRole('button', { name: /^No action needed/ });
const something = (): HTMLElement => within(decision()).getByRole('button', { name: /^Something else/ });
const queue = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const toasts = (): HTMLElement => screen.getByRole('region', { name: 'Notifications' });
const said = (): HTMLElement => screen.getByRole('region', { name: 'What they said' });
const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;

afterEach(() => {
  vi.useRealTimers();
});

const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function open(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  // A quick action moves on from the case; these tests are about the decision on it, so the page stays (`stay`). The clock moves past
  // the quick-key cooldown of a case that has just appeared.
  const r = renderHub(w, { path: `/reports/${id}`, mode: 'simple', stay: true, ...options });
  await screen.findByRole('heading', { level: 2, name: 'Mallory' });
  await screen.findByRole('button', { name: /^No action needed/ });
  w.clock.t += 400;
  return r;
}

describe('the card says who, why, what they said and their record', () => {
  it('names the person and says what they were reported for and by whom', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    await open(w, f.id);
    expect(screen.getByRole('heading', { level: 2, name: 'Mallory' })).toBeInTheDocument();
    expect(screen.getByText('Reported as Insults or harassment by Saffron, now.')).toBeInTheDocument();
  });

  it('says how long ago, in words', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    w.clock.t += 2 * DAY;
    await open(w, f.id);
    expect(screen.getByText('Reported as Insults or harassment by Saffron, 2 days ago.')).toBeInTheDocument();
  });

  it('with several reports it counts them and lists the reasons', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Saffron', category: 'hate', room: 'one' });
    await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Rae', category: 'harassment', room: 'two' });
    await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Kit', category: 'hate', room: 'three' });
    await open(w, a.id);
    expect(screen.getByText('3 reports: Hate, Insults or harassment.')).toBeInTheDocument();
    expect(screen.queryByText(/^Reported as .* by /)).toBeNull();
  });

  it('shows only the reported person\'s lines, the reported line marked', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const items = within(within(said()).getByRole('list', { name: 'Chat lines' })).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.cw-line-text')?.textContent)).toEqual(['a line from the target', 'another line from the target']);
    expect(items.map((i) => i.hasAttribute('data-reported'))).toEqual([true, false]);
    expect(within(items[0]!).getByText('Reported line')).toBeInTheDocument();
    expect(within(said()).queryByText('hello there')).toBeNull();
    expect(within(said()).queryByText('what is going on')).toBeNull();
  });

  it('says how many more lines the whole chat has', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(said()).getByRole('button', { name: 'Show the whole chat (2 more lines)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('says "1 more line" for one', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hello there' }, { who: 'target', text: 'one line' }] });
    await open(w, f.id);
    expect(within(said()).getByRole('button', { name: 'Show the whole chat (1 more line)' })).toBeInTheDocument();
  });

  it('has no button when the target said everything there is', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'target', text: 'just me' }], cite: 0 });
    await open(w, f.id);
    expect(within(said()).queryByRole('button', { name: /Show the whole chat/ })).toBeNull();
  });

  it('opens the whole chat, with who said each line, and folds it back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(within(said()).getByRole('button', { name: 'Show the whole chat (2 more lines)' }));
    const items = within(within(said()).getByRole('list', { name: 'Chat lines' })).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('.cw-line-text')?.textContent)).toEqual(['hello there', 'a line from the target', 'what is going on', 'another line from the target']);
    expect(items.map((i) => i.querySelector('.cw-line-who')?.textContent)).toEqual([expect.stringMatching(/^Reporter/), 'Mallory', 'Bystander', 'Mallory']);
    expect(items.map((i) => i.hasAttribute('data-reported'))).toEqual([false, true, false, false]);
    const fold = within(said()).getByRole('button', { name: 'Show only their lines' });
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    await user.click(fold);
    expect(within(said()).getAllByRole('listitem')).toHaveLength(2);
    expect(within(said()).getByRole('button', { name: 'Show the whole chat (2 more lines)' })).toHaveFocus();
  });

  it('says so when the reported person wrote nothing', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hello there' }, { who: 'bystander', text: 'hmm' }], cite: null });
    await open(w, f.id);
    expect(within(said()).getByText('Mallory sent no messages in this excerpt.')).toBeInTheDocument();
    expect(within(said()).queryByRole('listitem')).toBeNull();
  });

  it('their record: nothing in the last 90 days', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const record = screen.getByRole('region', { name: 'Their record' });
    expect(await within(record).findByText('Nothing in the last 90 days.')).toBeInTheDocument();
  });

  it('a role that may not read histories sees no record section and no history is read', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(screen.queryByRole('region', { name: 'Their record' })).toBeNull();
    expect(w.sent.filter((r) => /\/people\/[^/]+\/history/.test(r.path))).toHaveLength(0);
  });
});

describe('the record in one line', () => {
  const record = async (w: HubWorld, id: string) => {
    await open(w, id);
    return screen.getByRole('region', { name: 'Their record' });
  };

  it('a warning', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning');
    expect(await within(await record(w, f.id)).findByText('1 past step: a warning.')).toBeInTheDocument();
  });

  it('a step still in force says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'chat', 1, 7 * DAY);
    expect(await within(await record(w, f.id)).findByText('1 past step: a 7-day chat restriction, still in force.')).toBeInTheDocument();
  });

  it('a step that has ended does not', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'chat', 1, DAY);
    w.clock.t += 3 * DAY;
    expect(await within(await record(w, f.id)).findByText('1 past step: a 24-hour chat restriction.')).toBeInTheDocument();
  });

  it.each([
    ['ban', 7 * DAY, 'a 7-day ban, still in force'],
    ['ban', null, 'a permanent ban, still in force'],
    ['chat', 3_600_000, 'a 1-hour chat restriction, still in force'],
    ['area', 30 * DAY, 'a 30-day area restriction, still in force'],
    ['note', null, 'a note'],
  ] as const)('%s for %s reads "%s"', async (kind, duration, words) => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, kind, 1, duration);
    expect(await within(await record(w, f.id)).findByText(`1 past step: ${words}.`)).toBeInTheDocument();
  });

  it('lists the newest first, and says how many there are', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning');
    w.clock.t += DAY;
    await w.sanction(f.person, 'chat', 1, DAY);
    w.clock.t += 5 * DAY;
    expect(await within(await record(w, f.id)).findByText('2 past steps: a 24-hour chat restriction and a warning.')).toBeInTheDocument();
  });

  it('shows three at most, then "and N more"', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    for (const kind of ['warning', 'note', 'warning', 'note', 'warning'] as const) {
      await w.sanction(f.person, kind);
      w.clock.t += DAY;
    }
    expect(await within(await record(w, f.id)).findByText('5 past steps: a warning, a note, a warning, and 2 more.')).toBeInTheDocument();
  });

  it('exactly three has no "more"', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    for (const kind of ['warning', 'note', 'warning'] as const) {
      await w.sanction(f.person, kind);
      w.clock.t += DAY;
    }
    const line = await within(await record(w, f.id)).findByText(/^3 past steps:/);
    expect(line.textContent).not.toMatch(/more/);
  });

  it('a revoked step is not a step', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const done = await w.sanction(f.person, 'warning');
    await w.cw.sanctions.revoke(done.groupId, 'ann@example.test', 'mistake');
    expect(await within(await record(w, f.id)).findByText('Nothing in the last 90 days.')).toBeInTheDocument();
  });
});

describe('the reporter warning', () => {
  /** Files the reporter's earlier reports: some decided (upheld or not), some still open. */
  async function history(w: HubWorld, reporter: string, past: Array<'upheld' | 'dismissed'>, open = 0): Promise<void> {
    for (const [i, outcome] of past.entries()) {
      const g = await w.file({ reporter, target: `Other${i}`, room: `past-${reporter}-${i}` });
      await w.client.decide(g.id, { verdict: outcome === 'upheld' ? 'upheld' : 'no_action', reason: 'Decided.', actions: [] });
    }
    for (let i = 0; i < open; i += 1) await w.file({ reporter, target: `Pending${i}`, room: `open-${reporter}-${i}` });
  }
  const warning = (): HTMLElement | null => screen.queryByText(/past reports were mostly not upheld/);
  // These are the all-time rule, which the card keeps for a kit that sends no recent figure (an older one): history answers without it.
  const olderKit = (w: HubWorld): void => {
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && /^\/people\/[^/]+\/history$/.test(req.path)) {
        const res = await w.direct.personHistory(req.path.split('/')[2] as string);
        const { accuracy, ...asReporter } = res.asReporter;
        void accuracy;
        return { status: 200, headers: {}, body: { ...res, asReporter } };
      }
      return undefined;
    };
  };
  /** Waits until the reporter's record has been asked for and answered, so "no warning" is a result, not a race. */
  const settle = async (w: HubWorld, reporter: string): Promise<void> => {
    await within(await screen.findByRole('region', { name: 'Their record' })).findByText('Nothing in the last 90 days.');
    await waitFor(() => expect(w.sent.some((r) => r.path === `/people/${reporter}/history`)).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  };

  // Only decided reports count (the one on the card is open, and so are any others still waiting).
  it.each([
    ['2 decided, none upheld', ['dismissed', 'dismissed'], 0, false],
    ['3 open, none decided', [], 3, false],
    ['3 decided, none upheld', ['dismissed', 'dismissed', 'dismissed'], 0, true],
    ['3 decided, 1 upheld (exactly a third)', ['upheld', 'dismissed', 'dismissed'], 0, false],
    ['3 decided, 2 upheld', ['upheld', 'upheld', 'dismissed'], 0, false],
    ['4 decided, 1 upheld', ['upheld', 'dismissed', 'dismissed', 'dismissed'], 0, true],
    ['4 decided, 2 upheld', ['upheld', 'upheld', 'dismissed', 'dismissed'], 0, false],
    ['2 decided, none upheld, and 3 open', ['dismissed', 'dismissed'], 3, false],
    ['3 decided, none upheld, and 2 open', ['dismissed', 'dismissed', 'dismissed'], 2, true],
  ] as const)('%s: warning shown: %s', async (_name, past, waiting, shown) => {
    const w = await hubWorld();
    await history(w, 'Saffron', [...past], waiting);
    olderKit(w);
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    await open(w, f.id);
    await settle(w, f.reporter);
    if (shown) expect(warning()).toBeInTheDocument();
    else expect(warning()).toBeNull();
  });

  it('is plain and does not accuse: it says what the numbers are, of the decided reports', async () => {
    const w = await hubWorld();
    await history(w, 'Saffron', ['upheld', 'dismissed', 'dismissed', 'dismissed'], 2);
    olderKit(w);
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    await open(w, f.id);
    expect(await screen.findByText("Saffron's past reports were mostly not upheld (1 of 4).")).toBeInTheDocument();
    expect(warning()?.textContent ?? '').not.toMatch(/bad faith|abuse|spam|liar/i);
  });

  it('a reporter with no record gets no warning and no meter', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    await open(w, f.id);
    await settle(w, f.reporter);
    expect(warning()).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText(/\d reports?, \d upheld/)).toBeNull();
  });

  it('a role that may not read histories gets no warning and the reporter\'s history is not read', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    await history(w, 'Saffron', ['dismissed', 'dismissed']).catch(() => undefined);
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    await open(w, f.id);
    expect(warning()).toBeNull();
    expect(w.sent.filter((r) => /\/people\//.test(r.path))).toHaveLength(0);
  });

  it('a reporter record that cannot be loaded says nothing, and the card still works', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    w.intercept.fn = (req) => (req.path === `/people/${f.reporter}/history` ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await open(w, f.id);
    expect(warning()).toBeNull();
    expect(primary()).toBeEnabled();
  });
});

describe('the suggestion and the three controls', () => {
  it('shows the ladder\'s step as a referee card with its why, then the primary button, No action needed and Something else', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const detail = await w.client.getReport(f.id);
    const { container } = await open(w, f.id);
    const card = within(decision()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(card).getByText('Chat restriction, 24 hours')).toBeInTheDocument();
    expect(within(card).getByText(detail.suggest.why)).toBeInTheDocument();
    expect(card.querySelector('.cw-card--restriction')).not.toBeNull();
    expect(container.querySelector('.cw-btn--primary')).toBe(primary());
    expect(noAction()).not.toHaveClass('cw-btn--primary');
    expect(something()).not.toHaveClass('cw-btn--primary');
  });

  it('says what the player will see, with the real counts and the rule number', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(decision()).getByText(`Mallory sees these 2 lines and Rule ${RULE}. You can undo for 5 seconds.`)).toBeInTheDocument();
  });

  it('says "this line" for one', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'target', text: 'one line' }] });
    await open(w, f.id);
    expect(within(decision()).getByText(`Mallory sees this line and Rule ${RULE}. You can undo for 5 seconds.`)).toBeInTheDocument();
  });

  it('says only the rule when there are no lines to show', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'bystander', text: 'hm' }], cite: null });
    await open(w, f.id);
    expect(within(decision()).getByText(`Mallory sees Rule ${RULE}. You can undo for 5 seconds.`)).toBeInTheDocument();
  });

  it('counts at most five lines', async () => {
    const w = await hubWorld();
    const lines: RichLine[] = [{ who: 'reporter', text: 'hi' }, ...Array.from({ length: 7 }, (_, i): RichLine => ({ who: 'target', text: `target line ${i + 1}` }))];
    const f = await w.fileRich({ lines });
    await open(w, f.id);
    expect(within(decision()).getByText(`Mallory sees these 5 lines and Rule ${RULE}. You can undo for 5 seconds.`)).toBeInTheDocument();
  });

  it('the primary button is named after the step the ladder gives a person with a record', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'chat', 1);
    const detail = await w.client.getReport(f.id);
    const outcome = detail.suggest.outcome as { kind: string; durationMs: number | null };
    await open(w, f.id);
    const words = { chat: 'Restrict chat', area: 'Restrict area', ban: 'Ban' }[outcome.kind] ?? '?';
    const length = outcome.durationMs === null ? 'permanent' : outcome.durationMs === DAY ? '24 hours' : `${outcome.durationMs / DAY} days`;
    expect(within(decision()).getByRole('button', { name: new RegExp(`^${words}, ${length}`) })).toHaveClass('cw-btn--primary');
  });

  it('a step that restricts the area is named for it, under its own rule', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'cheating' });
    await open(w, f.id);
    expect(within(decision()).getByRole('button', { name: /^Restrict area, 24 hours/ })).toHaveClass('cw-btn--primary');
    expect(within(decision()).getByText(`Mallory sees these 2 lines and Rule ${CATEGORY_TO_RULE.cheating as number}. You can undo for 5 seconds.`)).toBeInTheDocument();
  });

  it('a hateful report is the 7-day step, in the same words', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'hate' });
    await open(w, f.id);
    expect(within(decision()).getByRole('button', { name: /^Restrict chat, 7 days/ })).toHaveClass('cw-btn--primary');
  });
});

describe('when there is no suggestion', () => {
  it('no rule covers the report: the primary button is absent and Something else is the main action', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'other' });
    await open(w, f.id);
    // No rule is clear (the rule it mapped to is retired, or "Something else" maps to none), so the card asks which rule.
    expect(within(decision()).getByRole('combobox', { name: 'Which rule does this break?' })).toHaveValue('');
    expect(within(decision()).queryByRole('group', { name: 'The ladder suggests' })).toBeNull();
    expect(within(decision()).queryByRole('button', { name: /^(Restrict|Ban|Send a warning|Add a note)/ })).toBeNull();
    expect(something()).toHaveClass('cw-btn--primary');
    expect(noAction()).toBeInTheDocument();
    expect(within(decision()).queryByText(/sees (this|these)/)).toBeNull();
  });

  it('the rule the category maps to was retired: the same', async () => {
    const w = await hubWorld({ retire: [RULE] });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    // No rule is clear (the rule it mapped to is retired, or "Something else" maps to none), so the card asks which rule.
    expect(within(decision()).getByRole('combobox', { name: 'Which rule does this break?' })).toHaveValue('');
    expect(something()).toHaveClass('cw-btn--primary');
  });

  it('with no primary button, 1 does nothing and 2 still means no action', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'other' });
    const { user } = await open(w, f.id);
    await user.keyboard('1');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    await user.keyboard('2');
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', actions: [] });
  });

  it('a role that cannot apply sanctions: no primary button, and it says why; No action needed still works', async () => {
    const w = await hubWorld({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    expect(within(decision()).queryByRole('button', { name: /^Restrict/ })).toBeNull();
    expect(within(decision()).getByText('Your role cannot apply sanctions. You can still decide the report.')).toBeInTheDocument();
    await user.click(noAction());
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });

  it('a permanent step a moderator may not make: shown, with who can; no primary button', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'ban', 1, 30 * DAY);
    await open(w, f.id);
    const card = within(decision()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(card).getByText('Ban, permanent')).toBeInTheDocument();
    expect(within(decision()).getByText('Only a senior moderator can make this permanent.')).toBeInTheDocument();
    expect(within(decision()).queryByRole('button', { name: /^Ban, permanent/ })).toBeNull();
    expect(something()).toHaveClass('cw-btn--primary');
  });

  it('a senior gets the permanent step as the primary button', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'ban', 1, 30 * DAY);
    await open(w, f.id);
    expect(within(decision()).getByRole('button', { name: /^Ban, permanent/ })).toHaveClass('cw-btn--primary');
  });

  it('a role that cannot read the rules: no primary, and it says so', async () => {
    const w = await hubWorld({ permissions: { 'policy.read': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(decision()).queryByRole('button', { name: /^Restrict/ })).toBeNull();
    expect(within(decision()).getByText(/cannot read the rules/)).toBeInTheDocument();
    expect(noAction()).toBeInTheDocument();
  });

  it('a role that may read but not decide gets the plain notice and no buttons', async () => {
    const w = await hubWorld({ permissions: { 'reports.decide': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    expect(await screen.findByText('Your role can read reports but not decide them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^No action needed/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Something else/ })).toBeNull();
  });
});

describe('one click', () => {
  it('sends exactly: Fair, the suggested step, the rule, the rule\'s title as the reason, and the person\'s own lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(primary());
    expect(decides(w)).toHaveLength(0);
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toEqual({
      verdict: 'upheld',
      reason: ruleTitle(w),
      actions: [{ subject: f.person, kind: 'chat', durationMs: DAY, rule: RULE, lineIds: [f.lineIds[1], f.lineIds[3]] }],
    });
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
  });

  it('is the same send path as the bar: the request carries keepalive, and nothing else is read', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    const before = w.sent.length;
    await user.click(primary());
    await pageHides();
    const after = w.sent.slice(before).filter((r) => r.method === 'POST' && !/claim|viewing|release|\/cases\/next/.test(r.path));
    expect(after.map((r) => `${r.method} ${r.path}`)).toEqual([`POST /reports/${f.id}/decide`]);
    expect(after[0]).toMatchObject({ keepalive: true });
  });

  it('sends nothing at 4.9 seconds and one decision at 5', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    vi.useFakeTimers({ toFake: [...FAKE] });
    expect(UNDO_MS).toBe(5_000);
    fireEvent.click(primary());
    expect(within(toasts()).getByText('Sending the decision on Mallory in 5 s.')).toBeInTheDocument();
    await advance(4_900);
    expect(decides(w)).toHaveLength(0);
    await advance(200);
    expect(decides(w)).toHaveLength(1);
  });

  it('puts the case away and says it is queued, with Undo, in the card\'s place', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(primary());
    expect(screen.queryByRole('region', { name: 'What they said' })).toBeNull();
    expect(within(decision()).getByText('Decision queued.')).toBeInTheDocument();
    expect(within(decision()).getByText('Decision queued.').closest('[role="status"]')).toHaveFocus();
    expect(within(decision()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(within(decision()).getByRole('button', { name: 'Take next case' })).toBeInTheDocument();
    expect(within(decision()).queryByRole('button', { name: /^No action needed/ })).toBeNull();
  });

  it('after the send it says so, with the reference code, and the way on', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(primary());
    await pageHides();
    expect(await within(decision()).findByText('Decided. The report is closed.', { selector: 'strong' })).toBeInTheDocument();
    expect(within(decision()).getByRole('list', { name: 'Reference codes' })).toBeInTheDocument();
  });

  it('Undo in the card cancels with nothing sent, and the card comes back with the primary button focused', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await user.click(primary());
    await user.click(within(decision()).getByRole('button', { name: 'Undo' }));
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    expect(primary()).toHaveFocus();
    expect(within(said()).getAllByRole('listitem')).toHaveLength(2);
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
  });

  it('Undo in the toast does the same', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(primary());
    await advance(2_000);
    fireEvent.click(within(toasts()).getByRole('button', { name: 'Undo' }));
    await advance(20_000);
    expect(decides(w)).toHaveLength(0);
    expect(primary()).toBeInTheDocument();
    void user;
  });

  it('an undone decision can be made again: the second click sends once', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(primary());
    await user.click(within(decision()).getByRole('button', { name: 'Undo' }));
    await user.click(primary());
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });

  it('a double click sends one decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const button = primary();
    fireEvent.click(button);
    fireEvent.click(button);
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });

  it('a click goes on to the next case, as the keys do', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const g = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Other', room: 'rb' });
    const { user, router } = await open(w, f.id, { stay: false });
    await user.click(primary());
    await waitFor(() => expect(router.path).toBe(`/reports/${g.id}`));
    expect(w.sent.some((r) => r.path === '/cases/next')).toBe(true);
  });

  it('the queue row goes at once, as in Detailed, and comes back on Undo', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Other', room: 'rb' });
    const { user } = await open(w, f.id);
    await within(queue()).findByText('Beta');
    await user.click(primary());
    await user.click(within(decision()).getByRole('button', { name: 'Undo' }));
    expect(within(queue()).getByText('Mallory')).toBeInTheDocument();
  });
});

describe('No action needed', () => {
  it('sends the Not-a-problem verdict with no reason (the kit stores its standard one) and no actions', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(noAction());
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', actions: [] });
    expect(w.cw.reports.get(f.id)?.status).toBe('dismissed');
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(0);
  });

  it('is held five seconds with the same Undo', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(noAction());
    expect(within(decision()).getByText('Decision queued.')).toBeInTheDocument();
    await user.click(within(decision()).getByRole('button', { name: 'Undo' }));
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    expect(noAction()).toHaveFocus();
  });

  it('is there for a role that cannot apply sanctions', async () => {
    const w = await hubWorld({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(noAction()).toBeEnabled();
  });
});

describe('Something else…', () => {
  it('opens the full decision bar in place, pre-filled as it is in Detailed, and the simple controls give way', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(something());
    expect(within(decision()).queryByRole('button', { name: /^Restrict chat/ })).toBeNull();
    expect(within(decision()).queryByRole('button', { name: /^No action needed/ })).toBeNull();
    for (const name of ['Fair', 'Not a problem', 'Bad faith']) expect(within(decision()).getByRole('radio', { name })).toBeInTheDocument();
    expect(within(decision()).getByRole('radio', { name: 'Fair' })).not.toBeChecked();
    expect(within(decision()).getByRole('textbox', { name: 'Reason' })).toHaveValue('');
    expect(within(decision()).getByLabelText('Community Rule')).toHaveDisplayValue(`Rule ${RULE}: ${ruleTitle(w)}`);
    expect(within(decision()).getByRole('button', { name: 'Add an action' })).toBeInTheDocument();
    expect(within(decision()).getByRole('group', { name: 'The ladder suggests' })).toBeInTheDocument();
    expect(within(decision()).getByRole('button', { name: 'Decide and take next' })).toBeInTheDocument();
  });

  it('the evidence stays on the page above it', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(something());
    expect(within(said()).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 2, name: 'Mallory' })).toBeInTheDocument();
  });

  it('puts keyboard focus on the first control of the bar', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(something());
    expect(within(decision()).getByRole('radio', { name: 'Fair' })).toHaveFocus();
  });

  it('a decision made in the bar goes through the same hold', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(something());
    await user.click(within(decision()).getByRole('radio', { name: 'Bad faith' }));
    await user.type(within(decision()).getByRole('textbox', { name: 'Evidence for bad faith' }), 'Reported a friend as a joke.');
    await user.type(within(decision()).getByRole('textbox', { name: 'Reason' }), 'Bad faith.');
    await user.click(within(decision()).getByRole('button', { name: 'Decide' }));
    expect(within(decision()).getByText('Decision queued.')).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'bad_faith', reason: 'Bad faith.' });
  });

  it('Back returns to the suggestion, and what was entered is kept for next time', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(something());
    await user.type(within(decision()).getByRole('textbox', { name: 'Reason' }), 'Half written.');
    await user.click(screen.getByRole('button', { name: 'Back to the suggestion' }));
    expect(primary()).toBeInTheDocument();
    await user.click(something());
    expect(within(decision()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Half written.');
  });

  it('with no suggestion it is the same bar, and the primary button of the card was never there', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'other' });
    const { user } = await open(w, f.id);
    await user.click(something());
    expect(within(decision()).getByRole('radio', { name: 'Fair' })).toBeInTheDocument();
  });
});

describe('the case someone else holds', () => {
  it('reads, says who is on it, and offers no decision', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    expect(await screen.findByText('maya is on it.')).toBeInTheDocument();
    expect(screen.getByText('You can read the case. Deciding it waits until they release it.')).toBeInTheDocument();
    expect(within(said()).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^(Restrict|No action needed|Something else)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  });

  it('is shown in the queue row too, and only there for a case someone else holds', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const g = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Other', room: 'rb' });
    await w.clientFor('maya@example.test').claimCase(g.person);
    await open(w, f.id);
    const rows = within(queue()).getAllByRole('listitem');
    const beta = rows.find((r) => within(r).queryByText('Beta') !== null)!;
    const mine = rows.find((r) => within(r).queryByText('Mallory') !== null)!;
    expect(within(beta).getByText('maya is on it')).toBeInTheDocument();
    expect(within(mine).queryByText(/is on it/)).toBeNull();
    expect(within(queue()).queryByText('Unclaimed')).toBeNull();
    expect(within(queue()).queryByRole('button', { name: /^Release/ })).toBeNull();
  });

  it('keys do nothing on it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    const { user } = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByText('maya is on it.');
    await user.keyboard('1');
    await user.keyboard('2');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('control: the same keys act on a case nobody else holds (so the test above is not passing for another reason)', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('button', { name: /^No action needed/ });
    await user.keyboard('2');
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });

  it('a senior is offered Take over, and taking over brings the controls', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sen@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    const { user } = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    expect(await screen.findByText('You can read the case. As a senior you can take it over.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ })).toBeInTheDocument();
    expect(w.cw.cases.holder(f.person)?.by).toBe('sen@example.test');
    expect(screen.queryByText(/is on it/)).toBeNull();
    expect(w.cw.audit.list({ limit: 50 }).items.some((r) => r.action === 'case.takeover')).toBe(true);
  });

  it('Take over is offered by the permission, not the role name', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test', permissions: { 'claims.override': 'moderator' } });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    expect(await screen.findByRole('button', { name: 'Take over' })).toBeInTheDocument();
  });

  it('a moderator without the permission is offered none', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByText('maya is on it.');
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  });

  it('nobody else on the case: no claim is shown, yours or free', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    expect(screen.queryByText(/is on it/)).toBeNull();
    expect(screen.queryByText(/You're handling this/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Who is handling this case' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  it('still takes the claim silently, so two people never decide the same person', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    expect(w.sent.some((r) => r.method === 'POST' && r.path === `/cases/${f.person}/claim`)).toBe(true);
  });

  it('leaving the case lets it go', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { router } = await open(w, f.id, { stay: false });
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    act(() => router.navigate('/terms'));
    await waitFor(() => expect(w.cw.cases.holder(f.person)).toBeNull());
  });

  it('a decision refused because someone took the case meanwhile (409 claimed) brings the card back, read-only, with the holder named', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await w.clientFor('maya@example.test', 'senior').claimCase(f.person, { takeOver: true });
    await user.click(primary());
    await pageHides();
    expect(await screen.findByText('maya is on it.')).toBeInTheDocument();
  });
});

describe('when the decision fails', () => {
  it.each([
    [403, 'forbidden', 'Your role cannot do this.'],
    [500, 'internal', 'The server had a problem. Try again in a moment.'],
    [404, 'not_found', 'That no longer exists.'],
    [429, 'rate_limited', 'Too many requests. Try again in a moment.'],
    [400, 'invalid_request', 'The server did not accept this decision. Check the reason, the rules and the lines, then try again.'],
  ] as const)('a %s (%s) is explained in plain words, the card comes back, and Try again is offered', async (status, code, message) => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    w.intercept.fn = (req) => (isDecide(req) ? { status, body: { error: code, message: 'raw server words that must not be shown' } } : undefined);
    await user.click(primary());
    await pageHides();
    const alert = await within(decision()).findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent('raw server words');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(primary()).toBeInTheDocument();
    expect(within(said()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('a dropped connection says so and keeps the card', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    w.intercept.fn = async (req) => {
      if (isDecide(req)) throw new TypeError('Failed to fetch');
      return undefined;
    };
    await user.click(primary());
    await pageHides();
    const alert = await within(decision()).findByRole('alert');
    expect(alert).toHaveTextContent(/Something went wrong|Could not reach the server/);
    expect(primary()).toBeInTheDocument();
  });

  it('Try again sends the same body once more, and the error goes away', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    let fail = true;
    w.intercept.fn = (req) => (isDecide(req) && fail ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(primary());
    await pageHides();
    const alert = await within(decision()).findByRole('alert');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await within(decision()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(2);
    expect(decides(w)[1]!.body).toEqual(decides(w)[0]!.body);
    expect(within(decision()).queryByRole('alert')).toBeNull();
  });

  it('a failed No action needed can be sent again from the card', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    let fail = true;
    w.intercept.fn = (req) => (isDecide(req) && fail ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    await user.click(noAction());
    await pageHides();
    await within(decision()).findByRole('alert');
    fail = false;
    await user.click(noAction());
    await pageHides();
    await within(decision()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[1]!.body).toEqual({ verdict: 'no_action', actions: [] });
  });

  it('someone else decided it first: says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await w.client.decide(f.id, { verdict: 'no_action', reason: 'Already done.', actions: [] });
    await user.click(primary());
    await pageHides();
    expect(await screen.findByText('Someone already decided this report.', { selector: 'div' })).toBeInTheDocument();
  });
});

describe('what is not on the card', () => {
  it('has none of the things the Detailed workbench shows around a case', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await w.clientFor('boss@example.test', 'senior').addReason({ label: 'Spam', text: 'Advertising in chat.' });
    const f = await w.fileRich({ lines: TALK, note: 'Keeps following me.', tags: { mode: 'ranked' }, room: 'lobby-7' });
    const { container } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    // Panes and tabs.
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'People' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Who reported' })).toBeNull();
    // The claim, the viewing line, the facts: room, tags, status, filed.
    expect(screen.queryByRole('group', { name: 'Who is handling this case' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'About this report' })).toBeNull();
    expect(screen.queryByText(/Room lobby-7/)).toBeNull();
    expect(screen.queryByText(/mode: ranked/)).toBeNull();
    expect(screen.queryByText('Keeps following me.')).toBeNull();
    // Person tags.
    expect(container.querySelector('.cw-pid')).toBeNull();
    // Transcript filters and line checkboxes.
    expect(screen.queryByRole('group', { name: 'Show lines from' })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // The editing parts of the bar.
    expect(screen.queryByRole('button', { name: 'Add an action' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Reason' })).toBeNull();
    // The one choice on the card is the rule the report breaks (preselected from what it was reported as).
    expect(screen.queryAllByRole('combobox').map((c) => c.closest('.cw-scard-rule') !== null)).toEqual([true]);
    expect(screen.queryByRole('group', { name: 'Saved reasons' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    // The queue's claim filters and category filter.
    expect(screen.queryByRole('button', { name: 'Unclaimed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mine' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Category/ })).toBeNull();
  });

  it('the saved reasons are not read for Simple, and neither is the blocked list', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(w.sent.filter((r) => r.path === '/reasons')).toHaveLength(0);
    expect(w.sent.filter((r) => /^\/blocked/.test(r.path))).toHaveLength(0);
  });

  it('saved reasons are read once Something else opens the bar', async () => {
    const w = await hubWorld();
    await w.clientFor('boss@example.test', 'senior').addReason({ label: 'Spam', text: 'Advertising in chat.' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(something());
    expect(await within(decision()).findByRole('button', { name: 'Spam' })).toBeInTheDocument();
  });
});

describe('blocked words stay hidden until shown', () => {
  const BLOCKED: RichLine[] = [
    { who: 'reporter', text: 'hi' },
    { who: 'target', text: 'go back to the tutorial' },
    { who: 'target', text: 'you zorbak team' },
    { who: 'bystander', text: 'that vlemmo was uncalled for' },
  ];

  it('masks a blocked line of theirs, and leaves no part of it in the page', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED });
    const { container } = await open(w, f.id);
    expect(within(said()).getAllByText('Blocked words, hidden')).toHaveLength(1);
    expect(container.textContent).not.toContain('zorbak');
  });

  it('Show reveals that one line, Hide hides it again', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED });
    const { user, container } = await open(w, f.id);
    const show = within(said()).getByRole('button', { name: /^Show the blocked words in the line by Mallory at/ });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    await user.click(show);
    expect(within(said()).getByText('you zorbak team')).toBeInTheDocument();
    await user.click(within(said()).getByRole('button', { name: /^Hide the blocked words/ }));
    expect(container.textContent).not.toContain('zorbak');
  });

  it('the whole chat masks the others\' blocked lines too', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED });
    const { user, container } = await open(w, f.id);
    await user.click(within(said()).getByRole('button', { name: /^Show the whole chat/ }));
    expect(within(said()).getAllByText('Blocked words, hidden')).toHaveLength(2);
    expect(container.textContent).not.toContain('vlemmo');
    expect(container.textContent).not.toContain('zorbak');
  });

  it('the blocked words are not in the queue, the suggestion or the one-click body', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED });
    const { user, container } = await open(w, f.id);
    await user.click(primary());
    expect(container.textContent).not.toContain('zorbak');
    await pageHides();
    expect(JSON.stringify(decides(w)[0]!.body)).not.toContain('zorbak');
  });

  it('a revealed line stays revealed after a Back from Something else', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED });
    const { user } = await open(w, f.id);
    await user.click(within(said()).getByRole('button', { name: /^Show the blocked words/ }));
    await user.click(something());
    await user.click(screen.getByRole('button', { name: 'Back to the suggestion' }));
    expect(within(said()).getByText('you zorbak team')).toBeInTheDocument();
  });
});
