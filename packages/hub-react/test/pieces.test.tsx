import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/pieces/AuditLog.js';
import { BlockedList } from '../src/pieces/BlockedList.js';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { CaseWorkbench } from '../src/pieces/CaseWorkbench.js';
import { Guide } from '../src/pieces/Guide.js';
import { PersonRecord } from '../src/pieces/PersonRecord.js';
import { RecentActions } from '../src/pieces/RecentActions.js';
import { RuleGaps } from '../src/pieces/RuleGaps.js';
import { TermsManager } from '../src/pieces/TermsManager.js';
import { hubWorld } from './world.js';
import { renderPieces, watchNavigation } from './pieces-kit.js';

// Each piece alone under the provider, on the real routes: no router, no shell, no nav. What it shows, what its callbacks are
// told, that nothing ever moves the page by itself, and what a role without the permission sees.

let nav: ReturnType<typeof watchNavigation>;
beforeEach(() => {
  window.location.hash = '';
  nav = watchNavigation();
});
afterEach(() => {
  nav.restore();
  window.location.hash = '';
});

const noRouterLinks = (el: Element): void => {
  expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([]);
  expect(nav.hash()).toBe('');
  expect(nav.pushed()).toBe(0);
};

describe('every piece stands alone: no shell, no nav, no router', () => {
  it('renders none of the shell around it', async () => {
    const w = await hubWorld({ role: 'owner' });
    const f = await w.file({ target: 'Alpha' });
    const { container } = renderPieces(
      w,
      <>
        <CaseList />
        <CaseCard reportId={f.id} />
        <PersonRecord person={f.person} />
        <TermsManager />
        <BlockedList />
        <AuditLog />
        <RuleGaps />
        <Guide />
        <RecentActions />
      </>,
    );
    await screen.findByRole('region', { name: 'Case against Alpha' });
    for (const shell of ['.cw-top', '.cw-rail', '.cw-body', '.cw-work', '.cw-main', '.cw-snav', 'nav', 'main', '.cw-skip']) {
      expect(container.querySelector(shell), shell).toBeNull();
    }
    noRouterLinks(container);
  });

  it.each([
    ['CaseList', 'cw-queue', () => <CaseList className="mine" />],
    ['TermsManager', 'cw-screen', () => <TermsManager className="mine" />],
    ['BlockedList', 'cw-screen', () => <BlockedList className="mine" />],
    ['AuditLog', 'cw-screen', () => <AuditLog className="mine" />],
    ['RuleGaps', 'cw-screen', () => <RuleGaps className="mine" />],
    ['Guide', 'cw-screen', () => <Guide className="mine" />],
    ['RecentActions', 'cw-screen', () => <RecentActions className="mine" />],
  ] as const)('%s takes className on its own root, which is a .cw-piece', async (name, inner, make) => {
    const w = await hubWorld({ role: 'owner' });
    const { container } = renderPieces(w, make());
    await waitFor(() => expect(container.querySelector(`.${inner}`)).not.toBeNull());
    const root = container.querySelector('.mine') as HTMLElement;
    expect(root, name).toHaveClass('cw-piece');
    expect(root.dataset.cwPiece).toBe(name);
  });
});

