import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { actWorld } from './aiActWorld.js';
import { renderHub } from './render.js';
import type { HubWorld } from './world.js';

// Settings > AI > Advanced > "Would have acted" (AI levels 3 and 4, release 2, design 9.1 and 9.2): what the AI would have applied, read by the owner before acting can
// start. A plain list on the real routes and the real kit, over real shadow rows. Nothing here has a button that changes anything, and there is no export.

afterEach(() => cleanup());

async function openAdvanced(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/ai' });
  await screen.findByRole('heading', { level: 2, name: 'AI' });
  await r.user.click(await screen.findByRole('button', { name: 'Advanced' }));
  return r;
}
const list = async (): Promise<HTMLElement> => screen.findByRole('table', { name: 'Would have acted' });

/** An owner's world in shadow with `n` filed reports, each with a "would have applied" row. */
async function seeded(n: number, over: Parameters<typeof actWorld>[0] = {}) {
  const world = await actWorld(over);
  world.startShadow();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const f = await world.w.file({ target: `Target${i}`, reporter: `Reporter${i}` });
    ids.push(f.id);
    world.shadowRow(f.id, i % 2 === 0 ? {} : { rule: '3', severity: 'severe', kind: 'warning', durationMs: null });
  }
  return { ...world, ids };
}

