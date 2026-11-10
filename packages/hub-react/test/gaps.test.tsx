import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// Rule gaps: the sanctions a moderator filed under "No rule covers this", for the rules review. Everyone with gaps.read sees them;
// an owner closes one as "Made it rule N" or "Not a rule". Against the real routes.

const audits = (w: HubWorld, action: string): unknown[] => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action);
const closes = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/gaps\/.+\/close$/.test(r.path));
const openPanel = (): HTMLElement => screen.getByRole('region', { name: 'Open' });
const closedPanel = (): HTMLElement => screen.getByRole('region', { name: 'Closed' });
const items = (el: HTMLElement): HTMLElement[] => within(el).queryAllByRole('listitem');
const SERVER_500 = { status: 500, body: { error: 'internal', message: 'x' } };

async function openGaps(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
  const w = await hubWorld({ role: 'owner', ...options });
  await prepare?.(w);
  const r = renderHub(w, { path: '/gaps' });
  await screen.findByRole('heading', { level: 2, name: 'Rule gaps' });
  await screen.findByRole('region', { name: 'Open' });
  return { w, ...r };
}

/** Two gaps, the older first (the list is newest first). */
async function twoGaps(w: HubWorld) {
  const a = await w.file({ target: 'Vantablob' });
  const one = await w.sanction(a.person, 'warning', 'uncovered');
  const b = await w.file({ target: 'Kestrel' });
  const two = await w.sanction(b.person, 'chat', 'uncovered');
  return { a, b, one, two };
}

describe('the lists', () => {
  it('says there are no gaps, open or closed', async () => {
    await openGaps();
    expect(within(openPanel()).getByText('No open gaps.')).toBeInTheDocument();
    expect(within(closedPanel()).getByText('Nothing closed yet.')).toBeInTheDocument();
  });

  it('lists an open gap with its ref code, who filed it, when, and the note, newest first', async () => {
    const { w } = await openGaps({}, twoGaps);
    const rows = items(within(openPanel()).getByRole('list', { name: 'Open gaps' }));
    expect(rows).toHaveLength(2);
    const [newest, older] = w.cw.gaps.list();
    expect(rows[0]).toHaveTextContent(`Ref ${newest!.refCode}`);
    expect(rows[1]).toHaveTextContent(`Ref ${older!.refCode}`);
    expect(rows[0]).toHaveTextContent('Filed by ann');
    expect(rows[0]).toHaveTextContent('a gap note');
    expect(within(rows[0]!).getByRole('time')).toBeInTheDocument();
  });

  it('names no person: neither their handle nor their tag is on the page', async () => {
    let people: string[] = [];
    await openGaps({}, async (w) => {
      const g = await twoGaps(w);
      people = [g.a.person, g.b.person];
    });
    // The queue beside it names people with open reports; the gaps screen itself names none.
    const main = screen.getByRole('main');
    expect(people).toHaveLength(2);
    for (const p of people) expect(main.textContent).not.toContain(p.slice(0, 8));
    expect(main.textContent).not.toMatch(/Vantablob|Kestrel/);
  });

  it('a closed gap is listed below with how it was closed', async () => {
    const { w } = await openGaps({}, async (x) => {
      const { one, two } = await twoGaps(x);
      await x.direct.closeGap(one.groupId, { status: 'ruled', ref: 2 });
      await x.direct.closeGap(two.groupId, { status: 'not_a_rule' });
    });
    expect(within(openPanel()).getByText('No open gaps.')).toBeInTheDocument();
    const rows = items(within(closedPanel()).getByRole('list', { name: 'Closed gaps' }));
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Not a rule')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Made it a rule')).toBeInTheDocument();
    expect(w.cw.gaps.list().every((g) => g.status !== 'open')).toBe(true);
  });

  it('a long unbroken note stays in its box', async () => {
    const { container } = await openGaps({}, async (w) => {
      const f = await w.file({ target: 'Vantablob' });
      await w.cw.sanctions.apply({ kind: 'warning', subject: f.person, includeIp: false, durationMs: null, reason: 'r', actor: 'ann@example.test', source: 'moderator', automated: false, rule: 'uncovered', gapNote: 'x'.repeat(400) });
    });
    expect(container.querySelector('.cw-gap-note')?.textContent).toHaveLength(400);
  });

  it('reads the gaps once, and reads no rules until a form is opened', async () => {
    const { w } = await openGaps({}, twoGaps);
    expect(w.sent.filter((r) => r.path === '/gaps' && r.method === 'GET')).toHaveLength(1);
    expect(audits(w, 'policy.view')).toHaveLength(0);
    expect(audits(w, 'blocked.view')).toHaveLength(0);
  });
});

