import type { Chatwarden } from '@chatwarden/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eosWorld, idle, makeEos, sanctionKey, sanctionProblems, until } from './eos-world.js';
import type { EosWorld } from './eos-world.js';
import { world } from './world.js';

// K5 E2: a kit sanction becomes an EOS sanction (design 9.3). Nothing here touches the network: the adapter's `fetch` is the fake EOS, and its clock and jitter are injected.

afterEach(() => {
  vi.useRealTimers();
});

const DAY = 86_400_000;
const PUID = 'puid-fenrisk-0001';

/** A world, then fake timers (the kit's own setup needs real ones). */
const fakeWorld = async (over: Parameters<typeof eosWorld>[0] = {}) => {
  const c = await eosWorld(over);
  vi.useFakeTimers();
  return c;
};
/** With fake timers: let the queue run (microtasks and timers due now), then move `ms`. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

interface Made {
  subject: string;
  groupId: string;
  refCode: string;
}
/** A seated person with an EOS account, and one kit sanction on them. */
async function sanction(
  c: EosWorld,
  o: { kind?: 'chat' | 'area' | 'ban' | 'warning' | 'note'; durationMs?: number | null; rule?: number | 'uncovered'; reason?: string; ids?: string[]; automated?: boolean; source?: 'moderator' | 'auto_filter' } = {},
): Promise<Made> {
  const subject = c.w.person();
  c.accounts.set(subject, o.ids ?? [PUID]);
  const kind = o.kind ?? 'chat';
  const timed = kind === 'chat' || kind === 'area' || kind === 'ban';
  const rule = o.rule ?? 1;
  const res = await c.cw.sanctions.apply({
    kind,
    subject,
    includeIp: false,
    durationMs: timed ? (o.durationMs === undefined ? DAY : o.durationMs) : null,
    reason: o.reason ?? 'private moderator reason',
    actor: 'ann',
    source: o.source ?? 'moderator',
    automated: o.automated ?? false,
    rule,
    ...(rule === 'uncovered' && (o.source ?? 'moderator') === 'moderator' ? { gapNote: 'a gap note' } : {}),
  });
  return { subject, ...res };
}

/** The API calls (not the token) as `METHOD tail`. */
const api = (c: EosWorld): string[] =>
  c.fake.calls.filter((x) => !x.path.includes('/oauth/')).map((x) => `${x.method} ${x.path.replace(/^\/sanctions\/v1\/[^/]+\//, '').replace(/users\/.*/, 'users/_')}`);
const creates = (c: EosWorld) => c.fake.calls.filter((x) => x.method === 'POST' && x.path.endsWith('/sanctions'));
const deletes = (c: EosWorld) => c.fake.calls.filter((x) => x.method === 'DELETE');
const link = (c: EosWorld, m: Made, id = PUID) => c.cw.links.get('eos-sanction', sanctionKey(m.groupId, id));
const eosLogs = (c: EosWorld) => c.logged.filter(([e]) => e.startsWith('chatwarden.eos'));

/** The kit as the adapter sees it, with `links.put` and `links.get` that fail on demand. */
function failingLinks(cw: Chatwarden, fails: { put: number; get: number }): Chatwarden {
  const links = {
    get supported() {
      return true;
    },
    get: (system: never, ref: string) => {
      if (fails.get > 0) {
        fails.get--;
        throw new Error('disk full puid-glarn-SECRETP');
      }
      return cw.links.get(system, ref);
    },
    put: (row: never) => {
      if (fails.put > 0) {
        fails.put--;
        throw new Error('disk full puid-glarn-SECRETP');
      }
      cw.links.put(row);
    },
    list: (system: never, q?: never) => cw.links.list(system, q),
  };
  return new Proxy(cw, { get: (t, p, r) => (p === 'links' ? links : (Reflect.get(t, p, r) as unknown)) });
}

