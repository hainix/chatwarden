import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The urgent case's strip and its "What to do" panel (design 5.2 and 5.3): the reason as words, the owner's guidance as plain text, the
// studio contact, the two buttons and the kit's limits; the hand-off mark that survives a reload; claims refused in words.

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

async function urgentCase(options: WorldOptions = {}, reason: string | null = 'threat') {
  const w = await hubWorld(options);
  const f = await w.file({ target: 'Threatener', reason });
  return { w, f };
}

const strip = (): HTMLElement => screen.getByRole('region', { name: 'Urgent case' });
const panel = (): HTMLElement => screen.getByRole('region', { name: 'What to do' });

async function open(w: HubWorld, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const view = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('region', { name: 'Urgent case' });
  return view;
}

describe('the case strip', () => {
  it('shows "Urgent: <reason label>" on an urgent case', async () => {
    const { w, f } = await urgentCase();
    await open(w, f.id);
    expect(within(strip()).getByText('Urgent: Threats')).toBeInTheDocument();
  });

  it('a case a moderator marked urgent shows the reason it was filed under', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    await w.direct.setUrgent(f.id, true);
    renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('region', { name: 'Urgent case' });
    expect(within(strip()).getByText('Urgent: Spam or ads')).toBeInTheDocument();
  });

  it('an ordinary case has no strip, no panel and no toggle', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: /Calm/ });
    await screen.findByRole('tablist');
    expect(screen.queryByRole('region', { name: 'Urgent case' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'What to do' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What to do' })).toBeNull();
  });

  it('the panel is open by default, a disclosure that collapses and opens, and the choice is kept in the browser', async () => {
    const { w, f } = await urgentCase();
    const { user, unmount } = await open(w, f.id);
    const toggle = within(strip()).getByRole('button', { name: 'What to do' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await screen.findByRole('region', { name: 'What to do' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'What to do' })).toBeNull();
    unmount();
    await open(w, f.id);
    expect(within(strip()).getByRole('button', { name: 'What to do' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a browser with no storage still works: the panel is open and collapses for the visit', async () => {
    const { w, f } = await urgentCase();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { user } = await open(w, f.id);
    const toggle = within(strip()).getByRole('button', { name: 'What to do' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the "What to do" panel', () => {
  it('renders the owner\'s guidance as plain text (a script tag and a markdown link render literally) and the studio contact', async () => {
    const guidance = 'First <script>alert(1)</script> paragraph\n\nSecond: [click](https://example.test/x) and **bold**';
    const { w, f } = await urgentCase({ overrides: { safety: { guidance, contact: 'Call Pat on 555-0100' } } });
    await open(w, f.id);
    const p = await screen.findByRole('region', { name: 'What to do' });
    expect(p.textContent).toContain('First <script>alert(1)</script> paragraph');
    expect(p.textContent).toContain('Second: [click](https://example.test/x) and **bold**');
    expect(p.querySelector('script, a, strong, em')).toBeNull();
    expect(within(p).getAllByText(/paragraph|Second/)).toHaveLength(2);
    expect(within(p).getByText('Call Pat on 555-0100')).toBeInTheDocument();
  });

  it('shows the default guidance when the owner wrote none, and a line about the contact being unset', async () => {
    const { w, f } = await urgentCase();
    await open(w, f.id);
    const p = await screen.findByRole('region', { name: 'What to do' });
    expect(p.textContent).toContain('You are not asked to judge whether anyone is at risk');
    expect(p.textContent).toContain('follow your studio');
    expect(p.querySelectorAll('p').length).toBeGreaterThanOrEqual(5);
  });

  it('always says what the kit does not do, in one plain line', async () => {
    const { w, f } = await urgentCase({ overrides: { safety: { guidance: 'Be quick.' } } });
    await open(w, f.id);
    const p = await screen.findByRole('region', { name: 'What to do' });
    expect(within(p).getByText('Chatwarden does not judge risk, contact anyone or forward images. It holds text only.')).toBeInTheDocument();
  });

  it('has the two buttons', async () => {
    const { w, f } = await urgentCase();
    await open(w, f.id);
    const p = await screen.findByRole('region', { name: 'What to do' });
    expect(within(p).getByRole('button', { name: 'I passed this to our safety team' })).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: 'Mark as not urgent' })).toBeInTheDocument();
  });

  it('a role without policy.read sees the default guidance and never the studio contact', async () => {
    const { w, f } = await urgentCase({ permissions: { 'policy.read': 'owner' }, overrides: { safety: { guidance: 'Owner words', contact: 'Call Pat on 555-0100' } } });
    await open(w, f.id);
    const p = await screen.findByRole('region', { name: 'What to do' });
    expect(p.textContent).toContain('You are not asked to judge');
    expect(document.body.textContent).not.toContain('Call Pat');
    expect(document.body.textContent).not.toContain('Owner words');
  });
});

describe('the hand-off mark', () => {
  it('records who and when, shows it in the strip, and survives a reload', async () => {
    const { w, f } = await urgentCase({ actor: 'ann@example.test' });
    const { user, unmount } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: 'I passed this to our safety team' }));
    await waitFor(() => expect(within(strip()).getByText(/Passed to the safety team by ann/)).toBeInTheDocument());
    expect(w.sent.filter((r) => r.method === 'POST' && r.path === `/reports/${f.id}/handoff`)).toHaveLength(1);
    // The button is gone once marked: a second click cannot send a second mark.
    expect(screen.queryByRole('button', { name: 'I passed this to our safety team' })).toBeNull();
    unmount();
    await open(w, f.id);
    await waitFor(() => expect(within(strip()).getByText(/Passed to the safety team by ann/)).toBeInTheDocument());
  });

  it('is idempotent on the server: a second mark keeps the first time', async () => {
    const { w, f } = await urgentCase({ actor: 'ann@example.test' });
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: 'I passed this to our safety team' }));
    await waitFor(() => expect(within(strip()).getByText(/Passed to the safety team by ann/)).toBeInTheDocument());
    const first = (await w.direct.getReport(f.id)).report.handoff;
    w.clock.t += 60_000;
    await w.direct.handoff(f.id);
    expect((await w.direct.getReport(f.id)).report.handoff).toEqual(first);
  });

  it('honours the claim in words and keeps the panel and what was open', async () => {
    const { w, f } = await urgentCase({ actor: 'ann@example.test' });
    await w.clientFor('bea@example.test').claimCase(f.person);
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: 'I passed this to our safety team' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('bea is handling this case');
    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I passed this to our safety team' })).toBeInTheDocument();
    expect(within(strip()).queryByText(/Passed to the safety team/)).toBeNull();
  });

  it('a network failure says so in words and keeps the button', async () => {
    const { w, f } = await urgentCase();
    const { user } = await open(w, f.id);
    await screen.findByRole('region', { name: 'What to do' });
    w.intercept.fn = (req) => (req.path.endsWith('/handoff') ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'I passed this to our safety team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/server/i);
    expect(screen.getByRole('button', { name: 'I passed this to our safety team' })).toBeInTheDocument();
  });

  it('the hand-off contacts no one: only one write is sent', async () => {
    const { w, f } = await urgentCase();
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: 'I passed this to our safety team' }));
    await waitFor(() => expect(within(strip()).getByText(/Passed to the safety team/)).toBeInTheDocument());
    expect(w.sent.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`).filter((p) => !p.includes('/claim') && !p.includes('/viewing') && !p.includes('/release'))).toEqual([`POST /reports/${f.id}/handoff`]);
  });
});

describe('Not urgent and Mark as urgent', () => {
  it('"Mark as not urgent" in the panel clears the strip and the queue chip', async () => {
    const { w, f } = await urgentCase();
    const { user } = await open(w, f.id);
    expect(document.querySelector('.cw-urgent-chip')).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Mark as not urgent' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Urgent case' })).toBeNull());
    await waitFor(() => expect(document.querySelector('.cw-urgent-chip')).toBeNull());
    expect((await w.direct.getReport(f.id)).report.urgent).toBe(false);
  });
});

describe('Simple mode', () => {
  it('shows the strip and the panel on the case card', async () => {
    const { w, f } = await urgentCase({ role: 'moderator' });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('region', { name: 'Urgent case' });
    expect(within(strip()).getByText('Urgent: Threats')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'What to do' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I passed this to our safety team' })).toBeInTheDocument();
  });
});
