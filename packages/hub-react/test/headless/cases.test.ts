// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { emptyForm } from '../../src/decision.js';
import { UNDO_MS } from '../../src/headless/toasts.js';
import type { DecideInput } from '../../src/types.js';
import { MINUTE } from '../world.js';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// Working a case: claiming it when it is opened, the heartbeat, releasing it on leaving, and take-next. On the real routes.

const OK: DecideInput = { verdict: 'no_action', reason: 'Nothing to act on.', actions: [] };
const ME = 'ann@example.test';
const claims = (r: Rig, person: string): number => r.count('POST', `/cases/${encodeURIComponent(person)}/claim`);
const releases = (r: Rig, person: string): number => r.count('POST', `/cases/${encodeURIComponent(person)}/release`);
const views = (r: Rig, person: string): number => r.count('POST', `/cases/${encodeURIComponent(person)}/viewing`);
const group = (r: Rig, person: string) => r.controller.queue.getSnapshot().groups.find((g) => g.person === person);
const toastTexts = (r: Rig): string[] => r.controller.toasts.getSnapshot().map((t) => t.text);
/** Every toast text said from now on, even those that have since gone. */
function said(r: Rig): string[] {
  const all: string[] = [];
  const seen = new Set<number>();
  r.controller.toasts.subscribe(() => {
    for (const t of r.controller.toasts.getSnapshot()) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      all.push(t.text);
    }
  });
  return all;
}

async function ready(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  const a = await r.w.file({ target: 'Alpha' });
  const b = await r.w.file({ target: 'Bravo' });
  await r.controller.start();
  await settle();
  return { r, a, b };
}

describe('opening a case', () => {
  it('claims it for the moderator and says they are viewing it', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    expect(claims(r, a.person)).toBe(1);
    expect(views(r, a.person)).toBe(1);
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    expect(r.controller.opened.getSnapshot()).toEqual({ reportId: a.id, person: a.person });
  });

  it('open() resolves once the first claim has answered, so the claim is on screen when it does', async () => {
    const { r, a } = await ready();
    await r.controller.open(a.id);
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    expect(views(r, a.person)).toBe(1);
    // Before the queue shows the case there is nothing to wait for.
    const early = await rig();
    const x = await early.w.file({ target: 'Early' });
    await expect(early.controller.open(x.id)).resolves.toBeUndefined();
  });

  it('opening the same report again does nothing more', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    r.controller.open(a.id);
    await settle();
    expect(claims(r, a.person)).toBe(1);
  });

  it('a case someone else holds is opened to read: their claim shows, with a notice said once', async () => {
    const { r, a } = await ready();
    const all = said(r);
    await r.w.clientFor('bea@example.test').claimCase(a.person);
    r.controller.open(a.id);
    await settle();
    expect(group(r, a.person)?.claim?.by).toBe('bea@example.test');
    expect(all.filter((t) => t.startsWith('bea is handling this case'))).toHaveLength(1);
    await r.timers.advance(MINUTE * 3);
    expect(all.filter((t) => t.startsWith('bea is handling this case'))).toHaveLength(1);
  });

  it('a role that cannot decide claims nothing', async () => {
    const { r, a } = await ready({ world: { permissions: { 'reports.decide': 'senior' } } });
    r.controller.open(a.id);
    await settle();
    expect(claims(r, a.person)).toBe(0);
    expect(views(r, a.person)).toBe(1);
  });

  it('opens before the queue has loaded: the claim starts when the case appears', async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha' });
    r.controller.open(a.id);
    expect(r.controller.opened.getSnapshot()).toEqual({ reportId: a.id, person: null });
    await r.controller.start();
    await settle();
    expect(claims(r, a.person)).toBe(1);
    expect(r.controller.opened.getSnapshot()?.person).toBe(a.person);
  });

  it('a report that is not in the queue claims nothing', async () => {
    const { r } = await ready();
    r.controller.open('no-such-report');
    await settle();
    expect(r.count('POST', /\/claim$/)).toBe(0);
    expect(r.controller.opened.getSnapshot()).toEqual({ reportId: 'no-such-report', person: null });
  });

  it('keeps the open case row in the queue even when the case closes', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    await r.w.clientFor('bea@example.test', 'senior').decide(a.id, { ...OK, takeOver: true });
    await r.timers.advance(5_000);
    const row = r.controller.queue.getSnapshot().rows.find((x) => x.group.person === a.person);
    expect(row?.gone).toBe(true);
    // The case closed for another reason: nothing is claimed or viewed any more.
    const before = claims(r, a.person);
    await r.timers.advance(MINUTE * 3);
    expect(claims(r, a.person)).toBe(before);
  });
});