describe('push: what is sent', () => {
  it('chat, area and ban push with the configured action names, a duration in seconds, source chatwarden, tags cw and rule<n>, metadata cw_ref and cw_rule, a justification of the ref and rule only', async () => {
    const c = await eosWorld();
    const made: Made[] = [];
    for (const [kind, ms] of [['chat', DAY], ['area', 2 * 3_600_000], ['ban', 7 * DAY]] as const) {
      made.push(await sanction(c, { kind, durationMs: ms, rule: 2, ids: [`puid-${kind}-0001`] }));
    }
    await until(() => creates(c).length === 3 && link(c, made[2] as Made, 'puid-ban-0001') !== null, 'three pushes');
    const bodies = creates(c).map((x) => (x.body as unknown[])[0]);
    expect(bodies).toEqual(
      (['chat', 'area', 'ban'] as const).map((kind, i) => ({
        productUserId: `puid-${kind}-0001`,
        action: `chatwarden-${kind}`,
        justification: `Chatwarden ${(made[i] as Made).refCode}, Rule 2`,
        source: 'chatwarden',
        duration: [86_400, 7200, 604_800][i],
        pending: false,
        automated: false,
        tags: ['cw', 'rule2'],
        metadata: { cw_ref: (made[i] as Made).refCode, cw_rule: '2' },
      })),
    );
    for (const call of creates(c)) expect((call.body as unknown[]).length).toBe(1);
    expect(c.fake.schemaProblems.flat()).toEqual([]);
    expect(eosLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('a rule the kit does not cover has no rule in the justification and no rule tag', async () => {
    const c = await eosWorld();
    const m = await sanction(c, { rule: 'uncovered' });
    await until(() => link(c, m) !== null, 'push');
    const body = (creates(c)[0]?.body as Array<Record<string, unknown>>)[0];
    expect(body?.['justification']).toBe(`Chatwarden ${m.refCode}`);
    expect(body?.['tags']).toEqual(['cw']);
    expect(body?.['metadata']).toEqual({ cw_ref: m.refCode, cw_rule: 'uncovered' });
    c.adapter.dispose();
  });

  it('the duration is rounded to whole seconds and is at least 1; a permanent sanction sends duration 0', async () => {
    const c = await eosWorld();
    const cases: Array<[number | null, number]> = [[1400, 1], [1600, 2], [1, 1], [86_400_000, 86_400], [null, 0]];
    const made: Made[] = [];
    for (const [i, [ms]] of cases.entries()) made.push(await sanction(c, { kind: 'ban', durationMs: ms, ids: [`puid-dur-${i}`] }));
    await until(() => creates(c).length === cases.length && link(c, made[4] as Made, 'puid-dur-4') !== null, 'pushes');
    expect(creates(c).map((x) => ((x.body as Array<{ duration: number }>)[0] as { duration: number }).duration)).toEqual(cases.map(([, want]) => want));
    c.adapter.dispose();
  });

  it('the time already used is taken off: the duration counts from the kit clock when the request is made', async () => {
    const c = await fakeWorld();
    // The first request fails once and waits 1 s; the duration is read when the request is built, from `until` minus now.
    c.fake.script.push({ on: 'create', status: 503 });
    const m = await sanction(c, { kind: 'ban', durationMs: 100_000 });
    await tick(0);
    c.w.clock.t += 10_000;
    await tick(1000);
    await tick(0);
    expect(link(c, m)?.state).toBe('active');
    const last = creates(c).at(-1)?.body as Array<{ duration: number }>;
    expect(last[0]?.duration).toBe(90);
    c.adapter.dispose();
  });

  it('a warning is pushed only when it has an action (permanent: duration 0); a note never', async () => {
    const off = await eosWorld();
    await sanction(off, { kind: 'warning' });
    await sanction(off, { kind: 'note' });
    await idle();
    expect(off.fake.calls).toEqual([]);
    off.adapter.dispose();

    const on = await eosWorld({ sanctions: { actions: { warning: 'chatwarden-warning', chat: 'chatwarden-chat' } } });
    const w = await sanction(on, { kind: 'warning' });
    await sanction(on, { kind: 'note', ids: ['puid-note-1'] });
    await until(() => link(on, w) !== null, 'warning push');
    expect(creates(on)).toHaveLength(1);
    const body = (creates(on)[0]?.body as Array<Record<string, unknown>>)[0];
    expect(body).toMatchObject({ action: 'chatwarden-warning', duration: 0 });
    expect(on.fake.calls.some((x) => JSON.stringify(x.body ?? '').includes('puid-note-1'))).toBe(false);
    on.adapter.dispose();
  });

  it('a kind with no action is not pushed and makes no request, not even a lookup', async () => {
    const c = await eosWorld({ sanctions: { actions: { ban: 'chatwarden-ban' } } });
    await sanction(c, { kind: 'chat' });
    await idle();
    expect(c.fake.calls).toEqual([]);
    expect(c.resolved).toEqual([]);
    c.adapter.dispose();
  });

  it('an automatic sanction is pushed only with includeAutomatic: not by sanction.applied, and not by auto.restricted', async () => {
    const off = await eosWorld();
    await sanction(off, { source: 'auto_filter', automated: true, durationMs: 1_800_000 });
    await idle();
    expect(off.fake.calls).toEqual([]);
    // The adapter is not even subscribed to auto.restricted.
    expect(off.subs.map(([t]) => t).sort()).toEqual(['sanction.applied', 'sanction.revoked']);
    off.adapter.dispose();
  });

  it('with includeAutomatic: an automatic timeout from auto.restricted is pushed with automated true, its length and rule read from the stored group', async () => {
    const w = await world();
    const subject = w.person();
    const g = await w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: 1_800_000, reason: 'auto', actor: 'auto_filter', source: 'auto_filter', automated: true, rule: 2 });
    const c = makeEos(w, { sanctions: { includeAutomatic: true } });
    c.accounts.set(subject, [PUID]);
    expect(c.subs.map(([t]) => t).sort()).toEqual(['auto.restricted', 'sanction.applied', 'sanction.revoked']);
    c.emit({ type: 'auto.restricted', groupId: g.groupId, refCode: g.refCode, second: false, subject });
    await until(() => c.cw.links.get('eos-sanction', sanctionKey(g.groupId, PUID)) !== null, 'push');
    const body = (creates(c)[0]?.body as Array<Record<string, unknown>>)[0];
    expect(body).toMatchObject({ action: 'chatwarden-chat', duration: 1800, automated: true, tags: ['cw', 'rule2'], metadata: { cw_ref: g.refCode, cw_rule: '2' } });
    // The same group again (an event twice) is a no-op: the link exists.
    c.emit({ type: 'auto.restricted', groupId: g.groupId, refCode: g.refCode, second: false, subject });
    await idle();
    expect(creates(c)).toHaveLength(1);
    c.adapter.dispose();
  });

  it('with includeAutomatic: a sanction.applied marked automated is pushed too', async () => {
    const c = await eosWorld({ sanctions: { includeAutomatic: true } });
    const m = await sanction(c, { source: 'auto_filter', automated: true, durationMs: 1_800_000 });
    await until(() => link(c, m) !== null, 'push');
    expect((creates(c)[0]?.body as Array<{ automated: boolean }>)[0]?.automated).toBe(true);
    c.adapter.dispose();
  });

  it('an auto.restricted for a group the kit cannot find sends nothing and is not an error', async () => {
    const w = await world();
    const c = makeEos(w, { sanctions: { includeAutomatic: true } });
    c.emit({ type: 'auto.restricted', groupId: 'g-none', refCode: 'M-AAAAA', second: false, subject: 's_x' });
    await idle();
    expect(c.fake.calls).toEqual([]);
    c.adapter.dispose();
  });
});

describe('push: the private reason', () => {
  const REASON = 'zorbak is quissel and vlemmo, private moderator reason';

  it("the moderator's private reason is never sent unless justification is 'reason'", async () => {
    const c = await eosWorld();
    const m = await sanction(c, { reason: REASON });
    await until(() => link(c, m) !== null, 'push');
    for (const call of c.fake.calls) expect(JSON.stringify(call.body ?? '')).not.toContain('quissel');
    c.adapter.dispose();
  });

  it("with justification 'reason' the reason is sent, cut to 2048 without splitting a character", async () => {
    const c = await eosWorld({ sanctions: { justification: 'reason' } });
    const m = await sanction(c, { reason: REASON });
    const long = await sanction(c, { reason: `${'a'.repeat(2047)}\u{1F600}tail`, ids: ['puid-long-1'] });
    const huge = await sanction(c, { reason: 'b'.repeat(2500), ids: ['puid-long-2'] });
    await until(() => link(c, huge, 'puid-long-2') !== null && link(c, long, 'puid-long-1') !== null && link(c, m) !== null, 'pushes');
    const just = (id: string) => ((creates(c).find((x) => (x.body as Array<{ productUserId: string }>)[0]?.productUserId === id)?.body as Array<{ justification: string }>)[0] as { justification: string }).justification;
    expect(just(PUID)).toBe(REASON);
    expect(just('puid-long-1')).toBe('a'.repeat(2047));
    expect(just('puid-long-2')).toBe('b'.repeat(2048));
    expect(c.fake.schemaProblems.flat()).toEqual([]);
    c.adapter.dispose();
  });
});

describe('push: the fake enforces EOS limits', () => {
  it("an action over 64 characters, a tag over 16, a metadata value over 128, a bad source or a duplicate tag are refused by the fake", () => {
    const ok = { productUserId: 'p', action: 'a', justification: 'j', source: 'chatwarden', duration: 5, tags: ['cw'], metadata: { k: 'v' } };
    expect(sanctionProblems(ok)).toEqual([]);
    expect(sanctionProblems({ ...ok, action: 'a'.repeat(65) })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, action: 'has space' })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, tags: ['x'.repeat(17)] })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, tags: ['cw', 'CW'] })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, metadata: { k: 'v'.repeat(129) } })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, metadata: { ['k'.repeat(65)]: 'v' } })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, source: 'x' })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, justification: '' })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, justification: 'j'.repeat(2049) })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, duration: -1 })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, duration: 1.5 })).not.toEqual([]);
    expect(sanctionProblems({ ...ok, extra: 1 })).not.toEqual([]);
  });

  it('the adapter never produces one: long action names, a big rule number and a 5000 character reason all pass the fake', async () => {
    const c = await eosWorld({ sanctions: { justification: 'reason', actions: { chat: 'c'.repeat(64), ban: 'chatwarden-ban' } } });
    const a = await sanction(c, { rule: 123_456, reason: 'r'.repeat(5000) });
    const b = await sanction(c, { kind: 'ban', rule: 999_999_999_999_999, ids: ['puid-big-1'] });
    await until(() => link(c, a) !== null && link(c, b, 'puid-big-1') !== null, 'pushes');
    expect(c.fake.schemaProblems.flat()).toEqual([]);
    expect(c.fake.sanctions).toHaveLength(2);
    const tags = c.fake.sanctions.map((s) => s.tags);
    expect(tags[0]).toEqual(['cw', 'rule123456']);
    expect(tags[1]).toEqual(['cw']);
    c.adapter.dispose();
  });
});

