import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MyRecord } from '../src/MyRecord.js';
import { NoticeQueue } from '../src/NoticeQueue.js';
import { ReportDialog } from '../src/ReportDialog.js';
import { RestrictedChatLine } from '../src/RestrictedChatLine.js';
import { RulesPage } from '../src/RulesPage.js';
import { FIXED, findStatus, renderUi, SIX_REASONS } from './render.js';
import { ALICE, BOB, CARA, DAY, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

// Players see these components inside a game. Whatever the kit knows about other people, a room or the staff stays out of the
// markup: the only identifier a player may see is a reference code (M-XXXXX) of their own sanction. Every check here is a scan
// of the page's innerHTML (attributes and text both), so an id in a data attribute or a title counts as much as one in a line.

const REF_CODE = /\bM-[A-Z0-9]{5}\b/g;

/** A world where Alice is sanctioned three ways over reports from Bob, with staff text, rooms and keys all around. */
async function world() {
  const w = await playerWorld();
  await w.warn(ALICE, { rule: 2, lines: ['you play like a snerp'] });
  w.clock.t += DAY;
  await w.sanction(ALICE, 'chat', { rule: 1, durationMs: DAY, lines: ['glarn'] });
  await w.sanction(ALICE, 'ban', { rule: 3, durationMs: null, lines: ['vlemmo'] });
  // Cara is in the same rooms' world and has her own history.
  await w.sanction(CARA, 'warning', { rule: 1, lines: ['cara line tarvo'] });
  return w;
}

function secrets(w: PlayerWorld): string[] {
  const staffRefs: string[] = [];
  for (const r of w.cw.reports.list().items) staffRefs.push(r.targetPerson, r.reporterPerson, ...r.people);
  const ids = [...w.pending(ALICE), ...w.record(ALICE), ...w.pending(BOB), ...w.pending(CARA)].map((n) => n.id);
  return [
    ...staffRefs,
    ...ids,
    ...w.cw.reports.list().items.map((r) => r.id),
    ALICE.key,
    BOB.key,
    CARA.key,
    'ann@example.test',
    'private moderator reason',
    'reporter line the target must never see',
    'a private gap note',
  ];
}

function expectClean(html: string, w: PlayerWorld, allowCodes: string[]): void {
  for (const s of secrets(w)) expect(html, s).not.toContain(s);
  // A subject id of the kit (s_ plus 22 characters), a person ref (a: or k:), a room id, an address, a long hex id, an email.
  expect(html).not.toMatch(/\bs_[A-Za-z0-9_-]{22}\b/);
  expect(html).not.toMatch(/(^|[^A-Za-z0-9])[ak]:[A-Za-z0-9_-]{6,}/);
  expect(html).not.toMatch(/\broom-\d+\b/);
  expect(html).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  expect(html).not.toMatch(/\b[0-9a-f]{24,}\b/i);
  expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  // Other people's handles and the staff names never appear in Alice's view.
  for (const name of ['Bob', 'Cara', 'Mallory']) expect(html, name).not.toContain(name);
  // Only her own reference codes.
  const codes = html.match(REF_CODE) ?? [];
  for (const c of codes) expect(allowCodes, c).toContain(c);
}

describe('no identifier leaks into the page', () => {
  it('NoticeQueue: every notice in turn, innerHTML scanned', async () => {
    const w = await world();
    const mine = w.pending(ALICE);
    expect(mine.length).toBe(3);
    const codes = mine.map((n) => n.refCode as string);
    const { user, container } = renderUi(<NoticeQueue client={w.client} now={w.now} {...FIXED} appealUrl="https://game.test/appeal" />);
    for (let i = 0; i < 3; i += 1) {
      await screen.findByRole('dialog');
      expectClean(document.body.innerHTML, w, codes);
      expect(container.innerHTML).toContain(codes[i] as string);
      await user.click(screen.getByRole('button', { name: /Acknowledge|Got it/ }));
      await waitFor(() => expect(screen.queryByText(codes[i] as string)).toBeNull());
    }
  });

  it('NoticeQueue: the thank-you to a reporter names no one', async () => {
    const w = await world();
    w.caller.key = BOB.key;
    renderUi(<NoticeQueue client={w.client} now={w.now} {...FIXED} />);
    await screen.findByRole('dialog');
    const html = document.body.innerHTML;
    for (const name of ['Alice', 'Cara']) expect(html).not.toContain(name);
    expect(html).not.toMatch(REF_CODE);
    expect(html).not.toMatch(/\bs_[A-Za-z0-9_-]{22}\b/);
  });

  it('MyRecord: the whole record, innerHTML scanned', async () => {
    const w = await world();
    const codes = w.record(ALICE).map((n) => n.refCode as string);
    renderUi(<MyRecord client={w.client} now={w.now} {...FIXED} appealUrl="https://game.test/appeal" />);
    await screen.findByRole('list', { name: 'Your record' });
    expectClean(document.body.innerHTML, w, codes);
    for (const c of codes) expect(document.body.innerHTML).toContain(c);
  });

  it('MyRecord: one player never sees another player record', async () => {
    const w = await world();
    w.caller.key = CARA.key;
    renderUi(<MyRecord client={w.client} now={w.now} {...FIXED} />);
    await screen.findByRole('list', { name: 'Your record' });
    expect(document.body).not.toHaveTextContent('snerp');
    expect(document.body).not.toHaveTextContent('glarn');
    expect(document.body).toHaveTextContent('cara line tarvo');
  });

  it('a notice list carries no other field into the page even when the server sends one', async () => {
    const w = await world();
    w.intercept.fn = (req) =>
      req.method === 'GET'
        ? {
            status: 200,
            body: {
              notices: [
                {
                  id: 'n-secret-id',
                  kind: 'ban',
                  rule: 1,
                  ruleLabel: 'Community Rule 1: Be kind',
                  until: null,
                  refCode: 'M-ABCDE',
                  excerpt: [{ text: 'own line', day: '2027-01-15', roomId: 'room-77', handle: 'Mallory' }],
                  createdAt: 5,
                  mustAcknowledge: false,
                  subject: 's_aaaaaaaaaaaaaaaaaaaaaa',
                  actor: 'ann@example.test',
                  reason: 'private moderator reason',
                  ip: '203.0.113.9',
                },
              ],
            },
          }
        : undefined;
    renderUi(<NoticeQueue client={w.client} now={w.now} {...FIXED} />);
    await screen.findByRole('dialog');
    const html = document.body.innerHTML;
    for (const s of ['n-secret-id', 'room-77', 'Mallory', 's_aaaa', 'ann@example.test', 'private moderator reason', '203.0.113.9']) expect(html, s).not.toContain(s);
    expect(html).toContain('M-ABCDE');
  });

  it('RulesPage: the rules only', async () => {
    const w = await world();
    renderUi(<RulesPage client={w.client} now={w.now} {...FIXED} />);
    await screen.findByRole('list', { name: 'Community rules' });
    expectClean(document.body.innerHTML, w, []);
  });

  it('RestrictedChatLine: only what it is given', () => {
    const { container } = renderUi(<RestrictedChatLine {...FIXED} until={Date.now() + DAY} byModerator refCode="M-4K7QW" />);
    expect(container.innerHTML.match(REF_CODE)).toEqual(['M-4K7QW']);
    expect(container.innerHTML).not.toMatch(/\bs_[A-Za-z0-9_-]{22}\b/);
  });

  it('ReportDialog: after a report, the page holds no report id, room id or seat', async () => {
    const w = await world();
    w.cw.rooms.seat('rd-room', 'a', { clientKey: ALICE.key }, 'Alice');
    w.cw.rooms.seat('rd-room', 'b', { clientKey: 'key-dave' }, 'Dave');
    w.cw.chat.accept('rd-room', 'b', 'hello');
    const { user } = renderUi(
      <ReportDialog
        {...FIXED}
        reporting={SIX_REASONS}
        onSubmit={(d) => w.cw.reports.submit({ roomId: 'rd-room', reporterSeat: 'a', targetSeat: 'b', reason: d.reason })}
        onClose={() => undefined}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Why?' }), 'Spam');
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await findStatus();
    const html = document.body.innerHTML;
    const [report] = w.cw.reports.list().items.filter((r) => r.roomId === 'rd-room');
    expect(report).toBeDefined();
    for (const s of [report?.id, 'rd-room', 'Dave', 'key-dave', report?.targetPerson, report?.reporterPerson]) expect(html, String(s)).not.toContain(String(s));
  });

  it('the scan itself catches a leak (control)', async () => {
    const w = await world();
    const [first] = w.pending(ALICE);
    expect(() => expectClean(`<p>${first?.id as string}</p>`, w, [])).toThrow();
    expect(() => expectClean('<p>room-3</p>', w, [])).toThrow();
    expect(() => expectClean('<p>s_abcdefghijklmnopqrstuv</p>', w, [])).toThrow();
    expect(() => expectClean('<p>a:3f9c2b7e1d</p>', w, [])).toThrow();
    expect(() => expectClean('<p>Bob</p>', w, [])).toThrow();
    expect(() => expectClean('<p>M-ZZZZZ</p>', w, ['M-AAAAA'])).toThrow();
    expect(() => expectClean('<p>nothing here</p>', w, [])).not.toThrow();
  });

  it('no element carries an id or data attribute from the server: attributes hold only the component own', async () => {
    const w = await world();
    renderUi(<NoticeQueue client={w.client} now={w.now} {...FIXED} />);
    const d = await screen.findByRole('dialog');
    const attrs = new Set<string>();
    for (const el of [d, ...d.querySelectorAll('*')]) for (const a of el.getAttributeNames()) attrs.add(a);
    expect([...attrs].filter((a) => a.startsWith('data-') && a !== 'data-cw-theme' && a !== 'data-kind').sort()).toEqual([]);
    expect(within(d).getAllByRole('heading').length).toBeGreaterThan(0);
  });
});
