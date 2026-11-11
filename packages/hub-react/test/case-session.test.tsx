import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Working a case: opening it claims it, and while it stays open the claim is renewed every 60 seconds and the "viewing" hint
// every 20, only while the tab is visible.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await tick(0);
};
const calls = (w: HubWorld, suffix: string): number => w.sent.filter((r) => r.path.startsWith('/cases/') && r.path.endsWith(suffix)).length;

async function opened(w: HubWorld, id: string) {
  const view = renderHub(w, { path: `/reports/${id}` });
  await settle();
  return view;
}

describe('the claim and the viewing hint while a case is open', () => {
  it('claims and announces viewing at once on opening', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await opened(w, a.id);
    expect(calls(w, '/claim')).toBe(1);
    expect(calls(w, '/viewing')).toBe(1);
    expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test');
  });

  it('renews the claim every 60 seconds and the viewing hint every 20, while visible', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await opened(w, a.id);
    await tick(19_900);
    expect(calls(w, '/viewing')).toBe(1);
    await tick(200);
    expect(calls(w, '/viewing')).toBe(2);
    await tick(20_000);
    expect(calls(w, '/viewing')).toBe(3);
    expect(calls(w, '/claim')).toBe(1);
    await tick(20_000);
    expect(calls(w, '/claim')).toBe(2);
    expect(calls(w, '/viewing')).toBe(4);
    await tick(60_000);
    expect(calls(w, '/claim')).toBe(3);
  });

  it('keeps the claim alive: the server clock moves, the claim extends and is still ours', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await opened(w, a.id);
    const since = w.cw.cases.holder(a.person)!.since;
    const until = w.cw.cases.holder(a.person)!.until;
    w.clock.t += 9 * 60_000;
    await tick(60_000);
    const holder = w.cw.cases.holder(a.person)!;
    expect(holder.by).toBe('ann@example.test');
    expect(holder.since).toBe(since);
    expect(holder.until).toBeGreaterThan(until);
  });

  it('sends nothing while the tab is hidden, and beats at once when it is visible again', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await opened(w, a.id);
    setVisibility('hidden');
    await tick(0);
    const claim = calls(w, '/claim');
    const view = calls(w, '/viewing');
    await tick(180_000);
    expect(calls(w, '/claim')).toBe(claim);
    expect(calls(w, '/viewing')).toBe(view);
    setVisibility('visible');
    await tick(0);
    expect(calls(w, '/claim')).toBe(claim + 1);
    expect(calls(w, '/viewing')).toBe(view + 1);
  });

  it('stops when the case is left, and starts for the next one', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    const { router } = await opened(w, a.id);
    act(() => router.navigate(`/reports/${b.id}`));
    await settle();
    expect(w.sent.some((r) => r.path === `/cases/${b.person}/claim`)).toBe(true);
    const aClaims = w.sent.filter((r) => r.path === `/cases/${a.person}/claim`).length;
    await tick(180_000);
    expect(w.sent.filter((r) => r.path === `/cases/${a.person}/claim`).length).toBe(aClaims);
    act(() => router.navigate('/'));
    await settle();
    const bClaims = w.sent.filter((r) => r.path === `/cases/${b.person}/claim`).length;
    await tick(180_000);
    expect(w.sent.filter((r) => r.path === `/cases/${b.person}/claim`).length).toBe(bClaims);
  });

  it('does not claim from a screen that is not a case', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await w.file({ target: 'Alpha' });
    renderHub(w, { path: '/' });
    await settle();
    await tick(120_000);
    expect(calls(w, '/claim')).toBe(0);
    expect(calls(w, '/viewing')).toBe(0);
  });
});

describe('a case someone else holds', () => {
  it('is opened to read: one notice naming who, no claim, and the viewing hint still goes', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    await opened(w, a.id);
    expect(screen.getByText('maya is handling this case. Deciding it is refused until they release it.', { selector: '.cw-toast-text' })).toBeInTheDocument();
    expect(w.cw.cases.holder(a.person)?.by).toBe('maya@example.test');
    expect(calls(w, '/viewing')).toBe(1);
    // The next heartbeat does not say it again.
    await tick(60_000);
    expect(screen.queryAllByText('maya is handling this case. Deciding it is refused until they release it.', { selector: '.cw-toast-text' }).length).toBeLessThanOrEqual(1);
    await tick(10_000);
    const notices = w.sent.filter((r) => r.path === `/cases/${a.person}/claim`).length;
    expect(notices).toBeGreaterThanOrEqual(2);
  });

  it('says once when a senior takes over the case you were handling, at the next heartbeat', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await opened(w, a.id);
    await w.clientFor('sam@example.test', 'senior').claimCase(a.person, { takeOver: true });
    await tick(60_000);
    expect(screen.getByText('sam took this case over.')).toBeInTheDocument();
    const row = within(screen.getByRole('region', { name: 'Open cases' })).getAllByRole('listitem')[0]!;
    expect(row).toHaveAttribute('data-claim', 'other');
    expect(w.cw.cases.holder(a.person)?.by).toBe('sam@example.test');
  });

  it('a moderator who cannot decide never claims, but still shows as viewing', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test', permissions: { 'reports.decide': 'senior' } });
    const a = await w.file({ target: 'Alpha' });
    await opened(w, a.id);
    expect(calls(w, '/claim')).toBe(0);
    expect(calls(w, '/viewing')).toBe(1);
    expect(w.cw.cases.holder(a.person)).toBeNull();
  });
});
