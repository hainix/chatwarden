import { isValidAuditActor, suggestedRule } from '@chatwarden/core';
import type { Chatwarden, ReportExcerptLine, StaffReport } from '@chatwarden/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveOptions } from '../src/coop/options.js';
import { actorOf, buildReport, decisionOf } from '../src/coop/wire.js';
import { ITEM_TYPES, API_KEY, COOP_URL, reportProblems, sharedPair, callbackBody } from './coop-world.js';
import { world } from './world.js';

// K5 C1: the pure mappers. `buildReport` makes the body of design 8.3 for every evidence / includeNote / handles mix; `decisionOf` maps a Coop callback to a kit
// decision (design 8.2 and 8.4 steps 5 to 9) or says why it is ignored.

const SEEDS = { room: 'room-secret-zorbak', repSeat: 'seat-rep-secret', tgtSeat: 'seat-tgt-secret', o1Seat: 'seat-o1-secret', o2Seat: 'seat-o2-secret', repHandle: 'SnerpReporter', tgtHandle: 'GlarnTarget', o1Handle: 'TarvoOne', o2Handle: 'FenriskTwo' };

const line = (id: string, ts: number, p: number | null, seat: string, handle: string, raw: string, extra: Partial<ReportExcerptLine> = {}): ReportExcerptLine => ({
  lineId: id,
  ts,
  seatId: seat,
  handle,
  raw,
  delivered: raw,
  blocked: false,
  audience: null,
  p,
  ...extra,
});

const T0 = Date.UTC(2026, 10, 12, 10, 29, 0);

/** A four person report: person-rep reported person-tgt; person-o1 and person-o2 also spoke. */
function report(over: Partial<StaffReport> = {}): StaffReport {
  return {
    id: 'rpt0001',
    createdAt: Date.UTC(2026, 10, 12, 10, 30, 0),
    roomId: SEEDS.room,
    tags: { tag: 'value', tag2: 'value2' },
    origin: null,
    originKey: null,
    urgent: false,
    evidenceRef: null,
    scope: null,
    handoffAt: null,
    handoffBy: null,
    escalatedTo: null,
    escalatedBy: null,
    escalatedAt: null,
    reporterSubject: 'sub-rep',
    reporterSeat: SEEDS.repSeat,
    reporterHandle: SEEDS.repHandle,
    targetSubject: 'sub-tgt',
    targetSeat: SEEDS.tgtSeat,
    targetHandle: SEEDS.tgtHandle,
    category: 'harassment',
    reportedReason: 'harassment',
    note: 'the note: drakkuun said a thing',
    lineId: 'l3',
    excerpt: [
      line('l1', T0, 2, SEEDS.o1Seat, SEEDS.o1Handle, 'hello vlemmo'),
      line('l2', T0 + 1000, 0, SEEDS.repSeat, SEEDS.repHandle, 'please stop'),
      line('l3', T0 + 2000, 1, SEEDS.tgtSeat, SEEDS.tgtHandle, 'zorbak quissel', { blocked: true, delivered: null }),
      line('l4', T0 + 3000, 3, SEEDS.o2Seat, SEEDS.o2Handle, 'leave them alone'),
      line('l5', T0 + 4000, 2, SEEDS.o1Seat, SEEDS.o1Handle, 'agreed'),
    ],
    people: ['person-rep', 'person-tgt', 'person-o1', 'person-o2'],
    status: 'open',
    badFaith: false,
    actionedAt: null,
    actionedBy: null,
    modNote: null,
    badFaithEvidence: null,
    detailAt: null,
    targetPerson: 'person-tgt',
    reporterPerson: 'person-rep',
    ownLineIds: {},
    ...over,
  };
}

const optionsOf = (over: Record<string, unknown> = {}) =>
  resolveOptions({
    baseUrl: COOP_URL,
    apiKey: API_KEY,
    webhookPublicKey: sharedPair().publicPem,
    itemTypes: { ...ITEM_TYPES },
    evidence: 'excerpt',
    actions: {
      'action-warn': { verdict: 'upheld', kind: 'warning' },
      'action-chat': { verdict: 'upheld', kind: 'chat', durationMs: 86_400_000 },
      'action-ban7': { verdict: 'upheld', kind: 'ban', durationMs: 7 * 86_400_000 },
      'action-banperm': { verdict: 'upheld', kind: 'ban' },
      'action-note': { verdict: 'noted' },
      'action-dismiss': { verdict: 'no_action' },
      'action-badfaith': { verdict: 'bad_faith' },
    },
    rules: {},
    ...over,
  });

