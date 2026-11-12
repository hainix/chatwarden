import { describe, expect, it } from 'vitest';
import type { Matcher } from '@chatwarden/core';
import { appealsWorld } from './appealsWorld.js';
import { HOUR, keysDeep, world } from './world.js';

// `handleFlagged`: every staff payload that carries a handle says whether the matcher flags it, so the hub can mask it until shown. The key
// is present (true) only when the handle is flagged AND `names.maskInHub` is on (the default); an unflagged body is what 0.1.7 sent.
// Synthetic terms only: zorbak (a slur here).

const matcher: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
const BAD = 'Zorbak_Fan';
const FINE = 'FriendlyFox';

type W = Awaited<ReturnType<typeof world>>;
let seq = 0;

/** One open report: a reporter and a target in a room of their own, with the handles given, and a line from the target. */
async function fileNamed(w: W, target = BAD, reporter = FINE) {
  const n = ++seq;
  const room = `flag-room-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-flag-reporter-${n}`, ip: '198.51.100.23' }, reporter);
  w.cw.rooms.seat(room, 'p2', { clientKey: `raw-client-key-flag-target-${n}`, ip: '203.0.113.99' }, target);
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.cw.chat.accept(room, 'p1', 'a line from the reporter');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
  if (!res.ok) throw new Error(`report refused: ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  if (report === null) throw new Error('report missing');
  return { id: res.reportId, target: report.targetPerson, reporter: report.reporterPerson, key: `raw-client-key-flag-target-${n}` };
}

/** One appeal on a sanction whose target went by `handle`, filed the real way. */
async function flaggedAppeal(w: Awaited<ReturnType<typeof appealsWorld>>, handle: string) {
  const n = ++seq;
  const room = `flag-appeal-room-${n}`;
  const key = `raw-client-key-flag-appeal-target-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-flag-appeal-reporter-${n}`, ip: '198.51.100.23' }, 'Reporter');
  w.cw.rooms.seat(room, 'p2', { clientKey: key, ip: '203.0.113.99' }, handle);
  w.cw.chat.accept(room, 'p2', 'a line');
  w.clock.t += 1000;
  const sub = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
  if (!sub.ok) throw new Error('report refused');
  const target = w.cw.reports.get(sub.reportId)?.targetPerson as string;
  const res = await w.cw.decide({ reportId: sub.reportId, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: target, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] }] } as never);
  if (!res.ok) throw new Error('decide refused');
  const filed = w.cw.appeals.file({ clientKey: key }, { noticeId: res.groups[0]?.noticeId as string, statement: 'not me' });
  if (!filed.ok) throw new Error('filing refused');
  w.clock.t += 1000;
  return filed.appeal.id;
}

const sanction = (w: W, subject: string) =>
  w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: 6 * HOUR, reason: 'private moderator reason', actor: 'ann', source: 'moderator', automated: false, rule: 2 });

const body = async (w: W, path: string, query: Record<string, string> = {}) => (await w.call('GET', path, { query })).body as Record<string, unknown>;

describe('handleFlagged appears only when flagged and only with maskInHub; unflagged bodies are byte-identical to 0.1.7; a matcher failure reads as not flagged; listing 100 handles stores no evidence even with keepBlocked on', () => {
  it('GET /reports: targetHandleFlagged and reporterHandleFlagged, each only when that handle is flagged', async () => {
    const w = await world({ matcher });
    await fileNamed(w, BAD, FINE);
    await fileNamed(w, FINE, BAD);
    await fileNamed(w, FINE, FINE);
    const items = (await body(w, '/reports')).items as Array<Record<string, unknown>>;
    const by = (target: string, reporter: string) => items.find((i) => i.targetHandle === target && i.reporterHandle === reporter) as Record<string, unknown>;
    expect(by(BAD, FINE).targetHandleFlagged).toBe(true);
    expect(Object.keys(by(BAD, FINE))).not.toContain('reporterHandleFlagged');
    expect(by(FINE, BAD).reporterHandleFlagged).toBe(true);
    expect(Object.keys(by(FINE, BAD))).not.toContain('targetHandleFlagged');
    const clean = by(FINE, FINE);
    expect(Object.keys(clean).filter((k) => k.endsWith('Flagged'))).toEqual([]);
  });

  it('GET /reports/:id: the report\'s two handles and each excerpt line\'s handle', async () => {
    const w = await world({ matcher });
    const f = await fileNamed(w, BAD, FINE);
    const one = (await body(w, `/reports/${f.id}`)).report as { targetHandle: string; targetHandleFlagged?: boolean; reporterHandleFlagged?: boolean; excerpt: Array<{ handle: string; handleFlagged?: boolean }> };
    expect(one.targetHandle).toBe(BAD);
    expect(one.targetHandleFlagged).toBe(true);
    expect(Object.keys(one)).not.toContain('reporterHandleFlagged');
    const lines = one.excerpt.map((l) => [l.handle, l.handleFlagged]);
    expect(lines).toContainEqual([BAD, true]);
    expect(lines).toContainEqual([FINE, undefined]);
    for (const l of one.excerpt) if (l.handle === FINE) expect(Object.keys(l)).not.toContain('handleFlagged');
  });

  it('GET /people/:ref/history: handleFlagged beside handle', async () => {
    const w = await world({ matcher });
    const bad = await fileNamed(w, BAD);
    const fine = await fileNamed(w, FINE);
    const h1 = await body(w, `/people/${bad.target}/history`);
    expect(h1.handle).toBe(BAD);
    expect(h1.handleFlagged).toBe(true);
    const h2 = await body(w, `/people/${fine.target}/history`);
    expect(Object.keys(h2)).not.toContain('handleFlagged');
  });

  it('GET /sanctions: handleFlagged beside each item\'s handle', async () => {
    const w = await world({ matcher });
    const bad = await fileNamed(w, BAD);
    const fine = await fileNamed(w, FINE);
    await sanction(w, bad.target);
    await sanction(w, fine.target);
    const items = (await body(w, '/sanctions')).items as Array<{ person: string; handle: string; handleFlagged?: boolean }>;
    expect(items.find((i) => i.person === bad.target)?.handleFlagged).toBe(true);
    const clean = items.find((i) => i.person === fine.target) as object;
    expect(Object.keys(clean)).not.toContain('handleFlagged');
  });

  it('GET /blocked (chat lines and kept names): handleFlagged beside the handle', async () => {
    const w = await world({ matcher, overrides: { names: { keepBlocked: true } } });
    const bad = await fileNamed(w, BAD);
    const fine = await fileNamed(w, FINE);
    w.store.insertStrike({ id: 'k1', at: w.clock.now() - HOUR, subject: bad.target, roomId: 'ROOM1', termId: 'syn:zorbak', rawLine: 'you zorbak' });
    w.store.insertStrike({ id: 'k2', at: w.clock.now() - HOUR, subject: fine.target, roomId: 'ROOM1', termId: 'syn:zorbak', rawLine: 'you zorbak' });
    w.cw.names.check('zorbak_a', { who: { clientKey: bad.key } });
    w.cw.names.check('zorbak_b', { who: { clientKey: fine.key } });
    for (const query of [{}, { source: 'name' }] as Array<Record<string, string>>) {
      const items = (await body(w, '/blocked', query)).items as Array<{ person: string; handleFlagged?: boolean }>;
      expect(items.find((i) => i.person === bad.target)?.handleFlagged, JSON.stringify(query)).toBe(true);
      expect(Object.keys(items.find((i) => i.person === fine.target) as object), JSON.stringify(query)).not.toContain('handleFlagged');
    }
  });

  it('GET /appeals: handleFlagged beside handle, only for a caller who sees the handle; an unflagged name carries none', async () => {
    const w = await appealsWorld({ matcher });
    await flaggedAppeal(w, BAD);
    await flaggedAppeal(w, FINE);
    const items = (await body(w, '/appeals')).items as Array<{ handle: string; handleFlagged?: boolean }>;
    expect(items.map((i) => [i.handle, i.handleFlagged])).toEqual([
      [BAD, true],
      [FINE, undefined],
    ]);
    expect(Object.keys(items[1] as object)).not.toContain('handleFlagged');
    // A caller without history.read gets no handle, and so no flag to go with it.
    const closed = await appealsWorld({ matcher, permissions: { 'history.read': 'senior' } });
    await flaggedAppeal(closed, BAD);
    const hidden = ((await closed.call('GET', '/appeals', { role: 'moderator' })).body as { items: Array<Record<string, unknown>> }).items;
    expect(hidden[0]).toMatchObject({ handle: null });
    expect(Object.keys(hidden[0] as object)).not.toContain('handleFlagged');
    const shown = ((await closed.call('GET', '/appeals', { role: 'senior' })).body as { items: Array<Record<string, unknown>> }).items;
    expect(shown[0]).toMatchObject({ handle: BAD, handleFlagged: true });
  });

  it('names.maskInHub off: no handleFlagged anywhere', async () => {
    const w = await world({ matcher, overrides: { names: { maskInHub: false } } });
    const bad = await fileNamed(w, BAD, BAD);
    await sanction(w, bad.target);
    w.store.insertStrike({ id: 'k1', at: w.clock.now() - HOUR, subject: bad.target, roomId: 'ROOM1', termId: 'syn:zorbak', rawLine: 'you zorbak' });
    for (const path of ['/reports', `/reports/${bad.id}`, `/people/${bad.target}/history`, '/sanctions', '/blocked']) {
      const text = JSON.stringify(await body(w, path));
      expect(text, path).toContain(BAD);
      expect(text, path).not.toContain('Flagged');
    }
  });

  it('names.maskInHub is read live: switching it off in the policy takes effect at once', async () => {
    const w = await world({ matcher });
    const bad = await fileNamed(w);
    expect(JSON.stringify(await body(w, `/people/${bad.target}/history`))).toContain('handleFlagged');
    w.cw.policy.save({ names: { maskInHub: false } }, { version: 0, actor: 'owner', reason: 'show names' });
    expect(JSON.stringify(await body(w, `/people/${bad.target}/history`))).not.toContain('handleFlagged');
  });

  it('unflagged bodies are byte-identical to 0.1.7: no Flagged key at any depth, and the same JSON as a kit with no matcher', async () => {
    const plain = await world({});
    const withMatcher = await world({ matcher });
    const run = async (w: W) => {
      const f = await fileNamed(w, FINE, FINE);
      await sanction(w, f.target);
      return { f, bodies: { reports: await body(w, '/reports'), one: await body(w, `/reports/${f.id}`), history: await body(w, `/people/${f.target}/history`), sanctions: await body(w, '/sanctions'), blocked: await body(w, '/blocked') } };
    };
    const a = await run(plain);
    const b = await run(withMatcher);
    for (const k of ['reports', 'one', 'history', 'sanctions', 'blocked'] as const) {
      expect([...keysDeep(b.bodies[k])].filter((x) => x.endsWith('Flagged')), k).toEqual([]);
      // Random ids and codes differ between the two worlds; every key and every value that is not one does not.
      const norm = (v: unknown): string => JSON.stringify(v).replace(/s_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{16,}|[A-Z]-[A-Z0-9]{5}|flag-room-\d+/g, '*');
      expect(norm(b.bodies[k]), k).toBe(norm(a.bodies[k]));
    }
  });

  it('a matcher failure reads as not flagged: the route still answers 200 with no flag, and logs the class only', async () => {
    const boom: Matcher = {
      match: () => {
        throw new TypeError(`matcher down ${BAD}`);
      },
    };
    const w = await world({ matcher: boom });
    const f = await fileNamed(w, BAD, BAD);
    await sanction(w, f.target);
    for (const path of ['/reports', `/reports/${f.id}`, `/people/${f.target}/history`, '/sanctions']) {
      const res = await w.call('GET', path);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toContain('Flagged');
    }
    expect(JSON.stringify(w.logged)).not.toContain(BAD);
  });

  it('listing 100 handles stores no evidence even with keepBlocked on, and writes no audit row of its own', async () => {
    const w = await world({ matcher, overrides: { names: { keepBlocked: true, profanity: true } } });
    for (let i = 0; i < 100; i++) await fileNamed(w, `${BAD}_${i}`);
    const kept = () => w.store.listBlockedNames?.(0, 200) ?? [];
    expect(kept()).toEqual([]);
    const res = await w.call('GET', '/reports', { query: { limit: '100' } });
    const items = (res.body as { items: Array<{ targetHandleFlagged?: boolean }> }).items;
    expect(items).toHaveLength(100);
    expect(items.every((i) => i.targetHandleFlagged === true)).toBe(true);
    await w.call('GET', '/sanctions');
    await w.call('GET', '/blocked');
    expect(kept()).toEqual([]);
    expect(w.routeAudit().map((r) => r.action).sort()).toEqual(['blocked.view', 'history.view', 'report.view']);
  });

  it('no handle or name is logged', async () => {
    const w = await world({ matcher });
    const f = await fileNamed(w, BAD, `${FINE}_unique`);
    await sanction(w, f.target);
    for (const path of ['/reports', `/reports/${f.id}`, `/people/${f.target}/history`, '/sanctions', '/blocked']) await w.call('GET', path);
    const text = JSON.stringify(w.logged);
    for (const v of [BAD, FINE, 'unique', 'zorbak']) expect(text.toLowerCase()).not.toContain(v.toLowerCase());
  });
});

describe('the matcher runs once per distinct handle in one response, and again on the next request', () => {
  const counting = () => {
    const calls: string[] = [];
    const m: Matcher = { match: (t) => (calls.push(t), /zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
    return { calls, m };
  };

  it('GET /reports with many reports and repeated handles: each distinct handle is asked about once, the answers are unchanged', async () => {
    const { calls, m } = counting();
    const w = await world({ matcher: m });
    for (let i = 0; i < 6; i++) await fileNamed(w, BAD, FINE);
    for (let i = 0; i < 4; i++) await fileNamed(w, FINE, BAD);
    calls.length = 0;
    const items = (await body(w, '/reports')).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(10);
    expect(calls.slice().sort()).toEqual([BAD, FINE].sort());
    expect(items.filter((i) => i.targetHandleFlagged === true)).toHaveLength(6);
    expect(items.filter((i) => i.reporterHandleFlagged === true)).toHaveLength(4);
    // the next request asks again: a term added in between takes effect at once
    calls.length = 0;
    await body(w, '/reports');
    expect(calls.slice().sort()).toEqual([BAD, FINE].sort());
  });

  it('GET /reports/:id: the same handle on the report and on every excerpt line is asked about once', async () => {
    const { calls, m } = counting();
    const w = await world({ matcher: m });
    const f = await fileNamed(w, BAD, FINE);
    calls.length = 0;
    const one = (await body(w, `/reports/${f.id}`)).report as { excerpt: Array<{ handle: string; handleFlagged?: boolean }> };
    expect(one.excerpt.length).toBeGreaterThan(1);
    expect(calls.filter((c) => c === BAD)).toHaveLength(1);
    expect(calls.filter((c) => c === FINE)).toHaveLength(1);
    expect(one.excerpt.filter((l) => l.handle === BAD).every((l) => l.handleFlagged === true)).toBe(true);
  });

  it('a handle the matcher fails on is asked once per response too, reads as not flagged, and is retried on the next request', async () => {
    let calls = 0;
    const m: Matcher = {
      match: () => {
        calls += 1;
        throw new RangeError('matcher down');
      },
    };
    const w = await world({ matcher: m });
    for (let i = 0; i < 5; i++) await fileNamed(w, BAD, FINE);
    calls = 0;
    const items = (await body(w, '/reports')).items as Array<Record<string, unknown>>;
    expect(calls).toBe(2);
    expect(items.some((i) => Object.keys(i).some((k) => k.endsWith('Flagged')))).toBe(false);
    await body(w, '/reports');
    expect(calls).toBe(4);
  });

  it('maskInHub off: the matcher is not asked at all', async () => {
    const { calls, m } = counting();
    const w = await world({ matcher: m, overrides: { names: { maskInHub: false } } });
    for (let i = 0; i < 3; i++) await fileNamed(w, BAD, FINE);
    calls.length = 0;
    await body(w, '/reports');
    expect(calls).toEqual([]);
  });
});
