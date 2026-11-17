import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiOutcomeInsert } from '@chatwarden/core';
import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import { renderHub } from './render.js';
import { DAY, hubWorld, T0 } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > AI > Advanced > "Where the AI may act" (AI levels 3 and 4, release 1, design 9.2): the gate table. Read-only: it shows each rule and conduct level
// the profile could ever act on, each gate as a tick or a cross with its number against the need, the reach, and the cooling date. Nothing acts in this release and
// nothing on the table changes a number; the hub computes no gate: it shows what the server sent. On the real routes and the real kit.

afterEach(() => cleanup());

type GateStore = MemoryStore & { insertAiOutcome(r: AiOutcomeInsert): boolean };
let seq = 0;
const decision = (rule: number, severity: 'hostile' | 'severe', by: string, decidedAt: number): AiOutcomeInsert => {
  seq += 1;
  return {
    reportId: `hub-g-${seq}`,
    readId: null,
    decidedAt,
    level: 2,
    verdict: 'upheld',
    rule: String(rule),
    severity,
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
    badFaith: false,
    example: null,
    aiRule: String(rule),
    aiSeverity: severity,
    aiConfidence: 'high',
    decidedBy: by,
    source: 'human',
  };
};

/** An owner's world with the AI on over the strict profile (which lets the AI act on hostile and severe), with the casebook in hand. */
async function gatesWorld(o: WorldOptions = {}) {
  const store = withMemoryAi(new MemoryStore()) as GateStore;
  const w = await hubWorld({ role: 'owner', actor: 'owen@example.test', profile: 'strict', ai: { level: 2 }, store, ...o });
  /** `n` clean decisions in cell (rule, hostile) by two moderators across 60 days. */
  const seed = (rule: number, n: number, severity: 'hostile' | 'severe' = 'hostile'): void => {
    for (let i = 0; i < n; i++) store.insertAiOutcome(decision(rule, severity, i % 2 === 0 ? 'mod_a' : 'mod_b', T0 - DAY - Math.floor((i / n) * 58 * DAY)));
  };
  return { w, store, seed };
}

async function openTable(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/ai' });
  await screen.findByRole('heading', { level: 2, name: 'AI' });
  await r.user.click(await screen.findByRole('button', { name: 'Advanced' }));
  await screen.findByRole('heading', { name: 'Where the AI may act' });
  return r;
}
const table = async (): Promise<HTMLElement> => screen.findByRole('table', { name: 'Gates for each rule and conduct level' });
const rowOf = async (name: RegExp): Promise<HTMLElement> => within(await table()).getByRole('row', { name });
/** The parts of a cell these tests rewrite. */
interface Cell {
  rule: number;
  level: string;
  open: boolean;
  excluded: boolean;
  coolingUntil: number | null;
  coolingCode: string | null;
  checks: Array<{ ok: boolean; name?: string; value?: number | null; need?: string }>;
}
/** The hostile cell of a rule in a (parsed) answer; a test that asks for one that is not there fails. */
const cellOf = (b: { cells: Cell[] }, rule: number): Cell => {
  const c = b.cells.find((x) => x.rule === rule && x.level === 'hostile');
  if (c === undefined) throw new Error(`no cell for rule ${rule}`);
  return c;
};
/** Rewrites the real answer of GET /ai/gates. */
function gates(w: HubWorld, change: (body: { cells: Cell[] }) => void): void {
  w.intercept.fn = async (req) => {
    if (req.method !== 'GET' || req.path !== '/ai/gates') return undefined;
    const res = await w.raw({ method: 'GET', path: req.path });
    const body = JSON.parse(JSON.stringify(res.body)) as { cells: Cell[] };
    change(body);
    return { ...res, body };
  };
}