describe('who may close', () => {
  it.each(['moderator', 'senior'] as const)('a %s sees the gaps and an owner-only note, and no Close', async (role) => {
    await openGaps({ role }, twoGaps);
    expect(items(within(openPanel()).getByRole('list', { name: 'Open gaps' }))).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Close the gap/ })).toBeNull();
    expect(screen.getByText('An owner closes gaps.')).toBeInTheDocument();
  });

  it('an owner sees Close on each open gap and no owner-only note', async () => {
    await openGaps({}, twoGaps);
    expect(screen.getAllByRole('button', { name: /^Close the gap with ref/ })).toHaveLength(2);
    expect(screen.queryByText('An owner closes gaps.')).toBeNull();
  });

  it('follows the permission table, not the role name: a senior can close when the server says so', async () => {
    await openGaps({ role: 'senior', permissions: { 'gaps.close': 'senior' } }, twoGaps);
    expect(screen.getAllByRole('button', { name: /^Close the gap with ref/ })).toHaveLength(2);
  });

  it('a role that cannot read gaps gets the "not available" page and reads nothing', async () => {
    const w = await hubWorld({ permissions: { 'gaps.read': 'owner' } });
    renderHub(w, { path: '/gaps' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(w.sent.filter((r) => r.path === '/gaps')).toHaveLength(0);
  });
});

