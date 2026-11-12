import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppealDialog } from '../src/AppealDialog.js';
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

// Appeals (0.1.9): an appeal is filed from a notice id and answered with an appeal id, a statement goes up and a decision comes down.
// None of that, and nothing a moderator wrote, may stand in the markup: the only things on the page are words.
describe('appeals: no identifier appears in any answer', () => {
  const SERVER_FIELDS = { reason: 'private moderator reason', decidedBy: 'ann@example.test', groupId: 'grp-secret-77', subject: 's_aaaaaaaaaaaaaaaaaaaaaa', statement: 'a statement the player wrote', sanction: { kind: 'ban' }, roomId: 'room-77', ip: '203.0.113.9' };
  const SERVER_STRINGS = Object.values(SERVER_FIELDS).filter((v): v is string => typeof v === 'string');

  async function appealWorld() {
    const w = await playerWorld({ appeals: { perPlayerPerWeek: 20 } });
    await w.warn(ALICE, { rule: 2, lines: ['you play like a snerp'] });
    w.clock.t += DAY;
    await w.sanction(ALICE, 'chat', { rule: 1, durationMs: DAY, lines: ['glarn'] });
    await w.sanction(CARA, 'warning', { rule: 1, lines: ['cara line tarvo'] });
    return w;
  }
  const appealSecrets = (w: PlayerWorld, ids: string[]): string[] => [...secrets(w), ...ids, ...SERVER_STRINGS, 'private appeal reason', 'bea@example.test'];

  it('MyRecord with appeals on, in every state of an appeal: none, sent, and decided; then the outcome notice', async () => {
    const w = await appealWorld();
    const codes = w.record(ALICE).map((n) => n.refCode as string);
    const first = w.noticeOf(ALICE, 0);
    const ids: string[] = [first, w.noticeOf(ALICE, 1)];
    const view = (key: number) => <MyRecord client={w.client} now={w.now} {...FIXED} appeals appealUrl="https://game.test/appeal" refreshKey={key} />;
    const r = renderUi(view(1));
    await screen.findAllByRole('button', { name: 'Think this is a mistake?' });
    expectClean(document.body.innerHTML, w, codes);
    const sent = await w.client.fileAppeal(first, 'a statement the player wrote');
    if (!sent.ok) throw new Error('refused');
    ids.push(sent.appeal.id);
    r.rerender(view(2));
    await screen.findByText(/^Appeal sent /);
    for (const s of appealSecrets(w, ids)) expect(document.body.innerHTML, s).not.toContain(s);
    expectClean(document.body.innerHTML, w, codes);
    await w.decideAppeal(ALICE, 'uphold');
    r.rerender(view(3));
    await screen.findByText('We kept the decision');
    for (const s of appealSecrets(w, ids)) expect(document.body.innerHTML, s).not.toContain(s);
    expectClean(document.body.innerHTML, w, codes);
    r.unmount();
    renderUi(<NoticeQueue client={w.client} now={w.now} {...FIXED} appeals />);
    await screen.findByRole('dialog');
    for (const s of appealSecrets(w, ids)) expect(document.body.innerHTML, s).not.toContain(s);
  });

  it('the dialog: not while typing, not after sending, not after a refusal', async () => {
    const w = await appealWorld();
    const noticeId = w.noticeOf(ALICE, 0);
    const codes = w.record(ALICE).map((n) => n.refCode as string);
    const { user, rerender } = renderUi(<AppealDialog client={w.client} noticeId={noticeId} onClose={() => undefined} {...FIXED} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a statement the player wrote' } });
    // What the player types is in the field's value, not in the markup; nothing else of ours is.
    expect(document.body.innerHTML).not.toContain(noticeId);
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(/^Appeal sent\./);
    const [mine] = await w.client.appeals();
    const ids = [noticeId, mine?.id as string];
    for (const s of appealSecrets(w, ids)) expect(document.body.innerHTML, s).not.toContain(s);
    expectClean(document.body.innerHTML, w, codes);
    rerender(<AppealDialog key="again" client={w.client} noticeId={noticeId} onClose={() => undefined} {...FIXED} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'again' } });
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByRole('alert');
    for (const s of appealSecrets(w, ids)) expect(document.body.innerHTML, s).not.toContain(s);
  });

  it('an answer that carries more than the documented fields never puts the rest on the page', async () => {
    const w = await appealWorld();
    const id = w.noticeOf(ALICE, 0);
    w.intercept.fn = (req) =>
      req.path === '/appeals' && req.method === 'GET'
        ? { status: 200, body: { appeals: [{ id: 'appeal-secret-id', noticeId: id, status: 'upheld', createdAt: 5, decidedAt: 6, ...SERVER_FIELDS }] } }
        : req.path === '/appeals'
          ? { status: 200, body: { appeal: { id: 'appeal-secret-id', noticeId: id, status: 'open', createdAt: 5, decidedAt: null, ...SERVER_FIELDS } } }
          : undefined;
    renderUi(<MyRecord client={w.client} now={w.now} {...FIXED} appeals />);
    await screen.findByText('We kept the decision');
    for (const s of ['appeal-secret-id', ...SERVER_STRINGS]) expect(document.body.innerHTML, s).not.toContain(s);
    // And what the client hands a host is the five fields, so a host that logs it leaks nothing either.
    const filed = await w.client.fileAppeal(id, 'x');
    expect(JSON.stringify(filed)).not.toMatch(/ann@example|203\.0\.113|s_aaaa|room-77|grp-secret|private moderator/);
  });

  it('a notice that is not yours is refused with the same answer as one that does not exist (no probing)', async () => {
    const w = await appealWorld();
    const carasNotice = w.noticeOf(CARA, 0);
    const notMine = await w.client.fileAppeal(carasNotice, 'it is not mine');
    const none = await w.client.fileAppeal('not-a-notice', 'it is not mine');
    expect(notMine).toEqual(none);
    expect(JSON.stringify(notMine)).not.toContain(carasNotice);
  });

  it('the outcome notice carries no id, no reason and no moderator: the page holds the words only', async () => {
    const w = await appealWorld();
    await w.client.fileAppeal(w.noticeOf(ALICE, 0), 'please');
    await w.decideAppeal(ALICE, 'uphold');
    renderUi(<NoticeQueue client={w.client} now={w.now} {...FIXED} />);
    const d = await screen.findByRole('dialog');
    const pending = w.pending(ALICE).map((n) => n.id);
    for (const s of [...appealSecrets(w, pending), 'Mallory', 'bea']) expect(d.innerHTML, s).not.toContain(s);
    expect(d.innerHTML).not.toMatch(/\bs_[A-Za-z0-9_-]{22}\b/);
    expect(d.innerHTML).not.toMatch(/\b[0-9a-f]{24,}\b/i);
  });
});