describe('CaseList', () => {
  it('lists the open cases, one row per person, longest wait first', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    await w.file({ target: 'Bravo' });
    renderPieces(w, <CaseList />);
    const list = await screen.findByRole('list', { name: 'Cases' });
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('.cw-case-name')?.textContent)).toEqual(['Alpha', 'Bravo']);
  });

  it('a row is a plain row without onOpenCase: no link, no button, no navigation', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const { container } = renderPieces(w, <CaseList />);
    await screen.findByText('Alpha');
    const row = container.querySelector('.cw-case-link') as HTMLElement;
    expect(row.tagName).toBe('DIV');
    noRouterLinks(container);
  });

  it('a click on a row tells onOpenCase the person and the newest report, and nothing moves', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const { container, user } = renderPieces(w, <CaseList onOpenCase={onOpenCase} />);
    await screen.findByText('Alpha');
    const row = container.querySelector('.cw-case-link') as HTMLElement;
    expect(row.tagName).toBe('BUTTON');
    await user.click(row);
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    expect(onOpenCase).toHaveBeenCalledWith(f.person, f.id);
    noRouterLinks(container);
  });

  it('a row opens from the keyboard too', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const { container, user } = renderPieces(w, <CaseList onOpenCase={onOpenCase} />);
    await screen.findByText('Alpha');
    (container.querySelector('.cw-case-link') as HTMLElement).focus();
    await user.keyboard('{Enter}');
    expect(onOpenCase).toHaveBeenCalledWith(f.person, f.id);
  });

  it('marks the selected case', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    await w.file({ target: 'Bravo' });
    const { container } = renderPieces(w, <CaseList selected={a.id} />);
    await screen.findByText('Bravo');
    expect([...container.querySelectorAll('.cw-case')].map((li) => li.getAttribute('data-selected'))).toEqual(['true', null]);
    expect(container.querySelector('.cw-case-link[aria-current="true"]')).not.toBeNull();
  });

  it('Take next claims the oldest free case and hands it to onOpenCase', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const { user } = renderPieces(w, <CaseList onOpenCase={onOpenCase} />);
    await screen.findByText('Alpha');
    await user.click(screen.getByRole('button', { name: /Take next/ }));
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith(a.person, a.id));
    expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test');
  });

  it('Take next without a callback still takes the case, and still navigates nowhere', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const { container, user } = renderPieces(w, <CaseList />);
    await screen.findByText('Alpha');
    await user.click(screen.getByRole('button', { name: /Take next/ }));
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    noRouterLinks(container);
  });

  it('shows no N shortcut hint: nothing in a piece listens for it', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const { container } = renderPieces(w, <CaseList />);
    await screen.findByText('Alpha');
    expect(container.querySelector('.cw-kbd')).toBeNull();
    expect(container.querySelector('[aria-keyshortcuts]')).toBeNull();
  });

  it('says so when nobody is waiting', async () => {
    const w = await hubWorld();
    renderPieces(w, <CaseList />);
    expect(await screen.findByText('All clear')).toBeInTheDocument();
  });

  it('with no permission to read reports, a plain message, and no read of the queue', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    renderPieces(w, <CaseList />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => r.path === '/reports' || r.path === '/changes')).toEqual([]);
  });
});