describe('the heartbeat', () => {
  it('renews the claim every 60 seconds and the viewing hint every 20, while visible', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    expect([claims(r, a.person), views(r, a.person)]).toEqual([1, 1]);
    await r.timers.advance(19_999);
    expect(views(r, a.person)).toBe(1);
    await r.timers.advance(1);
    expect(views(r, a.person)).toBe(2);
    await r.timers.advance(39_999);
    expect(claims(r, a.person)).toBe(1);
    await r.timers.advance(1);
    expect(claims(r, a.person)).toBe(2);
    expect(views(r, a.person)).toBe(4);
    await r.timers.advance(MINUTE);
    expect([claims(r, a.person), views(r, a.person)]).toEqual([3, 7]);
  });

  it('does not beat while the tab is hidden, and beats at once when it is shown again', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    r.page.hide();
    await r.timers.advance(MINUTE * 3);
    expect([claims(r, a.person), views(r, a.person)]).toEqual([1, 1]);
    r.page.show();
    await settle();
    expect([claims(r, a.person), views(r, a.person)]).toEqual([2, 2]);
  });

  it('a case someone takes over is said once, as lost; taking it back says nothing', async () => {
    const { r, a } = await ready();
    const all = said(r);
    r.controller.open(a.id);
    await settle();
    await r.w.clientFor('bea@example.test', 'senior').claimCase(a.person, { takeOver: true });
    await r.timers.advance(MINUTE);
    expect(all).toContain('bea took this case over.');
    expect(group(r, a.person)?.claim?.by).toBe('bea@example.test');
    await r.timers.advance(MINUTE);
    expect(all.filter((t) => t === 'bea took this case over.')).toHaveLength(1);
  });

  it('the viewing hint puts the other viewers on the row', async () => {
    const { r, a } = await ready();
    await r.w.clientFor('bea@example.test').viewing(a.person);
    r.controller.open(a.id);
    await settle();
    expect(group(r, a.person)?.viewing).toEqual(['bea@example.test']);
  });
});

