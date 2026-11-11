import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The queue pane beside the screen lists the same people and loads the same data, so the screen's own words are read inside <main>.
const inMain = () => within(screen.getByRole('main'));
async function mainAlert(): Promise<HTMLElement> {
  return within(await screen.findByRole('main')).findByRole('alert');
}

const list = (): HTMLElement => screen.getByRole('list', { name: 'Reported people' });
const rows = (): HTMLElement[] => within(list()).getAllByRole('listitem').filter((li) => li.classList.contains('cw-qrow'));
const status = (name: string): HTMLElement => within(screen.getByRole('group', { name: 'Report status' })).getByRole('button', { name });

async function ready() {
  await screen.findByRole('heading', { level: 2, name: 'Reports' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
}

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

describe('Reports: grouping by person', () => {
  it('shows the empty message for an empty open queue', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/reports' });
    await ready();
    expect(screen.getByText('No open reports. Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('one report is one row, with the handle, tag, category, counts and age', async () => {
    const w = await hubWorld();
    const [a] = await queue(w, 1, 1);
    w.clock.t += 2 * HOUR;
    renderHub(w, { path: '/reports' });
    await ready();
    expect(rows()).toHaveLength(1);
    const r = within(rows()[0]!);
    expect(r.getByText('Target0')).toBeInTheDocument();
    expect(r.getByText(personTag(a!.person))).toBeInTheDocument();
    expect(r.getByText('1 report')).toBeInTheDocument();
    expect(r.getByText('1 room')).toBeInTheDocument();
    expect(r.getByText('1 reporter')).toBeInTheDocument();
    expect(r.getByText('Insults or harassment')).toBeInTheDocument();
    expect(r.getByText('Waiting 2h')).toBeInTheDocument();
    expect(rows()[0]).toHaveAttribute('data-wait', 'aging');
  });

  it('several reports about one person are one row with the counts of distinct rooms and reporters', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Mallory', reporter: 'A', room: 'r1', category: 'harassment' });
    await w.file({ target: 'Mallory', reporter: 'B', room: 'r2', category: 'hate' });
    await w.file({ target: 'Mallory', reporter: 'A', room: 'r3', category: 'harassment' });
    renderHub(w, { path: '/reports' });
    await ready();
    expect(rows()).toHaveLength(1);
    const r = within(rows()[0]!);
    expect(r.getByText('3 reports')).toBeInTheDocument();
    expect(r.getByText('3 rooms')).toBeInTheDocument();
    expect(r.getByText('2 reporters')).toBeInTheDocument();
    expect(r.getByText('Insults or harassment')).toBeInTheDocument();
    expect(r.getByText('Hate')).toBeInTheDocument();
  });

  it('marks the wait with a tone: fresh under an hour, stale after a day', async () => {
    const w = await hubWorld();
    await queue(w, 1, 1);
    w.clock.t += 30 * 60_000;
    const { unmount } = renderHub(w, { path: '/reports' });
    await ready();
    expect(rows()[0]).toHaveAttribute('data-wait', 'fresh');
    unmount();
    w.clock.t += 30 * HOUR;
    renderHub(w, { path: '/reports' });
    await ready();
    expect(rows()[0]).toHaveAttribute('data-wait', 'stale');
    expect(rows()[0]).toHaveTextContent('Waiting 30h');
  });

  it('puts the person with the newest report first', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Old' });
    await w.file({ target: 'Newer' });
    renderHub(w, { path: '/reports' });
    await ready();
    expect(rows().map((li) => li.querySelector('.cw-qrow-name')?.textContent)).toEqual(['Newer', 'Old']);
  });

  it('links Review to the newest report and History to the person', async () => {
    const w = await hubWorld();
    const filed = await queue(w, 1, 3);
    renderHub(w, { path: '/reports' });
    await ready();
    const r = within(rows()[0]!);
    expect(r.getByRole('link', { name: 'Review the newest report against Target0' })).toHaveAttribute('href', `#/reports/${filed[2]!.id}`);
    expect(r.getByRole('link', { name: 'Open the history of Target0' })).toHaveAttribute('href', `#/people/${filed[0]!.person}`);
  });

  it('offers earlier reports behind a disclosure, each as what it was reported as and how long ago, never the raw id', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Mallory', reporter: 'A', category: 'hate' });
    w.clock.t += 3 * HOUR;
    const second = await w.file({ target: 'Mallory', reporter: 'B', category: 'spam' });
    w.clock.t += 5 * 60_000;
    await w.file({ target: 'Mallory', reporter: 'C', category: 'harassment' });
    const { user } = renderHub(w, { path: '/reports' });
    await ready();
    const r = within(rows()[0]!);
    expect(r.queryByRole('list', { name: 'Earlier reports' })).not.toBeInTheDocument();
    const toggle = r.getByRole('button', { name: 'Show 2 earlier reports' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const links = within(r.getByRole('list', { name: 'Earlier reports' })).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', `#/reports/${second.id}`);
    expect(links[0]).toHaveAccessibleName('Spam or ads, 5 minutes ago');
    expect(links[0]).toHaveTextContent('Spam or ads, 5 minutes ago');
    expect(links[1]).toHaveAttribute('href', `#/reports/${first.id}`);
    expect(links[1]).toHaveAccessibleName('Hate, 3 hours ago');
    expect(document.body.textContent).not.toContain(first.id);
    expect(document.body.textContent).not.toContain(second.id);
    const hide = r.getByRole('button', { name: 'Hide earlier reports' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    await user.click(hide);
    expect(r.queryByRole('list', { name: 'Earlier reports' })).not.toBeInTheDocument();
  });

  it('has no disclosure for one report, and points to the history past ten earlier reports', async () => {
    const w = await hubWorld();
    await queue(w, 1, 1);
    const one = renderHub(w, { path: '/reports' });
    await ready();
    expect(within(rows()[0]!).queryByRole('button', { name: /earlier/ })).not.toBeInTheDocument();
    one.unmount();
    for (let i = 0; i < 14; i += 1) await w.file({ target: 'Target0', reporter: `More${i}` });
    const { user } = renderHub(w, { path: '/reports' });
    await ready();
    const r = within(rows()[0]!);
    await user.click(r.getByRole('button', { name: 'Show 14 earlier reports' }));
    expect(within(r.getByRole('list', { name: 'Earlier reports' })).getAllByRole('link')).toHaveLength(10);
    expect(r.getByText('4 older reports are in their history.')).toBeInTheDocument();
  });

  it('an unnamed person is shown by tag', async () => {
    const w = await hubWorld();
    const [a] = await queue(w, 1, 1);
    w.intercept.fn = async (req) => {
      if (req.path !== '/reports') return undefined;
      const real = await w.handle({ method: 'GET', path: '/reports', query: { status: 'open' }, headers: {}, body: undefined });
      const body = real.body as { items: Array<Record<string, unknown>> };
      return { status: 200, body: { ...body, items: body.items.map((i) => ({ ...i, targetHandle: null })) } };
    };
    renderHub(w, { path: '/reports' });
    await ready();
    const r = within(rows()[0]!);
    expect(r.getByText('Unnamed player')).toBeInTheDocument();
    expect(r.getByText(personTag(a!.person))).toBeInTheDocument();
    expect(r.getByRole('link', { name: `Review the newest report against Person ${personTag(a!.person)}` })).toBeInTheDocument();
  });

  it('lists other handles a person was seen under', async () => {
    const w = await hubWorld();
    const [a] = await queue(w, 1, 1);
    w.clock.t += 5000;
    w.cw.rooms.seat('room-alias', 'p1', { clientKey: 'key-reporter-Other' }, 'Other');
    w.cw.rooms.seat('room-alias', 'p2', { clientKey: 'key-target-Target0' }, 'TargetAlias');
    w.cw.chat.accept('room-alias', 'p2', 'hi');
    const res = await w.cw.reports.submit({ roomId: 'room-alias', reporterSeat: 'p1', targetSeat: 'p2', category: 'spam' });
    expect(res.ok).toBe(true);
    renderHub(w, { path: '/reports' });
    await ready();
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText('TargetAlias')).toBeInTheDocument();
    expect(within(rows()[0]!).getByText('Also seen as Target0')).toBeInTheDocument();
    void a;
  });
});

describe('Reports: paging with 60+ reports', () => {
  it('shows the first page of 50, loads the rest on request, and groups the whole', async () => {
    const w = await hubWorld();
    await queue(w, 13, 5); // 65 reports over 13 people
    const { user } = renderHub(w, { path: '/reports' });
    await ready();
    expect(w.sent.find((r) => r.path === '/reports' && r.query?.limit === 50)?.query).toMatchObject({ status: 'open', limit: 50 });
    expect(screen.getByText('Showing 50 reports.')).toBeInTheDocument();
    expect(screen.getByText('Load more to add older reports to the groups.')).toBeInTheDocument();
    const before = rows().length;
    expect(before).toBeLessThanOrEqual(13);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Showing 65 reports.')).toBeInTheDocument());
    expect(inMain().getByRole('status')).toHaveTextContent('Loaded 15 more reports.');
    expect(rows()).toHaveLength(13);
    for (const li of rows()) expect(li).toHaveTextContent('5 reports');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.queryByText('Load more to add older reports to the groups.')).not.toBeInTheDocument();
    const reportPages = w.sent.filter((r) => r.path === '/reports' && r.query?.limit === 50);
    expect(reportPages).toHaveLength(2);
    expect(reportPages[1]?.query?.cursor).toBeTruthy();
  });

  it('an exact page of 50 still offers Load more once, then the list ends', async () => {
    const w = await hubWorld();
    await queue(w, 50, 1);
    const { user } = renderHub(w, { path: '/reports' });
    await ready();
    expect(rows()).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
    expect(rows()).toHaveLength(50);
    expect(inMain().getByRole('status').textContent).toBe('');
  });

  it('keeps the rows and offers a retry when a later page fails', async () => {
    const w = await hubWorld();
    await queue(w, 3, 20); // 60 reports
    const { user } = renderHub(w, { path: '/reports' });
    await ready();
    const first = rows().length;
    w.intercept.fn = (req) => (req.path === '/reports' && req.query?.cursor !== undefined ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await mainAlert()).toHaveTextContent('The server had a problem');
    expect(rows()).toHaveLength(first);
    w.intercept.fn = null;
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Showing 60 reports.')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a double click on Load more asks for one page', async () => {
    const w = await hubWorld();
    await queue(w, 3, 20);
    const { user } = renderHub(w, { path: '/reports' });
    await ready();
    const button = screen.getByRole('button', { name: 'Load more' });
    await user.dblClick(button);
    await waitFor(() => expect(screen.getByText('Showing 60 reports.')).toBeInTheDocument());
    expect(w.sent.filter((r) => r.path === '/reports' && r.query?.cursor !== undefined)).toHaveLength(1);
  });
});

describe('Reports: the status filter', () => {
  it('defaults to Open, marks it pressed and asks for status=open', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/reports' });
    await ready();
    expect(status('Open')).toHaveAttribute('aria-pressed', 'true');
    expect(status('Actioned')).toHaveAttribute('aria-pressed', 'false');
    expect(w.sent.find((r) => r.path === '/reports')?.query).toMatchObject({ status: 'open' });
  });

  it('reads the status from the address', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/reports?status=dismissed' });
    await ready();
    expect(status('Dismissed')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('No dismissed reports yet.')).toBeInTheDocument();
  });

  it('moves a decided report from Open to Actioned, and All shows both with their status', async () => {
    const w = await hubWorld();
    const filed = await queue(w, 2, 1);
    await w.client.decide(filed[0]!.id, {
      verdict: 'upheld',
      reason: 'clear',
      actions: [{ subject: filed[0]!.person, kind: 'warning', durationMs: null, rule: 1 }],
    });
    const { user, router } = renderHub(w, { path: '/reports' });
    await ready();
    expect(rows().map((li) => li.querySelector('.cw-qrow-name')?.textContent)).toEqual(['Target1']);

    await user.click(status('Actioned'));
    expect(router.path).toBe('/reports?status=actioned');
    await waitFor(() => expect(rows().map((li) => li.querySelector('.cw-qrow-name')?.textContent)).toEqual(['Target0']));
    expect(within(rows()[0]!).getByText('Actioned')).toBeInTheDocument();
    expect(w.sent.at(-1)?.query).toMatchObject({ status: 'actioned' });

    await user.click(status('Dismissed'));
    expect(await screen.findByText('No dismissed reports yet.')).toBeInTheDocument();

    await user.click(status('All'));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(w.sent.at(-1)?.query ?? {}).not.toHaveProperty('status');
    expect(within(rows()[0]!).getByText('Open')).toBeInTheDocument();

    await user.click(status('Open'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(router.path).toBe('/reports');
  });

  it('shows the empty message for All with nothing filed', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/reports?status=all' });
    await ready();
    expect(screen.getByText('No reports yet.')).toBeInTheDocument();
  });

  it('ignores a slow answer for the status it was on when the person has moved on', async () => {
    const w = await hubWorld();
    await queue(w, 1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    w.intercept.fn = async (req) => {
      if (req.path === '/reports' && req.query?.status === 'open') {
        await gate;
        return undefined;
      }
      return undefined;
    };
    const { user } = renderHub(w, { path: '/reports' });
    await screen.findByRole('heading', { level: 2, name: 'Reports' });
    await user.click(status('Dismissed'));
    expect(await screen.findByText('No dismissed reports yet.')).toBeInTheDocument();
    await act(async () => release());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('No dismissed reports yet.')).toBeInTheDocument();
    expect(inMain().queryByText('Target0')).not.toBeInTheDocument();
  });
});

describe('Reports: failures and roles', () => {
  it('a failed first load shows an error with Try again, and works on retry', async () => {
    const w = await hubWorld();
    await queue(w, 1, 1);
    w.intercept.fn = (req) => (req.path === '/reports' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/reports' });
    expect(await mainAlert()).toHaveTextContent('Could not load the reports.');
    w.intercept.fn = null;
    await user.click(inMain().getByRole('button', { name: 'Try again' }));
    expect(await inMain().findByText('Target0')).toBeInTheDocument();
    expect(inMain().queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a 403 from the server as a plain sentence', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/reports' ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    renderHub(w, { path: '/reports' });
    expect(await mainAlert()).toHaveTextContent('Your role cannot do this.');
  });

  it('says how long to wait on a 429', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) =>
      req.path === '/reports' ? { status: 429, headers: { 'retry-after': '1' }, body: { error: 'rate_limited', message: 'x' } } : undefined;
    renderHub(w, { path: '/reports' });
    expect(await mainAlert()).toHaveTextContent('Try again in 1 second.');
  });

  it('a moderator without reports.read sees the not-available message and sends no queue request', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    renderHub(w, { path: '/reports' });
    expect(await screen.findByRole('heading', { name: 'Not available for your role' })).toBeInTheDocument();
    expect(w.sent.some((r) => r.path === '/reports')).toBe(false);
  });

  it('does not open a report to build the list (no audited read per row)', async () => {
    const w = await hubWorld();
    await queue(w, 3, 2);
    renderHub(w, { path: '/reports' });
    await ready();
    expect(w.sent.filter((r) => /^\/reports\/./.test(r.path))).toEqual([]);
  });
});