describe('CaseCard', () => {
  it('is the Simple card for one case, whatever mode the provider is in', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    renderPieces(w, <CaseCard reportId={f.id} />, { mode: 'detailed' });
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    expect(within(card).getByRole('button', { name: /No action needed/ })).toBeInTheDocument();
  });

  it('one click decides: Undo, then the decision is held and not sent', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { user } = renderPieces(w, <CaseCard reportId={f.id} />);
    const dismiss = await screen.findByRole('button', { name: /^No action needed/ });
    w.clock.t += 400;
    await user.click(dismiss);
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(await within(toasts).findByRole('button', { name: 'Undo' }));
    expect(w.sent.filter((r) => /\/decide$/.test(r.path))).toHaveLength(0);
    expect((await w.client.getReport(f.id)).report.status).toBe('open');
  });

  it('unmounting sends a held decision, and the report is decided', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { user, unmount } = renderPieces(w, <CaseCard reportId={f.id} />);
    const dismiss = await screen.findByRole('button', { name: /^No action needed/ });
    w.clock.t += 400;
    await user.click(dismiss);
    unmount();
    await waitFor(async () => expect((await w.client.getReport(f.id)).report.status).not.toBe('open'));
  });

  it('claims the case while it is shown, and lets it go when it leaves', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { unmount } = renderPieces(w, <CaseCard reportId={f.id} />);
    await screen.findByRole('region', { name: 'Case against Alpha' });
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    unmount();
    await waitFor(() => expect(w.cw.cases.holder(f.person)).toBeNull());
  });

  it('a case someone else holds is shown to read, with their name, and no one-click buttons', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.clientFor('bea@example.test').claimCase(f.person);
    renderPieces(w, <CaseCard reportId={f.id} />);
    expect(await screen.findByText(/bea/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^No action needed/ })).toBeNull();
  });

  it('a case that does not exist says so plainly instead of crashing', async () => {
    const w = await hubWorld();
    renderPieces(w, <CaseCard reportId="r_nope" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('Ctrl+Enter decides and goes on to the same person\'s next report: onOpenReport is told which, and nothing moves', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    const second = await w.file({ target: 'Alpha', room: 'room-b' });
    const onOpenReport = vi.fn();
    const { container, user } = renderPieces(w, <CaseCard reportId={first.id} onOpenReport={onOpenReport} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await within(card).findByRole('button', { name: /^No action needed/ });
    within(card).getByRole('button', { name: /^No action needed/ }).focus();
    w.clock.t += 1000;
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(onOpenReport).toHaveBeenCalledWith(second.id));
    noRouterLinks(container);
  });

  it('with no callback the same press still decides, and nothing is opened', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    await w.file({ target: 'Alpha', room: 'room-b' });
    const { container, user } = renderPieces(w, <CaseCard reportId={first.id} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await within(card).findByRole('button', { name: /^No action needed/ });
    within(card).getByRole('button', { name: /^No action needed/ }).focus();
    w.clock.t += 1000;
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findAllByRole('button', { name: 'Undo' })).not.toHaveLength(0);
    noRouterLinks(container);
  });

  it('2 dismisses with no reason and, with nowhere to show a next case, takes none (nothing is claimed that nothing would show)', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    await w.file({ target: 'Bravo', room: 'room-b' });
    const { container, user } = renderPieces(w, <CaseCard reportId={first.id} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    const dismiss = await within(card).findByRole('button', { name: /^No action needed/ });
    w.clock.t += 1000;
    dismiss.focus();
    await user.keyboard('2');
    expect(await screen.findAllByRole('button', { name: 'Undo' })).not.toHaveLength(0);
    expect(w.sent.some((r) => r.path === '/cases/next')).toBe(false);
    noRouterLinks(container);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    const sent = w.sent.find((r) => r.method === 'POST' && /\/decide$/.test(r.path));
    expect(sent?.body).toEqual({ verdict: 'no_action', actions: [] });
  });

  it('keys work only with focus inside the card: with focus elsewhere on the page, 2 does nothing', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    const { user } = renderPieces(
      w,
      <>
        <button type="button">outside</button>
        <CaseCard reportId={first.id} />
      </>,
    );
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await within(card).findByRole('button', { name: /^No action needed/ });
    w.clock.t += 1000;
    screen.getByRole('button', { name: 'outside' }).focus();
    await user.keyboard('2');
    expect(w.sent.some((r) => r.method === 'POST' && /\/decide$/.test(r.path))).toBe(false);
    expect(screen.queryAllByRole('button', { name: 'Undo' })).toHaveLength(0);
  });

  it('a role that cannot read reports gets a plain message and no read of the report', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    renderPieces(w, <CaseCard reportId="r_x" />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => /^\/reports/.test(r.path))).toEqual([]);
  });

  it('takes className', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { container } = renderPieces(w, <CaseCard reportId={f.id} className="mine" />);
    await screen.findByRole('region', { name: 'Case against Alpha' });
    expect(container.querySelector('.cw-piece.mine')).not.toBeNull();
  });
});