describe('leaving a case', () => {
  it('releases the claim, and the beat stops', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(1);
    expect(group(r, a.person)?.claim).toBeNull();
    expect(r.controller.opened.getSnapshot()).toBeNull();
    const before = [claims(r, a.person), views(r, a.person)];
    await r.timers.advance(MINUTE * 5);
    expect([claims(r, a.person), views(r, a.person)]).toEqual(before);
    const detail = await r.w.client.getReport(a.id);
    expect(detail.claim).toBeNull();
  });

  it('opening another case leaves the first one', async () => {
    const { r, a, b } = await ready();
    r.controller.open(a.id);
    await settle();
    r.controller.open(b.id);
    await settle();
    expect(releases(r, a.person)).toBe(1);
    expect(claims(r, b.person)).toBe(1);
    expect(r.controller.opened.getSnapshot()?.reportId).toBe(b.id);
  });

  it('leave for a report that is not the open one does nothing', async () => {
    const { r, a, b } = await ready();
    r.controller.open(a.id);
    await settle();
    r.controller.leave(b.id);
    await settle();
    expect(releases(r, a.person)).toBe(0);
    expect(r.controller.opened.getSnapshot()?.reportId).toBe(a.id);
  });

  it('leave with no case open, twice, does nothing', async () => {
    const { r, a } = await ready();
    r.controller.leave();
    r.controller.open(a.id);
    await settle();
    r.controller.leave();
    r.controller.leave();
    await settle();
    expect(releases(r, a.person)).toBe(1);
  });

  it('does not release a claim that is someone else\'s', async () => {
    const { r, a } = await ready();
    await r.w.clientFor('bea@example.test').claimCase(a.person);
    r.controller.open(a.id);
    await settle();
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(0);
    expect(group(r, a.person)?.claim?.by).toBe('bea@example.test');
  });

  it('does not release a claim that has lapsed (it is nobody\'s)', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    r.w.clock.t += 11 * MINUTE;
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(0);
  });

  it('does not release while a decision on the case is waiting: sending it lets the claim go', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK, snapshot: emptyForm() });
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(0);
    await r.timers.advance(UNDO_MS);
    expect(releases(r, a.person)).toBe(0);
    const detail = await r.w.client.getReport(a.id);
    expect(detail.claim).toBeNull();
  });

  it('does not release while the decision waits even when a queue read shows the claim again (the server still holds it)', async () => {
    const { r, a } = await ready();
    await r.controller.open(a.id);
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    expect(group(r, a.person)?.claim).toBeNull();
    await r.controller.queue.reload();
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(0);
    expect(group(r, a.person)?.claim?.by).toBe(ME);
  });

  it('leaving while the first claim is still on its way: the answer changes nothing on screen', async () => {
    const { r, a } = await ready();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    r.w.intercept.fn = async (req) => {
      if (/\/claim$/.test(req.path)) await gate;
      return undefined;
    };
    const all = said(r);
    void r.controller.open(a.id);
    await settle();
    r.controller.leave(a.id);
    open();
    await settle();
    expect(group(r, a.person)?.claim).toBeNull();
    expect(all).toEqual([]);
  });

  it('does release after an Undo: the decision is not coming', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    r.controller.undo(a.id);
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(1);
  });

  it('does release when the decision keeps the case (the person has other open reports)', async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha', reporter: 'R1' });
    await r.w.file({ target: 'Alpha', reporter: 'R2' });
    await r.controller.start();
    await settle();
    r.controller.open(a.id);
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    r.controller.leave(a.id);
    await settle();
    expect(releases(r, a.person)).toBe(1);
  });

  it('a released case is not claimed again by its own heartbeat, but opening it again claims it', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    const released = await r.controller.release(a.person);
    expect(released).toEqual({ ok: true, value: { released: true } });
    await r.timers.advance(MINUTE * 2);
    expect(claims(r, a.person)).toBe(1);
    expect(group(r, a.person)?.claim).toBeNull();
    r.controller.leave(a.id);
    r.controller.open(a.id);
    await settle();
    expect(claims(r, a.person)).toBe(2);
  });

  it('dispose lets the open case go once, stops the beat, and a later leave adds nothing', async () => {
    const { r, a } = await ready();
    r.controller.open(a.id);
    await settle();
    r.controller.dispose();
    r.controller.dispose();
    await settle();
    expect(releases(r, a.person)).toBe(1);
    expect(r.timers.count()).toBe(0);
    r.controller.leave(a.id);
    await r.timers.advance(MINUTE * 3);
    expect(releases(r, a.person)).toBe(1);
    expect(claims(r, a.person)).toBe(1);
  });
});

