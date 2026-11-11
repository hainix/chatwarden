import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { KitEvent } from '../src/events.js';
import type { Logger, Matcher, Platform, RawWho } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const R = 'room';

const alice: RawWho = { clientKey: 'key-alice', ip: '198.51.100.1' };
const bob: RawWho = { clientKey: 'key-bob', ip: '198.51.100.2' };

const blocker: Matcher = { match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null) };

const SECRET_TEXT = {
  line: 'hello there from alice',
  blocked: 'you zorbak',
  note: 'REPORTER-NOTE-TEXT',
  reason: 'PRIVATE-REASON-TEXT',
  gap: 'PRIVATE-GAP-NOTE-TEXT',
  evidence: 'PRIVATE-EVIDENCE-TEXT',
  revoke: 'PRIVATE-REVOKE-REASON',
};

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

async function setup(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store, secret: 'events-secret', platform, clock, logger, matcher: blocker, ...over });
  const events: KitEvent[] = [];
  cw.on('*', (e) => void events.push(e));
  return { cw, store, clock, logged, events };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Alice and Bob seated; Alice wrote two lines; Bob reported her. */
async function reported(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const s = await setup(over, store);
  const { cw } = s;
  cw.rooms.seat(R, 'a', alice, 'Alice', { mode: 'ranked' });
  cw.rooms.seat(R, 'b', bob, 'Bob');
  cw.chat.accept(R, 'a', SECRET_TEXT.line);
  const res = await cw.reports.submit({
    roomId: R,
    reporterSeat: 'b',
    targetSeat: 'a',
    category: 'harassment',
    note: SECRET_TEXT.note,
  });
  if (!res.ok) throw new Error('expected the report to be stored');
  const a = cw.rooms.subjectAt(R, 'a');
  const b = cw.rooms.subjectAt(R, 'b');
  if (a === null || b === null) throw new Error('expected subjects');
  const own = store.loadReport(res.reportId)?.excerpt.filter((l) => l.seatId === 'a').map((l) => l.lineId) ?? [];
  s.events.length = 0; // the report.created event is covered on its own
  return { ...s, reportId: res.reportId, a, b, own };
}

type Reported = Awaited<ReturnType<typeof reported>>;

const decideUpheld = (r: Reported, actions: Array<Record<string, unknown>>) =>
  r.cw.decide({
    reportId: r.reportId,
    verdict: 'upheld',
    actor: 'mod@example.test',
    reason: SECRET_TEXT.reason,
    actions: actions as never,
  });

const types = (events: KitEvent[]) => events.map((e) => e.type);

/** The listener-failure log lines (setup also logs the unrelated no-profanity-filter warning). */
const failures = (s: Setup) => s.logged.filter(([event]) => event === 'chatwarden.listener_failed');

describe('events: report.created', () => {
  it('fires once, after the commit, with the documented shape', async () => {
    const s = await setup();
    const { cw, store, events } = s;
    cw.rooms.seat(R, 'a', alice, 'Alice', { mode: 'ranked', region: 'eu' });
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const seenInListener: Array<string | undefined> = [];
    cw.on('report.created', (e) => void seenInListener.push(store.loadReport(e.reportId)?.id));
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment', note: SECRET_TEXT.note });
    if (!res.ok) throw new Error('expected ok');
    expect(events).toEqual([
      { type: 'report.created', reportId: res.reportId, createdAt: NOW, category: 'harassment', reportedReason: 'harassment', roomTags: { mode: 'ranked', region: 'eu' } },
    ]);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['category', 'createdAt', 'reportId', 'reportedReason', 'roomTags', 'type']);
    // The report was readable from inside the listener: the event follows the commit.
    expect(seenInListener).toEqual([res.reportId]);
  });

  it('carries an empty tag map for a room with no tags, and the category as stored', async () => {
    const { cw, events } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    // A report with no reason is stored under 'other', with no reported reason; the event says what was stored.
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a' });
    expect(events).toEqual([expect.objectContaining({ type: 'report.created', category: 'other', reportedReason: null, roomTags: {} })]);
  });

  it('does not alias the room tags: a listener changing them changes nothing else', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice', { mode: 'ranked' });
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.on('report.created', (e) => {
      try {
        (e.roomTags as Record<string, string>).mode = 'hacked';
      } catch {
        // frozen: fine too
      }
    });
    const got: KitEvent[] = [];
    cw.on('report.created', (e) => void got.push(e));
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    expect(got[0]).toMatchObject({ roomTags: { mode: 'ranked' } });
  });

  it('fires for no refused report: self, guest, rate, duplicate, kill switch', async () => {
    let on = false;
    const { cw, events } = await setup({ enabled: () => on });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.rooms.seat(R, 'g', {}, 'Guest');
    const input = { roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' as const };
    expect(await cw.reports.submit(input)).toEqual({ ok: false, refused: 'off' });
    on = true;
    expect(await cw.reports.submit({ ...input, reporterSeat: 'a' })).toEqual({ ok: false, refused: 'self' });
    expect(await cw.reports.submit({ ...input, reporterSeat: 'g' })).toMatchObject({ ok: false });
    expect(await cw.reports.submit(input)).toMatchObject({ ok: true });
    expect(await cw.reports.submit(input)).toEqual({ ok: false, refused: 'duplicate' });
    expect(types(events)).toEqual(['report.created']);
  });

  it('fires nothing when the store write fails', async () => {
    class Failing extends MemoryStore {
      override insertReport(): boolean {
        throw new Error('disk full');
      }
    }
    const { cw, events } = await setup({}, new Failing());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' })).toEqual({
      ok: false,
      refused: 'off',
    });
    expect(events).toEqual([]);
  });
});