describe('closing a gap', () => {
  const choose = (value: string): HTMLSelectElement => {
    const select = screen.getByLabelText('Close it as') as HTMLSelectElement;
    fireEvent.change(select, { target: { value } });
    return select;
  };
  async function open(r: Awaited<ReturnType<typeof openGaps>>, index = 0) {
    await r.user.click(screen.getAllByRole('button', { name: /^Close the gap with ref/ })[index]!);
    const form = await screen.findByRole('form', { name: /^Close the gap with ref/ });
    await waitFor(() => expect((screen.getByLabelText('Close it as') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    return form;
  }

  it('opens a form under the gap with the picker focused: Choose, each active rule, and Not a rule', async () => {
    const r = await openGaps({ retire: [3] }, twoGaps);
    await open(r);
    const select = screen.getByLabelText('Close it as') as HTMLSelectElement;
    expect(select).toHaveFocus();
    const options = [...select.options].map((o) => o.textContent);
    expect(options[0]).toBe('Choose');
    expect(options.at(-1)).toBe('Not a rule');
    expect(options.some((o) => o?.startsWith('Made it rule 1:'))).toBe(true);
    // A retired rule cannot be cited, so it is not offered.
    expect(options.some((o) => o?.startsWith('Made it rule 3:'))).toBe(false);
    expect(options).toHaveLength(2 + r.w.cw.rules.all().filter((x) => x.retired !== true).length);
    expect(audits(r.w, 'policy.view')).toHaveLength(1);
  });

  it('closing as "Made it rule 2" sends the rule, moves the gap to Closed, toasts, and refocuses the title', async () => {
    const r = await openGaps({}, twoGaps);
    const target = r.w.cw.gaps.list()[0]!;
    await open(r);
    const select = screen.getByLabelText('Close it as') as HTMLSelectElement;
    const two = [...select.options].find((o) => o.textContent?.startsWith('Made it rule 2:'))!;
    choose(two.value);
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    await waitFor(() => expect(items(within(openPanel()).getByRole('list', { name: 'Open gaps' }))).toHaveLength(1));
    expect(closes(r.w)).toHaveLength(1);
    expect(closes(r.w)[0]?.body).toEqual({ status: 'ruled', ref: 2 });
    expect(r.w.cw.gaps.list().find((g) => g.groupId === target.groupId)?.status).toBe('ruled');
    expect(within(closedPanel()).getByText('Made it a rule')).toBeInTheDocument();
    expect(await screen.findByText('Gap closed.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Rule gaps' })).toHaveFocus();
    expect(audits(r.w, 'gap.close')).toHaveLength(1);
  });

  it('closing as Not a rule sends no rule', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    choose('none');
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    await waitFor(() => expect(closes(r.w)).toHaveLength(1));
    expect(closes(r.w)[0]?.body).toEqual({ status: 'not_a_rule' });
    await waitFor(() => expect(within(closedPanel()).getByText('Not a rule')).toBeInTheDocument());
  });

  it('closing with nothing chosen says to choose, marks the field, and sends nothing', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    expect(screen.getByText('Choose how to close it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Close it as')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Close it as')).toHaveFocus();
    expect(closes(r.w)).toHaveLength(0);
  });

  it('a rule the server says is not in force (400 invalid_gap_ref) is a field error and the form stays', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    r.w.intercept.fn = (req) => (/\/close$/.test(req.path) ? { status: 400, body: { error: 'invalid_gap_ref', message: 'x' } } : undefined);
    const select = screen.getByLabelText('Close it as') as HTMLSelectElement;
    choose([...select.options].find((o) => o.textContent?.startsWith('Made it rule 1:'))!.value);
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    expect(await screen.findByText('That rule is not in force. Choose another.')).toBeInTheDocument();
    expect(screen.getByLabelText('Close it as')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('form', { name: /^Close the gap with ref/ })).toBeInTheDocument();
    expect(items(within(openPanel()).getByRole('list', { name: 'Open gaps' }))).toHaveLength(2);
  });

  it('a gap someone else closed meanwhile says so, reloads and drops the form', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    await r.w.clientFor('bea@example.test', 'owner').closeGap(r.w.cw.gaps.list()[0]!.groupId, { status: 'not_a_rule' });
    choose('none');
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    expect(await screen.findByText('Someone already closed this gap.')).toBeInTheDocument();
    await waitFor(() => expect(items(within(openPanel()).getByRole('list', { name: 'Open gaps' }))).toHaveLength(1));
    expect(screen.queryByRole('form', { name: /^Close the gap with ref/ })).toBeNull();
  });

  it('a 403 says the role cannot do this and keeps the form', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    r.w.intercept.fn = (req) => (/\/close$/.test(req.path) ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    choose('none');
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    expect(await screen.findByText('Your role cannot do this.')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /^Close the gap with ref/ })).toBeInTheDocument();
  });

  it('a network failure keeps the choice and Try again sends it once more', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    let fail = true;
    r.w.intercept.fn = (req) => {
      if (/\/close$/.test(req.path) && fail) {
        fail = false;
        throw new Error('offline');
      }
      return undefined;
    };
    choose('none');
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server');
    expect(screen.getByLabelText('Close it as')).toHaveValue('none');
    await r.user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(items(within(openPanel()).getByRole('list', { name: 'Open gaps' }))).toHaveLength(1));
  });

  it('a double click sends one close', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r);
    choose('none');
    const close = screen.getByRole('button', { name: 'Close gap' });
    fireEvent.click(close);
    fireEvent.click(close);
    await waitFor(() => expect(items(within(openPanel()).getByRole('list', { name: 'Open gaps' }))).toHaveLength(1));
    expect(closes(r.w)).toHaveLength(1);
  });

  it('Cancel closes the form and returns focus to the Close button; only one form is open at a time', async () => {
    const r = await openGaps({}, twoGaps);
    const buttons = screen.getAllByRole('button', { name: /^Close the gap with ref/ });
    await r.user.click(buttons[0]!);
    await screen.findByRole('form', { name: /^Close the gap/ });
    await r.user.click(buttons[1]!);
    expect(screen.getAllByRole('form', { name: /^Close the gap/ })).toHaveLength(1);
    await r.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: /^Close the gap/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Close the gap with ref/ })[1]).toHaveFocus();
  });

  it('opening a second form reads the rules once for the session, not again', async () => {
    const r = await openGaps({}, twoGaps);
    await open(r, 0);
    await r.user.click(screen.getByRole('button', { name: 'Cancel' }));
    await open(r, 1);
    expect(audits(r.w, 'policy.view')).toHaveLength(1);
    expect(r.w.sent.filter((x) => x.path === '/policy')).toHaveLength(1);
  });

  it('when the rules cannot be loaded it says so and still lets the gap be closed as not a rule', async () => {
    const r = await openGaps({}, twoGaps);
    r.w.intercept.fn = (req) => (req.path === '/policy' ? SERVER_500 : undefined);
    await r.user.click(screen.getAllByRole('button', { name: /^Close the gap with ref/ })[0]!);
    expect(await screen.findByText(/The Community Rules could not be loaded/)).toBeInTheDocument();
    const select = screen.getByLabelText('Close it as') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose', 'Not a rule']);
    fireEvent.change(select, { target: { value: 'none' } });
    await r.user.click(screen.getByRole('button', { name: 'Close gap' }));
    await waitFor(() => expect(closes(r.w)).toHaveLength(1));
  });
});

describe('when it cannot be shown', () => {
  it('a 403 on the list says so with Try again', async () => {
    const w = await hubWorld({ role: 'owner' });
    let n = 0;
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/gaps' && ++n === 1 ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/gaps' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the rule gaps. Your role cannot do this.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Open' })).toBeInTheDocument();
  });

  it('a 500 says the server had a problem', async () => {
    const w = await hubWorld({ role: 'owner' });
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/gaps' ? SERVER_500 : undefined);
    renderHub(w, { path: '/gaps' });
    expect(await screen.findByText(/The server had a problem/)).toBeInTheDocument();
  });
});
