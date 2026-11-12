// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../../src/client.js';
import { emptyForm } from '../../src/decision.js';
import type { DecideInput } from '../../src/types.js';
import { TOAST_HELD_MAX, UNDO_MS } from '../../src/headless/toasts.js';
import { MINUTE } from '../world.js';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// The decision store's quick-action layer: Undo of the newest decision whatever else has happened since, and the sweep ("dismiss all
// open reports about / from") held for the same Undo window as one decision. Real staff routes behind a controller; the clock is the test's.

const DISMISS: DecideInput = { verdict: 'no_action', actions: [] };
const decides = (r: Rig): number => r.count('POST', /^\/reports\/[^/]+\/decide$/);
const sweeps = (r: Rig) => r.w.sent.filter((q) => q.method === 'POST' && q.path === '/reports/dismiss-open');
const status = (r: Rig, id: string): string | undefined => r.controller.decisions.entry(id)?.state.status;
const toastTexts = (r: Rig): string[] => r.controller.toasts.getSnapshot().map((t) => t.text);
const visible = (r: Rig): string[] => r.controller.queue.getSnapshot().visible.map((x) => x.group.person);

async function cases(r: Rig, count: number) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(await r.w.file({ target: `Target${i}`, reporter: `Reporter${i}` }));
  await r.controller.start();
  await settle();
  return out;
}
const dismissCase = (r: Rig, c: { id: string; person: string }, hold: boolean | number = true) =>
  r.controller.decide({ reportId: c.id, person: c.person, input: DISMISS, name: 'Alpha', snapshot: emptyForm() }, { hold });