describe('one case per person', () => {
  async function two(options: Parameters<typeof rig>[0] = {}) {
    const r = await rig(options);
    const a = await r.w.file({ target: 'Alpha', reporter: 'R1' });
    const b = await r.w.file({ target: 'Alpha', reporter: 'R2' });
    await r.controller.start();
    await settle();
    return { r, a, b };
  }

  it("opening the same person's other report is the same case: the claim is kept, nothing released or claimed again", async () => {
    const { r, a, b } = await two();
    r.controller.open(a.id);
    await settle();
    r.controller.open(b.id);
    await settle();
    expect(releases(r, a.person)).toBe(0);
    expect(claims(r, a.person)).toBe(1);
    expect(r.controller.opened.getSnapshot()).toEqual({ reportId: b.id, person: a.person });
    // The beat is the one beat: not doubled by the move.
    await r.timers.advance(MINUTE);
    expect(claims(r, a.person)).toBe(2);
    r.controller.leave(b.id);
    await settle();
    expect(releases(r, a.person)).toBe(1);
  });

  it("opening a report of another person lets the first person's case go and claims the new one", async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha' });
    const c = await r.w.file({ target: 'Charlie' });
    await r.controller.start();
    await settle();
    r.controller.open(a.id);
    await settle();
    r.controller.open(c.id);
    await settle();
    expect(releases(r, a.person)).toBe(1);
    expect(claims(r, c.person)).toBe(1);
    expect(r.controller.opened.getSnapshot()).toEqual({ reportId: c.id, person: c.person });
  });

  it('deciding one report keeps the claim and the beat while the person has another open', async () => {
    const { r, a, b } = await two();
    r.controller.open(a.id);
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    await r.timers.advance(UNDO_MS);
    expect(releases(r, a.person)).toBe(0);
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    expect(group(r, a.person)?.reportIds).toEqual([b.id]);
    await r.timers.advance(MINUTE);
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    expect(r.controller.opened.getSnapshot()?.person).toBe(a.person);
  });

  it('the report just decided stays "mine" after the queue forgets it: the claim and the beat go on', async () => {
    const r = await rig();
    const x = await r.w.file({ target: 'Solo' });
    await r.controller.start();
    await settle();
    r.controller.open(x.id);
    await settle();
    void r.controller.decide({ reportId: x.id, person: x.person, input: OK }, { hold: false });
    await settle();
    expect(group(r, x.person)).toBeUndefined();
    expect(r.controller.opened.getSnapshot()?.person).toBe(x.person);
    // The heartbeat goes on for the case just decided (their other reports, if any, are the same case).
    const before = views(r, x.person);
    await r.timers.advance(20_000);
    expect(views(r, x.person)).toBe(before + 1);
  });

  it('continueFrom goes to the same person\'s next open report, keeping the claim, and takes the next case only when there is none', async () => {
    const shown: string[] = [];
    const { r, a, b } = await two({ controller: { host: { show: (id) => shown.push(id) } } });
    r.controller.open(a.id);
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    const next = await r.controller.continueFrom({ reportId: a.id, person: a.person });
    expect(next).toEqual({ status: 'same', reportId: b.id });
    expect(shown).toEqual([b.id]);
    expect(r.count('POST', '/cases/next')).toBe(0);
    void r.controller.decide({ reportId: b.id, person: a.person, input: OK });
    const none = await r.controller.continueFrom({ reportId: b.id, person: a.person });
    expect(none).toEqual({ status: 'none' });
    expect(r.count('POST', '/cases/next')).toBe(1);
  });
});