describe('events: decide', () => {
  it('emits report.closed, then one sanction.applied per group, then gap.created for an uncovered group', async () => {
    const r = await reported();
    const res = await decideUpheld(r, [
      { subject: r.a, kind: 'chat', durationMs: H, rule: 2 },
      { subject: r.a, kind: 'warning', durationMs: null, rule: 'uncovered', gapNote: SECRET_TEXT.gap, lineIds: r.own },
    ]);
    if (!res.ok) throw new Error('expected ok');
    expect(res.groups).toHaveLength(2);
    const [chat, warning] = res.groups;
    expect(types(r.events)).toEqual(['report.closed', 'sanction.applied', 'sanction.applied', 'gap.created']);
    expect(r.events).toEqual([
      { type: 'report.closed', reportId: r.reportId, verdict: 'upheld', at: NOW },
      {
        type: 'sanction.applied',
        groupId: chat?.groupId,
        refCode: chat?.refCode,
        kind: 'chat',
        until: NOW + H,
        rule: 2,
        source: 'moderator',
        automated: false,
        target: r.a,
      },
      {
        type: 'sanction.applied',
        groupId: warning?.groupId,
        refCode: warning?.refCode,
        kind: 'warning',
        until: null,
        rule: 'uncovered',
        source: 'moderator',
        automated: false,
        target: r.a,
      },
      { type: 'gap.created', groupId: warning?.groupId, refCode: warning?.refCode, at: NOW, subject: r.a },
    ]);
  });

  it('a permanent ban has until null; a note is a sanction.applied too', async () => {
    const r = await reported();
    const res = await decideUpheld(r, [{ subject: r.a, kind: 'ban', durationMs: null, rule: 1 }]);
    expect(res.ok).toBe(true);
    expect(r.events[1]).toMatchObject({ type: 'sanction.applied', kind: 'ban', until: null, rule: 1 });

    const r2 = await reported();
    const res2 = await r2.cw.decide({
      reportId: r2.reportId,
      verdict: 'noted',
      actor: 'mod@example.test',
      reason: SECRET_TEXT.reason,
      actions: [{ subject: r2.a, kind: 'note', durationMs: null, rule: 2 }],
    });
    expect(res2.ok).toBe(true);
    expect(types(r2.events)).toEqual(['report.closed', 'sanction.applied']);
    expect(r2.events[0]).toMatchObject({ verdict: 'noted' });
    expect(r2.events[1]).toMatchObject({ kind: 'note', until: null });
  });

  it('a decision with no actions emits only report.closed, with the verdict', async () => {
    for (const verdict of ['no_action', 'bad_faith'] as const) {
      const r = await reported();
      const res = await r.cw.decide({
        reportId: r.reportId,
        verdict,
        actor: 'mod@example.test',
        reason: SECRET_TEXT.reason,
        ...(verdict === 'bad_faith' ? { evidence: SECRET_TEXT.evidence } : {}),
        actions: [],
      });
      expect(res.ok).toBe(true);
      expect(r.events).toEqual([{ type: 'report.closed', reportId: r.reportId, verdict, at: NOW }]);
    }
  });

  it('uses the decision source, and an uncovered rule from a non-moderator source makes no gap row and no gap event', async () => {
    const r = await reported();
    const res = await r.cw.decide({
      reportId: r.reportId,
      verdict: 'upheld',
      actor: 'ai-agent',
      reason: SECRET_TEXT.reason,
      source: 'ai',
      actions: [{ subject: r.a, kind: 'warning', durationMs: null, rule: 'uncovered' }],
    });
    expect(res.ok).toBe(true);
    expect(r.cw.gaps.list()).toEqual([]);
    expect(types(r.events)).toEqual(['report.closed', 'sanction.applied']);
    expect(r.events[1]).toMatchObject({ source: 'ai', rule: 'uncovered', automated: false });
  });

  it('emits for the canonical target', async () => {
    const r = await reported();
    await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    expect(r.events[1]).toMatchObject({ target: r.cw.rooms.subjectAt(R, 'a') });
  });

  it('fires after the commit: inside the listener the report is closed and the restriction is live', async () => {
    const r = await reported();
    const seen: unknown[] = [];
    r.cw.on('sanction.applied', () => {
      seen.push(r.store.loadReport(r.reportId)?.status);
      seen.push(r.cw.chat.accept(R, 'a', 'hello'));
    });
    await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    expect(seen[0]).toBe('actioned');
    expect(seen[1]).toMatchObject({ refuse: { reason: 'restricted' } });
  });

  it('a replay of the same decision emits nothing', async () => {
    const r = await reported();
    const actions = [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }];
    await decideUpheld(r, actions);
    const first = r.events.length;
    expect(first).toBe(2);
    const again = await decideUpheld(r, actions);
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(r.events).toHaveLength(first);
  });

  it('emits nothing for an invalid, unknown or already-decided decision', async () => {
    const r = await reported();
    expect(await r.cw.decide({ reportId: r.reportId, verdict: 'upheld', actor: 'm', reason: '', actions: [] })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await decideUpheld({ ...r, reportId: 'nope' } as Reported, [])).toEqual({ ok: false, error: 'not_found' });
    // A rule that does not exist is refused whole: no partial emission.
    expect(await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 99 }])).toEqual({ ok: false, error: 'invalid' });
    expect(r.events).toEqual([]);
    await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    r.events.length = 0;
    expect(await decideUpheld(r, [{ subject: r.a, kind: 'warning', durationMs: null, rule: 2 }])).toEqual({
      ok: false,
      error: 'already_decided',
    });
    expect(r.events).toEqual([]);
  });

  it('emits nothing when the store fails and the decision rejects', async () => {
    class Failing extends MemoryStore {
      fail = false;
      override insertDecision(...args: Parameters<MemoryStore['insertDecision']>): void {
        if (this.fail) throw new Error('disk full');
        super.insertDecision(...args);
      }
    }
    const store = new Failing();
    const r = await reported({}, store);
    store.fail = true;
    await expect(decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }])).rejects.toThrow('disk full');
    expect(r.events).toEqual([]);
  });

  it('the staff-facing result keeps its shape: groups carry subject, groupId, refCode, kind, noticeId only', async () => {
    const r = await reported();
    const res = await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    if (!res.ok) throw new Error('expected ok');
    expect(Object.keys(res).sort()).toEqual(['groups', 'ok', 'replay']);
    expect(Object.keys(res.groups[0] ?? {}).sort()).toEqual(['groupId', 'kind', 'noticeId', 'refCode', 'subject']);
    // The replay answers with the same shape.
    const again = await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    if (!again.ok) throw new Error('expected ok');
    expect(Object.keys(again.groups[0] ?? {}).sort()).toEqual(['groupId', 'kind', 'noticeId', 'refCode', 'subject']);
  });
});

