import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_TO_RULE } from '@chatwarden/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '../src/types.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The shell around the Simple card: the menu (Cases, Words, Blocked, More), the queue beside the card, the keys, what a case
// costs in audited reads, and the card's accessibility and layout.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const RULE = CATEGORY_TO_RULE.harassment as number;
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const sections = (): HTMLElement => screen.getByRole('navigation', { name: 'Moderator hub sections' });
const queue = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

const MORE: ReadonlyArray<[string, PermissionKey, string]> = [
  ['Recent actions', 'history.read', '/actions'],
  ['Audit', 'audit.read', '/audit'],
  ['Rule gaps', 'gaps.read', '/gaps'],
  ['Guide', 'policy.read', '/guide'],
];

describe('the menu: Cases, Words, Blocked and More', () => {
  it('lists exactly those four, in that order, and nothing of the Detailed rail', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    const nav = sections();
    const names = [...nav.querySelectorAll('a, button')].map((el) => el.textContent?.trim());
    expect(names).toEqual(['Cases', 'Words', 'Blocked', 'More']);
    for (const gone of ['Overview', 'Reports', 'Terms', 'Rule gaps', 'Audit', 'Guide']) expect(within(nav).queryByRole('link', { name: gone })).toBeNull();
  });

  it('Cases, Words and Blocked are links to the queue, Terms and Blocked', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { router, user } = renderHub(w, { mode: 'simple', path: '/terms' });
    await screen.findByRole('heading', { level: 2, name: /^Terms in English|Terms/ });
    expect(within(sections()).getByRole('link', { name: 'Words' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(sections()).getByRole('link', { name: 'Blocked' }));
    expect(router.path).toBe('/blocked');
    expect(within(sections()).getByRole('link', { name: 'Blocked' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(sections()).getByRole('link', { name: 'Cases' }));
    expect(router.path).toBe('/');
    expect(within(sections()).getByRole('link', { name: 'Cases' })).toHaveAttribute('aria-current', 'page');
  });

  it('Cases stays current on an open case', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    expect(within(sections()).getByRole('link', { name: 'Cases' })).toHaveAttribute('aria-current', 'page');
  });

  it('More is a menu of Recent actions, Audit, Rule gaps and Guide, closed until opened', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    const more = within(sections()).getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(within(sections()).queryByRole('link', { name: 'Audit' })).toBeNull();
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect([...sections().querySelectorAll('.cw-snav-menu a')].map((a) => a.textContent)).toEqual(['Recent actions', 'Audit', 'Rule gaps', 'Guide']);
  });

  it.each(MORE)('%s opens its screen from More, and More closes', async (name, _permission, path) => {
    const w = await hubWorld({ role: 'owner' });
    const { user, router } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    await user.click(within(sections()).getByRole('button', { name: 'More' }));
    await user.click(within(sections()).getByRole('link', { name }));
    expect(router.path).toBe(path);
    expect(within(sections()).getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
    // More is the current section while one of its screens is open.
    expect(within(sections()).getByRole('button', { name: 'More' })).toHaveAttribute('data-current', 'true');
  });

  it('Escape closes More and returns focus to its button', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    const more = within(sections()).getByRole('button', { name: 'More' });
    await user.click(more);
    await user.keyboard('{Escape}');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
  });

  it('a click elsewhere closes More', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    const more = within(sections()).getByRole('button', { name: 'More' });
    await user.click(more);
    await user.click(screen.getByRole('main'));
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('More is not current on Cases', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(within(sections()).getByRole('button', { name: 'More' })).not.toHaveAttribute('data-current');
  });

  describe.each(['moderator', 'senior', 'owner'] as const)('as a %s', (role) => {
    it('offers what the role can open, by permission, and nothing else', async () => {
      const w = await hubWorld({ role });
      const me = await w.client.me();
      const { user } = renderHub(w, { mode: 'simple' });
      await screen.findByRole('region', { name: 'Open cases' });
      await user.click(within(sections()).getByRole('button', { name: 'More' }));
      for (const [name, permission] of MORE) {
        if (me.can[permission]) expect(within(sections()).getByRole('link', { name })).toBeInTheDocument();
        else expect(within(sections()).queryByRole('link', { name })).toBeNull();
      }
      expect(within(sections()).getByRole('link', { name: 'Words' })).toBeInTheDocument();
      expect(within(sections()).getByRole('link', { name: 'Blocked' })).toBeInTheDocument();
    });
  });

  it('a moderator has no Audit (senior only) and a senior has it', async () => {
    const mod = await hubWorld({ role: 'moderator' });
    const a = renderHub(mod, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    await a.user.click(within(sections()).getByRole('button', { name: 'More' }));
    expect(within(sections()).queryByRole('link', { name: 'Audit' })).toBeNull();
    expect(within(sections()).getByRole('link', { name: 'Guide' })).toBeInTheDocument();
    a.unmount();
    const sen = await hubWorld({ role: 'senior' });
    const b = renderHub(sen, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    await b.user.click(within(sections()).getByRole('button', { name: 'More' }));
    expect(within(sections()).getByRole('link', { name: 'Audit' })).toBeInTheDocument();
  });

  it('a link is gated by its permission when the adopter moves it', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'gaps.read': 'owner', 'terms.read': 'owner', 'blocked.read': 'owner' } });
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(within(sections()).queryByRole('link', { name: 'Words' })).toBeNull();
    expect(within(sections()).queryByRole('link', { name: 'Blocked' })).toBeNull();
    await user.click(within(sections()).getByRole('button', { name: 'More' }));
    expect(within(sections()).queryByRole('link', { name: 'Rule gaps' })).toBeNull();
    expect(within(sections()).getByRole('link', { name: 'Guide' })).toBeInTheDocument();
  });

  it('with nothing to put under More there is no More', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'history.read': 'owner', 'gaps.read': 'owner', 'policy.read': 'owner', 'audit.read': 'owner' } });
    renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(within(sections()).queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('a role that cannot read reports still has Cases (the team view), Words and Blocked', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    const { container } = renderHub(w, { mode: 'simple' });
    await waitFor(() => expect(container.querySelector('.cw-body')).not.toBeNull());
    expect(await within(sections()).findByRole('link', { name: 'Cases' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Open cases' })).toBeNull();
  });
});

describe('every route works in Simple', () => {
  it.each([
    ['/reports', 'Reports'],
    ['/terms', /^Terms/],
    ['/blocked', /^Blocked/],
    ['/gaps', 'Rule gaps'],
    ['/audit', 'Audit'],
    ['/guide', 'Guide'],
    ['/actions', 'All actions'],
  ] as const)('%s opens its own screen', async (path, name) => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { mode: 'simple', path });
    expect(await screen.findByRole('heading', { level: 2, name })).toBeInTheDocument();
  });

  it('a person page opens', async () => {
    const w = await hubWorld({ role: 'owner' });
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple', path: `/people/${f.person}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'Mallory' })).toBeInTheDocument();
  });

  it('a path that is no screen says so', async () => {
    const w = await hubWorld();
    renderHub(w, { mode: 'simple', path: '/nope' });
    expect(await screen.findByRole('heading', { name: 'That page does not exist' })).toBeInTheDocument();
  });

  it('the command bar still reaches Overview and Reports', async () => {
    const w = await hubWorld();
    const { user, router } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'Reports');
    await user.keyboard('{Enter}');
    expect(router.path).toBe('/reports');
  });

  it('the landing is a calm Cases screen, not the dense team view, and says what to do', async () => {
    const w = await hubWorld();
    await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Cases' })).toBeInTheDocument();
    expect(await screen.findByText('1 person is waiting for a decision.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Team' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'At a glance' })).toBeNull();
  });

  it('with nothing waiting it says so', async () => {
    const w = await hubWorld();
    renderHub(w, { mode: 'simple' });
    expect(await screen.findByText('Nothing is waiting. You are all caught up.')).toBeInTheDocument();
  });
});