describe('continueFrom after a quick action', () => {
  const three = async () => {
    const r = await rig();
    const files = [await r.w.file({ target: 'Alpha' }), await r.w.file({ target: 'Bravo' }), await r.w.file({ target: 'Charlie' })];
    await r.controller.start();
    await settle();
    return { r, files };
  };

  it('keeps the double-click guard by default: a second continueFrom within the take cooldown is busy', async () => {
    const { r, files } = await three();
    const [a, b] = files;
    void r.controller.decide({ reportId: a!.id, person: a!.person, input: OK });
    expect((await r.controller.continueFrom({ reportId: a!.id, person: a!.person })).status).toBe('taken');
    void r.controller.decide({ reportId: b!.id, person: b!.person, input: OK });
    expect((await r.controller.continueFrom({ reportId: b!.id, person: b!.person })).status).toBe('busy');
  });

  it('{ quick: true } is not held up by the cooldown, so a fast run of quick actions advances every time', async () => {
    const { r, files } = await three();
    const [a, b] = files;
    void r.controller.decide({ reportId: a!.id, person: a!.person, input: OK });
    expect((await r.controller.continueFrom({ reportId: a!.id, person: a!.person }, { quick: true })).status).toBe('taken');
    await settle();
    void r.controller.decide({ reportId: b!.id, person: b!.person, input: OK });
    const second = await r.controller.continueFrom({ reportId: b!.id, person: b!.person }, { quick: true });
    expect(second.status).toBe('taken');
    expect(r.count('POST', '/cases/next')).toBe(2);
  });

  it('{ quick: true } still refuses a take that is running (never two at once)', async () => {
    const { r, files } = await three();
    const [a, b] = files;
    void r.controller.decide({ reportId: a!.id, person: a!.person, input: OK });
    void r.controller.decide({ reportId: b!.id, person: b!.person, input: OK });
    const first = r.controller.continueFrom({ reportId: a!.id, person: a!.person }, { quick: true });
    const second = r.controller.continueFrom({ reportId: b!.id, person: b!.person }, { quick: true });
    const outcomes = (await Promise.all([first, second])).map((o) => o.status).sort();
    expect(outcomes).toEqual(['busy', 'taken']);
  });
});

