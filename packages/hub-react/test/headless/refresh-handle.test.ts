// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// `controller.refresh()`: poll the change token now, instead of at the next tick. It only reads (`GET /changes`, and `GET /reports`
// when the token moved); it never writes and never touches the audit trail beyond what a normal poll does.

const changes = (r: Rig): number => r.count('GET', '/changes');
const reads = (r: Rig): number => r.count('GET', '/reports');
const writes = (r: Rig): number => r.w.sent.filter((q) => q.method !== 'GET').length;
const names = (r: Rig): string[] => r.controller.queue.getSnapshot().groups.map((g) => g.person);

async function running(): Promise<Rig> {
  const r = await rig();
  await r.controller.start();
  await settle();
  return r;
}

describe('controller.refresh()', () => {
  it('is on the controller, as a function', async () => {
    const r = await rig();
    expect(typeof r.controller.refresh).toBe('function');
  });

  it('reads the change token exactly once, and not the queue while the token has not moved', async () => {
    const r = await running();
    const before = changes(r);
    const queueReads = reads(r);
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before + 1);
    expect(reads(r)).toBe(queueReads);
  });

  it('shows a report filed since the last poll at once, not at the next tick', async () => {
    const r = await running();
    const a = await r.w.file({ target: 'Alpha' });
    expect(names(r)).toEqual([]);
    r.controller.refresh();
    await settle();
    // The new case is in the incoming count or the list: either way the queue has read it.
    expect(r.controller.queue.getSnapshot().reports).toBe(1);
    expect(r.controller.queue.getSnapshot().groups.map((g) => g.person)).toEqual([a.person]);
  });

  it('is only a read: no request but GET /changes and GET /reports, and nothing that writes', async () => {
    const r = await running();
    await r.w.file({ target: 'Alpha' });
    const writesBefore = writes(r);
    const sentBefore = r.w.sent.length;
    r.controller.refresh();
    await settle();
    const since = r.w.sent.slice(sentBefore);
    expect(since.length).toBeGreaterThan(0);
    expect(since.every((q) => q.method === 'GET' && (q.path === '/changes' || q.path === '/reports'))).toBe(true);
    expect(writes(r)).toBe(writesBefore);
    // No audit read either: the audit trail is the audit screen's, and `/audit` is never asked.
    expect(r.count('GET', '/audit')).toBe(0);
  });

  it('the poll loop goes on after it: the next poll is a full interval after the refresh, not before', async () => {
    const r = await running();
    await r.timers.advance(3_000);
    const before = changes(r);
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before + 1);
    // The loop asks again one whole interval after the read the refresh made (it was due at 5 s; it is now due at 8 s).
    await r.timers.advance(4_900);
    expect(changes(r)).toBe(before + 1);
    await r.timers.advance(200);
    expect(changes(r)).toBe(before + 2);
  });

  it('twice within a second: the second waits and is sent once the second is up (a trailing read), not at once', async () => {
    const r = await running();
    const before = changes(r);
    r.controller.refresh();
    await settle();
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before + 1);
    await r.timers.advance(900);
    expect(changes(r)).toBe(before + 1);
    await r.timers.advance(150);
    expect(changes(r)).toBe(before + 2);
  });

  it('called in a loop (each call after the last read answered): one read now, one trailing read, however many calls', async () => {
    const r = await running();
    const before = changes(r);
    for (let i = 0; i < 50; i += 1) {
      r.controller.refresh();
      await settle(2);
    }
    await r.timers.advance(1_100);
    expect(changes(r)).toBe(before + 2);
    await r.timers.advance(900);
    // Nothing more is queued behind them: the next read is the poll's own.
    expect(changes(r)).toBe(before + 2);
  });

  it('called 50 times at once: one read (the others are answered by it)', async () => {
    const r = await running();
    const before = changes(r);
    for (let i = 0; i < 50; i += 1) r.controller.refresh();
    await settle();
    await r.timers.advance(2_000);
    expect(changes(r)).toBe(before + 1);
  });

  it('after a second of quiet it reads at once again', async () => {
    const r = await running();
    const before = changes(r);
    r.controller.refresh();
    await settle();
    await r.timers.advance(1_000);
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before + 2);
  });

  it('a call while a read is on its way is ignored, and leaves the poll timer alone', async () => {
    const r = await running();
    await r.timers.advance(3_000);
    const before = changes(r);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.w.intercept.fn = async (req) => {
      if (req.path === '/changes') await held;
      return undefined;
    };
    r.controller.refresh();
    await settle();
    const timersWaiting = r.timers.count();
    r.controller.refresh();
    r.controller.refresh();
    await settle();
    expect(r.timers.count()).toBe(timersWaiting);
    release();
    await settle();
    r.w.intercept.fn = null;
    // One read for the refresh; the two calls made meanwhile asked for nothing, and no trailing read is waiting.
    expect(changes(r)).toBe(before + 1);
    await r.timers.advance(2_000);
    expect(changes(r)).toBe(before + 1);
  });

  it('does nothing before the queue is running (no read, no throw)', async () => {
    const r = await rig();
    expect(() => r.controller.refresh()).not.toThrow();
    await settle();
    expect(changes(r)).toBe(0);
    expect(reads(r)).toBe(0);
  });

  it('does nothing after dispose', async () => {
    const r = await running();
    r.controller.dispose();
    const before = changes(r);
    expect(() => r.controller.refresh()).not.toThrow();
    await settle();
    expect(changes(r)).toBe(before);
  });

  it('does nothing while the browser is offline', async () => {
    const r = await running();
    r.page.goOffline();
    const before = changes(r);
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before);
  });

  it('works while the tab is hidden (it is a poll, not a page-hide)', async () => {
    const r = await running();
    r.page.hide();
    const before = changes(r);
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before + 1);
  });

  it('a role that cannot read reports has no queue running: refresh reads nothing', async () => {
    const r = await rig();
    const me = await r.w.client.me();
    r.controller.identify({ ...me, can: { ...me.can, 'reports.read': false } });
    await r.controller.start();
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(0);
  });
});
