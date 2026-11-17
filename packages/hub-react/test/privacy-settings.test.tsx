import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "Privacy requests": a find box by account id that opens the person's page, and the statement table (categories with the retention in days). The
// owner's panel: nobody else is offered it. The kit never verifies a requester, and the panel says so.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Privacy requests' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Privacy requests' });

describe('who is offered the panel', () => {
  it('the owner is; a senior and a moderator are not, and no privacy request is made for them', async () => {
    const o = await owner();
    await open(o);
    expect(within(panel()).getByText(/You check who is asking first/)).toBeInTheDocument();
    cleanup();
    for (const role of ['moderator', 'senior'] as const) {
      const w = await hubWorld({ role });
      renderHub(w, { path: '/settings/advanced' });
      await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
      expect(screen.queryByRole('region', { name: 'Privacy requests' }), role).toBeNull();
      expect(w.sent.filter((r) => /privacy/.test(r.path)), role).toEqual([]);
      cleanup();
    }
  });
});

describe('find a person by account id', () => {
  it('a known account id opens that person\'s page', async () => {
    const w = await owner();
    w.cw.rooms.seat('room-find', 'p1', { clientKey: 'key-find-person', accountId: 'acct-find-0001' }, 'Finder');
    await w.cw.flush();
    const person = w.cw.rooms.subjectAt('room-find', 'p1') as string;
    const { user, router } = await open(w);
    await user.type(within(panel()).getByRole('textbox', { name: 'Account id' }), 'acct-find-0001');
    await user.click(within(panel()).getByRole('button', { name: 'Find person' }));
    await waitFor(() => expect(router.path).toBe(`/people/${person}`));
    const finds = w.sent.filter((r) => r.path === '/privacy/find');
    expect(finds).toHaveLength(1);
    expect(finds[0]?.body).toEqual({ accountId: 'acct-find-0001' });
  });

  it('an unknown account id says so, stays on the page, and creates nothing', async () => {
    const w = await owner();
    const before = (await w.store.loadSubjects()).subjects.length;
    const { user, router } = await open(w);
    await user.type(within(panel()).getByRole('textbox', { name: 'Account id' }), 'acct-nobody');
    await user.click(within(panel()).getByRole('button', { name: 'Find person' }));
    expect(await within(panel()).findByText('No person has this account id. Nothing was created.')).toBeInTheDocument();
    expect(router.path).toBe('/settings/advanced');
    await w.cw.flush();
    expect((await w.store.loadSubjects()).subjects.length).toBe(before);
  });

  it('an empty box sends nothing; a failure says so in words', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Find person' }));
    expect(w.sent.filter((r) => r.path === '/privacy/find')).toEqual([]);
    w.intercept.fn = (req) => (req.path === '/privacy/find' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.type(within(panel()).getByRole('textbox', { name: 'Account id' }), 'acct-x');
    await user.click(within(panel()).getByRole('button', { name: 'Find person' }));
    expect(await within(panel()).findByText(/Could not look up the account id\./)).toBeInTheDocument();
  });

  it('the account id is not echoed anywhere after a lookup, and the audit row names no account id', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(within(panel()).getByRole('textbox', { name: 'Account id' }), 'acct-secret-9999');
    await user.click(within(panel()).getByRole('button', { name: 'Find person' }));
    await within(panel()).findByText('No person has this account id. Nothing was created.');
    expect(JSON.stringify(w.cw.audit.list({ limit: 50 }).items)).not.toContain('acct-secret-9999');
    expect(w.cw.audit.list({ limit: 50 }).items.some((a) => a.action === 'privacy.find')).toBe(true);
  });
});

describe('the statement table lists categories with retention in days', () => {
  it('has a header row, a row for each category with the kit\'s words, and the live retention in days', async () => {
    const w = await owner();
    await open(w);
    const table = await within(panel()).findByRole('table');
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['What', 'In an export', 'Erase, keeping what a ban needs', 'Erase, keeping nothing', 'Kept for']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBe(w.cw.privacy.statement().categories.length);
    const strikes = within(table).getByRole('row', { name: /Blocked lines/ });
    expect(within(strikes).getByText('30 days')).toBeInTheDocument();
    const holds = within(table).getByRole('row', { name: /Legal holds/ });
    expect(within(holds).getByText('Until removed')).toBeInTheDocument();
    expect(panel()).toHaveTextContent('not legal advice');
  });

  it('follows the retention in force', async () => {
    const w = await owner({ signalsMs: 20 * 86_400_000 });
    await open(w);
    const table = await within(panel()).findByRole('table');
    expect(within(within(table).getByRole('row', { name: /Signals/ })).getByText('20 days')).toBeInTheDocument();
  });

  it('draws no id, hash or secret, and one request reads it (never polled)', async () => {
    const w = await owner();
    await open(w);
    await within(panel()).findByRole('table');
    expect(panel().textContent ?? '').not.toContain('hub-react-test-secret');
    expect(w.sent.filter((r) => r.path === '/privacy/statement')).toHaveLength(1);
  });
});