describe('the queue beside the card', () => {
  it('is the list: name, categories, how many reports, how long it has waited, and the open one marked', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, target: 'Mallory', category: 'hate', reporter: 'Saffron', room: 'ra' });
    w.clock.t += 2 * 86_400_000;
    await w.fileRich({ lines: TALK, target: 'Beta', category: 'spam', reporter: 'Rae', room: 'rb' });
    const { container } = renderHub(w, { mode: 'simple', path: `/reports/${a.id}` });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    const rows = within(queue()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const mallory = rows.find((r) => within(r).queryByText('Mallory') !== null)!;
    expect(within(mallory).getByText('Hate')).toBeInTheDocument();
    expect(within(mallory).getByRole('link')).toHaveAttribute('aria-current', 'true');
    expect(mallory).toHaveAttribute('data-wait', 'overdue');
    expect(container.querySelector('.cw-queue .cw-pid')).toBeNull();
  });

  it('keeps Take next case, and hides the claim and category filters', async () => {
    const w = await hubWorld();
    await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple' });
    await within(await screen.findByRole('region', { name: 'Open cases' })).findByText('Mallory');
    expect(within(queue()).getByRole('button', { name: /^Take next case/ })).toBeInTheDocument();
    expect(within(queue()).queryByRole('group', { name: /Claim|Show/ })).toBeNull();
    expect(within(queue()).queryByRole('combobox')).toBeNull();
  });

  it('shows who is viewing nobody, and no team faces in the top bar', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    expect(screen.queryByRole('list', { name: 'On now' })).toBeNull();
  });

  it('opening another row opens its card, and leaving the first lets it go', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'R1', room: 'ra' });
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'R2', room: 'rb' });
    const { user } = renderHub(w, { mode: 'simple', path: `/reports/${a.id}` });
    await screen.findByRole('heading', { level: 2, name: 'Alpha' });
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    await user.click(within(queue()).getByRole('link', { name: /Beta/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Beta' })).toBeInTheDocument();
    await waitFor(() => expect(w.cw.cases.holder(a.person)).toBeNull());
    expect(b.id).not.toBe(a.id);
  });
});