describe('push: skip when linked, and reconcile before create', () => {
  it('a group already linked is skipped with no request at all; so is one linked as removed', async () => {
    const w = await world();
    const c = makeEos(w);
    const subject = w.person();
    c.accounts.set(subject, [PUID, 'puid-2']);
    // Hold the push until the links exist, by raising the event ourselves after writing them.
    const g = await w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'x', actor: 'ann', source: 'moderator', automated: false, rule: 1 });
    await until(() => c.fake.sanctions.length === 2, 'the first push');
    const before = c.fake.calls.length;
    c.cw.links.put({ system: 'eos-sanction', ref: sanctionKey(g.groupId, 'puid-2'), external: 'ref-2', state: 'removed', at: 1 });
    c.emit({ type: 'sanction.applied', groupId: g.groupId, refCode: g.refCode, kind: 'chat', until: w.clock.t + DAY, rule: 1, source: 'moderator', automated: false, target: subject });
    await idle();
    expect(c.fake.calls).toHaveLength(before);
    expect(c.fake.sanctions).toHaveLength(2);
    c.adapter.dispose();
  });

  it('reconcile before create: after a lost answer the retry finds the sanction by cw_ref, writes the link and creates nothing', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'create', lose: true });
    const m = await sanction(c);
    await tick(0);
    // EOS made it; the answer was lost; no link yet.
    expect(c.fake.sanctions).toHaveLength(1);
    expect(link(c, m)).toBeNull();
    await tick(1000);
    await tick(0);
    expect(c.fake.sanctions).toHaveLength(1);
    expect(creates(c)).toHaveLength(1);
    expect(link(c, m)).toMatchObject({ system: 'eos-sanction', external: c.fake.sanctions[0]?.referenceId, state: 'active' });
    c.adapter.dispose();
  });

  it('reconcile before create: a crash between EOS answering and the link write (the write fails once) creates no second sanction', async () => {
    const fails = { put: 1, get: 0 };
    const c = await fakeWorld({ wrapKit: (cw) => failingLinks(cw, fails) });
    const m = await sanction(c);
    await tick(0);
    expect(fails.put).toBe(0);
    expect(c.fake.sanctions).toHaveLength(1);
    expect(link(c, m)).toBeNull();
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'link', error: 'Error' }]]);
    await tick(1000);
    await tick(0);
    expect(c.fake.sanctions).toHaveLength(1);
    expect(creates(c)).toHaveLength(1);
    expect(link(c, m)).toMatchObject({ state: 'active', external: c.fake.sanctions[0]?.referenceId });
    c.adapter.dispose();
  });

  /** A sanction of someone else's, as the portal might have made it: newer than ours. */
  const other = (i: number, puid: string) => ({
    referenceId: `other-${i}`,
    productUserId: puid,
    action: 'x',
    justification: 'j',
    source: 'portal',
    tags: [],
    metadata: { cw_ref: `M-OTHER${i}` },
    duration: null,
    automated: false,
    pending: false,
    status: 'Active' as const,
    createdAt: new Date(1_900_000_000_000 + i * 1000).toISOString(),
  });

  /** A kit group written before the adapter exists, then an adapter that is told about it (as a retry after a restart would be). */
  async function lateAdapter(over: Parameters<typeof makeEos>[1] = {}) {
    const w = await world();
    const subject = w.person();
    const g = await w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'x', actor: 'ann', source: 'moderator', automated: false, rule: 1 });
    const c = makeEos(w, over);
    c.accounts.set(subject, [PUID]);
    const raise = () => c.emit({ type: 'sanction.applied', groupId: g.groupId, refCode: g.refCode, kind: 'chat', until: w.clock.t + DAY, rule: 1, source: 'moderator', automated: false, target: subject });
    const made: Made = { subject, ...g };
    return { c, g, made, raise };
  }

  it('reconcile finds the sanction on a later page and ignores the sanctions of other groups; nothing is created', async () => {
    const { c, g, made, raise } = await lateAdapter();
    for (let i = 0; i < 120; i++) c.fake.sanctions.push(other(i, PUID));
    c.fake.sanctions.push({ ...other(0, PUID), referenceId: 'ours-0001', metadata: { cw_ref: g.refCode }, createdAt: new Date(1_000_000_000_000).toISOString() });
    raise();
    await until(() => link(c, made) !== null, 'the link');
    expect(link(c, made)).toMatchObject({ external: 'ours-0001', state: 'active' });
    expect(c.fake.calls.filter((x) => x.method === 'GET' && x.path.includes('/users/')).map((x) => x.query)).toEqual([
      [['limit', '100'], ['offset', '0']],
      [['limit', '100'], ['offset', '100']],
    ]);
    expect(creates(c)).toHaveLength(0);
    c.adapter.dispose();
  });

  it('the lookup is bounded: with more than 500 sanctions to scan and ours not among them, nothing is created and the log says so', async () => {
    const { c, made, raise } = await lateAdapter();
    for (let i = 0; i < 600; i++) c.fake.sanctions.push(other(i, PUID));
    raise();
    await until(() => eosLogs(c).length > 0, 'a log');
    expect(creates(c)).toHaveLength(0);
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'reconcile', error: 'TooMany' }]]);
    expect(link(c, made)).toBeNull();
    expect(c.fake.calls.filter((x) => x.method === 'GET' && x.path.includes('/users/'))).toHaveLength(5);
    c.adapter.dispose();
  });

  it('a sanction of this group that someone removed in EOS is linked as removed and not created again', async () => {
    const { c, g, made, raise } = await lateAdapter();
    c.fake.sanctions.push({ ...other(0, PUID), referenceId: 'ours-gone', metadata: { cw_ref: g.refCode }, status: 'Removed' });
    raise();
    await until(() => link(c, made) !== null, 'the link');
    expect(link(c, made)).toMatchObject({ external: 'ours-gone', state: 'removed' });
    expect(creates(c)).toHaveLength(0);
    c.adapter.dispose();
  });

  it('a lookup answer that is not a list is a failure, never a create', async () => {
    const { c, made, raise } = await lateAdapter();
    c.fake.script.push({ on: 'user', status: 200, body: { elements: 'nope' } });
    raise();
    await until(() => eosLogs(c).length > 0, 'a log');
    expect(creates(c)).toHaveLength(0);
    expect(link(c, made)).toBeNull();
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'reconcile', error: 'BadAnswer' }]]);
    c.adapter.dispose();
  });
});

