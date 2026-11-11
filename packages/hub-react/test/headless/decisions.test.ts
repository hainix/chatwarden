// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { emptyForm } from '../../src/decision.js';
import type { DecisionEntry } from '../../src/headless/decisions.js';
import { hasLeft, isWaiting } from '../../src/headless/decisions.js';
import { UNDO_MS } from '../../src/headless/toasts.js';
import type { DecideInput } from '../../src/types.js';
import { MINUTE } from '../world.js';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// A decision is held for 5 seconds, then sent; Undo cancels it; the page going away sends it at once; a failure gives the case
// back. All of it on the real routes, with the clock and the page in the test's hand.

const OK: DecideInput = { verdict: 'no_action', reason: 'Nothing to act on.', actions: [] };
const decides = (r: Rig): number => r.count('POST', /^\/reports\/[^/]+\/decide$/);
const entry = (r: Rig, id: string): DecisionEntry | undefined => r.controller.decisions.entry(id);
const status = (r: Rig, id: string): string | undefined => entry(r, id)?.state.status;
const toastTexts = (r: Rig): string[] => r.controller.toasts.getSnapshot().map((t) => t.text);

async function ready(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  const a = await r.w.file({ target: 'Alpha' });
  await r.controller.start();
  await settle();
  const cmd = { reportId: a.id, person: a.person, name: 'Alpha', input: OK, snapshot: emptyForm() };
  return { r, a, cmd };
}

describe('deciding: the hold window', () => {
  it('holds a decision for 5 seconds: nothing is sent at 4.9 s, and it is sent at 5 s', async () => {
    const { r, a, cmd } = await ready();
    const outcome = r.controller.decide(cmd);
    expect(status(r, a.id)).toBe('held');
    expect(UNDO_MS).toBe(5_000);
    await r.timers.advance(4_900);
    expect(decides(r)).toBe(0);
    expect(status(r, a.id)).toBe('held');
    await r.timers.advance(99);
    expect(decides(r)).toBe(0);
    await r.timers.advance(1);
    expect(decides(r)).toBe(1);
    expect(await outcome).toMatchObject({ status: 'done', replay: false });
    expect(status(r, a.id)).toBe('done');
  });

  it('says so while it waits ("Sending the decision on Alpha in 5 s."), and "Decision on Alpha sent." after', async () => {
    const { r, cmd } = await ready();
    void r.controller.decide(cmd);
    expect(toastTexts(r)).toEqual(['Sending the decision on Alpha in 5 s.']);
    await r.timers.advance(UNDO_MS);
    expect(toastTexts(r)).toContain('Decision on Alpha sent.');
  });

  it('while it waits the case is off the list (pending) and the claim looks released', async () => {
    const { r, a, cmd } = await ready();
    await r.controller.claim(a.person);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).not.toBeNull();
    void r.controller.decide(cmd);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(true);
    expect(r.controller.queue.getSnapshot().visible).toEqual([]);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toBeNull();
    expect(r.controller.decisions.isPending(a.person)).toBe(true);
    expect(r.controller.decisions.decidedIds().has(a.id)).toBe(true);
  });

  it('a second decide for the same report while one waits is ignored, and answers what the first answers', async () => {
    const { r, a, cmd } = await ready();
    const first = r.controller.decide(cmd);
    const second = r.controller.decide({ ...cmd, input: { ...OK, reason: 'Different.' } });
    await r.timers.advance(UNDO_MS);
    expect(decides(r)).toBe(1);
    expect(await second).toEqual(await first);
    expect(entry(r, a.id)?.input.reason).toBe('Nothing to act on.');
    expect(r.controller.toasts.getSnapshot().filter((t) => t.held)).toEqual([]);
  });

  it('hold: false sends at once, with no Undo toast', async () => {
    const { r, a, cmd } = await ready();
    const outcome = await r.controller.decide(cmd, { hold: false });
    expect(outcome.status).toBe('done');
    expect(decides(r)).toBe(1);
    expect(toastTexts(r)).not.toContain('Sending the decision on Alpha in 5 s.');
    expect(status(r, a.id)).toBe('done');
  });

  it('hold: 2000 holds it for 2 seconds', async () => {
    const { r, cmd } = await ready();
    void r.controller.decide(cmd, { hold: 2_000 });
    await r.timers.advance(1_999);
    expect(decides(r)).toBe(0);
    await r.timers.advance(1);
    expect(decides(r)).toBe(1);
  });

  it('the decision really reaches the kit: the report closes and the queue loses the case', async () => {
    const { r, a, cmd } = await ready();
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    const detail = await r.w.client.getReport(a.id);
    expect(detail.report.status).not.toBe('open');
    expect(r.controller.queue.getSnapshot().groups).toEqual([]);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(false);
  });
});

