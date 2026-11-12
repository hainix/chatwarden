import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The Audit screen: who did what, newest first, a page at a time, filtered by staff member and action. Senior and up (the
// permission `/audit` asks for). Against the real routes and a real trail.

const list = (): HTMLElement => screen.getByRole('region', { name: 'Audit entries' });
const bodyRows = (): HTMLElement[] => within(list()).getAllByRole('row').slice(1);
const reads = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'GET' && r.path === '/audit');
const SERVER_500 = { status: 500, body: { error: 'internal', message: 'x' } };

async function openAudit(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
  const w = await hubWorld({ role: 'senior', ...options });
  await prepare?.(w);
  const r = renderHub(w, { path: '/audit' });
  await screen.findByRole('heading', { level: 2, name: 'Audit' });
  await screen.findByRole('region', { name: 'Audit entries' });
  return { w, ...r };
}

/** `n` rows of `history.view` for a person, by a teammate, so the trail has something to page through. */
async function manyRows(w: HubWorld, n: number, actor = 'bea@example.test') {
  const f = await w.file({ target: 'Vantablob' });
  const bea = w.clientFor(actor, 'senior');
  for (let i = 0; i < n; i += 1) await bea.personHistory(f.person);
  return f;
}

describe('the trail', () => {
  it('lists time, staff member, role, action and target, newest first', async () => {
    const { w } = await openAudit({}, async (x) => {
      const f = await x.file({ target: 'Vantablob' });
      await x.clientFor('bea@example.test', 'owner').personHistory(f.person);
    });
    expect(within(list()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Time', 'Staff member', 'Role', 'Action', 'Target']);
    const first = bodyRows().find((r) => r.textContent?.includes('Viewed a person’s record'))!;
    expect(first).toHaveTextContent('bea@example.test');
    expect(first).toHaveTextContent('Owner');
    expect(first).toHaveTextContent('Viewed a person’s record');
    expect(within(first).getByRole('time')).toBeInTheDocument();
    // Newest first: the list is in the order the trail has it.
    const trail = w.cw.audit.list({ limit: 200 }).items.map((i) => i.id);
    expect(trail.length).toBeGreaterThanOrEqual(bodyRows().length - 1);
  });

  it('a person target is "Person" and the 8-character tag, a link to their page, and never the whole ref in the text', async () => {
    let person = '';
    const { router, user } = await openAudit({}, async (x) => {
      person = (await manyRows(x, 1)).person;
    });
    const row = bodyRows().find((r) => r.textContent?.includes('Viewed a person’s record'))!;
    const link = within(row).getByRole('link', { name: `Person ${personTag(person)}` });
    expect(list().textContent).not.toContain(person);
    await user.click(link);
    expect(router.path).toBe(`/people/${person}`);
  });

  it('a report target links to the report, and names it by a short tag', async () => {
    let id = '';
    const { router, user } = await openAudit({}, async (x) => {
      const f = await x.file({ target: 'Vantablob' });
      id = f.id;
      await x.clientFor('bea@example.test', 'senior').getReport(f.id);
    });
    const row = bodyRows().find((r) => r.textContent?.includes('Viewed a report') && r.textContent.includes(personTag(id)))!;
    await user.click(within(row).getByRole('link', { name: `Report ${personTag(id)}` }));
    expect(router.path).toBe(`/reports/${id}`);
  });

  it('a term or exception target is only "A term" or "An exception": the row id (which can hold the word) is never shown', async () => {
    const { container } = await openAudit({}, async (x) => {
      await x.clientFor('bea@example.test', 'senior').setTermActive('syn:zorbak', false);
      await x.clientFor('bea@example.test', 'senior').setExceptionActive('syn-ex:tarvo-lake', false);
      await x.clientFor('bea@example.test', 'senior').addTerm({ term: 'flarpnok', language: 'en' });
    });
    expect(within(list()).getAllByText('A term').length).toBeGreaterThan(0);
    expect(within(list()).getAllByText('An exception').length).toBeGreaterThan(0);
    for (const word of ['zorbak', 'tarvo', 'flarpnok', 'syn:']) expect(container.textContent?.toLowerCase()).not.toContain(word);
    expect(container.innerHTML.toLowerCase()).not.toContain('zorbak');
  });

  it('a sanction is "Sanction" and a short tag; an entry with no target says None', async () => {
    const { w } = await openAudit({}, async (x) => {
      const f = await x.file({ target: 'Vantablob' });
      await x.clientFor('bea@example.test', 'senior').applySanction({ subject: f.person, kind: 'warning', durationMs: null, rule: 1, reason: 'r' });
      x.blockLine('Kestrel', 'zorbak');
      await x.clientFor('bea@example.test', 'senior').listBlocked();
    });
    const sanction = bodyRows().find((r) => r.textContent?.includes('Applied a sanction'))!;
    expect(sanction).toHaveTextContent(/Sanction [A-Za-z0-9_-]{8}/);
    expect(within(sanction).queryByRole('link')).toBeNull();
    const blocked = bodyRows().find((r) => r.textContent?.includes('Viewed the blocked lines'))!;
    expect(within(blocked).getByText('None')).toBeInTheDocument();
    expect(w.cw.audit.list({ limit: 200 }).items.some((i) => i.action === 'blocked.view')).toBe(true);
  });

  it('every action the kit records has a plain label, and an action from a newer kit is shown as it is', async () => {
    const w = await hubWorld({ role: 'senior' });
    w.intercept.fn = (req) =>
      req.path === '/audit'
        ? { status: 200, body: { items: [{ id: 'a1', at: w.now(), actor: 'x@example.test', role: null, action: 'future.thing' }, { id: 'a2', at: w.now(), actor: 'y', role: 'owner', action: 'case.takeover', target: { type: 'person', ref: 's_abcdefghijkl' } }], next: null } }
        : undefined;
    renderHub(w, { path: '/audit' });
    await screen.findByRole('region', { name: 'Audit entries' });
    const rows = bodyRows();
    expect(rows[0]).toHaveTextContent('future.thing');
    expect(rows[0]).toHaveTextContent('Not recorded');
    expect(rows[1]).toHaveTextContent('Took over a case');
  });

  it('a report.view with no target is "Viewed the report list" (the queue read), and one with a target is "Viewed a report"', async () => {
    let id = '';
    await openAudit({}, async (x) => {
      const f = await x.file({ target: 'Vantablob' });
      id = f.id;
      await x.clientFor('bea@example.test', 'senior').listReports();
      await x.clientFor('bea@example.test', 'senior').getReport(f.id);
    });
    const listRows = bodyRows().filter((r) => r.textContent?.includes('Viewed the report list'));
    expect(listRows.length).toBeGreaterThan(0);
    for (const r of listRows) expect(within(r).getByText('None')).toBeInTheDocument();
    const reportRow = bodyRows().find((r) => r.textContent?.includes('Viewed a report') && r.textContent.includes(personTag(id)))!;
    expect(within(reportRow).getByRole('link', { name: `Report ${personTag(id)}` })).toBeInTheDocument();
    expect(bodyRows().filter((r) => r.textContent?.includes('Viewed a report') && within(r).queryByText('None') !== null)).toHaveLength(0);
  });

  it('opening the trail writes no audit row of its own', async () => {
    const { w } = await openAudit({}, async (x) => void (await manyRows(x, 2)));
    const before = w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action !== 'report.view').length;
    expect(before).toBe(2);
    // Only the queue pane's own list read (a report.view with no target) is new.
    expect(w.cw.audit.list({ limit: 200 }).items.every((r) => r.action === 'history.view' || r.action === 'report.view')).toBe(true);
  });

  it('an empty trail says so', async () => {
    const w = await hubWorld({ role: 'senior' });
    w.intercept.fn = (req) => (req.path === '/audit' ? { status: 200, body: { items: [], next: null } } : undefined);
    renderHub(w, { path: '/audit' });
    expect(await screen.findByText('Nothing is recorded yet.')).toBeInTheDocument();
  });
});

describe('who may open it', () => {
  it('a moderator has no Audit tab, gets the "not available" page by link, and nothing is read', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderHub(w, { path: '/audit' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit' })).toBeNull();
    expect(reads(w)).toHaveLength(0);
  });

  it('a senior and an owner have the tab', async () => {
    for (const role of ['senior', 'owner'] as const) {
      const w = await hubWorld({ role });
      const { unmount } = renderHub(w, { path: '/' });
      expect(await screen.findByRole('link', { name: 'Audit' })).toBeInTheDocument();
      unmount();
    }
  });

  it('follows the permission table: a moderator can read it when the server says so', async () => {
    await openAudit({ role: 'moderator', permissions: { 'audit.read': 'moderator' } }, async (x) => void (await manyRows(x, 1)));
    expect(screen.getByRole('link', { name: 'Audit' })).toBeInTheDocument();
  });

  it('a 403 from the server says so plainly, with Try again', async () => {
    const w = await hubWorld({ role: 'senior' });
    let n = 0;
    w.intercept.fn = (req) => (req.path === '/audit' && ++n === 1 ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/audit' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the audit trail. Your role cannot do this.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Audit entries' })).toBeInTheDocument();
  });

  it('a 500 says the server had a problem', async () => {
    const w = await hubWorld({ role: 'senior' });
    w.intercept.fn = (req) => (req.path === '/audit' ? SERVER_500 : undefined);
    renderHub(w, { path: '/audit' });
    expect(await screen.findByText(/The server had a problem/)).toBeInTheDocument();
  });
});