describe('events: sanctions.apply and sanctions.revoke', () => {
  const input = (subject: string, over: Record<string, unknown> = {}) => ({
    kind: 'chat' as const,
    subject,
    includeIp: false,
    durationMs: H,
    reason: SECRET_TEXT.reason,
    actor: 'mod@example.test',
    source: 'moderator' as const,
    automated: false,
    rule: 1,
    ...over,
  });

  async function seated() {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    return { ...s, subject };
  }

  it('apply emits sanction.applied once with the group, the end time and the target', async () => {
    const s = await seated();
    const { groupId, refCode } = await s.cw.sanctions.apply(input(s.subject));
    expect(s.events).toEqual([
      {
        type: 'sanction.applied',
        groupId,
        refCode,
        kind: 'chat',
        until: NOW + H,
        rule: 1,
        source: 'moderator',
        automated: false,
        target: s.subject,
      },
    ]);
  });

  it('apply passes through source and automated, and an absent rule reads uncovered (with its gap event)', async () => {
    const s = await seated();
    await s.cw.sanctions.apply(input(s.subject, { source: 'api', automated: true, rule: undefined, kind: 'ban', durationMs: null }));
    expect(s.events).toEqual([expect.objectContaining({ source: 'api', automated: true, rule: 'uncovered', until: null, kind: 'ban' })]);
    // 'api' is not the moderator: no gap row, so no gap event.
    expect(types(s.events)).toEqual(['sanction.applied']);
  });

  it('apply with an uncovered moderator rule also emits gap.created', async () => {
    const s = await seated();
    const { groupId, refCode } = await s.cw.sanctions.apply(input(s.subject, { rule: 'uncovered', gapNote: SECRET_TEXT.gap }));
    expect(types(s.events)).toEqual(['sanction.applied', 'gap.created']);
    expect(s.events[1]).toEqual({ type: 'gap.created', groupId, refCode, at: NOW, subject: s.subject });
    expect(s.cw.gaps.list().map((g) => g.groupId)).toEqual([groupId]);
  });

  it('apply of a warning has until null', async () => {
    const s = await seated();
    await s.cw.sanctions.apply(input(s.subject, { kind: 'warning', durationMs: null }));
    expect(s.events[0]).toMatchObject({ kind: 'warning', until: null });
  });

  it('a rejected apply emits nothing', async () => {
    const s = await seated();
    await expect(s.cw.sanctions.apply(input(s.subject, { durationMs: 0 }))).rejects.toThrow();
    await expect(s.cw.sanctions.apply(input(s.subject, { rule: 'uncovered' }))).rejects.toThrow();
    await expect(s.cw.sanctions.apply(input(''))).rejects.toThrow();
    expect(s.events).toEqual([]);
  });

  it('a failing store emits nothing for apply', async () => {
    class Failing extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    const s = await setup({}, new Failing());
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a') ?? '';
    await expect(s.cw.sanctions.apply(input(subject))).rejects.toThrow('disk full');
    expect(s.events).toEqual([]);
  });

  it('revoke emits sanction.revoked once with the ref code; a second revoke and an unknown group emit nothing', async () => {
    const s = await seated();
    const { groupId, refCode } = await s.cw.sanctions.apply(input(s.subject));
    s.events.length = 0;
    s.clock.t += 5000;
    expect(await s.cw.sanctions.revoke(groupId, 'mod@example.test', SECRET_TEXT.revoke)).toBe(true);
    expect(s.events).toEqual([{ type: 'sanction.revoked', groupId, refCode, at: NOW + 5000, subject: s.subject, rule: 1 }]);
    expect(await s.cw.sanctions.revoke(groupId, 'mod@example.test', 'again')).toBe(false);
    expect(await s.cw.sanctions.revoke('no-such-group', 'mod@example.test', 'x')).toBe(false);
    expect(s.events).toHaveLength(1);
  });

  it('revoke of a group already expired still reports it with its ref code', async () => {
    const s = await seated();
    const { groupId, refCode } = await s.cw.sanctions.apply(input(s.subject));
    s.clock.t += 2 * H;
    s.events.length = 0;
    expect(await s.cw.sanctions.revoke(groupId, 'mod@example.test', 'cleanup')).toBe(true);
    expect(s.events).toEqual([expect.objectContaining({ type: 'sanction.revoked', groupId, refCode, subject: s.subject })]);
  });

  it('revoking a decision group emits sanction.revoked too', async () => {
    const r = await reported();
    const res = await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    if (!res.ok) throw new Error('expected ok');
    r.events.length = 0;
    await r.cw.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'oops');
    expect(r.events).toEqual([
      { type: 'sanction.revoked', groupId: res.groups[0]?.groupId, refCode: res.groups[0]?.refCode, at: NOW, subject: r.a, rule: 2 },
    ]);
  });

  it('a failing store rejects revoke and emits nothing', async () => {
    class Failing extends MemoryStore {
      fail = false;
      override revokeSanctionGroup(...args: Parameters<MemoryStore['revokeSanctionGroup']>): number {
        if (this.fail) throw new Error('disk full');
        return super.revokeSanctionGroup(...args);
      }
    }
    const store = new Failing();
    const s = await setup({}, store);
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId } = await s.cw.sanctions.apply(input(subject));
    s.events.length = 0;
    store.fail = true;
    await expect(s.cw.sanctions.revoke(groupId, 'mod', 'x')).rejects.toThrow('disk full');
    expect(s.events).toEqual([]);
  });
});

