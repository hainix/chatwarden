import { describe, expect, it } from 'vitest';
import { SubjectIndex } from '../src/subjects.js';
import type { Logger, SubjectId } from '../src/types.js';
import { DAY, NOW, world } from './reportingWorld.js';
import { fullStore } from './legalWorld.js';

// Chunk 5 review, Important 1: a `saveSubject` that fails must not leave the person memory-only. The index keeps the subject unsaved, retries it (and the
// identifiers and the merge that waited behind it), and the stray-row sweep never deletes the rows of a subject this process has not yet been able to save.

const MIN = 60_000;
const key = (k: string) => ({ clientKey: k, accountId: null, ipHash: null });

/** A store whose `saveSubject` throws while `down.on`, and whose calls are counted. */
function flaky(store: ReturnType<typeof fullStore>) {
  const state = { on: false, failOnlyCall: 0, calls: 0, failures: 0 };
  const real = store.saveSubject.bind(store);
  store.saveSubject = async (s) => {
    state.calls += 1;
    if (state.on || (state.failOnlyCall !== 0 && state.calls === state.failOnlyCall)) {
      state.failures += 1;
      throw new Error('SQLITE_BUSY secret detail');
    }
    return real(s);
  };
  return state;
}

describe('SubjectIndex: a subject whose save failed is retried', () => {
  it('after the retry window, the next flush saves the subject, its identifiers and its place in a merge', async () => {
    const store = fullStore();
    const clock = { t: NOW, now: () => clock.t };
    const state = flaky(store);
    state.on = true;
    const index = new SubjectIndex(store, clock);
    await index.load();
    const a = index.resolve({ clientKey: 'ka', accountId: 'acct-a', ipHash: null }) as SubjectId;
    const b = index.resolve({ clientKey: 'kb', accountId: null, ipHash: null }) as SubjectId;
    await index.flush();
    expect(index.hasUnsaved()).toBe(true);
    expect((await store.loadSubjects()).subjects).toEqual([]);
    // the same flush again inside the window does not hammer the store
    const callsBefore = state.calls;
    await index.flush();
    expect(state.calls).toBe(callsBefore);
    // a merge while both are unsaved
    state.on = false;
    index.resolve({ clientKey: 'kb', accountId: 'acct-a', ipHash: null });
    expect(index.canonical(a)).toBe(index.canonical(b));
    clock.t += 10_000;
    await index.flush();
    expect(index.hasUnsaved()).toBe(false);
    const loaded = await store.loadSubjects();
    expect(loaded.subjects.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(loaded.ids.map((r) => `${r.kind}:${r.value}`).sort()).toEqual(['account:acct-a', 'key:ka', 'key:kb']);
    const winner = index.canonical(a);
    expect(loaded.subjects.find((s) => s.id !== winner)?.mergedInto).toBe(winner);
    // a reload sees one person
    const again = new SubjectIndex(store, clock);
    await again.load();
    expect(again.canonical(a)).toBe(again.canonical(b));
  });

  it('a subject that is still unsaved is never forgotten by a reconcile (refresh), so its key keeps its owner', async () => {
    const store = fullStore();
    const clock = { t: NOW, now: () => clock.t };
    const state = flaky(store);
    state.on = true;
    const index = new SubjectIndex(store, clock);
    await index.load();
    const a = index.resolve(key('ka')) as SubjectId;
    await index.flush();
    await index.refresh();
    expect(index.knows(a)).toBe(true);
    expect(index.resolve(key('ka'))).toBe(a);
  });

  it('retries on a resolve too, once the window has passed (a quiet kit still heals)', async () => {
    const store = fullStore();
    const clock = { t: NOW, now: () => clock.t };
    const state = flaky(store);
    state.failOnlyCall = 1;
    const index = new SubjectIndex(store, clock);
    await index.load();
    const a = index.resolve(key('ka')) as SubjectId;
    await index.flush();
    expect(index.hasUnsaved()).toBe(true);
    clock.t += 10_000;
    index.resolve(key('ka'));
    await index.flush();
    expect(index.hasUnsaved()).toBe(false);
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual([a]);
  });

  it('a retry that fails again is logged by class only and the subject stays unsaved', async () => {
    const store = fullStore();
    const clock = { t: NOW, now: () => clock.t };
    const logs: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
    const logger: Logger = { warn: (e, d) => void logs.push([e, d]) };
    const state = flaky(store);
    state.on = true;
    const index = new SubjectIndex(store, clock, { logger });
    await index.load();
    const a = index.resolve(key('ka-secret')) as SubjectId;
    await index.flush();
    clock.t += 10_000;
    await index.flush();
    expect(state.failures).toBe(2);
    expect(index.hasUnsaved()).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(logs);
    for (const secret of ['ka-secret', a, 'SQLITE_BUSY', 'secret detail']) expect(text).not.toContain(secret);
  });

  it('control: with nothing failed, hasUnsaved is false and flush writes nothing extra', async () => {
    const store = fullStore();
    const clock = { t: NOW, now: () => clock.t };
    const state = flaky(store);
    const index = new SubjectIndex(store, clock);
    await index.load();
    index.resolve(key('ka'));
    await index.flush();
    clock.t += 10_000;
    await index.flush();
    await index.flush();
    expect(state.calls).toBe(1);
    expect(index.hasUnsaved()).toBe(false);
  });
});

describe('end to end: a save that failed once, rows written, a sweep ten minutes later', () => {
  const setup = async (fail: 'once' | 'down') => {
    const store = fullStore();
    const w = await world({}, store);
    const state = flaky(store);
    // call 1 is the reporter, call 2 the target
    if (fail === 'once') state.failOnlyCall = 2;
    else state.on = true;
    const t = w.table({ reporter: 'key-reporter-r', target: 'key-target-t' });
    await w.cw.flush();
    const filed = await w.submit(t.room);
    if (!filed.ok) throw new Error(`refused: ${filed.refused}`);
    const res = await w.cw.decide({
      reportId: filed.reportId,
      verdict: 'upheld',
      actor: 'mod_ann',
      reason: 'r',
      actions: [{ subject: t.target, kind: 'chat', durationMs: DAY, rule: 2, lineIds: [] }],
    });
    if (!res.ok) throw new Error('decision refused');
    store.insertStrike({ id: 'st-target', at: NOW, subject: t.target, roomId: t.room, termId: 't', rawLine: 'zorbak line' });
    return { ...w, store, state, t, noticeId: res.groups[0]?.noticeId as string };
  };

  it('the target keeps its notice and strike through the sweep, and has a subject row and identifiers afterwards', async () => {
    const e = await setup('once');
    expect(e.store.loadNotices([e.t.target]).length).toBe(1);
    e.clock.t = NOW + 11 * MIN;
    const result = await e.cw.purge();
    expect(result.strayRows).toBe(0);
    expect(e.store.loadNotices([e.t.target]).length).toBe(1);
    expect(e.store.loadStrikes(0).map((s) => s.id)).toEqual(['st-target']);
    const loaded = await e.store.loadSubjects();
    expect(loaded.subjects.map((s) => s.id)).toContain(e.t.target);
    expect(loaded.ids.filter((r) => r.subjectId === e.t.target).length).toBeGreaterThan(0);
    // a later pass is quiet too
    e.clock.t = NOW + 25 * MIN;
    expect((await e.cw.purge()).strayRows).toBe(0);
    expect(e.store.loadStrikes(0).length).toBe(1);
  });

  it('while the store is still failing at the sweep, nothing of the unsaved subject is swept; once it recovers the rows still stand', async () => {
    const e = await setup('down');
    e.clock.t = NOW + 11 * MIN;
    const during = await e.cw.purge();
    expect(during.strayRows).toBe(0);
    expect(e.store.loadNotices([e.t.target]).length).toBe(1);
    expect(e.store.loadStrikes(0).length).toBe(1);
    e.state.on = false;
    e.clock.t = NOW + 25 * MIN;
    const after = await e.cw.purge();
    expect(after.strayRows).toBe(0);
    expect(e.store.loadNotices([e.t.target]).length).toBe(1);
    expect(e.store.loadStrikes(0).length).toBe(1);
    expect((await e.store.loadSubjects()).subjects.map((s) => s.id)).toContain(e.t.target);
  });

  it('control: a row of a subject nobody knows is still swept after ten minutes (the sweep itself is unchanged)', async () => {
    const e = await setup('once');
    e.store.insertStrike({ id: 'ghost', at: NOW, subject: 's_ghost', roomId: 'R', termId: 't', rawLine: 'ghost line' });
    e.clock.t = NOW + 11 * MIN;
    const result = await e.cw.purge();
    expect(result.strayRows).toBe(1);
    expect(e.store.loadStrikes(0).map((s) => s.id)).toEqual(['st-target']);
  });
});

describe('the sweep is visible: chatwarden.stray_rows_swept with the count and no id', () => {
  it('logs the count each pass that swept something, and nothing when it swept nothing', async () => {
    const w = await world({}, fullStore());
    w.store.insertStrike({ id: 'g1', at: NOW - 20 * MIN, subject: 's_ghost_one', roomId: 'R', termId: 't', rawLine: 'ghost line one' });
    w.store.insertStrike({ id: 'g2', at: NOW - 20 * MIN, subject: 's_ghost_two', roomId: 'R', termId: 't', rawLine: 'ghost line two' });
    await w.cw.purge();
    const swept = w.logged.filter(([e]) => e === 'chatwarden.stray_rows_swept');
    expect(swept).toEqual([['chatwarden.stray_rows_swept', { count: 2 }]]);
    const text = JSON.stringify(w.logged);
    for (const secret of ['s_ghost_one', 's_ghost_two', 'ghost line']) expect(text).not.toContain(secret);
    w.logged.length = 0;
    await w.cw.purge();
    expect(w.logged.filter(([e]) => e === 'chatwarden.stray_rows_swept')).toEqual([]);
  });
});