describe('undoLatest', () => {
  it('undoes the newest held decision and returns its id; again, the next; null when none', async () => {
    const r = await rig();
    const [a, b, c] = await cases(r, 3);
    void dismissCase(r, a!);
    void dismissCase(r, b!);
    void dismissCase(r, c!);
    expect(r.controller.decisions.undoLatest()).toBe(c!.id);
    expect(status(r, c!.id)).toBe('undone');
    expect(r.controller.decisions.undoLatest()).toBe(b!.id);
    expect(status(r, b!.id)).toBe('undone');
    expect(r.controller.decisions.undoLatest()).toBe(a!.id);
    expect(r.controller.decisions.undoLatest()).toBeNull();
    await r.timers.advance(UNDO_MS * 2);
    expect(decides(r)).toBe(0);
  });

  it('returns null and does nothing when no decision was ever made', async () => {
    const r = await rig();
    await cases(r, 1);
    expect(r.controller.decisions.undoLatest()).toBeNull();
  });

  it('skips a decision that has already been sent: only a held one can be undone', async () => {
    const r = await rig();
    const [a, b] = await cases(r, 2);
    void dismissCase(r, a!);
    await r.timers.advance(2_000);
    void dismissCase(r, b!);
    await r.timers.advance(UNDO_MS - 2_000);
    expect(status(r, a!.id)).toBe('done');
    expect(r.controller.decisions.undoLatest()).toBe(b!.id);
    expect(r.controller.decisions.undoLatest()).toBeNull();
  });

  it('after the moderator has gone on, the undone case is shown again; when it is the one open, nothing is shown', async () => {
    const shown: string[] = [];
    let open: string | null = null;
    const r = await rig({ controller: { host: { openReport: () => open, show: (id) => void shown.push(id) } } });
    const [a, b] = await cases(r, 2);
    open = a!.id;
    void dismissCase(r, a!);
    open = b!.id;
    expect(r.controller.decisions.undoLatest()).toBe(a!.id);
    expect(shown).toEqual([a!.id]);
    void dismissCase(r, b!);
    open = b!.id;
    r.controller.decisions.undoLatest();
    expect(shown).toEqual([a!.id]);
  });

  it('gives the claim back, as Undo does', async () => {
    const r = await rig();
    const [a] = await cases(r, 1);
    await r.controller.claim(a!.person);
    const held = r.controller.queue.getSnapshot().groups[0]?.claim;
    expect(held).not.toBeNull();
    void dismissCase(r, a!);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toBeNull();
    r.controller.decisions.undoLatest();
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toEqual(held);
    expect(r.controller.queue.getSnapshot().pending.has(a!.person)).toBe(false);
  });

  it('six decisions in five seconds are all undoable, newest first, and none is sent', async () => {
    const r = await rig();
    const six = await cases(r, 6);
    for (const c of six) {
      void dismissCase(r, c);
      await r.timers.advance(500);
    }
    expect(r.controller.toasts.getSnapshot().filter((t) => t.held)).toHaveLength(6);
    const undone = [];
    for (let i = 0; i < 6; i += 1) undone.push(r.controller.decisions.undoLatest());
    expect(undone).toEqual([...six].reverse().map((c) => c.id));
    expect(r.controller.decisions.undoLatest()).toBeNull();
    await r.timers.advance(UNDO_MS * 2);
    expect(decides(r)).toBe(0);
    expect(visible(r)).toHaveLength(6);
  });

  it('a held toast is not pushed off by news toasts: Undo still works after five of them', async () => {
    const r = await rig();
    const [a] = await cases(r, 1);
    void dismissCase(r, a!);
    for (let i = 0; i < 5; i += 1) r.controller.toasts.push({ text: `news ${i}`, action: { label: 'x', run: () => undefined } });
    await settle();
    expect(status(r, a!.id)).toBe('held');
    expect(r.controller.decisions.undoLatest()).toBe(a!.id);
  });

  it('the 11th held decision commits the oldest (it is sent), and Undo reaches the other ten', async () => {
    const r = await rig();
    const many = await cases(r, TOAST_HELD_MAX + 1);
    for (const c of many) void dismissCase(r, c);
    await settle();
    expect(decides(r)).toBe(1);
    expect(status(r, many[0]!.id)).toBe('done');
    const undone = [];
    for (let i = 0; i < TOAST_HELD_MAX; i += 1) undone.push(r.controller.decisions.undoLatest());
    expect(undone).toEqual(many.slice(1).reverse().map((c) => c.id));
    expect(r.controller.decisions.undoLatest()).toBeNull();
  });

  it('a failed send after the moderator has gone on still surfaces the "not sent" toast with a way back', async () => {
    const shown: string[] = [];
    const r = await rig({ controller: { host: { openReport: () => 'elsewhere', show: (id) => void shown.push(id) } } });
    const [a] = await cases(r, 1);
    r.w.intercept.fn = (req) => (/\/decide$/.test(req.path) ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    void dismissCase(r, a!);
    await r.timers.advance(UNDO_MS);
    const toast = r.controller.toasts.getSnapshot().find((t) => t.tone === 'bad');
    expect(toast?.text).toContain('was not sent');
    toast?.action?.run();
    expect(shown).toEqual([a!.id]);
  });
});

/** Files `count` open reports about one person from different reporters; returns their ids and the person. */
async function aboutOne(r: Rig, count: number, target = 'Mallory') {
  const reports = [];
  for (let i = 0; i < count; i += 1) reports.push(await r.w.file({ target, reporter: `Rep${target}${i}` }));
  return { person: reports[0]!.person, ids: reports.map((x) => x.id), reporters: reports.map((x) => x.reporter) };
}
const request = (scope: 'person' | 'reporter', ref: string, person: string, reportIds: readonly string[], name = 'Mallory') => ({ scope, ref, person, name, reportIds });

describe('dismissOpen (person scope)', () => {
  it('holds, then sends once, then reloads the queue: the case leaves at once and the reports close', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 3);
    await r.controller.start();
    await settle();
    const outcome = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    expect(visible(r)).toEqual([]);
    for (const id of ids) expect(status(r, id)).toBe('held');
    expect(r.controller.decisions.decidedIds()).toEqual(new Set(ids));
    expect(toastTexts(r)).toEqual(['Dismissing 3 reports in 5 s.']);
    await r.timers.advance(UNDO_MS - 1);
    expect(sweeps(r)).toHaveLength(0);
    await r.timers.advance(1);
    expect(sweeps(r)).toHaveLength(1);
    expect(sweeps(r)[0]?.body).toEqual({ scope: 'person', ref: person });
    expect(await outcome).toMatchObject({ status: 'done', result: { ok: true, dismissed: 3, open: 3, dryRun: false } });
    for (const id of ids) expect(status(r, id)).toBe('done');
    expect(r.controller.queue.getSnapshot().groups).toEqual([]);
    expect(r.controller.queue.getSnapshot().pending.has(person)).toBe(false);
    expect(toastTexts(r)).toContain('Dismissed 3 reports.');
    expect((await r.w.client.getReport(ids[0]!)).report.status).toBe('dismissed');
  });

  it('Undo before the send sends nothing and gives the claim back', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    await r.controller.claim(person);
    const held = r.controller.queue.getSnapshot().groups[0]?.claim;
    const outcome = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toBeNull();
    await r.timers.advance(4_000);
    expect(r.controller.decisions.undoLatest()).toBe(ids[0]);
    expect(await outcome).toEqual({ status: 'undone' });
    for (const id of ids) expect(status(r, id)).toBe('undone');
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toEqual(held);
    expect(r.controller.queue.getSnapshot().pending.has(person)).toBe(false);
    expect(visible(r)).toEqual([person]);
    await r.timers.advance(UNDO_MS * 2);
    expect(sweeps(r)).toHaveLength(0);
  });

  it('undo(id) of any one of its reports undoes the whole sweep, once', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 3);
    await r.controller.start();
    await settle();
    const outcome = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    r.controller.decisions.undo(ids[2]!);
    r.controller.decisions.undo(ids[0]!);
    expect(await outcome).toEqual({ status: 'undone' });
    expect(ids.map((id) => status(r, id))).toEqual(['undone', 'undone', 'undone']);
    await r.timers.advance(UNDO_MS * 2);
    expect(sweeps(r)).toHaveLength(0);
  });

  it('Undo after the moderator has gone on shows the case again', async () => {
    const shown: string[] = [];
    const r = await rig({ controller: { host: { openReport: () => 'elsewhere', show: (id) => void shown.push(id) } } });
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    void r.controller.decisions.dismissOpen(request('person', person, person, ids));
    r.controller.decisions.undoLatest();
    expect(shown).toEqual([ids[0]]);
  });

  it('a second confirm for the same sweep while one waits is ignored and answers what the first answers', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    const first = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    const second = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    await r.timers.advance(UNDO_MS);
    expect(sweeps(r)).toHaveLength(1);
    expect(await second).toEqual(await first);
    expect(r.controller.toasts.getSnapshot().filter((t) => t.held)).toEqual([]);
  });

  it('a decision already waiting on one of its reports keeps its own entry; the sweep covers the rest', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 3);
    await r.controller.start();
    await settle();
    void r.controller.decide({ reportId: ids[0]!, person, input: DISMISS, name: 'Mallory', snapshot: emptyForm() });
    void r.controller.decisions.dismissOpen(request('person', person, person, ids));
    expect(r.controller.toasts.getSnapshot().filter((t) => t.held)).toHaveLength(2);
    await r.timers.advance(UNDO_MS);
    expect(decides(r)).toBe(1);
    expect(sweeps(r)).toHaveLength(1);
  });

  it('hold: false sends at once with no Undo toast', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    const outcome = await r.controller.decisions.dismissOpen(request('person', person, person, ids), { hold: false });
    expect(outcome.status).toBe('done');
    expect(sweeps(r)).toHaveLength(1);
    expect(r.controller.toasts.getSnapshot().filter((t) => t.held)).toEqual([]);
  });

  it('pagehide flushes a held sweep, once, whatever else happens', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    const outcome = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    r.page.close();
    await settle();
    expect(sweeps(r)).toHaveLength(1);
    expect(sweeps(r)[0]).toMatchObject({ keepalive: true });
    expect(await outcome).toMatchObject({ status: 'done' });
    await r.timers.advance(UNDO_MS * 2);
    expect(sweeps(r)).toHaveLength(1);
  });

  it('409 claimed fails the entries, puts the holder in the queue and reports who holds it', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    await r.w.clientFor('maya@example.test', 'moderator').claimCase(person);
    const outcome = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    await r.timers.advance(UNDO_MS);
    const done = await outcome;
    expect(done.status).toBe('failed');
    const error = (done as { error: HubError }).error;
    expect(error).toMatchObject({ status: 409, code: 'claimed', heldBy: 'maya@example.test' });
    for (const id of ids) expect(status(r, id)).toBe('failed');
    expect(r.controller.queue.getSnapshot().groups[0]?.claim?.by).toBe('maya@example.test');
    expect(r.controller.queue.getSnapshot().pending.has(person)).toBe(false);
    expect(toastTexts(r).join(' ')).toContain('Nothing was dismissed');
    expect((await r.w.client.getReport(ids[0]!)).report.status).toBe('open');
  });

  it('a failed sweep can be sent again once its entries are dismissed (a senior\'s takeOver)', async () => {
    const r = await rig({ world: { role: 'senior', actor: 'sen@example.test' } });
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    await r.w.clientFor('maya@example.test', 'moderator').claimCase(person);
    const first = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    await r.timers.advance(UNDO_MS);
    expect((await first).status).toBe('failed');
    for (const id of ids) r.controller.decisions.dismiss(id);
    const second = await r.controller.decisions.dismissOpen({ ...request('person', person, person, ids), takeOver: true }, { hold: false });
    expect(second).toMatchObject({ status: 'done', result: { dismissed: 2 } });
    expect(sweeps(r).at(-1)?.body).toEqual({ scope: 'person', ref: person, takeOver: true });
  });

  it('any other failure (500) brings the case back with a "nothing was changed" toast', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    r.w.intercept.fn = (req) => (req.path === '/reports/dismiss-open' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    const outcome = r.controller.decisions.dismissOpen(request('person', person, person, ids));
    await r.timers.advance(UNDO_MS);
    expect((await outcome).status).toBe('failed');
    expect(visible(r)).toEqual([person]);
    expect(toastTexts(r)).toContain('The reports could not be dismissed. Nothing was changed.');
  });
});

