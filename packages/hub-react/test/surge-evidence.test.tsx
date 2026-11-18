import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { MINUTE, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// On a case: the report-surge line (design 9.4) and the gameplay-evidence row (design 11). Both are data the server sends on the case only; the queue never shows either. A surge is a hint,
// not a reason to set a report aside; an evidence link is only ever an https link, built from the owner's own template.

const SURGE: WorldOptions = { overrides: { desk: { surge: { enabled: true, reports: 3, windowMinutes: 10, newAccountDays: 2 } } } };
const TEMPLATE: WorldOptions = { overrides: { reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } };

async function surgeCase(options: WorldOptions = {}, n = 3) {
  const w = await hubWorld({ ...SURGE, ...options });
  let last = '';
  for (let i = 0; i < n; i += 1) {
    const f = await w.file({ target: 'Mallory', reporter: `Reporter${i}`, room: `room-${i}` });
    last = f.id;
    w.clock.t += MINUTE;
  }
  return { w, id: last };
}
async function open(w: HubWorld, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('tablist');
  return r;
}

describe('the surge line', () => {
  it('says the numbers and the hint, on the case, when the person is over the threshold', async () => {
    const { w, id } = await surgeCase();
    await open(w, id);
    const line = await screen.findByRole('note', { name: 'Report surge' });
    expect(within(line).getByText('3 reports in 10 minutes from 3 players.')).toBeInTheDocument();
    expect(within(line).getByText('A hint, not a reason to set reports aside.')).toBeInTheDocument();
  });

  it('adds the new-account half when the kit knows account ages, and leaves it out when newAccounts is null', async () => {
    const withAges = await surgeCase();
    withAges.w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${withAges.id}`) {
        const real = await withAges.w.direct.getReport(withAges.id);
        return { status: 200, body: { ...real, report: { ...real.report, surge: { ...real.report.surge, newAccounts: 3, newAccountDays: 2 } } } };
      }
      return undefined;
    };
    const a = await open(withAges.w, withAges.id);
    expect(await screen.findByText('3 reports in 10 minutes from 3 players, 3 of them accounts under 2 days old.')).toBeInTheDocument();
    a.unmount();
    const none = await surgeCase();
    await open(none.w, none.id);
    const line = await screen.findByRole('note', { name: 'Report surge' });
    expect(line.textContent).not.toContain('accounts under');
  });

  it('is not there under the threshold, or with the setting off', async () => {
    const few = await surgeCase({}, 2);
    const a = await open(few.w, few.id);
    expect(screen.queryByRole('note', { name: 'Report surge' })).toBeNull();
    a.unmount();
    const off = await surgeCase({ overrides: { desk: { surge: { enabled: false } } } });
    await open(off.w, off.id);
    expect(screen.queryByRole('note', { name: 'Report surge' })).toBeNull();
  });

  it('is only on the case: the queue row, the Reports list and Overview carry no surge', async () => {
    const { w } = await surgeCase();
    renderHub(w);
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).getAllByRole('listitem').length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toMatch(/surge|A hint, not a reason/i);
  });

  it('numbers are drawn as sent: one reporter reads in the singular', async () => {
    const w = await hubWorld({ ...SURGE });
    const f = await w.file({ target: 'Mallory', reporter: 'Solo' });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) {
        const real = await w.direct.getReport(f.id);
        return { status: 200, body: { ...real, report: { ...real.report, surge: { reports: 4, reporters: 1, windowMinutes: 10, newAccounts: 1, newAccountDays: 2 } } } };
      }
      return undefined;
    };
    await open(w, f.id);
    expect(await screen.findByText('4 reports in 10 minutes from 1 player, 1 of them accounts under 2 days old.')).toBeInTheDocument();
  });

  it('is on the Simple card too', async () => {
    const { w, id } = await surgeCase();
    renderHub(w, { path: `/reports/${id}`, mode: 'simple' });
    expect(await screen.findByRole('note', { name: 'Report surge' })).toBeInTheDocument();
  });
});

describe('the evidence row', () => {
  async function evidenceCase(ref: string | undefined, options: WorldOptions = {}) {
    const w = await hubWorld(options);
    w.cw.rooms.seat('room-e', 'p1', { clientKey: 'key-r' }, 'Rhea');
    w.cw.rooms.seat('room-e', 'p2', { clientKey: 'key-t' }, 'Mallory');
    w.cw.chat.accept('room-e', 'p2', 'a line');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: 'room-e', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment', ...(ref === undefined ? {} : { evidenceRef: ref }) });
    if (!res.ok) throw new Error('refused');
    return { w, id: res.reportId };
  }

  it('is a link built from the owner\'s template, with rel noopener noreferrer, for an https url', async () => {
    const { w, id } = await evidenceCase('match_123', TEMPLATE);
    await open(w, id);
    const row = await screen.findByText('Match or replay');
    const link = within(row.parentElement as HTMLElement).getByRole('link', { name: 'match_123' });
    expect(link).toHaveAttribute('href', 'https://replays.example.test/m/match_123');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('is a plain ref when there is no template', async () => {
    const { w, id } = await evidenceCase('match_123');
    await open(w, id);
    const row = (await screen.findByText('Match or replay')).parentElement as HTMLElement;
    expect(row).toHaveTextContent('match_123');
    expect(within(row).queryByRole('link')).toBeNull();
  });

  it('is nothing at all for a report with no ref', async () => {
    const { w, id } = await evidenceCase(undefined, TEMPLATE);
    await open(w, id);
    await screen.findByRole('tablist');
    expect(screen.queryByText('Match or replay')).toBeNull();
  });

  it.each(['javascript:alert(1)', 'http://replays.example.test/m/x', 'data:text/html,<b>x</b>', 'https://user:pw@replays.example.test/x', '//replays.example.test/x', 'ftp://x.test/y', ' https://x.test/y'])('a bad server\'s url %s is text, never a link', async (url) => {
    const { w, id } = await evidenceCase('match_123', TEMPLATE);
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${id}`) {
        const real = await w.direct.getReport(id);
        return { status: 200, body: { ...real, report: { ...real.report, evidence: { ref: 'match_123', url } } } };
      }
      return undefined;
    };
    await open(w, id);
    const row = (await screen.findByText('Match or replay')).parentElement as HTMLElement;
    expect(within(row).queryByRole('link')).toBeNull();
    expect(row.querySelector('a')).toBeNull();
    expect(row).toHaveTextContent('match_123');
  });

  it('shows the ref as text even when it looks like markup', async () => {
    const { w, id } = await evidenceCase('match_123', TEMPLATE);
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${id}`) {
        const real = await w.direct.getReport(id);
        return { status: 200, body: { ...real, report: { ...real.report, evidence: { ref: '<img src=x onerror=alert(1)>', url: null } } } };
      }
      return undefined;
    };
    await open(w, id);
    const row = (await screen.findByText('Match or replay')).parentElement as HTMLElement;
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('is on the Simple card too, and never in the queue', async () => {
    const { w, id } = await evidenceCase('match_123', TEMPLATE);
    renderHub(w, { path: `/reports/${id}`, mode: 'simple' });
    expect(await screen.findByText('Match or replay')).toBeInTheDocument();
    const pane = screen.getByRole('region', { name: 'Open cases' });
    expect(within(pane).queryByText(/match_123|Match or replay/)).toBeNull();
  });
});