describe('take next', () => {
  it('claims the longest-waiting unclaimed case, says which report to open, and shows it', async () => {
    const shown: string[] = [];
    const { r, a } = await ready({ controller: { host: { show: (id) => shown.push(id) } } });
    const taken = await r.controller.takeNext();
    expect(taken).toEqual({ status: 'taken', reportId: a.id, person: a.person });
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    expect(shown).toEqual([a.id]);
  });

  it('skips a case someone holds', async () => {
    const { r, a, b } = await ready();
    await r.w.clientFor('bea@example.test').claimCase(a.person);
    const taken = await r.controller.takeNext();
    expect(taken).toMatchObject({ status: 'taken', reportId: b.id });
  });

  it('with none left it says so, once, and answers none', async () => {
    const r = await rig();
    await r.controller.start();
    await settle();
    expect(await r.controller.takeNext()).toEqual({ status: 'none' });
    expect(toastTexts(r)).toEqual(['No unclaimed cases right now.']);
  });

  it('a double press is one request: busy while it runs, and for 500 ms after', async () => {
    const { r } = await ready();
    const first = r.controller.takeNext();
    const second = await r.controller.takeNext();
    expect(second).toEqual({ status: 'busy' });
    expect((await first).status).toBe('taken');
    expect(await r.controller.takeNext()).toEqual({ status: 'busy' });
    await r.timers.advance(499);
    expect(await r.controller.takeNext()).toEqual({ status: 'busy' });
    await r.timers.advance(1);
    expect((await r.controller.takeNext()).status).toBe('taken');
    expect(r.count('POST', '/cases/next')).toBe(2);
  });

  it('takes from the reason the filter names, and sends none or a reason id as the kit expects', async () => {
    const r = await rig();
    await r.w.file({ target: 'Alpha', reason: 'hate' });
    const c = await r.w.file({ target: 'Cheater', reason: 'cheating' });
    const none = await r.w.file({ target: 'Quiet', reason: null });
    await r.controller.start();
    await settle();
    r.controller.queue.setFilter({ reason: 'cheating' });
    expect(await r.controller.takeNext()).toMatchObject({ status: 'taken', reportId: c.id });
    expect(r.w.sent.filter((q) => q.path === '/cases/next').at(-1)?.body).toEqual({ reason: 'cheating' });
    await r.timers.advance(500);
    r.controller.queue.setFilter({ reason: 'none' });
    expect(await r.controller.takeNext()).toMatchObject({ status: 'taken', reportId: none.id });
    expect(r.w.sent.filter((q) => q.path === '/cases/next').at(-1)?.body).toEqual({ reason: 'none' });
  });

  it('a category set through the (deprecated) filter is still sent, beside a reason', async () => {
    const r = await rig();
    await r.w.file({ target: 'Alpha', reason: 'harassment' });
    await r.controller.start();
    await settle();
    r.controller.queue.setFilter({ category: 'harassment', reason: 'harassment' });
    await r.controller.takeNext();
    expect(r.w.sent.filter((q) => q.path === '/cases/next').at(-1)?.body).toEqual({ category: 'harassment', reason: 'harassment' });
  });

  it('takes from the category the filter names', async () => {
    const r = await rig();
    await r.w.file({ target: 'Alpha', category: 'harassment' });
    const c = await r.w.file({ target: 'Cheater', category: 'cheating' });
    await r.controller.start();
    await settle();
    r.controller.queue.setFilter({ category: 'cheating' });
    expect(await r.controller.takeNext()).toMatchObject({ status: 'taken', reportId: c.id });
  });

  it('clears a filter that would hide the case just taken', async () => {
    const { r } = await ready();
    r.controller.queue.setFilter({ claim: 'unclaimed' });
    await r.controller.takeNext();
    expect(r.controller.queue.getSnapshot().filter.claim).toBe('all');
  });

  it('a case newer than the list is read in first', async () => {
    const r = await rig();
    await r.controller.start();
    await settle();
    const late = await r.w.file({ target: 'Late' });
    const taken = await r.controller.takeNext();
    expect(taken).toMatchObject({ status: 'taken', reportId: late.id });
    expect(group(r, late.person)?.claim?.by).toBe(ME);
  });

  it('a failure says so (an alert toast), answers failed with the error, and the guard opens again', async () => {
    const { r } = await ready();
    r.w.intercept.fn = (req) => (req.path === '/cases/next' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    const out = await r.controller.takeNext();
    expect(out.status).toBe('failed');
    expect(out.status === 'failed' && out.error.status).toBe(500);
    expect(r.controller.toasts.getSnapshot().some((t) => t.tone === 'bad')).toBe(true);
    r.w.intercept.fn = null;
    await r.timers.advance(500);
    expect((await r.controller.takeNext()).status).toBe('taken');
  });
});

describe('claim, take over, release', () => {
  it('claim answers the claim and puts it on screen', async () => {
    const { r, a } = await ready();
    const out = await r.controller.claim(a.person);
    expect(out.ok && out.value.by).toBe(ME);
    expect(group(r, a.person)?.claim?.by).toBe(ME);
  });

  it('claim on a case someone holds answers the error, shows their claim, and says so as an alert', async () => {
    const { r, a } = await ready();
    await r.w.clientFor('bea@example.test').claimCase(a.person);
    const out = await r.controller.claim(a.person);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.code).toBe('claimed');
    expect(group(r, a.person)?.claim?.by).toBe('bea@example.test');
    const t = r.controller.toasts.getSnapshot().find((x) => x.text.startsWith('bea is handling'));
    expect(t?.tone).toBe('bad');
  });

  it('a senior takes a live claim over, and is told whose it was; a moderator is refused', async () => {
    const senior = await ready({ world: { role: 'senior' } });
    await senior.r.w.clientFor('bea@example.test').claimCase(senior.a.person);
    const out = await senior.r.controller.takeOver(senior.a.person);
    expect(out.ok && out.value.tookOverFrom).toBe('bea@example.test');
    expect(toastTexts(senior.r)).toContain('You took this case over from bea.');

    const mod = await ready();
    await mod.r.w.clientFor('bea@example.test').claimCase(mod.a.person);
    const refused = await mod.r.controller.takeOver(mod.a.person);
    expect(refused.ok).toBe(false);
    expect(mod.r.controller.toasts.getSnapshot().some((x) => x.tone === 'bad')).toBe(true);
  });

  it('takeOver of a free case says "You are handling this case."', async () => {
    const { r, a } = await ready({ world: { role: 'senior' } });
    const out = await r.controller.takeOver(a.person);
    expect(out.ok && out.value.tookOverFrom).toBeNull();
    expect(toastTexts(r)).toContain('You are handling this case.');
  });

  it('release lets the case go, says so with an Undo that claims it again', async () => {
    const { r, a } = await ready();
    await r.controller.claim(a.person);
    const out = await r.controller.release(a.person);
    expect(out).toEqual({ ok: true, value: { released: true } });
    expect(group(r, a.person)?.claim).toBeNull();
    const t = r.controller.toasts.getSnapshot().find((x) => x.text.startsWith('You released the case against'));
    expect(t?.action?.label).toBe('Undo');
    t?.action?.run();
    await settle();
    expect(group(r, a.person)?.claim?.by).toBe(ME);
    expect(toastTexts(r).some((x) => x.startsWith('You are handling the case against'))).toBe(true);
    expect(r.controller.queue.isHeldOff(a.person)).toBe(false);
  });

  it('release of a case that was not yours says nothing and holds nothing off', async () => {
    const { r, a } = await ready();
    const out = await r.controller.release(a.person);
    expect(out).toEqual({ ok: true, value: { released: false } });
    expect(toastTexts(r)).toEqual([]);
    expect(r.controller.queue.isHeldOff(a.person)).toBe(false);
  });

  it('release holds the case off the open heartbeat; the Undo takes it back off', async () => {
    const { r, a } = await ready();
    await r.controller.claim(a.person);
    await r.controller.release(a.person);
    expect(r.controller.queue.isHeldOff(a.person)).toBe(true);
  });

  it('release failing is an alert and answers the error', async () => {
    const { r, a } = await ready();
    r.w.intercept.fn = (req) => (/release$/.test(req.path) ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    const out = await r.controller.release(a.person);
    expect(out.ok).toBe(false);
    expect(r.controller.toasts.getSnapshot().some((x) => x.tone === 'bad')).toBe(true);
  });

  it('claim, take over and release never throw, whatever the failure', async () => {
    const { r, a } = await ready();
    r.w.intercept.fn = () => {
      throw new Error('offline');
    };
    const results = await Promise.all([r.controller.claim(a.person), r.controller.takeOver(a.person), r.controller.release(a.person), r.controller.takeNext()]);
    expect(results.map((x) => ('ok' in x ? x.ok : x.status))).toEqual([false, false, false, 'failed']);
  });
});

describe('the open case store', () => {
  it('is the same snapshot until the case or its person changes', async () => {
    const { r, a, b } = await ready();
    const listener = vi.fn();
    r.controller.opened.subscribe(listener);
    const none = r.controller.opened.getSnapshot();
    expect(r.controller.opened.getSnapshot()).toBe(none);
    expect(none).toBeNull();
    r.controller.open(a.id);
    await settle();
    const open = r.controller.opened.getSnapshot();
    await r.timers.advance(MINUTE * 2);
    expect(r.controller.opened.getSnapshot()).toBe(open);
    r.controller.open(b.id);
    await settle();
    expect(r.controller.opened.getSnapshot()).not.toBe(open);
    expect(listener).toHaveBeenCalled();
  });

  it('is what the controller means by "the open report" until the host says otherwise', async () => {
    const shown: string[] = [];
    const { r, a } = await ready({ controller: { host: { show: (id) => shown.push(id) } } });
    r.controller.open(a.id);
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    r.controller.undo(a.id);
    expect(shown).toEqual([]);
    r.controller.leave();
    await settle();
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    r.controller.undo(a.id);
    expect(shown).toEqual([a.id]);
  });
});