describe('the gate table', () => {
  it('Advanced shows one row per cell with each gate as a tick or a cross and the number against the need', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    await openTable(w);
    const view = await w.client.aiGates();
    const cells = view.cells.filter((c) => c.reach[0]?.withinCeilings === true);
    expect(cells.length).toBeGreaterThan(1);
    const rows = within(await table()).getAllByRole('row');
    // the header row and one row per cell the AI could ever act on
    expect(rows).toHaveLength(1 + cells.length);
    const row = await rowOf(/^Rule 2, Hostile/);
    const cols = within(row).getAllByRole('cell');
    // status, then eight gates
    expect(cols).toHaveLength(1 + 8);
    // the numbers are met, but without appeals no cell opens
    expect(within(row).getByText('Not yet')).toBeInTheDocument();
    // volume: 150 of 100, met
    expect(cols[1]).toHaveTextContent('Met');
    expect(cols[1]).toHaveTextContent('150 of 100 decisions');
    // breadth: two moderators over 14 days
    expect(cols[2]).toHaveTextContent('Met');
    expect(cols[2]).toHaveTextContent('2 moderators, needs 2 over 14 days');
    // agreement: the lower bound against 90%
    expect(cols[3]).toHaveTextContent('Met');
    expect(cols[3]).toHaveTextContent(/Met 97.5%, needs at least 90%/);
    expect(cols[4]).toHaveTextContent('needs at most 5%');
    // a cell with no decisions: crosses and the numbers it has
    const empty = await rowOf(/^Rule 3, Hostile/);
    expect(within(empty).getByText('Not yet')).toBeInTheDocument();
    expect(within(empty).getAllByText('Not met').length).toBeGreaterThan(0);
    expect(within(empty).getAllByRole('cell')[1]).toHaveTextContent('0 of 100 decisions');
  });

  it('the ticks have text alternatives: a mark that is hidden from a reader and a word that is not', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    await openTable(w);
    const row = await rowOf(/^Rule 2, Hostile/);
    const cell = within(row).getAllByRole('cell')[1] as HTMLElement;
    expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe('\u2713');
    expect(within(cell).getByText('Met')).toBeInTheDocument();
    const empty = await rowOf(/^Rule 3, Hostile/);
    expect((within(empty).getAllByRole('cell')[1] as HTMLElement).querySelector('[aria-hidden="true"]')?.textContent).toBe('\u2717');
  });

  it('cells that can never act are collapsed with the reason in words', async () => {
    const { w } = await gatesWorld();
    const r = await openTable(w);
    const view = await w.client.aiGates();
    const never = view.cells.filter((c) => c.reach[0]?.withinCeilings !== true);
    expect(never.length).toBeGreaterThan(0);
    // no row for them in the table
    expect(within(await table()).queryByRole('row', { name: /Severe/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: `Never acted on by the AI (${never.length})` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await r.user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Never acted on by the AI' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(never.length);
    expect(list).toHaveTextContent(/more than the AI will ever do/);
    expect(list).toHaveTextContent(/Rule \d+, Severe/);
  });

  it('a cell with a cooling date shows it, and why', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    const until = T0 + 9 * DAY;
    gates(w, (b) => {
      const c = cellOf(b, 2);
      c.coolingUntil = until;
      c.coolingCode = 'not_a_violation';
      c.open = false;
    });
    await openTable(w);
    const row = await rowOf(/^Rule 2, Hostile/);
    expect(within(row).getByText(/Paused until/)).toBeInTheDocument();
    expect(row).toHaveTextContent('an action was undone as not a violation');
    expect(within(row).getByText('Not yet')).toBeInTheDocument();
    gates(w, (b) => {
      const c = cellOf(b, 2);
      c.coolingUntil = until;
      c.coolingCode = 'appeal_revoked';
    });
    cleanup();
    await openTable(w);
    expect(await rowOf(/^Rule 2, Hostile/)).toHaveTextContent('an action was revoked on appeal');
  });

  // Review R1 final M4: the keep gate's number is the Wilson LOWER bound of the undo rate, not the rate; the row must not read like "5.2% were undone".
  describe('the keep gate says what its number is', () => {
    const keep = (value: number | null, ok: boolean) => (b: { cells: Cell[] }): void => {
      const k = cellOf(b, 2).checks.find((c) => c.name === 'keep');
      if (k === undefined) throw new Error('no keep check');
      k.value = value;
      k.ok = ok;
      k.need = 'lower<=0.05;pair>14d';
    };
    const keepCell = async (): Promise<HTMLElement> => within(await rowOf(/^Rule 2, Hostile/)).getAllByRole('cell')[8] as HTMLElement;

    it('a lower bound over the cut reads as "likely above", with the bound named, and never as "needs at most"', async () => {
      const { w, seed } = await gatesWorld();
      seed(2, 150);
      gates(w, keep(0.052, false));
      await openTable(w);
      const cell = await keepCell();
      expect(cell).toHaveTextContent('Undo rate is likely above 5% (lower bound 5.2%)');
      expect(cell).not.toHaveTextContent('needs at most');
    });

    it('a lower bound within the cut reads as within it, with the bound named', async () => {
      const { w, seed } = await gatesWorld();
      seed(2, 150);
      gates(w, keep(0.028, true));
      await openTable(w);
      const cell = await keepCell();
      expect(cell).toHaveTextContent('Undo rate is within 5% (lower bound 2.8%)');
      expect(cell).not.toHaveTextContent('needs at most');
    });

    it('a lower bound exactly at the cut is within it (the gate passes "at most")', async () => {
      const { w, seed } = await gatesWorld();
      seed(2, 150);
      gates(w, keep(0.05, true));
      await openTable(w);
      expect(await keepCell()).toHaveTextContent('Undo rate is within 5% (lower bound 5%)');
    });

    it('with too few reviewed actions it still says it applies once enough are reviewed', async () => {
      const { w, seed } = await gatesWorld();
      seed(2, 150);
      gates(w, keep(null, true));
      await openTable(w);
      expect(await keepCell()).toHaveTextContent('Applies once enough of its actions are reviewed');
    });

    it('the override gate keeps its own wording (the keep words do not leak into it)', async () => {
      const { w, seed } = await gatesWorld();
      seed(2, 150);
      await openTable(w);
      const cols = within(await rowOf(/^Rule 2, Hostile/)).getAllByRole('cell');
      expect(cols[4]).toHaveTextContent('needs at most 5%');
      expect(cols[4]).not.toHaveTextContent('Undo rate');
    });
  });

  it('R1 shows "Acting is not available in this version" and offers no Act option', async () => {
    const { w } = await gatesWorld();
    await openTable(w);
    expect(screen.getByText('Acting is not available in this version.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^Act/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Act|Start acting|Allow the AI to act|Turn on acting)/i })).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('with no appeals the appeals checks read "not available"', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    await openTable(w);
    const row = await rowOf(/^Rule 2, Hostile/);
    const cols = within(row).getAllByRole('cell');
    expect(cols[6]).toHaveTextContent('Not available');
    expect(cols[6]).toHaveTextContent('Not met');
    expect(cols[7]).toHaveTextContent('Not available');
    // so no cell can open without appeals: its status is "Not yet", and the page says why in one line
    expect(within(row).getByText('Not yet')).toBeInTheDocument();
    expect(screen.getByText(/Appeals are off, so no cell can open/)).toBeInTheDocument();
  });

  it('the hub computes no gate: a response with ok false is rendered as sent, and so is one with ok true', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    gates(w, (b) => {
      const c = cellOf(b, 2);
      for (const k of c.checks) k.ok = false;
      c.open = true; // the server said so: the hub does not recompute it from the checks
      const other = cellOf(b, 3);
      for (const k of other.checks) k.ok = true;
      other.open = false;
    });
    await openTable(w);
    const row = await rowOf(/^Rule 2, Hostile/);
    expect(within(row).getByText('Gates met')).toBeInTheDocument();
    expect(within(row).getAllByText('Not met')).toHaveLength(8);
    const other = await rowOf(/^Rule 3, Hostile/);
    expect(within(other).getByText('Not yet')).toBeInTheDocument();
    expect(within(other).getAllByText('Met')).toHaveLength(8);
  });

  it('an excluded rule is shown as left to people and never as met', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    gates(w, (b) => {
      const c = cellOf(b, 2);
      c.excluded = true;
      c.open = false;
    });
    await openTable(w);
    const row = await rowOf(/^Rule 2, Hostile/);
    expect(within(row).getByText('Left to people')).toBeInTheDocument();
    expect(within(row).queryByText('Gates met')).toBeNull();
  });

  it('the reach is shown in words: what the ladder gives for a clean record', async () => {
    const { w } = await gatesWorld();
    await openTable(w);
    const view = await w.client.aiGates();
    const cell = view.cells.find((c) => c.reach[0]?.withinCeilings === true);
    const label = cell?.reach[0]?.step?.label ?? '';
    expect(label).not.toBe('');
    const row = within(await table()).getAllByRole('row')[1] as HTMLElement;
    expect(row).toHaveTextContent(`For a clean record: ${label}`);
  });
});

