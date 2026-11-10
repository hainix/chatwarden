import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

const panel = (name: string): HTMLElement => screen.getByRole('region', { name });
const stat = (label: string): string => {
  const dt = within(panel('At a glance')).getByText(label);
  return dt.closest('div')?.querySelector('dd')?.textContent ?? '';
};
const rows = (name: string): HTMLElement[] => within(panel(name)).queryAllByRole('listitem');

async function ready() {
  await screen.findByRole('heading', { level: 2, name: 'Overview' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
}

/** `people` reported people with `each` reports apiece, from different reporters. */
async function queue(w: HubWorld, people: number, each = 1) {
  const out: Array<{ id: string; person: string; name: string }> = [];
  for (let p = 0; p < people; p += 1) {
    for (let r = 0; r < each; r += 1) {
      const name = `Target${p}`;
      const filed = await w.file({ target: name, reporter: `Rep${p}x${r}` });
      out.push({ id: filed.id, person: filed.person, name });
    }
  }
  return out;
}

describe('Overview: an empty hub', () => {
  it('shows zeros, nobody waiting, an all-clear and no recent actions', async () => {
    const w = await hubWorld();
    renderHub(w);
    await ready();
    expect(stat('People waiting')).toBe('0');
    expect(stat('Open reports')).toBe('0');
    expect(stat('Longest wait')).toBe('None');
    expect(within(panel('At a glance')).getByText('Nobody is waiting')).toBeInTheDocument();
    expect(within(panel('Needs review')).getByText('All clear')).toBeInTheDocument();
    expect(within(panel('Needs review')).getByText('No open reports. Nothing is waiting on you.')).toBeInTheDocument();
    expect(within(panel('Recent actions')).getByText(/No actions yet/)).toBeInTheDocument();
  });
});

describe('Overview: the numbers come from the open queue', () => {
  it('counts people, reports and the longest wait', async () => {
    const w = await hubWorld();
    const filed = await queue(w, 3, 2); // 3 people, 6 reports
    const first = w.cw.reports.get(filed[0]!.id)!;
    w.clock.t = first.createdAt + 3 * HOUR;
    renderHub(w);
    await ready();
    expect(stat('People waiting')).toBe('3');
    expect(stat('Open reports')).toBe('6');
    expect(stat('Longest wait')).toBe('3h');
    expect(within(panel('At a glance')).getByText('Oldest open report is against Target0')).toBeInTheDocument();
  });

  it('counts only open reports: a decided report leaves the numbers', async () => {
    const w = await hubWorld();
    const filed = await queue(w, 2, 1);
    await w.client.decide(filed[0]!.id, { verdict: 'no_action', reason: 'fine', actions: [] });
    renderHub(w);
    await ready();
    expect(stat('People waiting')).toBe('1');
    expect(stat('Open reports')).toBe('1');
    expect(within(panel('At a glance')).getByText('Oldest open report is against Target1')).toBeInTheDocument();
  });

  it('handles 60+ reports over several pages (the queue is paged at 200)', async () => {
    const w = await hubWorld();
    await queue(w, 13, 5); // 65 reports
    renderHub(w);
    await ready();
    expect(stat('People waiting')).toBe('13');
    expect(stat('Open reports')).toBe('65');
    expect(rows('Needs review')).toHaveLength(5);
  });

  it('follows next across pages and stops after five pages, saying the count is partial', async () => {
    const w = await hubWorld();
    let pages = 0;
    w.intercept.fn = (req) => {
      if (req.method !== 'GET' || req.path !== '/reports') return undefined;
      pages += 1;
      const items = Array.from({ length: 200 }, (_, i) => ({
        id: `r${pages}-${i}`,
        createdAt: 1_800_000_000_000 - pages * 1000 - i,
        roomId: 'x',
        tags: {},
        category: 'spam',
        status: 'open',
        badFaith: false,
        targetPerson: `person${i % 40}`,
        reporterPerson: `rep${i}`,
        actionedAt: null,
        actionedBy: null,
        targetHandle: null,
      }));
      return { status: 200, body: { items, next: `cursor-${pages}` } };
    };
    renderHub(w);
    await ready();
    expect(pages).toBe(5);
    expect(stat('Open reports')).toBe('1,000');
    expect(stat('People waiting')).toBe('40');
    expect(within(panel('At a glance')).getByText(/Counted from the newest 1,000 reports/)).toBeInTheDocument();
    // The reports left out are the oldest, so the longest wait is a floor, not the answer.
    expect(within(panel('At a glance')).getByText('At least this long. Older reports were not counted.')).toBeInTheDocument();
  });

  it('does not call the longest wait a floor when every open report was counted', async () => {
    const w = await hubWorld();
    await queue(w, 2, 1);
    renderHub(w);
    await ready();
    expect(within(panel('At a glance')).queryByText(/At least this long/)).not.toBeInTheDocument();
  });

  it('never opens a single report (that is an audited read) to build the overview', async () => {
    const w = await hubWorld();
    await queue(w, 2, 2);
    renderHub(w);
    await ready();
    expect(w.sent.filter((r) => /^\/reports\/[^/]+/.test(r.path))).toEqual([]);
    expect(w.sent.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /me', 'GET /reports', 'GET /sanctions']);
  });
});

describe('Overview: Needs review', () => {
  it('shows the five longest-waiting people first, with a link to all reports', async () => {
    const w = await hubWorld();
    await queue(w, 7, 1);
    const { user, router } = renderHub(w);
    await ready();
    const list = rows('Needs review');
    expect(list).toHaveLength(5);
    expect(list.map((li) => li.textContent)).toEqual(
      ['Target0', 'Target1', 'Target2', 'Target3', 'Target4'].map((n) => expect.stringContaining(n)),
    );
    await user.click(within(panel('Needs review')).getByRole('link', { name: 'All reports' }));
    expect(router.path).toBe('/reports');
  });

  it('each row has the handle, a short person tag, the counts and links to the newest report and the history', async () => {
    const w = await hubWorld();
    const [a, b] = await queue(w, 1, 2);
    renderHub(w);
    await ready();
    const [row] = rows('Needs review');
    expect(row).toBeDefined();
    const r = within(row!);
    expect(r.getByText('Target0')).toBeInTheDocument();
    expect(r.getByText(personTag(a!.person))).toBeInTheDocument();
    expect(r.getByText('2 reports')).toBeInTheDocument();
    expect(r.getByText('2 rooms')).toBeInTheDocument();
    expect(r.getByText('2 reporters')).toBeInTheDocument();
    expect(r.getByText('Harassment')).toBeInTheDocument();
    // newest first: b was filed after a
    expect(r.getByRole('link', { name: 'Review the newest report against Target0' })).toHaveAttribute('href', `#/reports/${b!.id}`);
    expect(r.getByRole('link', { name: 'Open the history of Target0' })).toHaveAttribute('href', `#/people/${a!.person}`);
  });

  it('never prints a person ref longer than its 8 character tag', async () => {
    const w = await hubWorld();
    const filed = await queue(w, 2, 1);
    await w.sanction(filed[0]!.person, 'chat');
    renderHub(w);
    await ready();
    for (const f of filed) {
      expect(f.person.length).toBeGreaterThan(8);
      expect(document.body.textContent).not.toContain(f.person);
      expect(document.body.textContent).not.toContain(f.person.slice(0, 9));
    }
  });
});

describe('Overview: Recent actions', () => {
  it('lists the newest sanctions with what, how long, which rule, who and the state', async () => {
    const w = await hubWorld();
    const [t] = await queue(w, 1, 1);
    await w.sanction(t!.person, 'chat', 1);
    await w.sanction(t!.person, 'ban', 2);
    await w.sanction(t!.person, 'warning', 'uncovered');
    renderHub(w);
    await ready();
    const list = rows('Recent actions');
    expect(list).toHaveLength(3);
    expect(list[0]).toHaveTextContent('Warning');
    expect(list[0]).toHaveTextContent('No rule fits yet');
    expect(list[1]).toHaveTextContent('Ban');
    expect(list[1]).toHaveTextContent('24h');
    expect(list[1]).toHaveTextContent('Rule 2');
    expect(list[2]).toHaveTextContent('Chat restriction');
    expect(list[2]).toHaveTextContent('by ann@example.test');
    expect(list[2]).toHaveTextContent('Active');
    expect(within(list[2]!).getByText(personTag(t!.person))).toBeInTheDocument();
    expect(within(list[2]!).getByRole('link', { name: /Person/ })).toHaveAttribute('href', `#/people/${t!.person}`);
  });

  it('shows at most the newest 10', async () => {
    const w = await hubWorld();
    const [t] = await queue(w, 1, 1);
    for (let i = 0; i < 12; i += 1) await w.sanction(t!.person, 'warning', 1);
    renderHub(w);
    await ready();
    expect(rows('Recent actions')).toHaveLength(10);
    expect(w.sent.find((r) => r.path === '/sanctions')?.query).toMatchObject({ limit: 10 });
  });

  it('shows a permanent ban as permanent and a revoked sanction as Revoked', async () => {
    const w = await hubWorld({ role: 'senior' });
    const [t] = await queue(w, 1, 1);
    await w.cw.sanctions.apply({ kind: 'ban', subject: t!.person, includeIp: false, durationMs: null, reason: 'r', actor: 'ann@example.test', source: 'moderator', automated: false, rule: 1 });
    const chat = await w.sanction(t!.person, 'chat', 3);
    await w.client.revokeSanction(chat.groupId, 'mistake');
    renderHub(w);
    await ready();
    const list = rows('Recent actions');
    expect(list.find((li) => li.textContent?.includes('Ban'))).toHaveTextContent('permanent');
    expect(list.find((li) => li.textContent?.includes('Chat restriction'))).toHaveTextContent('Revoked');
  });

  it('labels an automatic sanction and a non-moderator source (the AI label slot)', async () => {
    const w = await hubWorld();
    const [t] = await queue(w, 1, 1);
    await w.cw.sanctions.apply({ kind: 'chat', subject: t!.person, includeIp: false, durationMs: HOUR, reason: 'auto', actor: 'system', source: 'auto_filter', automated: true, rule: 1 });
    w.clock.t += 1000;
    await w.cw.sanctions.apply({ kind: 'warning', subject: t!.person, includeIp: false, durationMs: null, reason: 'ai', actor: 'ai-reader', source: 'ai', automated: false, rule: 1 });
    renderHub(w);
    await ready();
    const list = rows('Recent actions');
    expect(list[0]).toHaveTextContent('AI');
    expect(list[1]).toHaveTextContent('Automatic filter');
    expect(list[1]).toHaveTextContent('automatic');
    expect(list[1]).not.toHaveTextContent('by system');
  });

  it('does not show the private reason text', async () => {
    const w = await hubWorld();
    const [t] = await queue(w, 1, 1);
    await w.sanction(t!.person, 'chat', 1);
    renderHub(w);
    await ready();
    expect(document.body.textContent).not.toContain('private moderator reason');
  });
});

describe('Overview: roles', () => {
  it('leaves out Recent actions without history.read, and still shows the queue', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'history.read': 'owner' } });
    await queue(w, 1, 1);
    renderHub(w);
    await ready();
    expect(screen.queryByRole('region', { name: 'Recent actions' })).not.toBeInTheDocument();
    expect(rows('Needs review')).toHaveLength(1);
    expect(w.sent.some((r) => r.path === '/sanctions')).toBe(false);
  });

  it('leaves out the queue panels without reports.read, and still shows Recent actions', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    renderHub(w);
    await screen.findByRole('region', { name: 'Recent actions' });
    expect(screen.queryByRole('region', { name: 'Needs review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'At a glance' })).not.toBeInTheDocument();
    expect(w.sent.some((r) => r.path === '/reports')).toBe(false);
  });
});

describe('Overview: failures', () => {
  it('a failed queue shows an error with Try again in that panel, and Recent actions still works', async () => {
    const w = await hubWorld();
    const [t] = await queue(w, 1, 1);
    await w.sanction(t!.person, 'chat', 1);
    w.intercept.fn = (req) => (req.path === '/reports' ? { status: 500, body: { error: 'internal', message: 'Something went wrong.' } } : undefined);
    const { user } = renderHub(w);
    const review = await screen.findByRole('region', { name: 'Needs review' });
    expect(await within(review).findByRole('alert')).toHaveTextContent('Could not load the reports.');
    expect(rows('Recent actions')).toHaveLength(1);
    w.intercept.fn = null;
    await user.click(within(review).getByRole('button', { name: 'Try again' }));
    expect(await within(review).findByText('Target0')).toBeInTheDocument();
  });

  it('a failed recent-actions load says so in its panel', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => {
      if (req.path === '/sanctions') throw new TypeError('fetch failed');
      return undefined;
    };
    renderHub(w);
    const recent = await screen.findByRole('region', { name: 'Recent actions' });
    expect(await within(recent).findByRole('alert')).toHaveTextContent('Could not load recent actions.');
    expect(within(recent).getByRole('alert')).toHaveTextContent('Could not reach the server');
  });
});