describe('events: auto.restricted', () => {
  const sayZorbak = (s: Setup, seat: string) => {
    for (let i = 0; i < 3; i++) {
      s.cw.chat.accept(R, seat, 'zorbak');
      s.clock.t += 2000;
    }
  };

  it('fires once per automatic timeout with the stored group and ref code, and onAutoRestrict still fires', async () => {
    const told: Array<[string | null, boolean]> = [];
    const s = await setup({ onAutoRestrict: (subject, second) => void told.push([subject, second]) });
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a');
    sayZorbak(s, 'a');
    const stored = s.store.loadSanctions(s.clock.t).filter((r) => r.value === subject);
    expect(stored).toHaveLength(1);
    expect(s.events).toEqual([
      { type: 'auto.restricted', groupId: stored[0]?.groupId, refCode: stored[0]?.refCode, second: false, subject },
    ]);
    expect(told).toEqual([[subject, false]]);
  });

  it('the repeat within seven days says second: true', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    sayZorbak(s, 'a');
    s.clock.t += 31 * 60_000;
    sayZorbak(s, 'a');
    expect(s.events.map((e) => (e.type === 'auto.restricted' ? e.second : null))).toEqual([false, true]);
    const [first, second] = s.events;
    expect((first as { groupId: string }).groupId).not.toBe((second as { groupId: string }).groupId);
  });

  it('a throwing onAutoRestrict does not stop the event', async () => {
    const s = await setup({
      onAutoRestrict: () => {
        throw new Error('boom');
      },
    });
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    sayZorbak(s, 'a');
    expect(types(s.events)).toEqual(['auto.restricted']);
  });

  it('a speaker with no subject is held in memory: onAutoRestrict is told but there is no stored group, so no event', async () => {
    const told: Array<[string | null, boolean]> = [];
    const s = await setup({ onAutoRestrict: (subject, second) => void told.push([subject, second]) });
    s.cw.rooms.seat(R, 'g', {}, 'Guest');
    sayZorbak(s, 'g');
    expect(told).toEqual([[null, false]]);
    expect(s.events).toEqual([]);
  });

  it('the kill switch off: no timeout, no event', async () => {
    const s = await setup({ enabled: () => false });
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    sayZorbak(s, 'a');
    expect(s.events).toEqual([]);
  });

  it('two strikes are not a timeout: no event', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    s.cw.chat.accept(R, 'a', 'zorbak');
    s.clock.t += 2000;
    s.cw.chat.accept(R, 'a', 'zorbak');
    expect(s.events).toEqual([]);
  });

  it('does not fire without a listener, or break, when nobody subscribed', async () => {
    const s = await setup();
    // `setup` subscribed '*'; a kit with no listener at all is the common case.
    const bare = await createChatwarden({
      store: new MemoryStore(),
      secret: 's',
      platform: { identify: (c) => c as RawWho },
      clock: s.clock,
      matcher: blocker,
      logger: { warn() {} },
    });
    bare.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) bare.chat.accept(R, 'a', 'zorbak');
    expect(bare.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
  });
});