describe('deciding: Undo', () => {
  it('Undo at 4.9 s sends nothing, brings the case back, and the outcome is undone', async () => {
    const { r, a, cmd } = await ready();
    const outcome = r.controller.decide(cmd);
    await r.timers.advance(4_900);
    r.controller.undo(a.id);
    expect(await outcome).toEqual({ status: 'undone' });
    expect(status(r, a.id)).toBe('undone');
    await r.timers.advance(UNDO_MS * 2);
    expect(decides(r)).toBe(0);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(false);
    expect(r.controller.queue.getSnapshot().visible).toHaveLength(1);
  });

  it('Undo gives the claim back as it was', async () => {
    const { r, a, cmd } = await ready();
    const mine = await r.controller.claim(a.person);
    const before = r.controller.queue.getSnapshot().groups[0]?.claim;
    expect(mine.ok && before).toEqual(mine.ok && mine.value);
    void r.controller.decide(cmd);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toBeNull();
    r.controller.undo(a.id);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toEqual(before);
  });

  it('Undo at 5.0 s is too late: the decision is on its way, once', async () => {
    const { r, a, cmd } = await ready();
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    r.controller.undo(a.id);
    await settle();
    expect(decides(r)).toBe(1);
    expect(status(r, a.id)).toBe('done');
  });

  it('Undo twice, or for a report with no decision, does nothing', async () => {
    const { r, a, cmd } = await ready();
    void r.controller.decide(cmd);
    r.controller.undo(a.id);
    r.controller.undo(a.id);
    r.controller.undo('nope');
    await r.timers.advance(UNDO_MS);
    expect(decides(r)).toBe(0);
    expect(status(r, a.id)).toBe('undone');
  });

  it('a case Undo brings back is shown to a moderator who went on to another one', async () => {
    const shown: string[] = [];
    const { r, a, cmd } = await ready({ controller: { host: { show: (id) => shown.push(id), openReport: () => 'some-other-report' } } });
    void r.controller.decide(cmd);
    r.controller.undo(a.id);
    expect(shown).toEqual([a.id]);
  });

  it('and not when they are still looking at it', async () => {
    const shown: string[] = [];
    let looking: string | null = null;
    const { r, a, cmd } = await ready({ controller: { host: { show: (id) => shown.push(id), openReport: () => looking } } });
    looking = a.id;
    void r.controller.decide(cmd);
    r.controller.undo(a.id);
    expect(shown).toEqual([]);
  });

  it('after an Undo the same report can be decided again', async () => {
    const { r, a, cmd } = await ready();
    void r.controller.decide(cmd);
    r.controller.undo(a.id);
    const again = r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    expect((await again).status).toBe('done');
    expect(decides(r)).toBe(1);
  });
});