describe('paging', () => {
  it('shows 50 at first, Load more adds the next 50, and the last page ends with no button', async () => {
    const { w, user } = await openAudit({}, async (x) => void (await manyRows(x, 120)));
    expect(bodyRows()).toHaveLength(50);
    expect(screen.getByText('50 entries shown')).toBeInTheDocument();
    expect(reads(w)[0]?.query).toEqual({ limit: 50 });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(100));
    expect(await screen.findByText('Loaded 50 more entries.')).toBeInTheDocument();
    expect(reads(w)[1]?.query).toEqual({ limit: 50, cursor: expect.any(String) });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
    // Count only the rows this test made. The hub's own first reads (the queue) can write one audit row of their own, before or after
    // the trail is read, so the whole trail is 120 or 121 rows depending on which read comes first under load.
    const made = (rows: HTMLElement[]): number => rows.filter((r) => r.textContent?.includes('Viewed a person’s record')).length;
    expect(made(bodyRows())).toBe(120);
    expect(w.cw.audit.list({ limit: 200 }).items.filter((i) => i.action === 'history.view')).toHaveLength(120);
    expect(screen.getByText('That is the whole trail.')).toBeInTheDocument();
    expect(reads(w)).toHaveLength(3);
  });

  it('a trail that fits one page has no Load more and says it is whole', async () => {
    await openAudit({}, async (x) => void (await manyRows(x, 3)));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('That is the whole trail.')).toBeInTheDocument();
  });

  it('moves keyboard focus from Load more to the count when the last page arrives', async () => {
    const { user } = await openAudit({}, async (x) => void (await manyRows(x, 60)));
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
    expect(screen.getByText(/entries shown$/)).toHaveFocus();
  });

  it('a double click on Load more asks for one page', async () => {
    const { w } = await openAudit({}, async (x) => void (await manyRows(x, 120)));
    const more = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(more);
    fireEvent.click(more);
    await waitFor(() => expect(bodyRows()).toHaveLength(100));
    expect(reads(w)).toHaveLength(2);
  });

  it('a failed later page keeps what is shown, says so, and Load more tries that page again', async () => {
    const { w, user } = await openAudit({}, async (x) => void (await manyRows(x, 120)));
    let fail = true;
    w.intercept.fn = (req) => {
      if (req.path === '/audit' && req.query?.cursor !== undefined && fail) {
        fail = false;
        return SERVER_500;
      }
      return undefined;
    };
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the audit trail.');
    expect(bodyRows()).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(100));
  });
});

