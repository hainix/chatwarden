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

  it('does not move the next poll: the loop goes on at its own pace afterwards', async () => {
    const r = await running();
    r.controller.refresh();
    await settle();
    const after = changes(r);
    await r.timers.advance(4_900);
    expect(changes(r)).toBe(after);
    await r.timers.advance(200);
    expect(changes(r)).toBe(after + 1);
  });

  it('twice in a row: each is one read (the second waits for the first if it is still on its way)', async () => {
    const r = await running();
    const before = changes(r);
    r.controller.refresh();
    await settle();
    r.controller.refresh();
    await settle();
    expect(changes(r)).toBe(before + 2);
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