describe('dismissOpen (reporter scope)', () => {
  it('hides nothing in advance; after the send the reports are gone from the queue', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    const y = await r.w.file({ target: 'Bravo', reporter: 'Rita' });
    const z = await r.w.file({ target: 'Charlie', reporter: 'Sam' });
    await r.controller.start();
    await settle();
    const outcome = r.controller.decisions.dismissOpen(request('reporter', x.reporter, x.person, [x.id, y.id], 'Rita'));
    expect(visible(r)).toHaveLength(3);
    expect(r.controller.queue.getSnapshot().pending.size).toBe(0);
    expect(r.controller.decisions.isPending(x.person)).toBe(false);
    expect(r.controller.decisions.decidedIds().has(x.id)).toBe(false);
    await r.timers.advance(UNDO_MS);
    expect(await outcome).toMatchObject({ status: 'done', result: { dismissed: 2 } });
    expect(r.controller.queue.getSnapshot().groups.map((g) => g.person)).toEqual([z.person]);
    expect(sweeps(r)[0]?.body).toEqual({ scope: 'reporter', ref: x.reporter });
  });

  it('undoLatest undoes a reporter sweep too, and nothing was sent', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    await r.controller.start();
    await settle();
    const outcome = r.controller.decisions.dismissOpen(request('reporter', x.reporter, x.person, [x.id], 'Rita'));
    expect(r.controller.decisions.undoLatest()).not.toBeNull();
    expect(await outcome).toEqual({ status: 'undone' });
    await r.timers.advance(UNDO_MS * 2);
    expect(sweeps(r)).toHaveLength(0);
    expect(visible(r)).toHaveLength(1);
  });

  it('reports held by another moderator stay open and the toast says how many', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    await r.w.file({ target: 'Bravo', reporter: 'Rita' });
    await r.controller.start();
    await settle();
    await r.w.clientFor('maya@example.test', 'moderator').claimCase(x.person);
    const outcome = r.controller.decisions.dismissOpen(request('reporter', x.reporter, x.person, [x.id], 'Rita'));
    await r.timers.advance(UNDO_MS);
    expect(await outcome).toMatchObject({ status: 'done', result: { dismissed: 1, skipped: { claimed: 1 } } });
    expect(toastTexts(r)).toContain('Dismissed 1 report.');
    expect(toastTexts(r)).toContain('1 stays open: another moderator is handling it.');
  });
});