describe('CaseWorkbench', () => {
  it('is the detailed case: header, tabs, evidence, the decision bar, and the record beside it', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    renderPieces(w, <CaseWorkbench reportId={f.id} />, { mode: 'simple' });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: 'About this case' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Decision' })).toBeInTheDocument();
  });

  it('claims once, like the card', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    renderPieces(w, <CaseWorkbench reportId={f.id} />);
    await screen.findByRole('complementary', { name: 'About this case' });
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
  });

  it('shows no link back to a reports list it does not have, and a link to the person only when told where it goes', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const first = renderPieces(w, <CaseWorkbench reportId={f.id} />);
    await screen.findByRole('complementary', { name: 'About this case' });
    expect(screen.queryByText(/Back to/)).toBeNull();
    // Nor a dead "History" beside each person: the words of a link that goes nowhere are not left behind.
    expect(within(screen.getByRole('complementary', { name: 'About this case' })).queryByText('History')).toBeNull();
    noRouterLinks(first.container);
    first.unmount();
    const onOpenPerson = vi.fn();
    const second = renderPieces(w, <CaseWorkbench reportId={f.id} onOpenPerson={onOpenPerson} />);
    const aside = await screen.findByRole('complementary', { name: 'About this case' });
    const buttons = await within(aside).findAllByRole('button', { name: /history/i });
    await second.user.click(buttons[0] as HTMLElement);
    expect(onOpenPerson).toHaveBeenCalledWith(expect.any(String));
    noRouterLinks(second.container);
  });

  it("the Reports tab opens a person's other report through onOpenReport", async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha', room: 'room-a' });
    const b = await w.file({ target: 'Alpha', room: 'room-b' });
    const onOpenReport = vi.fn();
    const { user } = renderPieces(w, <CaseWorkbench reportId={a.id} onOpenReport={onOpenReport} />);
    await user.click(await screen.findByRole('tab', { name: /Reports/ }));
    const other = await screen.findByRole('button', { name: /Open/ });
    await user.click(other);
    expect(onOpenReport).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^(${a.id}|${b.id})$`)));
    expect(onOpenReport).not.toHaveBeenCalledWith(a.id === onOpenReport.mock.calls[0]?.[0] ? '' : 'x');
  });

  it("without onOpenReport the Reports tab lists the case's reports with no dead 'Open' beside them", async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha', room: 'room-a' });
    await w.file({ target: 'Alpha', room: 'room-b' });
    const { user } = renderPieces(w, <CaseWorkbench reportId={a.id} />);
    await user.click(await screen.findByRole('tab', { name: /Reports/ }));
    const list = await screen.findByRole('list', { name: /reports/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).queryByText('Open')).toBeNull();
  });

  it('a role that cannot read reports gets a plain message', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    renderPieces(w, <CaseWorkbench reportId="r_x" />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
  });
});

describe('PersonRecord', () => {
  it('shows one person: what is in force, the timeline, how their reports went', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Vlemmo' });
    await w.sanction(f.person, 'chat', 1);
    renderPieces(w, <PersonRecord person={f.person} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Vlemmo' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'In force now' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'As a reporter' })).toBeInTheDocument();
  });

  it('a Revoke works on the real routes', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Vlemmo' });
    await w.sanction(f.person, 'chat', 1);
    const { user } = renderPieces(w, <PersonRecord person={f.person} />);
    await user.click(await screen.findByRole('button', { name: /^Revoke/ }));
    await user.type(await screen.findByLabelText('Why are you revoking this?'), 'sent in error');
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(w.sent.some((r) => /\/revoke$/.test(r.path))).toBe(true));
    await waitFor(() => expect(screen.getByText('Nothing is in force right now.')).toBeInTheDocument());
  });

  it('a report in the timeline is text without onOpenReport, and a button that tells it the id with one', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Vlemmo' });
    const plain = renderPieces(w, <PersonRecord person={f.person} />);
    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.queryByRole('button', { name: /View the .* report/ })).toBeNull();
    // Not a dead "View report" left behind where a link would have been.
    expect(within(screen.getByRole('region', { name: 'Timeline' })).queryByText('View report')).toBeNull();
    noRouterLinks(plain.container);
    plain.unmount();
    const onOpenReport = vi.fn();
    const wired = renderPieces(w, <PersonRecord person={f.person} onOpenReport={onOpenReport} />);
    await wired.user.click(await screen.findByRole('button', { name: /View the .* report/ }));
    expect(onOpenReport).toHaveBeenCalledWith(f.id);
    noRouterLinks(wired.container);
  });

  it('a role that cannot read histories gets a plain message and no read', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'history.read': 'owner' } });
    renderPieces(w, <PersonRecord person="s_x" />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => /history/.test(r.path))).toEqual([]);
  });
});

describe('TermsManager', () => {
  it('lists the terms and adds one', async () => {
    const w = await hubWorld({ role: 'senior' });
    const { user } = renderPieces(w, <TermsManager />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Terms' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Add a term' }));
    await user.type(screen.getByLabelText('Word'), 'zorbakx');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(w.sent.some((r) => r.method === 'POST' && r.path === '/terms')).toBe(true));
  });

  it('a role that cannot read terms gets a plain message', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'terms.read': 'owner' } });
    renderPieces(w, <TermsManager />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => /^\/terms/.test(r.path))).toEqual([]);
  });
});

describe('BlockedList', () => {
  it('lists the lines the filter refused, masked until shown', async () => {
    const w = await hubWorld({ role: 'senior' });
    w.blockLine('Vantablob', 'you zorbak, learn');
    const { item } = w.blockLine('Kestrel', 'you vlemmo');
    renderPieces(w, <BlockedList />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Blocked' })).toBeInTheDocument();
    await screen.findAllByText(item.person.slice(0, 8));
    expect(screen.queryByText('you zorbak, learn')).toBeNull();
    expect(screen.queryByText('you vlemmo')).toBeNull();
  });

  it('a person is a button with onOpenPerson and text without; the Terms buttons appear only with onOpenTerms', async () => {
    const w = await hubWorld({ role: 'senior' });
    const { item } = w.blockLine('Vantablob', 'you zorbak, learn');
    const tag = item.person.slice(0, 8);
    const plain = renderPieces(w, <BlockedList />);
    await screen.findByText(tag, { selector: '.cw-pid' });
    expect(screen.queryByRole('button', { name: /Add exception|Add an exception/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /View term|Look at the term/i })).toBeNull();
    noRouterLinks(plain.container);
    plain.unmount();
    const onOpenPerson = vi.fn();
    const onOpenTerms = vi.fn();
    const wired = renderPieces(w, <BlockedList onOpenPerson={onOpenPerson} onOpenTerms={onOpenTerms} />);
    await wired.user.click(await screen.findByRole('button', { name: new RegExp(tag) }));
    expect(onOpenPerson).toHaveBeenCalledWith(item.person);
    const view = (await screen.findAllByRole('button', { name: /term/i })).find((b) => /View/i.test(b.textContent ?? ''));
    await wired.user.click(view as HTMLElement);
    expect(onOpenTerms).toHaveBeenCalledTimes(1);
    noRouterLinks(wired.container);
  });

  it('a role that cannot read blocked lines gets a plain message', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'blocked.read': 'owner' } });
    renderPieces(w, <BlockedList />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => /^\/blocked/.test(r.path))).toEqual([]);
  });
});

describe('AuditLog', () => {
  it('lists what staff did, for a senior', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Alpha' });
    await w.client.getReport(f.id);
    renderPieces(w, <AuditLog />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Audit' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    expect(w.sent.some((r) => r.path === '/audit')).toBe(true);
  });

  it('a moderator gets a plain message and the audit is never asked for', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderPieces(w, <AuditLog />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => r.path === '/audit')).toEqual([]);
  });
});

describe('RuleGaps', () => {
  it('lists the gaps, and a moderator cannot close one', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Alpha' });
    await w.sanction(f.person, 'warning', 'uncovered');
    renderPieces(w, <RuleGaps />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Rule gaps' })).toBeInTheDocument();
    await screen.findByText(/a gap note/);
    expect(screen.queryByRole('button', { name: /Close/ })).toBeNull();
  });

  it('an owner can close one', async () => {
    const w = await hubWorld({ role: 'owner' });
    const f = await w.file({ target: 'Alpha' });
    await w.sanction(f.person, 'warning', 'uncovered');
    renderPieces(w, <RuleGaps />);
    expect(await screen.findByRole('button', { name: /Close/ })).toBeInTheDocument();
  });
});

describe('Guide', () => {
  it('shows the generated guide', async () => {
    const w = await hubWorld({ role: 'senior' });
    renderPieces(w, <Guide />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Guide' })).toBeInTheDocument();
    await waitFor(() => expect(w.sent.some((r) => r.path === '/policy')).toBe(true));
  });

  it('a role that cannot read policy gets a plain message', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
    renderPieces(w, <Guide />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
    expect(w.sent.filter((r) => r.path === '/policy')).toEqual([]);
  });
});

describe('RecentActions', () => {
  it('lists the actions, each naming the person', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Zorbak-fan' });
    await w.sanction(f.person, 'chat', 1);
    renderPieces(w, <RecentActions />);
    expect(await screen.findByRole('heading', { level: 2, name: 'All actions' })).toBeInTheDocument();
    expect(await screen.findByText('Zorbak-fan')).toBeInTheDocument();
  });

  it('a person is text without onOpenPerson, and a button with it', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Zorbak-fan' });
    await w.sanction(f.person, 'chat', 1);
    const plain = renderPieces(w, <RecentActions />);
    await screen.findByText('Zorbak-fan');
    expect(screen.queryByRole('button', { name: /Zorbak-fan/ })).toBeNull();
    noRouterLinks(plain.container);
    plain.unmount();
    const onOpenPerson = vi.fn();
    const wired = renderPieces(w, <RecentActions onOpenPerson={onOpenPerson} />);
    await wired.user.click(await screen.findByRole('button', { name: /Zorbak-fan/ }));
    expect(onOpenPerson).toHaveBeenCalledWith(f.person);
    noRouterLinks(wired.container);
  });

  it('a role that cannot read histories gets a plain message', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'history.read': 'owner' } });
    renderPieces(w, <RecentActions />);
    expect(await screen.findByText(/can.t open this/)).toBeInTheDocument();
  });
});