describe('the keys', () => {
  const press = async (user: ReturnType<typeof renderHub>['user'], keys: string): Promise<void> => {
    await user.keyboard(keys);
  };

  it('1 sends the primary button\'s decision (after the hold)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    await press(user, '1');
    expect(decides(w)).toHaveLength(0);
    expect(await screen.findByText('Decision queued.')).toBeInTheDocument();
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'upheld', actions: [{ kind: 'chat', durationMs: 86_400_000, rule: RULE }] });
  });

  it('2 is No action needed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^No action needed/ });
    await press(user, '2');
    await pageHides();
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', reason: 'No rule was broken', actions: [] });
  });

  it('Ctrl+Enter is the primary button and then the next case', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const g = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Other', room: 'rb' });
    const { user, router } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    await press(user, '{Control>}{Enter}{/Control}');
    await waitFor(() => expect(router.path).toBe(`/reports/${g.id}`));
    expect(await screen.findByRole('heading', { level: 2, name: 'Beta' })).toBeInTheDocument();
    await pageHides();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'upheld' });
  });

  it('Cmd+Enter does the same', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const g = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Other', room: 'rb' });
    const { user, router } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    await press(user, '{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(router.path).toBe(`/reports/${g.id}`));
  });

  it('the keys are shown on the buttons, and named for assistive technology', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    const one = await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    expect(one).toHaveAttribute('aria-keyshortcuts', '1');
    expect(screen.getByRole('button', { name: /^No action needed/ })).toHaveAttribute('aria-keyshortcuts', '2');
  });

  it('with shortcuts off, no key does anything and no key is advertised', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: 'simple', shortcuts: false, path: `/reports/${f.id}` });
    const one = await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    expect(one).not.toHaveAttribute('aria-keyshortcuts');
    await press(user, '1');
    await press(user, '2');
    await press(user, '{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('with Something else open the keys of the card step aside: 1, 2 and Ctrl+Enter send nothing the bar has not been given', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: /^Something else/ }));
    await press(user, '1');
    await press(user, '2');
    await press(user, '{Control>}{Enter}{/Control}');
    await pageHides();
    // The bar has no verdict and no reason yet: it refuses, and nothing is sent.
    expect(decides(w)).toHaveLength(0);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Fix \d things? before deciding/);
  });

  it('a window over the page takes the keys', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    await user.keyboard('?');
    await screen.findByRole('dialog');
    await press(user, '1');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('N takes the next case', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const g = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Other', room: 'rb' });
    const { user, router } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    await press(user, 'n');
    await waitFor(() => expect(router.path).toMatch(/^\/reports\//));
    expect([f.id, g.id]).toContain(router.path.slice('/reports/'.length));
  });

  it('J and K move through the queue', async () => {
    const w = await hubWorld();
    await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'R1', room: 'ra' });
    await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'R2', room: 'rb' });
    const { user } = renderHub(w, { mode: 'simple' });
    await within(await screen.findByRole('region', { name: 'Open cases' })).findByText('Alpha');
    await press(user, 'j');
    const first = within(queue()).getAllByRole('link')[0]!;
    expect(first).toHaveFocus();
    await press(user, 'j');
    expect(within(queue()).getAllByRole('link')[1]).toHaveFocus();
    await press(user, 'k');
    expect(first).toHaveFocus();
  });

  it('the shortcut sheet still lists what it lists', async () => {
    const w = await hubWorld();
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    await user.keyboard('?');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('what a case costs in audited reads, against Detailed', () => {
  const counts = (w: HubWorld): Record<string, number> => {
    const out: Record<string, number> = {};
    // A `report.view` with no target is the queue's list; one with a target is a case being read.
    for (const r of w.cw.audit.list({ limit: 200 }).items) {
      const key = r.action === 'report.view' && r.target?.ref === undefined ? 'report.list' : r.action;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  async function reads(mode: 'simple' | 'detailed'): Promise<Record<string, number>> {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Saffron' });
    const before = counts(w);
    renderHub(w, { mode, path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: mode === 'simple' ? 'Mallory' : /report against Mallory/ });
    await waitFor(() => expect(w.sent.some((r) => r.path === `/people/${f.reporter}/history`)).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const after = counts(w);
    const diff: Record<string, number> = {};
    for (const [k, n] of Object.entries(after)) diff[k] = n - (before[k] ?? 0);
    return diff;
  }

  it('reads the report once, and no more of anything than Detailed does', async () => {
    const simple = await reads('simple');
    const detailed = await reads('detailed');
    expect(simple['report.view']).toBe(1);
    for (const [action, n] of Object.entries(simple)) {
      if (action === 'case.claim' || action === 'case.release') continue;
      expect(n, action).toBeLessThanOrEqual(detailed[action] ?? 0);
    }
  });

  it('reads the blocked list not at all', async () => {
    const simple = await reads('simple');
    expect(simple['blocked.view'] ?? 0).toBe(0);
  });

  it('a decision reads nothing more about the case', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: 'simple', path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ }));
    const before = counts(w);
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    await screen.findByText('Decided. The report is closed.', { selector: 'strong' });
    const after = counts(w);
    for (const k of ['report.view', 'history.view', 'policy.view', 'blocked.view']) expect(after[k] ?? 0, k).toBe(before[k] ?? 0);
  });
});

describe('accessibility', () => {
  const RULES = { 'color-contrast': { enabled: false } } as const;
  async function violations(container: HTMLElement): Promise<string[]> {
    const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
  }

  describe.each(['light', 'dark'] as const)('axe, %s theme', (theme) => {
    it('the card, with the queue and the menu', async () => {
      const w = await hubWorld({ role: 'owner' });
      const f = await w.fileRich({ lines: TALK, note: 'Keeps following me.' });
      await w.sanction(f.person, 'warning');
      const { container } = renderHub(w, { mode: 'simple', theme, path: `/reports/${f.id}` });
      await screen.findByRole('button', { name: /^Restrict|^Ban/ });
      await within(await screen.findByRole('region', { name: 'Their record' })).findByText(/^1 past step/);
      expect(await violations(container)).toEqual([]);
    });

    it('the card with More open, the whole chat open, and a masked line', async () => {
      const w = await hubWorld({ role: 'owner' });
      const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'target', text: 'you zorbak' }, { who: 'bystander', text: 'ok' }] });
      const { container, user } = renderHub(w, { mode: 'simple', theme, path: `/reports/${f.id}` });
      await screen.findByRole('button', { name: /^Restrict/ });
      await user.click(within(sections()).getByRole('button', { name: 'More' }));
      await user.click(screen.getByRole('button', { name: /^Show the whole chat/ }));
      expect(await violations(container)).toEqual([]);
    });

    it('Something else open, queued with Undo, and failed', async () => {
      const w = await hubWorld();
      const f = await w.fileRich({ lines: TALK });
      const { container, user } = renderHub(w, { mode: 'simple', theme, path: `/reports/${f.id}` });
      await user.click(await screen.findByRole('button', { name: /^Something else/ }));
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Back to the suggestion' }));
      await user.click(screen.getByRole('button', { name: /^Restrict chat/ }));
      expect(await violations(container)).toEqual([]);
      await user.click(within(screen.getByRole('region', { name: 'Decision' })).getByRole('button', { name: 'Undo' }));
      w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
      await user.click(screen.getByRole('button', { name: /^Restrict chat/ }));
      await pageHides();
      await screen.findByRole('alert');
      expect(await violations(container)).toEqual([]);
    });

    it('a case someone else holds, a reporter warning, no suggestion, and the Cases landing', async () => {
      const w = await hubWorld({ actor: 'ann@example.test' });
      const f = await w.fileRich({ lines: TALK, category: 'other' });
      await w.clientFor('maya@example.test').claimCase(f.person);
      const first = renderHub(w, { mode: 'simple', theme, path: `/reports/${f.id}` });
      await screen.findByText('maya is on it.');
      expect(await violations(first.container)).toEqual([]);
      first.unmount();
      const g = await w.fileRich({ lines: TALK, target: 'Gamma', category: 'other', reporter: 'Saffron', room: 'rg' });
      const second = renderHub(w, { mode: 'simple', theme, path: `/reports/${g.id}` });
      await screen.findByText('No step is suggested. Choose one.');
      expect(await violations(second.container)).toEqual([]);
      second.unmount();
      const third = renderHub(w, { mode: 'simple', theme });
      await screen.findByRole('heading', { level: 2, name: 'Cases' });
      expect(await violations(third.container)).toEqual([]);
    });
  });
});