describe('events: subscribing', () => {
  it("'*' receives every event type; a typed listener receives only its own", async () => {
    const r = await reported();
    const closed: KitEvent[] = [];
    const applied: KitEvent[] = [];
    r.cw.on('report.closed', (e) => void closed.push(e));
    r.cw.on('sanction.applied', (e) => void applied.push(e));
    const res = await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    if (!res.ok) throw new Error('expected ok');
    await r.cw.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'x');
    expect(types(closed)).toEqual(['report.closed']);
    expect(types(applied)).toEqual(['sanction.applied']);
    expect(types(r.events)).toEqual(['report.closed', 'sanction.applied', 'sanction.revoked']);
  });

  it('every listener is called, in registration order, "*" and typed alike', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const order: string[] = [];
    cw.on('report.created', () => void order.push('typed-1'));
    cw.on('*', () => void order.push('star-2'));
    cw.on('report.created', () => void order.push('typed-3'));
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    // '*' from setup() ran first (registered first); then the three, in order.
    expect(order).toEqual(['typed-1', 'star-2', 'typed-3']);
  });

  it('unsubscribe stops delivery, is idempotent, and leaves other listeners alone', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.rooms.seat(R, 'c', { clientKey: 'key-carol' }, 'Carol');
    const one: string[] = [];
    const two: string[] = [];
    const off = cw.on('report.created', (e) => void one.push(e.reportId));
    cw.on('report.created', (e) => void two.push(e.reportId));
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    off();
    off();
    await cw.reports.submit({ roomId: R, reporterSeat: 'c', targetSeat: 'a', category: 'spam' });
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(2);
  });

  it('the same function registered twice is called twice and unsubscribed separately', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    let n = 0;
    const fn = () => void n++;
    const off1 = cw.on('report.created', fn);
    cw.on('report.created', fn);
    off1();
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    expect(n).toBe(1);
  });

  it('a listener that unsubscribes itself, or another, during an emit does not break the emit', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const calls: string[] = [];
    let offSecond = (): void => undefined;
    const offFirst = cw.on('report.created', () => {
      calls.push('first');
      offFirst();
      offSecond();
    });
    offSecond = cw.on('report.created', () => void calls.push('second'));
    cw.on('report.created', () => void calls.push('third'));
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    // 'second' was unsubscribed before its turn: it is not called. 'third' is.
    expect(calls).toEqual(['first', 'third']);
  });

  it('a listener subscribed during an emit is not called for that event', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const late: string[] = [];
    cw.on('report.created', () => {
      cw.on('report.created', (e) => void late.push(e.reportId));
    });
    await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    expect(late).toEqual([]);
  });

  it('refuses an unknown event type or a non-function listener at subscription', async () => {
    const { cw } = await setup();
    expect(() => cw.on('report.creatd' as never, () => undefined)).toThrow(TypeError);
    expect(() => cw.on('report.created', 'nope' as never)).toThrow(TypeError);
    expect(() => cw.on('*', undefined as never)).toThrow(TypeError);
  });

  it('events are frozen', async () => {
    const r = await reported();
    await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    for (const e of r.events) expect(Object.isFrozen(e)).toBe(true);
  });
});