let cw: Chatwarden;
let ruleA: number;
let ruleB: number;
beforeAll(async () => {
  const w = await world();
  cw = w.cw;
  const active = cw.rules.active();
  ruleA = active[0]!.number;
  ruleB = active[1]!.number;
});

const kit = () => ({ rules: cw.rules, profile: cw.profile });
const body = (over: Record<string, unknown> = {}, r: StaffReport = report(), ai?: unknown) => buildReport(r, optionsOf(over), kit(), ai);

describe('buildReport', () => {
  it('evidence none has no thread and no lines', () => {
    const b = body({ evidence: 'none' });
    expect(b.reportedItemThread).toBeUndefined();
    expect(b.reportedItemsInThread).toBeUndefined();
    expect(JSON.stringify(b)).not.toMatch(/zorbak quissel|hello vlemmo|please stop/);
    expect(reportProblems(b)).toEqual([]);
  });

  it('the item is the report: its id, the category, the reason, the rule suggested, the room tags and the target as creator', () => {
    const b = body({ evidence: 'none' });
    expect(b.reportedItem.id).toBe('rpt0001');
    expect(b.reportedItem.typeId).toBe(ITEM_TYPES.report);
    const rule = suggestedRule(cw.profile.reporting.reasons, 'harassment', cw.rules);
    expect(b.reportedItem.data).toEqual({
      category: 'harassment',
      reportedReason: 'harassment',
      ...(typeof rule === 'number' ? { rule } : {}),
      room: 'tag=value,tag2=value2',
      creator: { id: 'person-tgt', typeId: ITEM_TYPES.user },
    });
    expect(b.reporter).toEqual({ kind: 'user', typeId: ITEM_TYPES.user, id: 'person-rep' });
    expect(b.reportedAt).toBe('2026-11-12T10:30:00.000Z');
  });

  it('excerpt has the lines in order with datetime, blocked lines with their original text', () => {
    const b = body();
    const thread = b.reportedItemThread ?? [];
    expect(thread.map((t) => t.data.text)).toEqual(['hello vlemmo', 'please stop', 'zorbak quissel', 'leave them alone', 'agreed']);
    expect(thread.map((t) => t.datetime)).toEqual([0, 1, 2, 3, 4].map((i) => new Date(T0 + i * 1000).toISOString()));
    expect(thread.map((t) => t.data.datetime)).toEqual(thread.map((t) => t.datetime));
    expect(new Set(thread.map((t) => t.id)).size).toBe(5);
    expect(thread.every((t) => t.id.startsWith('rpt0001-') && t.typeId === ITEM_TYPES.line)).toBe(true);
    expect(reportProblems(b)).toEqual([]);
  });

  it('lines are sorted by time even when stored out of order, ties keep the stored order', () => {
    const r = report({ excerpt: [line('b', T0 + 5, 0, 's', 'h', 'second'), line('a', T0, 1, 's', 'h', 'first'), line('c', T0 + 5, 1, 's', 'h', 'third')] });
    expect((body({}, r).reportedItemThread ?? []).map((t) => t.data.text)).toEqual(['first', 'second', 'third']);
  });

  it('handles hidden: labels reporter, reported, other 1 and other 2 for a four person excerpt', () => {
    const b = body({ handles: 'hidden' });
    expect((b.reportedItemThread ?? []).map((t) => t.data.author)).toEqual(['other 1', 'reporter', 'reported', 'other 2', 'other 1']);
    expect((b.reportedItemThread ?? []).every((t) => t.data.handle === undefined)).toBe(true);
  });

  it('a speaker with no person is labelled other n by seat, never by the seat id', () => {
    const r = report({ excerpt: [line('a', T0, null, 'seat-x-secret', 'H1', 'one'), line('b', T0 + 1, null, 'seat-y-secret', 'H2', 'two'), line('c', T0 + 2, null, 'seat-x-secret', 'H1', 'three')] });
    const b = body({}, r);
    expect((b.reportedItemThread ?? []).map((t) => t.data.author)).toEqual(['other 1', 'other 2', 'other 1']);
    expect(JSON.stringify(b)).not.toMatch(/seat-x-secret|seat-y-secret/);
  });

  it('handles shown carries the handle of each line', () => {
    const b = body({ handles: 'shown' });
    expect((b.reportedItemThread ?? []).map((t) => t.data.handle)).toEqual([SEEDS.o1Handle, SEEDS.repHandle, SEEDS.tgtHandle, SEEDS.o2Handle, SEEDS.o1Handle]);
    expect(reportProblems(b)).toEqual([]);
  });

  it('includeNote false never carries the note; true cuts it to 500', () => {
    const none = body({ policies: { byReason: { harassment: 'p-h' } } });
    expect(JSON.stringify(none)).not.toContain('drakkuun');
    expect(none.reportedForReason).toEqual({ policyId: 'p-h' });
    const on = body({ includeNote: true, policies: { byReason: { harassment: 'p-h' } } });
    expect(on.reportedForReason).toEqual({ policyId: 'p-h', reason: 'the note: drakkuun said a thing' });
    const long = body({ includeNote: true }, report({ note: 'x'.repeat(900) }));
    expect(long.reportedForReason?.reason).toHaveLength(500);
    expect(body({ includeNote: true }, report({ note: null })).reportedForReason).toBeUndefined();
    expect(body({ includeNote: true }, report({ note: '   ' })).reportedForReason).toBeUndefined();
  });

  it('the policy: a reason wins over a rule; no mapping and no note is no reportedForReason', () => {
    const rule = suggestedRule(cw.profile.reporting.reasons, 'harassment', cw.rules);
    expect(typeof rule).toBe('number');
    const both = body({ policies: { byReason: { harassment: 'p-reason' }, byRule: { [String(rule)]: 'p-rule' } } });
    expect(both.reportedForReason).toEqual({ policyId: 'p-reason' });
    const ruleOnly = body({ policies: { byRule: { [String(rule)]: 'p-rule' } } });
    expect(ruleOnly.reportedForReason).toEqual({ policyId: 'p-rule' });
    expect(body({ policies: { byReason: { other: 'p-x' } } }).reportedForReason).toBeUndefined();
    expect(body().reportedForReason).toBeUndefined();
  });

  it('the reported line is in reportedItemsInThread, only with an excerpt that holds it', () => {
    const b = body();
    expect(b.reportedItemsInThread).toEqual([{ id: (b.reportedItemThread ?? [])[2]!.id, typeId: ITEM_TYPES.line }]);
    expect(body({}, report({ lineId: null })).reportedItemsInThread).toBeUndefined();
    expect(body({}, report({ lineId: 'gone' })).reportedItemsInThread).toBeUndefined();
    expect(body({ evidence: 'none' }).reportedItemsInThread).toBeUndefined();
  });

  it('room is the tags as k=v pairs cut to 200, and absent when there are none', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, 'v'.repeat(20)]));
    const b = body({ evidence: 'none' }, report({ tags: many }));
    expect(b.reportedItem.data.room).toHaveLength(200);
    expect(b.reportedItem.data.room?.startsWith('key0=vvvv')).toBe(true);
    expect(body({ evidence: 'none' }, report({ tags: {} })).reportedItem.data.room).toBeUndefined();
  });

  it('aiSeverity only when given and a finite number from 0 to 100', () => {
    for (const ok of [0, 1, 72, 99.5, 100]) expect(body({ evidence: 'none' }, report(), ok).reportedItem.data.aiSeverity).toBe(ok);
    for (const nope of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, 101, '72', {}, [], true]) {
      expect(body({ evidence: 'none' }, report(), nope).reportedItem.data.aiSeverity, String(nope)).toBeUndefined();
    }
  });

  it('a missing reported reason is left out, and the category stays', () => {
    const b = body({ evidence: 'none' }, report({ reportedReason: null, category: 'other' }));
    expect(b.reportedItem.data.reportedReason).toBeUndefined();
    expect(b.reportedItem.data.category).toBe('other');
    expect(b.reportedItem.data.rule).toBeUndefined();
  });

  it('csam is absent in every combination', () => {
    for (const evidence of ['none', 'excerpt']) expect(JSON.stringify(body({ evidence }))).not.toContain('csam');
  });

  it('never carries the room id, a seat id, a client key, a hash or the reporter handle in a hidden-handles body (seeded)', () => {
    for (const evidence of ['none', 'excerpt']) {
      for (const includeNote of [false, true]) {
        const text = JSON.stringify(body({ evidence, includeNote, handles: 'hidden', policies: { byReason: { harassment: 'p-h' } } }));
        for (const [name, seed] of Object.entries(SEEDS)) expect(text, `${evidence}/${includeNote}/${name}`).not.toContain(seed);
        expect(text).not.toContain('person-o1');
        expect(text).not.toContain('person-o2');
        expect(text).not.toContain('sub-rep');
        expect(text).not.toContain('sub-tgt');
      }
    }
  });

  it('with handles shown the reporter handle still never appears outside the lines it wrote, and ids and seats never appear', () => {
    const b = body({ handles: 'shown' });
    const text = JSON.stringify(b);
    for (const seed of [SEEDS.room, SEEDS.repSeat, SEEDS.tgtSeat, SEEDS.o1Seat, SEEDS.o2Seat]) expect(text).not.toContain(seed);
    expect(JSON.stringify(b.reportedItem)).not.toContain(SEEDS.repHandle);
    expect(JSON.stringify(b.reporter)).not.toContain(SEEDS.repHandle);
  });

  it('validates against the fake documented schema for 40 generated combinations', () => {
    let n = 0;
    for (const evidence of ['none', 'excerpt']) {
      for (const includeNote of [false, true]) {
        for (const handles of ['hidden', 'shown']) {
          for (const reason of ['harassment', null, 'unknown_reason_zz']) {
            for (const ai of [undefined, 55, Number.NaN]) {
              if (n >= 40 && ai !== undefined) continue;
              const r = report({ reportedReason: reason, note: includeNote ? 'a note' : null, lineId: n % 3 === 0 ? null : 'l3' });
              const b = body({ evidence, includeNote, handles, policies: { byReason: { harassment: 'p-h' } } }, r, ai);
              expect(reportProblems(b), JSON.stringify({ evidence, includeNote, handles, reason, ai })).toEqual([]);
              n++;
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(40);
  });

  it('hostile text is carried as text: no change of shape', () => {
    const r = report({ excerpt: [line('l1', T0, 1, 's', 'h', '{"csam": true, "__proto__": {"x": 1}} \u0000 \u202e')], note: '"}{' });
    const b = body({ includeNote: true }, r);
    expect(reportProblems(b)).toEqual([]);
    expect(Object.keys(b).sort()).toEqual(['reportedAt', 'reportedForReason', 'reportedItem', 'reportedItemThread', 'reportedItemsInThread', 'reporter'].filter((k) => k in b).sort());
  });
});

describe('actorOf', () => {
  it('is coop:<email> with disallowed characters replaced and 128 at most; an empty email is coop:unknown', () => {
    expect(actorOf('drakkuun@example.test')).toBe('coop:drakkuun@example.test');
    expect(actorOf('Zorbak Vlemmo <z@x.test>')).toBe('coop:Zorbak_Vlemmo__z@x.test_');
    expect(actorOf('a+b@x.test')).toBe('coop:a+b@x.test');
    expect(actorOf('x'.repeat(300))).toHaveLength(128);
    for (const e of ['', '   ', undefined, null, 5, {}, []]) expect(actorOf(e), String(e)).toBe('coop:unknown');
    for (const e of ['a b', '\u00e9\u00e8', '\u0000\u0001', "'; DROP", 'x'.repeat(500)]) expect(isValidAuditActor(actorOf(e)), e).toBe(true);
  });
});

describe('decisionOf', () => {
  const open = (over: Partial<StaffReport> = {}): StaffReport => report({ id: 'rpt-open', ...over });
  const run = (cb: Record<string, unknown>, over: Record<string, unknown> = {}, r: StaffReport = open()) =>
    decisionOf(cb, optionsOf({ rules: { 'policy-harass': ruleA, 'policy-spam': ruleB, 'policy-bogus': 9999 }, ...over }), r, kit());
  const cbk = (over: Record<string, unknown> = {}) => callbackBody('rpt-open', over);

  it('each mapped action', () => {
    const target = 'person-tgt';
    const cases: Array<[string, unknown]> = [
      ['action-warn', { verdict: 'upheld', actions: [{ subject: target, kind: 'warning', durationMs: null, rule: ruleA }] }],
      ['action-chat', { verdict: 'upheld', actions: [{ subject: target, kind: 'chat', durationMs: 86_400_000, rule: ruleA }] }],
      ['action-ban7', { verdict: 'upheld', actions: [{ subject: target, kind: 'ban', durationMs: 7 * 86_400_000, rule: ruleA }] }],
      ['action-banperm', { verdict: 'upheld', actions: [{ subject: target, kind: 'ban', durationMs: null, rule: ruleA }] }],
      ['action-note', { verdict: 'noted', actions: [{ subject: target, kind: 'note', durationMs: null, rule: ruleA }] }],
      ['action-dismiss', { verdict: 'no_action', actions: [] }],
      ['action-badfaith', { verdict: 'bad_faith', actions: [], evidence: 'zorbak vlemmo is not allowed' }],
    ];
    for (const [id, expected] of cases) {
      const r = run(cbk({ action: { id } }));
      expect(r.ok, id).toBe(true);
      if (r.ok) {
        expect(r.decision).toMatchObject(expected as object);
        expect(r.decision.reason).toBe('zorbak vlemmo is not allowed');
        expect(r.actor).toBe('coop:drakkuun@example.test');
      }
    }
  });

  it('the person decided is always the report target, never anything in the callback', () => {
    const r = run(cbk({ item: { id: 'rpt-open', typeId: 't' }, creator: { id: 'person-o1', typeId: 'x' }, custom: { subject: 'person-o2', person: 'person-o2' } }));
    expect(r.ok && r.decision.actions.map((a) => a.subject)).toEqual(['person-tgt']);
  });

  it('an unknown action id is ignored with a reason', () => {
    expect(run(cbk({ action: { id: 'action-zz' } }))).toEqual({ ok: false, reason: 'unknown_action' });
    expect(run(cbk({ action: { id: '__proto__' } }))).toEqual({ ok: false, reason: 'unknown_action' });
    expect(run(cbk({ action: {} }))).toEqual({ ok: false, reason: 'unknown_action' });
    expect(run(cbk({ action: undefined }))).toEqual({ ok: false, reason: 'unknown_action' });
  });

  it('a policy mapped to a rule is used, the first mapped one wins', () => {
    const r = run(cbk({ policies: [{ id: 'policy-unknown' }, { id: 'policy-spam' }, { id: 'policy-harass' }] }));
    expect(r.ok && r.decision.actions[0]?.rule).toBe(ruleB);
  });

  it('a policy mapped to a rule that is not citable falls to the next, then to the suggestion', () => {
    const r = run(cbk({ policies: [{ id: 'policy-bogus' }, { id: 'policy-spam' }] }));
    expect(r.ok && r.decision.actions[0]?.rule).toBe(ruleB);
    const suggested = suggestedRule(cw.profile.reporting.reasons, 'harassment', cw.rules);
    const s = run(cbk({ policies: [{ id: 'policy-bogus' }] }));
    expect(s.ok && s.decision.actions[0]?.rule).toBe(suggested);
  });

  it('an unmapped policy falls back to the suggested rule', () => {
    const suggested = suggestedRule(cw.profile.reporting.reasons, 'harassment', cw.rules);
    expect(typeof suggested).toBe('number');
    const r = run(cbk({ policies: [{ id: 'policy-unmapped' }] }));
    expect(r.ok && r.decision.actions[0]?.rule).toBe(suggested);
  });

  it('no citable rule for an acting verdict is ignored with reason no_rule; a verdict that needs none is not', () => {
    const noRule = open({ reportedReason: null });
    for (const id of ['action-warn', 'action-chat', 'action-ban7', 'action-banperm', 'action-note']) {
      expect(run(cbk({ action: { id }, policies: [{ id: 'policy-unmapped' }] }), {}, noRule), id).toEqual({ ok: false, reason: 'no_rule' });
    }
    expect(run(cbk({ action: { id: 'action-dismiss' }, policies: [{ id: 'policy-unmapped' }] }), {}, noRule).ok).toBe(true);
    expect(run(cbk({ action: { id: 'action-badfaith' }, policies: [{ id: 'policy-unmapped' }] }), {}, noRule).ok).toBe(true);
  });

  it('bad_faith without a reason is ignored; the note is used when there is no decisionReason', () => {
    const bf = { action: { id: 'action-badfaith' } };
    expect(run(cbk({ ...bf, decisionReason: undefined, actorNote: undefined }))).toEqual({ ok: false, reason: 'no_reason' });
    expect(run(cbk({ ...bf, decisionReason: '   ', actorNote: '' }))).toEqual({ ok: false, reason: 'no_reason' });
    expect(run(cbk({ ...bf, decisionReason: 5, actorNote: {} }))).toEqual({ ok: false, reason: 'no_reason' });
    const withNote = run(cbk({ ...bf, decisionReason: undefined, actorNote: 'tarvo note' }));
    expect(withNote.ok && withNote.decision.evidence).toBe('tarvo note');
    const r = run(cbk({ ...bf, decisionReason: 'y'.repeat(900) }));
    expect(r.ok && r.decision.evidence).toHaveLength(500);
  });

  it('the reason is decisionReason, else actorNote, else a fixed text; cut to 500', () => {
    const a = run(cbk({ decisionReason: undefined, actorNote: 'the actor note' }));
    expect(a.ok && a.decision.reason).toBe('the actor note');
    const b = run(cbk({ decisionReason: undefined, actorNote: undefined }));
    expect(b.ok && b.decision.reason).toBe('Decided in Coop');
    const c = run(cbk({ decisionReason: 'z'.repeat(5000) }));
    expect(c.ok && c.decision.reason).toHaveLength(500);
    const d = run(cbk({ decisionReason: '  padded  ' }));
    expect(d.ok && d.decision.reason).toBe('padded');
  });

  it('no actorEmail is ignored (a rule-triggered action)', () => {
    for (const email of [undefined, '', '   ', 5, null]) expect(run(cbk({ actorEmail: email })), String(email)).toEqual({ ok: false, reason: 'no_actor' });
  });

  it('empty policies and rules (a strike threshold) is ignored, as is a body with neither array', () => {
    expect(run(cbk({ policies: [], rules: [] }))).toEqual({ ok: false, reason: 'no_policies' });
    expect(run(cbk({ policies: undefined, rules: undefined }))).toEqual({ ok: false, reason: 'no_policies' });
    expect(run(cbk({ policies: 'x', rules: {} }))).toEqual({ ok: false, reason: 'no_policies' });
    // A decision with a rule list but no policy is still a decision of a person.
    expect(run(cbk({ policies: [], rules: [{ id: 'r', name: 'n' }] })).ok).toBe(true);
  });

  it('hostile shapes are handled without throwing', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ id: `p${i}` }));
    expect(run(cbk({ policies: many })).ok).toBe(true);
    const junk = [null, 5, 'x', [], { id: 5 }, { id: { a: 1 } }, undefined];
    expect(run(cbk({ policies: junk })).ok).toBe(true);
    expect(run(cbk({ actorEmail: 'a@b.test', actorNote: { deep: { deeper: [1, 2, 3] } }, custom: { a: { b: { c: {} } } } })).ok).toBe(true);
  });

  it('the permanent ban is built as asked; refusing it for a low role is the permission check, not the mapper', () => {
    const r = run(cbk({ action: { id: 'action-banperm' } }));
    expect(r.ok && r.decision.actions[0]?.durationMs).toBeNull();
  });
});