describe('push: revoke', () => {
  it('removes the EOS sanction by referenceId with a Lifted justification and marks the link removed', async () => {
    const c = await eosWorld();
    const m = await sanction(c);
    await until(() => link(c, m)?.state === 'active', 'push');
    const referenceId = link(c, m)?.external;
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'private revoke reason quissel');
    await until(() => link(c, m)?.state === 'removed', 'removal');
    expect(deletes(c)).toHaveLength(1);
    expect(deletes(c)[0]?.body).toEqual({ referenceIds: [referenceId], justification: `Lifted: ${m.refCode}` });
    expect(c.fake.sanctions[0]?.status).toBe('Removed');
    expect(JSON.stringify(deletes(c)[0]?.body)).not.toContain('quissel');
    // A second revoke event for the same group does nothing more.
    c.emit({ type: 'sanction.revoked', groupId: m.groupId, refCode: m.refCode, at: 1, subject: m.subject, rule: 1 });
    await idle();
    expect(deletes(c)).toHaveLength(1);
    c.adapter.dispose();
  });

  it('a revoke for a group that was never pushed does nothing: no link, no delete', async () => {
    const w = await world();
    const subject = w.person();
    const g = await w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'x', actor: 'ann', source: 'moderator', automated: false, rule: 1 });
    const c = makeEos(w);
    c.accounts.set(subject, [PUID]);
    await w.cw.sanctions.revoke(g.groupId, 'ann', 'x');
    await idle();
    expect(deletes(c)).toHaveLength(0);
    expect(c.fake.sanctions).toHaveLength(0);
    expect(eosLogs(c)).toEqual([['chatwarden.eos_revoke_no_link', { count: 1 }]]);
    c.adapter.dispose();
  });

  it('a revoke that finds a removed link logs nothing (only a missing link is counted)', async () => {
    const c = await eosWorld();
    const m = await sanction(c);
    await until(() => link(c, m)?.state === 'active', 'push');
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'x');
    await until(() => link(c, m)?.state === 'removed', 'removal');
    c.emit({ type: 'sanction.revoked', groupId: m.groupId, refCode: m.refCode, at: 1, subject: m.subject, rule: 1 });
    await idle();
    expect(eosLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('a revoke of a kind that has no action, or a note, is not even looked up', async () => {
    const c = await eosWorld({ sanctions: { actions: { ban: 'chatwarden-ban' } } });
    const m = await sanction(c, { kind: 'chat' });
    const n = await sanction(c, { kind: 'note', ids: ['puid-n'] });
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'x');
    await c.cw.sanctions.revoke(n.groupId, 'ann', 'x');
    await idle();
    expect(c.resolved).toEqual([]);
    expect(c.fake.calls).toEqual([]);
    c.adapter.dispose();
  });

  it('a revoke queued before the create finished runs after it', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'create', status: 503 });
    const m = await sanction(c);
    await tick(0);
    expect(creates(c)).toHaveLength(1);
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'x');
    await tick(0);
    expect(deletes(c)).toHaveLength(0);
    await tick(1000);
    await tick(0);
    await tick(0);
    expect(api(c).filter((x) => !x.startsWith('GET'))).toEqual(['POST sanctions', 'POST sanctions', 'DELETE sanctions']);
    expect(link(c, m)?.state).toBe('removed');
    expect(c.fake.sanctions[0]?.status).toBe('Removed');
    c.adapter.dispose();
  });

  it('EOS having lost the sanction (404) still ends with the link removed and no retry; a 5xx is retried; a 400 is final', async () => {
    const c = await fakeWorld();
    const m = await sanction(c);
    await tick(0);
    expect(link(c, m)?.state).toBe('active');
    c.fake.script.push({ on: 'delete', status: 404 });
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'x');
    await tick(0);
    expect(deletes(c)).toHaveLength(1);
    expect(link(c, m)?.state).toBe('removed');
    c.adapter.dispose();

    const d = await fakeWorld();
    const m2 = await sanction(d);
    await tick(0);
    d.fake.script.push({ on: 'delete', status: 503 });
    await d.cw.sanctions.revoke(m2.groupId, 'ann', 'x');
    await tick(0);
    expect(link(d, m2)?.state).toBe('active');
    await tick(1000);
    await tick(0);
    expect(deletes(d)).toHaveLength(2);
    expect(link(d, m2)?.state).toBe('removed');
    d.adapter.dispose();

    const e = await fakeWorld();
    const m3 = await sanction(e);
    await tick(0);
    e.fake.script.push({ on: 'delete', status: 400 });
    await e.cw.sanctions.revoke(m3.groupId, 'ann', 'x');
    await tick(5000);
    expect(deletes(e)).toHaveLength(1);
    expect(link(e, m3)?.state).toBe('active');
    expect(eosLogs(e)).toEqual([['chatwarden.eos_failed', { op: 'revoke', status: 400, attempts: 1 }]]);
    e.adapter.dispose();
  });
});