describe('dismissOpen: more, and what is held', () => {
  const fake = (r: Rig, body: object) => {
    r.w.intercept.fn = (req) => (req.path === '/reports/dismiss-open' && req.method === 'POST' ? { status: 200, body } : undefined);
  };
  const base = { ok: true, dryRun: false, open: 200, dismissed: 200, replayed: 0, skipped: { claimed: 0, decided: 0 }, more: true };

  it('more with dismissed > 0: the toast offers "Dismiss more", and choosing it runs the call again at once', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    await r.controller.start();
    await settle();
    fake(r, base);
    void r.controller.decisions.dismissOpen(request('reporter', x.reporter, x.person, [x.id], 'Rita'));
    await r.timers.advance(UNDO_MS);
    const toast = r.controller.toasts.getSnapshot().find((t) => t.text === 'There are more open reports.');
    expect(toast?.action?.label).toBe('Dismiss more');
    expect(sweeps(r)).toHaveLength(1);
    toast?.action?.run();
    await settle();
    expect(sweeps(r)).toHaveLength(2);
    expect(sweeps(r)[1]?.body).toEqual({ scope: 'reporter', ref: x.reporter });
  });

  it('more with dismissed: 0 (held cases fill the window) offers no run-again, only what is held', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    await r.controller.start();
    await settle();
    fake(r, { ...base, open: 200, dismissed: 0, skipped: { claimed: 200, decided: 0 } });
    void r.controller.decisions.dismissOpen(request('reporter', x.reporter, x.person, [x.id], 'Rita'));
    await r.timers.advance(UNDO_MS);
    const all = r.controller.toasts.getSnapshot();
    expect(all.some((t) => t.action?.label === 'Dismiss more')).toBe(false);
    expect(all.map((t) => t.text)).toContain('200 stay open: another moderator is handling them.');
    expect(all.map((t) => t.text)).not.toContain('Dismissed 0 reports.');
  });

  it('nothing dismissed and nothing held says nothing was left to dismiss, not "Dismissed 0"', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    await r.controller.start();
    await settle();
    fake(r, { ...base, open: 0, dismissed: 0, more: false });
    void r.controller.decisions.dismissOpen(request('reporter', x.reporter, x.person, [x.id], 'Rita'));
    await r.timers.advance(UNDO_MS);
    expect(toastTexts(r)).toContain('There are no open reports to dismiss.');
  });
});