describe('events: listeners are fenced', () => {
  it('a throwing listener neither breaks the operation nor starves the others, and is logged by class only', async () => {
    const s = await setup();
    const { cw } = s;
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const after: string[] = [];
    cw.on('report.created', () => {
      throw new RangeError(`secret ${SECRET_TEXT.line}`);
    });
    cw.on('report.created', (e) => void after.push(e.reportId));
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    expect(res).toMatchObject({ ok: true });
    expect(after).toHaveLength(1);
    expect(failures(s)).toEqual([['chatwarden.listener_failed', { error: 'RangeError' }]]);
    expect(JSON.stringify(s.logged)).not.toContain('secret');
  });

  it('a rejecting async listener is logged by class and raises no unhandled rejection', async () => {
    const s = await setup();
    const { cw } = s;
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      cw.on('*', async () => {
        await Promise.resolve();
        throw new TypeError('async secret');
      });
      await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(failures(s)).toEqual([['chatwarden.listener_failed', { error: 'TypeError' }]]);
  });

  it('a non-Error throw is logged by its type', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    s.cw.rooms.seat(R, 'b', bob, 'Bob');
    s.cw.on('*', () => {
      throw 'a string with a secret';
    });
    await s.cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    expect(failures(s)).toEqual([['chatwarden.listener_failed', { error: 'string' }]]);
  });

  it('a broken logger cannot break the emit', async () => {
    const s = await setup({
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
    });
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    s.cw.rooms.seat(R, 'b', bob, 'Bob');
    s.cw.on('*', () => {
      throw new Error('boom');
    });
    expect(await s.cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' })).toMatchObject({ ok: true });
  });

  it('a throwing listener cannot break decide, revoke or the chat path', async () => {
    const r = await reported();
    r.cw.on('*', () => {
      throw new Error('boom');
    });
    const res = await decideUpheld(r, [{ subject: r.a, kind: 'chat', durationMs: H, rule: 2 }]);
    expect(res).toMatchObject({ ok: true, replay: false });
    if (!res.ok) throw new Error('expected ok');
    expect(await r.cw.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'x')).toBe(true);
    r.clock.t += 6000; // clear the rate window
    for (let i = 0; i < 3; i++) {
      r.cw.chat.accept(R, 'a', 'zorbak');
      r.clock.t += 2000;
    }
    expect(r.cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
  });
});