describe('deciding: sent once, whichever comes first', () => {
  for (const first of ['timer', 'pagehide', 'hidden', 'dispose', 'toast dismissed'] as const) {
    it(`${first} first: one request, and the others after it add none`, async () => {
      const { r, a, cmd } = await ready();
      const outcome = r.controller.decide(cmd);
      await r.timers.advance(1_000);
      if (first === 'timer') await r.timers.advance(UNDO_MS - 1_000);
      if (first === 'pagehide') r.page.close();
      if (first === 'hidden') r.page.hide();
      if (first === 'dispose') r.controller.dispose();
      if (first === 'toast dismissed') r.controller.toasts.dismiss(r.controller.toasts.getSnapshot().find((t) => t.held)?.id ?? -1);
      await settle();
      expect(decides(r)).toBe(1);
      // However it was flushed, the one request carries keepalive: the page may be going away.
      expect(r.w.sent.find((q) => /decide$/.test(q.path))?.keepalive).toBe(true);
      expect(await outcome).toMatchObject({ status: 'done' });
      r.page.close();
      r.page.hide();
      r.controller.dispose();
      await r.timers.advance(UNDO_MS * 3);
      expect(decides(r)).toBe(1);
      expect(status(r, a.id)).toBe('done');
    });
  }

  it('dispose with a decision held: that one request goes (keepalive), and nothing is asked after it, no timer is left', async () => {
    const { r, a, cmd } = await ready();
    void r.controller.decide(cmd);
    const before = r.w.sent.length;
    r.controller.dispose();
    await settle();
    await r.timers.advance(UNDO_MS * 3);
    await settle();
    const after = r.w.sent.slice(before);
    expect(after.map((q) => `${q.method} ${q.path}`)).toEqual([`POST /reports/${a.id}/decide`]);
    expect(after[0]?.keepalive).toBe(true);
    expect(r.timers.count()).toBe(0);
    expect(status(r, a.id)).toBe('done');
  });

  it('a send that closes the page carries keepalive', async () => {
    const { r, cmd } = await ready();
    void r.controller.decide(cmd);
    r.page.close();
    await settle();
    const sent = r.w.sent.find((q) => /decide$/.test(q.path));
    expect(sent?.keepalive).toBe(true);
  });

  it('a hidden tab that comes back with nothing held sends nothing', async () => {
    const { r } = await ready();
    r.page.hide();
    r.page.show();
    await settle();
    expect(decides(r)).toBe(0);
  });
});