describe('the stylesheet lays the card out for a phone as well as a desktop', () => {
  const css = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) return '';
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };

  it('the card, its lines and its buttons shrink and wrap instead of widening the page', () => {
    expect(rule('.cw-hub .cw-scard')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-scard-lines .cw-line-text')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-scard-actions')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('there is no fixed width on the card or its pieces', () => {
    for (const selector of ['.cw-hub .cw-scard', '.cw-hub .cw-scard-lines', '.cw-hub .cw-scard-actions', '.cw-hub .cw-snav']) {
      expect(rule(selector), selector).not.toMatch(/(^|[;\s])width:\s*\d/);
    }
  });

  it('Simple has no rail column: the body is the queue and the work', () => {
    expect(css).toMatch(/\.cw-body\[data-mode='simple'\]\[data-queue='true'\]\s*\{[^}]*grid-template-columns:\s*var\(--cw-queue-width\) minmax\(0, 1fr\)/);
  });

  it('the menu wraps on a phone', () => {
    expect(rule('.cw-hub .cw-snav > ul')).toMatch(/flex-wrap:\s*wrap/);
    const phone = css.slice(css.lastIndexOf('@media (max-width: 51.1875rem)'));
    expect(phone).toMatch(/\.cw-hub \.cw-snav\s*\{[^}]*flex:\s*1 1 100%/);
  });
});