describe('push: two accounts and a failing map', () => {
  it('two accounts for one person push one sanction each and are removed each; productUserIdsOf gets the canonical subject and every alias', async () => {
    const c = await eosWorld();
    const m = await sanction(c, { ids: ['puid-two-a', 'puid-two-b', 'puid-two-a', ''] });
    await until(() => c.fake.sanctions.length === 2 && link(c, m, 'puid-two-b') !== null, 'two pushes');
    expect(c.fake.sanctions.map((s) => s.productUserId).sort()).toEqual(['puid-two-a', 'puid-two-b']);
    expect(link(c, m, 'puid-two-a')?.external).not.toBe(link(c, m, 'puid-two-b')?.external);
    expect(c.resolved[0]).toEqual([m.subject, c.cw.people.aliases(m.subject)]);
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'x');
    await until(() => link(c, m, 'puid-two-a')?.state === 'removed' && link(c, m, 'puid-two-b')?.state === 'removed', 'two removals');
    expect(deletes(c)).toHaveLength(2);
    c.adapter.dispose();
  });

  it('an account found only on a later revoke is not invented: a revoke removes only what has an active link', async () => {
    const c = await eosWorld();
    const m = await sanction(c, { ids: ['puid-first'] });
    await until(() => link(c, m, 'puid-first') !== null, 'push');
    c.accounts.set(m.subject, ['puid-first', 'puid-later']);
    await c.cw.sanctions.revoke(m.groupId, 'ann', 'x');
    await until(() => link(c, m, 'puid-first')?.state === 'removed', 'removal');
    expect(deletes(c)).toHaveLength(1);
    expect(link(c, m, 'puid-later')).toBeNull();
    c.adapter.dispose();
  });

  it('a throwing, rejecting, empty or malformed productUserIdsOf logs op resolve with a class, pushes nothing, and the kit sanction is unaffected', async () => {
    const answers: Array<[string, () => unknown]> = [
      ['Error', () => { throw new Error('boom puid-glarn-SECRETP'); }],
      ['TypeError', () => Promise.reject(new TypeError('nope'))],
      ['NoAccounts', () => []],
      ['NoAccounts', () => ['', 5, 'has space', null]],
      ['BadAnswer', () => 'puid-glarn-SECRETP'],
      ['BadAnswer', () => undefined],
      ['BadAnswer', () => ({ length: 1, 0: 'x' })],
    ];
    for (const [cls, fn] of answers) {
      const c = await eosWorld({ sanctions: { productUserIdsOf: fn } });
      const subject = c.w.person();
      const res = await c.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'x', actor: 'ann', source: 'moderator', automated: false, rule: 1 });
      await until(() => eosLogs(c).length > 0, 'a log');
      expect(eosLogs(c), cls).toEqual([['chatwarden.eos_failed', { op: 'resolve', error: cls }]]);
      expect(c.fake.calls).toEqual([]);
      expect(c.cw.sanctions.byRef(res.refCode)?.active).toBe(true);
      expect(JSON.stringify(c.logged)).not.toContain('SECRETP');
      c.adapter.dispose();
    }
  });

  it('at most 20 accounts are used, and a list with junk keeps the good ids', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `puid-many-${i}`);
    const c = await eosWorld();
    const m = await sanction(c, { ids: many });
    await until(() => c.fake.sanctions.length === 20 && link(c, m, 'puid-many-19') !== null, 'twenty pushes');
    expect(c.fake.sanctions).toHaveLength(20);
    c.adapter.dispose();
  });
});