describe('deciding: failure, retry and restore', () => {
  const fail = (r: Rig, body = { error: 'boom', message: 'The server broke.' }, status = 500): void => {
    r.w.intercept.fn = (req) => (/decide$/.test(req.path) ? { status, body } : undefined);
  };

  it('a failed send gives the case back with the error and what was typed', async () => {
    const { r, a, cmd } = await ready();
    const form = { ...emptyForm(), reason: 'typed text', verdict: 'fair' as const };
    fail(r);
    const outcome = r.controller.decide({ ...cmd, snapshot: form });
    await r.timers.advance(UNDO_MS);
    const out = await outcome;
    expect(out.status).toBe('failed');
    expect(out.status === 'failed' && out.error.status).toBe(500);
    const e = entry(r, a.id);
    expect(e?.state.status).toBe('failed');
    expect(e?.snapshot).toBe(form);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(false);
    expect(r.controller.queue.getSnapshot().visible).toHaveLength(1);
    expect(isWaiting(e)).toBe(false);
    expect(hasLeft(e)).toBe(false);
  });

  it('a failed send gives the claim back as it was', async () => {
    const { r, a, cmd } = await ready();
    await r.controller.claim(a.person);
    const before = r.controller.queue.getSnapshot().groups[0]?.claim;
    fail(r);
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toEqual(before);
  });

  it('retry sends the same body again at once; success is done', async () => {
    const { r, a, cmd } = await ready();
    fail(r);
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    expect(status(r, a.id)).toBe('failed');
    r.w.intercept.fn = null;
    const outcome = await r.controller.retry(a.id);
    expect(outcome).toMatchObject({ status: 'done' });
    const sends = r.w.sent.filter((q) => /decide$/.test(q.path));
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body).toEqual(sends[0]?.body);
    expect(status(r, a.id)).toBe('done');
  });

  it('retry that fails again stays failed, and retry with nothing failed does nothing', async () => {
    const { r, a, cmd } = await ready();
    fail(r);
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    expect((await r.controller.retry(a.id)).status).toBe('failed');
    expect(decides(r)).toBe(2);
    r.w.intercept.fn = null;
    await r.controller.retry(a.id);
    const after = decides(r);
    expect((await r.controller.retry(a.id)).status).toBe('done');
    expect(decides(r)).toBe(after);
    expect(await r.controller.retry('nope')).toEqual({ status: 'none' });
  });

  it('a dropped connection is a failure too, with code network', async () => {
    const { r, a, cmd } = await ready();
    r.w.intercept.fn = (req) => {
      if (/decide$/.test(req.path)) throw new Error('offline');
      return undefined;
    };
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    const s = entry(r, a.id)?.state;
    expect(s?.status === 'failed' && s.error.code).toBe('network');
  });

  it('a case that is not open says so, with a way back; one that is open says nothing', async () => {
    const shown: string[] = [];
    const away = await ready({ controller: { host: { show: (id) => shown.push(id), openReport: () => 'elsewhere' } } });
    fail(away.r);
    void away.r.controller.decide(away.cmd);
    await away.r.timers.advance(UNDO_MS);
    const note = away.r.controller.toasts.getSnapshot().find((t) => t.text.startsWith('The decision on Alpha was not sent'));
    expect(note?.tone).toBe('bad');
    expect(note?.action?.label).toBe('Open the case');
    note?.action?.run();
    expect(shown).toEqual([away.a.id]);

    let hereId: string | null = null;
    const here = await ready({ controller: { host: { openReport: () => hereId } } });
    hereId = here.a.id;
    fail(here.r);
    void here.r.controller.decide(here.cmd);
    await here.r.timers.advance(UNDO_MS);
    expect(here.r.controller.toasts.getSnapshot().some((t) => t.text.includes('was not sent'))).toBe(false);
  });

  it('someone else holding the case: the failure puts their claim on screen and names them', async () => {
    const { r, a, cmd } = await ready({ controller: { host: { openReport: () => 'elsewhere' } } });
    await r.w.clientFor('bea@example.test').claimCase(a.person);
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    const s = entry(r, a.id)?.state;
    expect(s?.status === 'failed' && s.error.code).toBe('claimed');
    expect(r.controller.queue.getSnapshot().groups[0]?.claim?.by).toBe('bea@example.test');
    expect(toastTexts(r).some((t) => t.startsWith('bea is handling Alpha'))).toBe(true);
  });

  it('dismiss forgets a finished, failed or undone entry', async () => {
    const { r, a, cmd } = await ready();
    fail(r);
    void r.controller.decide(cmd);
    await r.timers.advance(UNDO_MS);
    r.controller.dismiss(a.id);
    expect(entry(r, a.id)).toBeUndefined();
    r.controller.dismiss(a.id);
  });
});

describe('deciding: someone else decided first', () => {
  it('is a conflict: the queue is read again and the person is told', async () => {
    const { r, a, cmd } = await ready();
    const outcome = r.controller.decide(cmd);
    await r.w.clientFor('bea@example.test', 'senior').decide(a.id, { verdict: 'bad_faith', reason: 'Decided by someone else.', evidence: 'They reported a friend.', actions: [], takeOver: true });
    await r.timers.advance(UNDO_MS);
    expect((await outcome).status).toBe('conflict');
    expect(status(r, a.id)).toBe('conflict');
    expect(toastTexts(r)).toContain('Someone already decided this report.');
    expect(r.controller.queue.getSnapshot().groups).toEqual([]);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(false);
  });
});