describe('events: carry no player text', () => {
  it('no event of a full run holds chat text, a reason, a note, evidence or a gap note, and the key sets are fixed', async () => {
    const r = await reported();
    // Auto restriction on a blocked line, a gapped warning, a ban, a revoke.
    r.clock.t += 6000; // clear the rate window
    for (let i = 0; i < 3; i++) {
      r.cw.chat.accept(R, 'a', SECRET_TEXT.blocked);
      r.clock.t += 2000;
    }
    const res = await decideUpheld(r, [
      { subject: r.a, kind: 'warning', durationMs: null, rule: 'uncovered', gapNote: SECRET_TEXT.gap, lineIds: r.own },
      { subject: r.a, kind: 'ban', durationMs: null, rule: 1 },
    ]);
    if (!res.ok) throw new Error('expected ok');
    await r.cw.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod@example.test', SECRET_TEXT.revoke);
    const { cw } = r;
    const direct = await cw.sanctions.apply({
      kind: 'chat',
      subject: r.a,
      includeIp: false,
      durationMs: H,
      reason: SECRET_TEXT.reason,
      actor: 'mod@example.test',
      source: 'moderator',
      automated: false,
      rule: 'uncovered',
      gapNote: SECRET_TEXT.gap,
    });
    expect(direct.groupId).toBeTruthy();

    const wire = JSON.stringify(r.events);
    for (const secret of Object.values(SECRET_TEXT)) expect(wire).not.toContain(secret);
    expect(wire).not.toContain('zorbak');
    expect(wire).not.toContain('Alice');
    expect(wire).not.toContain('mod@example.test');
    expect(wire).not.toContain('key-alice');
    expect(wire).not.toContain('198.51.100');

    const keys: Record<string, string[]> = {};
    for (const e of r.events) keys[e.type] = Object.keys(e).sort();
    expect(keys).toEqual({
      'auto.restricted': ['groupId', 'refCode', 'second', 'subject', 'type'],
      'report.closed': ['at', 'reportId', 'type', 'verdict'],
      'sanction.applied': ['automated', 'groupId', 'kind', 'refCode', 'rule', 'source', 'target', 'type', 'until'],
      'sanction.revoked': ['at', 'groupId', 'refCode', 'rule', 'subject', 'type'],
      'gap.created': ['at', 'groupId', 'refCode', 'subject', 'type'],
    });
  });

  it('report.created carries no chat text or note', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice', { mode: 'ranked' });
    s.cw.rooms.seat(R, 'b', bob, 'Bob');
    s.cw.chat.accept(R, 'a', SECRET_TEXT.line);
    await s.cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment', note: SECRET_TEXT.note });
    const wire = JSON.stringify(s.events);
    expect(wire).not.toContain(SECRET_TEXT.line);
    expect(wire).not.toContain(SECRET_TEXT.note);
    expect(wire).not.toContain('Alice');
    expect(wire).not.toContain('Bob');
  });
});

describe('events: fix round 1', () => {
  it('sanction.revoked.at equals the stored revokedAt even when the clock ticks on every read', async () => {
    const store = new MemoryStore();
    let t = NOW;
    const clock = { now: () => (t += 7) };
    const cw = await createChatwarden({
      store,
      secret: 'events-secret',
      platform: { identify: (c) => c as RawWho },
      clock,
      logger: { warn() {} },
      matcher: blocker,
    });
    const events: KitEvent[] = [];
    cw.on('*', (e) => void events.push(e));
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId } = await cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: H,
      reason: 'r',
      actor: 'mod',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    events.length = 0;
    expect(await cw.sanctions.revoke(groupId, 'mod', 'oops')).toBe(true);
    const stored = store.rawSanctions().filter((r) => r.groupId === groupId);
    expect(stored.length).toBeGreaterThan(0);
    const revokedAt = stored[0]?.revokedAt;
    expect(typeof revokedAt).toBe('number');
    expect(stored.every((r) => r.revokedAt === revokedAt)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'sanction.revoked', at: revokedAt });
  });
});

