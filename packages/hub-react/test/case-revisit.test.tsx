import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// Fix round 2 (N1, N3): a decided case is off the screen only in the visit where it was decided; coming back to it later shows it
// as the closed case it is. And the notice offers a way on while the decision is being sent, not only while it is held.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

async function decideIt(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  await r.user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
  await r.user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Clear from the chat.');
  await r.user.click(within(panel()).getByRole('button', { name: 'Decide' }));
  await pageHides();
  await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
  return r;
}

/** What a closed case shows when it is visited again: its header, transcript and record, and the result with its reference code. */
async function expectClosedCase(w: HubWorld, f: { person: string }) {
  expect(await screen.findByRole('heading', { level: 2, name: /report against Mallory/ })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Chat lines' })).toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: 'About this case' })).toBeVisible();
  expect(screen.getByRole('tablist')).toBeInTheDocument();
  const code = w.cw.sanctions.forPerson(f.person)[0]!.refCode;
  expect(await within(panel()).findByText(`${code} (Chat restriction)`)).toBeInTheDocument();
  expect(within(panel()).getByRole('list', { name: 'Reference codes' })).toBeInTheDocument();
  // It is a closed case: what was decided, not a form.
  expect(within(panel()).getByText('Actioned')).toBeInTheDocument();
  expect(within(panel()).queryByRole('button', { name: 'Decide' })).toBeNull();
}

describe('N1: a decided case can be visited again', () => {
  it('open, decide, wait out the hold, go away and come back: the closed case is whole, with its result', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    const { router } = await decideIt(w, f.id);
    act(() => router.navigate('/'));
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    act(() => router.navigate(`/reports/${f.id}`));
    await expectClosedCase(w, f);
  });

  it('coming back from the Reports list (Actioned) shows it too', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    const { user, router } = await decideIt(w, f.id);
    act(() => router.navigate('/reports?status=actioned'));
    await user.click(await screen.findByRole('link', { name: /^Review the newest report against Mallory/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${f.id}`));
    await expectClosedCase(w, f);
  });

  it('coming back from a person link (the History link in the pane) shows it too', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    const { router } = await decideIt(w, f.id);
    act(() => router.navigate(`/people/${f.person}`));
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    act(() => router.navigate(`/reports/${f.id}`));
    await expectClosedCase(w, f);
  });

  it('a case decided with "Decide and take next" (the bar was gone before it was sent) is whole when visited later', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'Ra', room: 'ra' });
    w.clock.t += 1000;
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', room: 'rb' });
    const { user, router } = renderHub(w, { path: `/reports/${a.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against Mallory/ });
    await within(panel()).findByRole('radio', { name: 'Fair' });
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Done.');
    await user.click(within(panel()).getByRole('button', { name: /^Decide and take next/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    await pageHides();
    await waitFor(() => expect(w.cw.reports.get(a.id)?.status).toBe('actioned'));
    act(() => router.navigate(`/reports/${a.id}`));
    await expectClosedCase(w, a);
  });

  it('in the visit where it was decided it is still off the screen until you leave (the result is the whole pane)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    await decideIt(w, f.id);
    expect(screen.queryByRole('heading', { level: 2, name: /report against/ })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Chat lines' })).toBeNull();
    expect(document.querySelector('.cw-ctx')).toHaveAttribute('hidden');
  });
});

describe('N3: the notice has a way on while the decision is being sent', () => {
  it('Take next case is offered while it is held and while it is sending', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    await within(panel()).findByRole('radio', { name: 'Fair' });
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Done.');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    w.intercept.fn = async (req) => {
      if (isDecide(req)) await held;
      return undefined;
    };
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    expect(within(panel()).getByRole('button', { name: /^Take next case/ })).toBeInTheDocument();
    await pageHides();
    // Now the request is out and has not answered: "Deciding", with a button to go on.
    const sending = await within(panel()).findByText('Deciding');
    expect(sending.closest('[aria-busy="true"]')).not.toBeNull();
    expect(within(panel()).getByRole('button', { name: /^Take next case/ })).toBeInTheDocument();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
  });
});