describe('deciding: one case per person', () => {
  async function two() {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha', reporter: 'R1' });
    const b = await r.w.file({ target: 'Alpha', reporter: 'R2' });
    await r.controller.start();
    await settle();
    const cmd = (id: string) => ({ reportId: id, person: a.person, name: 'Alpha', input: OK, snapshot: emptyForm() });
    return { r, a, b, cmd };
  }

  it('with other reports open the case stays: not pending, claim kept, nothing released', async () => {
    const { r, a, b, cmd } = await two();
    await r.controller.claim(a.person);
    const claim = r.controller.queue.getSnapshot().groups[0]?.claim;
    void r.controller.decide(cmd(a.id));
    const e = entry(r, a.id);
    expect(e?.keepsCase).toBe(true);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(false);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim).toEqual(claim);
    expect(r.controller.decisions.willRelease(a.person)).toBe(false);
    await r.timers.advance(UNDO_MS);
    expect(r.controller.queue.getSnapshot().groups[0]?.claim?.by).toBe('ann@example.test');
    expect(r.controller.queue.getSnapshot().groups[0]?.reportIds).toEqual([b.id]);
  });

  it('the last report of the person lets the case go: pending, and leaving must not release it first', async () => {
    const { r, a, b, cmd } = await two();
    void r.controller.decide(cmd(a.id));
    await r.timers.advance(UNDO_MS);
    void r.controller.decide(cmd(b.id));
    expect(entry(r, b.id)?.keepsCase).toBe(false);
    expect(r.controller.decisions.willRelease(a.person)).toBe(true);
    expect(r.controller.queue.getSnapshot().pending.has(a.person)).toBe(true);
  });

  it('two reports decided together: the first keeps the case, the second (the last open) does not', async () => {
    const { r, a, b, cmd } = await two();
    void r.controller.decide(cmd(a.id));
    void r.controller.decide(cmd(b.id));
    expect(entry(r, a.id)?.keepsCase).toBe(true);
    expect(entry(r, b.id)?.keepsCase).toBe(false);
  });
});

describe('deciding: the store', () => {
  it('its snapshot is the same map until an entry changes, and a listener is told for each change', async () => {
    const { r, a, cmd } = await ready();
    const listener = vi.fn();
    r.controller.decisions.subscribe(listener);
    const before = r.controller.decisions.getSnapshot();
    expect(r.controller.decisions.getSnapshot()).toBe(before);
    void r.controller.decide(cmd);
    const held = r.controller.decisions.getSnapshot();
    expect(held).not.toBe(before);
    expect(r.controller.decisions.getSnapshot()).toBe(held);
    expect(listener).toHaveBeenCalledTimes(1);
    r.controller.undo(a.id);
    expect(r.controller.decisions.getSnapshot()).not.toBe(held);
    r.controller.dismiss(a.id);
    r.controller.dismiss(a.id);
    expect(r.controller.decisions.getSnapshot().size).toBe(0);
  });

  it('isWaiting and hasLeft, pure', () => {
    const e = (status: DecisionEntry['state']['status']) => ({ reportId: 'r', person: 'p', name: 'n', input: OK, snapshot: emptyForm(), keepsCase: false, state: { status } }) as unknown as DecisionEntry;
    expect(isWaiting(undefined)).toBe(false);
    expect(['held', 'sending'].map((s) => isWaiting(e(s as never)))).toEqual([true, true]);
    expect(['done', 'failed', 'conflict', 'undone'].map((s) => isWaiting(e(s as never)))).toEqual([false, false, false, false]);
    expect(hasLeft(e('held'))).toBe(true);
    expect(hasLeft(e('done'))).toBe(true);
    expect(hasLeft(e('done'), false)).toBe(false);
    expect(['failed', 'conflict', 'undone'].map((s) => hasLeft(e(s as never)))).toEqual([false, false, false]);
  });

  it('one answer to "can this role read reports": a permission table without the key reads nothing, in start() and after a decision alike', async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha' });
    const me = await r.w.client.me();
    r.controller.identify({ ...me, can: {} as never });
    await r.controller.start();
    await r.controller.decide({ reportId: a.id, person: a.person, input: OK }, { hold: false });
    expect(r.count('GET', '/changes')).toBe(0);
    expect(r.count('GET', '/reports')).toBe(0);
    expect(r.controller.decisions.entry(a.id)?.state.status).toBe('done');
  });

  it('a person with no claim and no queue yet can still be decided (no queue read needed)', async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha' });
    const outcome = r.controller.decide({ reportId: a.id, person: a.person, input: OK }, { hold: false });
    expect((await outcome).status).toBe('done');
    expect(r.controller.decisions.entry(a.id)?.name).toBe(a.person.slice(0, 8));
    expect(r.w.now()).toBeGreaterThan(0);
    expect(MINUTE).toBe(60_000);
  });
});