describe('"would have acted"', () => {
  it('shows each row as "would have applied" with the step, the rule and level, the person and when, and no buttons', async () => {
    const { w } = await seeded(2);
    await openAdvanced(w);
    const table = await list();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(1 + 2);
    // newest first: the second report filed is the first row
    const first = rows[1] as HTMLElement;
    const second = rows[2] as HTMLElement;
    expect(first).toHaveTextContent('Would have applied');
    expect(first).toHaveTextContent('Warning');
    expect(first).toHaveTextContent('Rule 3, Severe');
    expect(second).toHaveTextContent('Would have applied: Chat restriction, 24 hours');
    expect(second).toHaveTextContent('Rule 2, Hostile');
    // the person as the usual short tag, never a name or a ref
    expect(within(first).getByText(/^\S{1,8}$/, { selector: '.cw-pid' })).toBeInTheDocument();
    // no buttons in any row: nothing here can change anything
    for (const row of rows) expect(within(row).queryAllByRole('button')).toHaveLength(0);
    // a plain link to the case, nothing else
    expect(within(first).getByRole('link', { name: /Open the case/ })).toBeInTheDocument();
  });

  it('says in words that nothing was sent to the player', async () => {
    const { w } = await seeded(1);
    await openAdvanced(w);
    await list();
    expect(screen.getByText(/Nothing was sent to a player/)).toBeInTheDocument();
  });

  it('is read newest first, as the server sent it, with the exact time of each', async () => {
    const { w } = await seeded(3);
    await openAdvanced(w);
    const view = (await w.client.aiActions({ state: 'shadow' })) as { items: Array<{ actionId: string; actedAt: number }> };
    expect(view.items.map((i) => i.actedAt)).toEqual([...view.items.map((i) => i.actedAt)].sort((a, b) => b - a));
    const rows = within(await list()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.querySelector('time')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('has no export and no download: no download link, no export or download word', async () => {
    const { w } = await seeded(2);
    await openAdvanced(w);
    await list();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(screen.queryByRole('button', { name: /export|download|csv/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /export|download|csv/i })).toBeNull();
  });

  it('is not loaded until Advanced is opened, and adds nothing to the page before', async () => {
    const { w } = await seeded(1);
    const r = renderHub(w, { path: '/settings/ai' });
    await screen.findByRole('heading', { level: 2, name: 'AI' });
    await screen.findByText(/^Shadow since /);
    expect(w.sent.filter((s) => s.path === '/ai/actions')).toHaveLength(0);
    expect(screen.queryByRole('table', { name: 'Would have acted' })).toBeNull();
    await r.user.click(await screen.findByRole('button', { name: 'Advanced' }));
    await list();
    expect(w.sent.filter((s) => s.path === '/ai/actions')).toHaveLength(1);
  });

  it('adds no control and no badge to the Cases queue or the shell', async () => {
    const { w } = await seeded(2);
    renderHub(w, { path: '/reports' });
    await screen.findByRole('heading', { level: 2, name: 'Reports' });
    expect(screen.queryByText(/would have/i)).toBeNull();
    expect(screen.queryByText(/AI actions? to review/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /shadow|acting/i })).toBeNull();
  });

  it('with no rows yet says so, and says what to expect', async () => {
    const { w } = await seeded(0);
    await openAdvanced(w);
    expect(await screen.findByText('Nothing yet. A row appears here when the AI reads a report and finds a step it would have applied.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Would have acted' })).toBeNull();
  });

  it('shows the total the server counted beside the list, not a count the hub made', async () => {
    const { w } = await seeded(3);
    await openAdvanced(w);
    await list();
    const state = w.cw.ai.acting.state();
    expect(state.shadowWouldHaveActed).toBe(3);
    expect(screen.getByText(/would have acted 3 times/)).toBeInTheDocument();
  });

  it('pages with "Show more", sending the cursor the server gave', async () => {
    const { w } = await seeded(3);
    const real = w.intercept.fn;
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/ai/actions') {
        const res = await w.raw({ method: 'GET', path: req.path, query: { ...req.query, limit: '2' } });
        return res;
      }
      return real?.(req);
    };
    const { user } = await openAdvanced(w);
    expect(within(await list()).getAllByRole('row')).toHaveLength(1 + 2);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Would have acted' })).getAllByRole('row')).toHaveLength(1 + 3));
    const asked = w.sent.filter((s) => s.path === '/ai/actions');
    expect(asked).toHaveLength(2);
    expect(asked[0]?.query?.cursor).toBeUndefined();
    expect(typeof asked[1]?.query?.cursor).toBe('string');
    // the last page has no "Show more"
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('asks only for shadow rows', async () => {
    const { w } = await seeded(1);
    await openAdvanced(w);
    await list();
    expect(w.sent.find((s) => s.path === '/ai/actions')?.query?.state).toBe('shadow');
  });

  it('a person without ai.review sees why, and no request is made', async () => {
    const { w } = await seeded(1, { permissions: { 'ai.review': 'owner' }, role: 'moderator', actor: 'mia@example.test' });
    await openAdvanced(w);
    expect(await screen.findByText('Reading this list needs the review permission.')).toBeInTheDocument();
    expect(w.sent.filter((s) => s.path === '/ai/actions')).toHaveLength(0);
  });

  it('a failed read is shown with a way to try again, not as an empty list', async () => {
    const { w } = await seeded(1);
    w.intercept.fn = async (req) => (req.method === 'GET' && req.path === '/ai/actions' ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    await openAdvanced(w);
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Nothing yet/)).toBeNull();
  });

  it('is absent when the code does not allow acting and nothing was ever recorded', async () => {
    const { w } = await actWorld({ maxLevel: 2 });
    await openAdvanced(w);
    await screen.findByRole('heading', { name: 'Where the AI may act' });
    expect(screen.queryByRole('heading', { name: 'Would have acted' })).toBeNull();
    expect(w.sent.filter((s) => s.path === '/ai/actions')).toHaveLength(0);
  });

  it('is absent on a server from before 0.1.14', async () => {
    const { w } = await seeded(1);
    w.intercept.fn = async (req) => (req.path === '/ai/acting' || req.path === '/ai/actions' ? { status: 404, headers: {}, body: { error: 'not_found', message: 'x' } } : undefined);
    await openAdvanced(w);
    await screen.findByRole('heading', { name: 'Where the AI may act' });
    expect(screen.queryByRole('heading', { name: 'Would have acted' })).toBeNull();
  });

  it('the gate table no longer says acting is not available, and says nothing is applied in this version', async () => {
    const { w } = await seeded(0);
    await openAdvanced(w);
    await screen.findByRole('heading', { name: 'Where the AI may act' });
    expect(screen.queryByText('Acting is not available in this version.')).toBeNull();
    expect(screen.getAllByText(/In this version the AI applies nothing to a player/).length).toBeGreaterThan(0);
  });
});