describe('previewDismiss', () => {
  it('sends dryRun and holds nothing: no toast, no entry, no pending case, nothing closed', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 3);
    await r.controller.start();
    await settle();
    const result = await r.controller.decisions.previewDismiss('person', person);
    expect(result).toMatchObject({ ok: true, dryRun: true, open: 3, dismissed: 0 });
    expect(sweeps(r)[0]?.body).toEqual({ scope: 'person', ref: person, dryRun: true });
    expect(r.controller.toasts.getSnapshot()).toEqual([]);
    expect(r.controller.decisions.decidedIds().size).toBe(0);
    expect(r.controller.queue.getSnapshot().pending.size).toBe(0);
    expect((await r.w.client.getReport(ids[0]!)).report.status).toBe('open');
  });

  it('a dry run on a case held by someone else counts what is held (never "nothing to do")', async () => {
    const r = await rig();
    const { person } = await aboutOne(r, 2);
    await r.controller.start();
    await settle();
    await r.w.clientFor('maya@example.test', 'moderator').claimCase(person);
    const result = await r.controller.decisions.previewDismiss('person', person);
    expect(result.skipped.claimed).toBeGreaterThan(0);
  });

  it('a refusal rejects with a HubError', async () => {
    const r = await rig({ world: { permissions: { 'reports.decide.bulk': 'senior' } } });
    const { person } = await aboutOne(r, 1);
    await r.controller.start();
    await settle();
    await expect(r.controller.decisions.previewDismiss('person', person)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('sweeps and decisions share the Undo stack', () => {
  it('undoLatest takes whichever was made last', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 2);
    const other = await r.w.file({ target: 'Other', reporter: 'Zed' });
    await r.controller.start();
    await settle();
    void r.controller.decisions.dismissOpen(request('person', person, person, ids));
    await r.timers.advance(MINUTE / 60);
    void dismissCase(r, other);
    expect(r.controller.decisions.undoLatest()).toBe(other.id);
    expect(r.controller.decisions.undoLatest()).toBe(ids[0]);
    expect(r.controller.decisions.undoLatest()).toBeNull();
  });

  it('is not a controller-level decide: the hold cannot be bypassed by a stale entry', async () => {
    const r = await rig();
    const { person, ids } = await aboutOne(r, 1);
    await r.controller.start();
    await settle();
    const spy = vi.spyOn(r.w.client, 'dismissOpen');
    void r.controller.decisions.dismissOpen(request('person', person, person, ids));
    expect(spy).not.toHaveBeenCalled();
  });
});