describe('the table is read-only and is behind Advanced', () => {
  it('the table is read-only: no control changes a number, and opening it sends one GET', async () => {
    const { w, seed } = await gatesWorld();
    seed(2, 150);
    await openTable(w);
    const section = screen.getByRole('heading', { name: 'Where the AI may act' }).closest('section, div') as HTMLElement;
    const region = within(await table()).getByRole('row', { name: /^Rule 2, Hostile/ }).closest('table') as HTMLElement;
    expect(region.querySelectorAll('input, select, textarea, button, [contenteditable], [role="slider"], [role="spinbutton"]')).toHaveLength(0);
    expect(section).toBeTruthy();
    const gatesCalls = w.sent.filter((r) => r.path === '/ai/gates');
    expect(gatesCalls).toHaveLength(1);
    expect(gatesCalls[0]?.method).toBe('GET');
    // nothing was written by looking
    expect(w.sent.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('is not asked for until Advanced is opened', async () => {
    const { w } = await gatesWorld();
    renderHub(w, { path: '/settings/ai' });
    await screen.findByRole('heading', { level: 2, name: 'AI' });
    await screen.findByRole('button', { name: 'Advanced' });
    expect(w.sent.filter((r) => r.path === '/ai/gates')).toEqual([]);
    expect(screen.queryByText('Where the AI may act')).toBeNull();
  });

  it('nothing is added to Simple mode or to the case card', async () => {
    const { w } = await gatesWorld();
    const f = await w.file();
    for (const mode of ['simple', 'detailed'] as const) {
      const r = renderHub(w, { path: `/reports/${f.id}`, mode });
      await screen.findAllByRole('heading', { level: 2 });
      expect(screen.queryByText('Where the AI may act')).toBeNull();
      expect(screen.queryByText(/Acting is not available/)).toBeNull();
      r.unmount();
    }
    expect(w.sent.filter((r) => r.path === '/ai/gates')).toEqual([]);
  });

  it('with the AI off, or no cell to show, it says so in one line', async () => {
    const { w } = await gatesWorld({ ai: { level: 0 } });
    await openTable(w);
    expect(screen.getByText(/Nothing to show yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Gates for each rule and conduct level' })).toBeNull();
  });

  it('an older server without the route says so, and the rest of Advanced still works', async () => {
    const { w } = await gatesWorld();
    w.intercept.fn = (req) => (req.path === '/ai/gates' ? { status: 404, headers: {}, body: { error: 'not_found', message: 'Not found.' } } : undefined);
    await openTable(w);
    expect(await screen.findByText('This server does not have the gate view yet.')).toBeInTheDocument();
    expect(screen.getByText('Learn from our decisions')).toBeInTheDocument();
  });

  it('a failing read shows the usual error with a retry', async () => {
    const { w } = await gatesWorld();
    let fail = true;
    w.intercept.fn = (req) => (fail && req.path === '/ai/gates' ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    const r = await openTable(w);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    await r.user.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(await table()).toBeInTheDocument();
  });

  it('a moderator without policy.read has no AI settings, so no gate table', async () => {
    const { w } = await gatesWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
    renderHub(w, { path: '/settings/ai' });
    await screen.findAllByRole('heading', { level: 2 });
    expect(screen.queryByText('Where the AI may act')).toBeNull();
    expect(w.sent.filter((r) => r.path === '/ai/gates')).toEqual([]);
  });
});