describe('events: subject on auto.restricted, sanction.revoked and gap.created', () => {
  const sayZorbak = (s: Setup, seat: string) => {
    for (let i = 0; i < 3; i++) {
      s.cw.chat.accept(R, seat, 'zorbak');
      s.clock.t += 2000;
    }
  };
  const input = (subject: string, over: Record<string, unknown> = {}) => ({
    kind: 'chat' as const,
    subject,
    includeIp: false,
    durationMs: H,
    reason: SECRET_TEXT.reason,
    actor: 'mod@example.test',
    source: 'moderator' as const,
    automated: false,
    rule: 1,
    ...over,
  });

  it('a revoke names the rule as a number, or null for uncovered', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a') ?? '';
    const numbered = await s.cw.sanctions.apply(input(subject, { rule: 4 }));
    const gap = await s.cw.sanctions.apply(input(subject, { rule: 'uncovered', gapNote: SECRET_TEXT.gap, kind: 'warning', durationMs: null }));
    s.events.length = 0;
    await s.cw.sanctions.revoke(numbered.groupId, 'mod', 'x');
    await s.cw.sanctions.revoke(gap.groupId, 'mod', 'x');
    expect(s.events.map((e) => (e.type === 'sanction.revoked' ? e.rule : 'x'))).toEqual([4, null]);
  });

  it.each([
    ['text', 'not-a-rule'],
    ['zero', '0'],
    ['a negative number', '-3'],
    ['a decimal', '2.5'],
    ['an empty string', ''],
    ['a huge number', '99999999999999999999'],
    ['padded', ' 4 '],
  ])('a stored rule that is malformed (%s) still emits sanction.revoked, with rule null, and logs nothing', async (_n, stored) => {
    // A store whose rows carry a rule value the reader cannot parse (a hand-edited or newer-schema row).
    class OddRules extends MemoryStore {
      override sanctionGroupTarget(groupId: string) {
        const row = super.sanctionGroupTarget(groupId);
        return row === null ? null : { ...row, rule: stored };
      }
    }
    const s = await setup({}, new OddRules());
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId, refCode } = await s.cw.sanctions.apply(input(subject, { rule: 4 }));
    s.events.length = 0;
    s.logged.length = 0;
    await expect(s.cw.sanctions.revoke(groupId, 'mod', 'x')).resolves.toBe(true);
    expect(s.events).toEqual([{ type: 'sanction.revoked', groupId, refCode, at: NOW, subject, rule: null }]);
    expect(failures(s)).toEqual([]);
  });

  it('a stored rule that is missing (null) also emits sanction.revoked with rule null', async () => {
    class NoRule extends MemoryStore {
      override sanctionGroupTarget(groupId: string) {
        const row = super.sanctionGroupTarget(groupId);
        return row === null ? null : { ...row, rule: null };
      }
    }
    const s = await setup({}, new NoRule());
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId } = await s.cw.sanctions.apply(input(subject, { rule: 4 }));
    s.events.length = 0;
    await s.cw.sanctions.revoke(groupId, 'mod', 'x');
    expect(s.events).toEqual([expect.objectContaining({ type: 'sanction.revoked', subject, rule: null })]);
  });

  it('a revoke after a restart (a fresh kit on the same store) still names the subject and rule', async () => {
    const store = new MemoryStore();
    const s = await setup({}, store);
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId } = await s.cw.sanctions.apply(input(subject, { rule: 1 }));
    await s.cw.flush();
    const s2 = await setup({}, store);
    await s2.cw.sanctions.revoke(groupId, 'mod', 'x');
    expect(s2.events).toEqual([expect.objectContaining({ type: 'sanction.revoked', subject, rule: 1 })]);
  });

  it('every one of the three carries the CANONICAL subject, also after a merge', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', { clientKey: 'k-one' }, 'A');
    s.cw.rooms.seat(R, 'b', { clientKey: 'k-two' }, 'B');
    const older = s.cw.rooms.subjectAt(R, 'a') ?? '';
    const newer = s.cw.rooms.subjectAt(R, 'b') ?? '';
    expect(older).not.toBe(newer);
    // The sanction is filed under one subject; then an account ties the two and one of them survives.
    const g = await s.cw.sanctions.apply(input(newer, { rule: 'uncovered', gapNote: SECRET_TEXT.gap }));
    s.cw.rooms.seat(R, 'c', { clientKey: 'k-one', accountId: 'acc-1' }, 'C');
    s.cw.rooms.seat(R, 'd', { clientKey: 'k-two', accountId: 'acc-1' }, 'D');
    await s.cw.flush();
    const root = s.cw.people.canonical(newer);
    expect([older, newer]).toContain(root);
    const alias = root === older ? newer : older;
    s.events.length = 0;
    await s.cw.sanctions.revoke(g.groupId, 'mod', 'x');
    expect(s.events).toEqual([expect.objectContaining({ type: 'sanction.revoked', subject: root })]);
    // A new apply to the alias id emits gap.created with the canonical subject.
    s.events.length = 0;
    await s.cw.sanctions.apply(input(alias, { rule: 'uncovered', gapNote: SECRET_TEXT.gap }));
    expect(s.events.filter((e) => e.type === 'gap.created')).toEqual([expect.objectContaining({ subject: root })]);
  });

  it('auto.restricted carries the speaker subject, for the first and the repeat timeout', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = s.cw.rooms.subjectAt(R, 'a');
    sayZorbak(s, 'a');
    s.clock.t += 3 * H;
    sayZorbak(s, 'a');
    const autos = s.events.filter((e) => e.type === 'auto.restricted');
    expect(autos.length).toBeGreaterThanOrEqual(1);
    for (const e of autos) expect(e).toMatchObject({ subject });
  });

  it('an auto timeout held only in memory (no subject) emits nothing', async () => {
    const s = await setup();
    s.cw.rooms.seat(R, 'a', { ip: '198.51.100.9' }, 'Anon');
    sayZorbak(s, 'a');
    expect(s.events.filter((e) => e.type === 'auto.restricted')).toEqual([]);
  });
});