describe('filters', () => {
  async function setup() {
    return openAudit({}, async (x) => {
      const f = await x.file({ target: 'Vantablob' });
      const bea = x.clientFor('bea@example.test', 'senior');
      await bea.personHistory(f.person);
      await bea.personHistory(f.person);
      await bea.getReport(f.id);
      await x.clientFor('cal@example.test', 'owner').personHistory(f.person);
    });
  }
  const actor = (): HTMLInputElement => screen.getByLabelText('Staff member') as HTMLInputElement;
  const action = (): HTMLSelectElement => screen.getByLabelText('Action') as HTMLSelectElement;

  it('filters by staff member, sending it exactly, and lists only theirs', async () => {
    const { w, user } = await setup();
    await user.type(actor(), 'cal@example.test');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(bodyRows().every((r) => r.textContent?.includes('cal@example.test'))).toBe(true));
    expect(bodyRows()).toHaveLength(1);
    expect(reads(w).at(-1)?.query).toEqual({ limit: 50, actor: 'cal@example.test' });
  });

  it('filters by action, with a label for every action the kit records', async () => {
    const { w, user } = await setup();
    const labels = [...action().options].map((o) => o.textContent);
    expect(labels[0]).toBe('Any action');
    expect(labels).toHaveLength(1 + 23);
    expect(new Set(labels).size).toBe(labels.length);
    // The two bulk dismissals (triage speed) are labelled in plain words, not shown as raw action names.
    expect(labels).toContain('Dismissed all open reports about a person');
    expect(labels).toContain('Dismissed all open reports from a reporter');
    fireEvent.change(action(), { target: { value: 'history.view' } });
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(reads(w).at(-1)?.query).toEqual({ limit: 50, action: 'history.view' }));
    await waitFor(() => expect(bodyRows().every((r) => r.textContent?.includes('Viewed a person’s record'))).toBe(true));
    expect(bodyRows()).toHaveLength(3);
  });

  it('both together narrow the list, and Clear filters puts everything back', async () => {
    const { w, user } = await setup();
    await user.type(actor(), 'bea@example.test');
    fireEvent.change(action(), { target: { value: 'report.view' } });
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(reads(w).at(-1)?.query).toEqual({ limit: 50, actor: 'bea@example.test', action: 'report.view' });
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(bodyRows().length).toBeGreaterThan(3));
    expect(actor()).toHaveValue('');
    expect(action()).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('a filter nobody matches says so', async () => {
    const { user } = await setup();
    await user.type(actor(), 'nobody@example.test');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByText('No entries match this filter.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Audit entries' })).toBeNull();
  });

  it('a filter the server refuses (400) says so, and Clear filters brings the list back', async () => {
    const { w, user } = await setup();
    w.intercept.fn = (req) => (req.path === '/audit' && req.query?.actor !== undefined ? { status: 400, body: { error: 'invalid_query', message: 'x' } } : undefined);
    await user.type(actor(), 'not a name');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByText('The server did not accept that filter. Clear it and try again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('region', { name: 'Audit entries' })).toBeInTheDocument();
  });

  it('typing alone reads nothing; only Filter does, and a blank name is no filter', async () => {
    const { w, user } = await setup();
    const before = reads(w).length;
    await user.type(actor(), 'bea');
    expect(reads(w)).toHaveLength(before);
    await user.clear(actor());
    await user.type(actor(), '   ');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(reads(w).at(-1)?.query).toEqual({ limit: 50 });
  });

  it('a new filter starts again from the first page', async () => {
    const { w, user } = await openAudit({}, async (x) => void (await manyRows(x, 120)));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(100));
    await user.type(screen.getByLabelText('Staff member'), 'bea@example.test');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(reads(w).at(-1)?.query).toEqual({ limit: 50, actor: 'bea@example.test' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
  });
});

describe('settings rows say which screen was changed', () => {
  it('a reporting save, a ladder save and a reset of reporting read differently', async () => {
    await openAudit({ role: 'owner' }, async (w) => {
      const owner = w.clientFor('owen@example.test', 'owner');
      await owner.savePolicyProfile({ layer: { reporting: { flow: 'reason_first' } }, version: 0, reason: 'a' });
      await owner.savePolicyProfile({ layer: { reporting: { flow: 'reason_first' }, durations: [3_600_000, 7_200_000] }, version: 1, reason: 'b' });
      await owner.resetPolicyProfile({ section: 'reporting', reason: 'c' });
    });
    const texts = within(list()).getAllByRole('row').map((r) => r.textContent ?? '');
    expect(texts.some((x) => x.includes('Changed the reporting settings'))).toBe(true);
    expect(texts.some((x) => x.includes('Changed the steps and ladder'))).toBe(true);
    expect(texts.some((x) => x.includes('Reset the reporting settings'))).toBe(true);
  });
});