describe('push: failures and retries', () => {
  it('a 401 refreshes the token once and the push goes through', async () => {
    const c = await fakeWorld();
    const m = await sanction(c);
    await tick(0);
    expect(link(c, m)?.state).toBe('active');
    c.fake.expireTokens();
    const m2 = await sanction(c, { ids: ['puid-second'] });
    await tick(0);
    expect(link(c, m2, 'puid-second')?.state).toBe('active');
    expect(c.fake.tokensIssued()).toBe(2);
    expect(eosLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('a 429 honours retry-after; a 5xx retries with the backoff; the retries are bounded and the end is logged by status and count', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'create', status: 429, headers: { 'retry-after': '5' } });
    const m = await sanction(c);
    await tick(0);
    expect(creates(c)).toHaveLength(1);
    await tick(4000);
    expect(creates(c)).toHaveLength(1);
    await tick(1000);
    await tick(0);
    expect(creates(c)).toHaveLength(2);
    expect(link(c, m)?.state).toBe('active');
    c.adapter.dispose();

    const d = await fakeWorld();
    for (let i = 0; i < 6; i++) d.fake.script.push({ on: 'create', status: 503 });
    const m2 = await sanction(d);
    await tick(0);
    await tick(70_000);
    expect(creates(d)).toHaveLength(6);
    expect(link(d, m2)).toBeNull();
    expect(eosLogs(d)).toEqual([['chatwarden.eos_failed', { op: 'apply', status: 503, attempts: 6 }]]);
    d.adapter.dispose();
  });

  it('a 400 is final and logged by status; a 403 on the lookup is final too, with nothing created', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'create', status: 400 });
    const m = await sanction(c);
    await tick(0);
    await tick(30_000);
    expect(creates(c)).toHaveLength(1);
    expect(link(c, m)).toBeNull();
    expect(eosLogs(c)).toEqual([['chatwarden.eos_failed', { op: 'apply', status: 400, attempts: 1 }]]);
    c.adapter.dispose();

    const d = await fakeWorld();
    d.fake.script.push({ on: 'user', status: 403 });
    await sanction(d);
    await tick(0);
    await tick(30_000);
    expect(creates(d)).toHaveLength(0);
    expect(eosLogs(d)).toEqual([['chatwarden.eos_failed', { op: 'apply', status: 403, attempts: 1 }]]);
    d.adapter.dispose();
  });

  it('a 404 on the user query means this user has no sanctions yet: the sanction is created, with one lookup and no log', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'user', status: 404 });
    const m = await sanction(c);
    await tick(0);
    expect(api(c)).toEqual(['GET users/_', 'POST sanctions']);
    expect(link(c, m)?.state).toBe('active');
    expect(eosLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('only a 404 on the user query reads as empty: a 400, 401 or 403 from it still stops the create', async () => {
    for (const status of [400, 401, 403]) {
      const d = await fakeWorld();
      d.fake.script.push({ on: 'user', status }, { on: 'user', status });
      await sanction(d);
      await tick(0);
      await tick(30_000);
      expect(creates(d), String(status)).toHaveLength(0);
      d.adapter.dispose();
    }
  });

  it('a failure for one account does not stop the others: the good account is linked and a retry repeats only the failed one', async () => {
    const c = await fakeWorld();
    // The first create (account a) fails with a 503; account b's create goes through in the same pass.
    c.fake.script.push({ on: 'create', status: 503 });
    const m = await sanction(c, { ids: ['puid-a', 'puid-b'] });
    await tick(0);
    expect(link(c, m, 'puid-b')?.state).toBe('active');
    expect(link(c, m, 'puid-a')).toBeNull();
    await tick(1000);
    await tick(0);
    expect(link(c, m, 'puid-a')?.state).toBe('active');
    expect(c.fake.sanctions.map((s) => s.productUserId).sort()).toEqual(['puid-a', 'puid-b']);
    expect(creates(c)).toHaveLength(3);
    c.adapter.dispose();
  });

  it('an answer without a usable referenceId creates no link and is logged by class', async () => {
    for (const body of [{ elements: [{ referenceId: 'has space' }] }, { elements: [] }, { elements: [{}] }, {}, [], 'text']) {
      const d = await fakeWorld();
      d.fake.script.push({ on: 'create', status: 200, body });
      const m = await sanction(d);
      await tick(0);
      expect(link(d, m), JSON.stringify(body)).toBeNull();
      expect(eosLogs(d), JSON.stringify(body)).toEqual([['chatwarden.eos_failed', { op: 'create', error: 'BadAnswer' }]]);
      d.adapter.dispose();
      vi.useRealTimers();
    }
  });

  it('the listener is fenced: a store that fails when the adapter looks (links.get throws) never changes the kit result', async () => {
    const fails = { put: 0, get: 100 };
    const c = await fakeWorld({ wrapKit: (cw) => failingLinks(cw, fails) });
    const m = await sanction(c);
    await tick(0);
    await tick(70_000);
    expect(c.cw.sanctions.byRef(m.refCode)?.active).toBe(true);
    expect(c.fake.sanctions).toHaveLength(0);
    c.adapter.dispose();
  });
});

describe('push: nothing identifying leaves in a log, an error or a row', () => {
  it('seeded user id, reason, reference id, subject, group id, token and secret are in no log line; the link row holds the hashed key and the referenceId', async () => {
    const REASON = 'zorbak-private-reason-SECRETR';
    const SEEDED = 'puid-glarn-SECRETP';
    const c = await fakeWorld({ sanctions: { justification: 'ref' } });
    const made: Made[] = [];
    // Every kind of failure, each with the seeded ids in play.
    c.fake.script.push({ on: 'create', status: 400, body: { echoed: SEEDED, reason: REASON } });
    made.push(await sanction(c, { reason: REASON, ids: [SEEDED] }));
    for (let i = 0; i < 6; i++) c.fake.script.push({ on: 'create', status: 503, body: { echoed: SEEDED } });
    made.push(await sanction(c, { reason: REASON, ids: [`${SEEDED}-2`] }));
    c.fake.script.push({ on: 'user', fail: true });
    made.push(await sanction(c, { reason: REASON, ids: [`${SEEDED}-3`] }));
    await tick(0);
    await tick(120_000);
    const ok = await sanction(c, { reason: REASON, ids: [`${SEEDED}-4`] });
    await tick(0);
    await tick(60_000);
    expect(eosLogs(c).length).toBeGreaterThan(0);
    const text = JSON.stringify(eosLogs(c));
    const referenceIds = c.fake.sanctions.map((s) => s.referenceId);
    for (const seed of [SEEDED, REASON, 'SECRET', ...referenceIds, ...made.flatMap((x) => [x.subject, x.groupId]), 'fake-access-token', 'fake-secret-quissel']) expect(text).not.toContain(seed);
    // The row.
    const row = link(c, ok, `${SEEDED}-4`);
    expect(row).toMatchObject({ system: 'eos-sanction', state: 'active', external: c.fake.sanctions.find((s) => s.productUserId === `${SEEDED}-4`)?.referenceId });
    expect(row?.ref).toMatch(/^[A-Za-z0-9_-]+#[0-9a-f]{16}$/);
    const rows = JSON.stringify(c.cw.links.list('eos-sanction', { limit: 500 }));
    for (const seed of [SEEDED, REASON, ok.refCode, ok.subject, 'fake-access-token', 'fake-secret-quissel']) expect(rows).not.toContain(seed);
    c.adapter.dispose();
  });
});

describe('push: lifecycle', () => {
  it('dispose unsubscribes, aborts the request in flight, clears timers and later events send nothing', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'user', hang: true });
    const m = await sanction(c);
    await tick(0);
    expect(c.fake.calls.filter((x) => !x.path.includes('/oauth/'))).toHaveLength(1);
    c.adapter.dispose();
    await tick(120_000);
    expect(c.fake.calls.filter((x) => !x.path.includes('/oauth/'))).toHaveLength(1);
    expect(link(c, m)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await sanction(c, { ids: ['puid-after'] });
    await tick(120_000);
    expect(c.fake.sanctions).toHaveLength(0);
    c.adapter.dispose();
  });

  it('dispose while a retry waits drops it: no further request and no write', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ on: 'create', status: 503 });
    const m = await sanction(c);
    await tick(0);
    expect(creates(c)).toHaveLength(1);
    c.adapter.dispose();
    await tick(120_000);
    expect(creates(c)).toHaveLength(1);
    expect(link(c, m)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose between the answer and the link write writes nothing', async () => {
    const c = await fakeWorld();
    const m = await sanction(c);
    c.adapter.dispose();
    await tick(10);
    expect(link(c, m)).toBeNull();
  });
});
