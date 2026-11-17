import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/errors.js';
import type { ErrorCode } from '../src/errors.js';
import { decideAs } from '../src/admin/decideAs.js';
import type { DecideAsInput } from '../src/admin/decideAs.js';
import { parseDecision } from '../src/admin/apply.js';
import { PERMISSIONS, resolvePermissions } from '../src/permissions.js';
import type { Role } from '../src/index.js';
import { DAY, NOW, world } from './world.js';

// The shared decision path (K5 task A3): `decideAs` is what `POST /reports/:id/decide` runs, extracted so the Discord bot and the Coop callback
// decide through the same checks. Behaviour-preserving for the route: the route's own tests are the safety net, and these tests drive the
// route and `decideAs` side by side on identical worlds and compare what each does.

type W = Awaited<ReturnType<typeof world>>;
type Filed = Awaited<ReturnType<W['file']>>;

/** What a call came to, without the random parts (ref codes). */
interface Outcome {
  status: number;
  error?: string;
  replay?: boolean;
  groups?: Array<{ kind: string }>;
}

const decisionOf = (target: string, kind: 'upheld' | 'noted' | 'no_action' | 'bad_faith', over: Record<string, unknown> = {}): Record<string, unknown> => {
  switch (kind) {
    case 'upheld':
      return { verdict: 'upheld', actions: [{ subject: target, kind: 'chat', durationMs: DAY, rule: 2 }], reason: 'a ladder decision about zorbak', ...over };
    case 'noted':
      return { verdict: 'noted', actions: [{ subject: target, kind: 'note', durationMs: null, rule: 1 }], reason: 'a note about vlemmo', ...over };
    case 'no_action':
      return { verdict: 'no_action', actions: [], reason: 'nothing here', ...over };
    case 'bad_faith':
      return { verdict: 'bad_faith', actions: [], reason: 'planted', evidence: 'planted-evidence-quissel-1', ...over };
  }
};

const viaRoute = async (w: W, reportId: string, body: Record<string, unknown>, o: { actor?: string; role?: Role } = {}): Promise<Outcome> => {
  const res = await w.call('POST', `/reports/${reportId}/decide`, { body, actor: o.actor ?? 'ann', role: o.role ?? 'moderator' });
  const b = res.body as { error?: string; replay?: boolean; groups?: Array<{ kind: string }> };
  if (res.status !== 200) return { status: res.status, ...(b.error === undefined ? {} : { error: b.error }) };
  return { status: 200, replay: b.replay as boolean, groups: (b.groups ?? []).map((g) => ({ kind: g.kind })) };
};

const asInput = (w: W, reportId: string, body: Record<string, unknown>, over: Partial<DecideAsInput> = {}): DecideAsInput => ({
  reportId,
  decision: parseDecision(body),
  actor: 'ann',
  role: 'moderator',
  permissions: PERMISSIONS,
  claims: 'gate',
  ...over,
} as DecideAsInput);

const viaDecideAs = async (w: W, reportId: string, body: Record<string, unknown>, over: Partial<DecideAsInput> = {}): Promise<Outcome> => {
  try {
    const out = await decideAs(w.cw, asInput(w, reportId, body, over));
    return { status: 200, replay: out.replay, groups: out.groups.map((g) => ({ kind: g.kind })) };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, error: err.code };
    throw err;
  }
};

/** The state a decision leaves: the report's status and the sanction groups of the target, with the random ref codes left out. */
const stateOf = (w: W, f: Filed) => ({
  status: w.cw.reports.get(f.id)?.status,
  sanctions: w.cw.sanctions.forPerson(f.target).map((s) => ({ kind: s.kind, rule: s.rule, source: s.source, actor: s.actor, automated: s.automated, reason: s.reason })),
});

describe('decideAs matches the staff route', () => {
  /** Both worlds start alike; `first` runs the same earlier decision (through the route) on both. */
  async function both(first?: (f: Filed) => Record<string, unknown>) {
    const a = await world();
    const b = await world();
    const fa = await a.file();
    const fb = await b.file();
    if (first !== undefined) {
      await viaRoute(a, fa.id, first(fa));
      await viaRoute(b, fb.id, first(fb));
    }
    return { a, b, fa, fb };
  }

  const scenarios: Array<[string, (t: string) => Record<string, unknown>, ((t: string) => Record<string, unknown>)?]> = [
    ['a ladder decision', (t) => decisionOf(t, 'upheld')],
    ['a warning', (t) => decisionOf(t, 'upheld', { actions: [{ subject: t, kind: 'warning', durationMs: null, rule: 1 }] })],
    ['a timed ban', (t) => decisionOf(t, 'upheld', { actions: [{ subject: t, kind: 'ban', durationMs: 7 * DAY, rule: 2 }] })],
    ['a dismissal', (t) => decisionOf(t, 'no_action')],
    ['a dismissal with no reason', () => ({ verdict: 'no_action', actions: [] })],
    ['a note', (t) => decisionOf(t, 'noted')],
    ['a bad faith with evidence', (t) => decisionOf(t, 'bad_faith')],
    ['a bad faith with no evidence', (t) => {
      const d = decisionOf(t, 'bad_faith');
      delete d.evidence;
      return d;
    }],
    ['an upheld decision with no reason', (t) => {
      const d = decisionOf(t, 'upheld');
      delete d.reason;
      return d;
    }],
    ['a replay', (t) => decisionOf(t, 'upheld'), (t) => decisionOf(t, 'upheld')],
    ['already_decided (a different decision on a closed report)', (t) => decisionOf(t, 'upheld'), (t) => decisionOf(t, 'no_action')],
  ];

  for (const [name, second, first] of scenarios) {
    it(`${name}: same answer and same state`, async () => {
      const { a, b, fa, fb } = await both(first === undefined ? undefined : (f) => first(f.target));
      const route = await viaRoute(a, fa.id, second(fa.target));
      const direct = await viaDecideAs(b, fb.id, second(fb.target));
      expect(direct).toEqual(route);
      expect(stateOf(b, fb)).toEqual(stateOf(a, fa));
    });
  }

  it('a replay is replay true with the same groups, and writes nothing twice', async () => {
    const w = await world();
    const f = await w.file();
    const one = await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'));
    const two = await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'));
    expect(one).toMatchObject({ status: 200, replay: false });
    expect(two).toMatchObject({ status: 200, replay: true });
    expect(two.groups).toEqual(one.groups);
    expect(w.cw.sanctions.forPerson(f.target)).toHaveLength(1);
  });

  it('an unknown report is 404 not_found, as the route answers it', async () => {
    const a = await world();
    const b = await world();
    expect(await viaDecideAs(b, 'no-such-report', decisionOf('s_x', 'no_action'))).toEqual(await viaRoute(a, 'no-such-report', decisionOf('s_x', 'no_action')));
    expect(await viaDecideAs(b, 'no-such-report', decisionOf('s_x', 'no_action'))).toEqual({ status: 404, error: 'not_found' });
  });

  it('a person not on the report is 400 invalid_request and writes nothing', async () => {
    const a = await world();
    const b = await world();
    const fa = await a.file();
    const fb = await b.file();
    const stranger = (w: W) => decisionOf(w.person(), 'upheld');
    const route = await viaRoute(a, fa.id, stranger(a));
    const direct = await viaDecideAs(b, fb.id, stranger(b));
    expect(direct).toEqual(route);
    expect(direct).toEqual({ status: 400, error: 'invalid_request' });
    expect(b.cw.reports.get(fb.id)?.status).toBe('open');
  });

  it('refuses the same things the route refuses (a bad action rule, a duration over the cap) with the same answer', async () => {
    const a = await world();
    const b = await world();
    const fa = await a.file();
    const fb = await b.file();
    const bad = (t: string) => decisionOf(t, 'upheld', { actions: [{ subject: t, kind: 'chat', durationMs: 400 * DAY, rule: 2 }] });
    expect(await viaDecideAs(b, fb.id, bad(fb.target))).toEqual(await viaRoute(a, fa.id, bad(fa.target)));
    const noRule = (t: string) => decisionOf(t, 'upheld', { actions: [{ subject: t, kind: 'chat', durationMs: DAY, rule: 999 }] });
    expect(await viaDecideAs(b, fb.id, noRule(fb.target))).toEqual(await viaRoute(a, fa.id, noRule(fa.target)));
  });

  it('does not audit: the caller does (audit modes differ), and the route still writes its own row', async () => {
    const b = await world();
    const fb = await b.file();
    await viaDecideAs(b, fb.id, decisionOf(fb.target, 'no_action'));
    expect(b.routeAudit()).toEqual([]);
    const a = await world();
    const fa = await a.file();
    await viaRoute(a, fa.id, decisionOf(fa.target, 'no_action'));
    expect(a.routeAudit().map((r) => r.action)).toEqual(['report.decide']);
  });
});

describe('decideAs and the claim on the person', () => {
  it('gates a claim held by another actor and passes the actor\'s own; takeOver needs the claims.override role; claims \'ignore\' never gates', async () => {
    const w = await world();
    const f1 = await w.file();
    expect(w.cw.cases.claim(f1.target, 'ann').ok).toBe(true);

    // another actor: refused, with who holds it, and nothing written
    const refused = await viaDecideAs(w, f1.id, decisionOf(f1.target, 'upheld'), { actor: 'bea' });
    expect(refused).toEqual({ status: 409, error: 'claimed' });
    try {
      await decideAs(w.cw, asInput(w, f1.id, decisionOf(f1.target, 'upheld'), { actor: 'bea' }));
    } catch (err) {
      expect(err).toMatchObject({ by: 'ann', code: 'claimed' });
    }
    expect(w.cw.reports.get(f1.id)?.status).toBe('open');
    expect(w.cw.cases.holder(f1.target)?.by).toBe('ann');

    // takeOver as a moderator: still refused (the role decides, not the caller's say-so)
    expect(await viaDecideAs(w, f1.id, decisionOf(f1.target, 'upheld'), { actor: 'bea', takeOver: true, onTakeOver: () => undefined })).toEqual({ status: 409, error: 'claimed' });
    expect(await viaDecideAs(w, f1.id, decisionOf(f1.target, 'upheld'), { actor: 'bea', role: 'moderator', takeOver: true, onTakeOver: () => undefined })).toEqual({ status: 409, error: 'claimed' });
    // a senior without takeOver: also refused
    expect(await viaDecideAs(w, f1.id, decisionOf(f1.target, 'upheld'), { actor: 'bea', role: 'senior' })).toEqual({ status: 409, error: 'claimed' });
    expect(w.cw.cases.holder(f1.target)?.by).toBe('ann');

    // the holder's own decision passes
    expect(await viaDecideAs(w, f1.id, decisionOf(f1.target, 'upheld'), { actor: 'ann' })).toMatchObject({ status: 200, replay: false });

    // 'ignore' never gates: another actor decides over ann's claim
    const f2 = await w.file();
    w.cw.cases.claim(f2.target, 'ann');
    expect(await viaDecideAs(w, f2.id, decisionOf(f2.target, 'no_action'), { actor: 'coop', claims: 'ignore' })).toMatchObject({ status: 200, replay: false });
    expect(w.cw.reports.get(f2.id)?.status).toBe('dismissed');
  });

  it('a takeover moves the claim to the actor after the caller\'s audit hook ran, and a hook that throws stops the decision with the claim untouched', async () => {
    const w = await world();
    const f = await w.file();
    w.cw.cases.claim(f.target, 'ann');
    const seen: Array<{ person: string; holderThen: string | undefined }> = [];
    const hook = (person: string): void => {
      seen.push({ person, holderThen: w.cw.cases.holder(person)?.by });
    };
    const out = await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { actor: 'sam', role: 'senior', takeOver: true, onTakeOver: hook });
    expect(out).toMatchObject({ status: 200, replay: false });
    expect(seen).toEqual([{ person: f.target, holderThen: 'ann' }]);

    const g = await w.file();
    w.cw.cases.claim(g.target, 'ann');
    const failing = (): void => {
      throw new Error('audit unavailable');
    };
    await expect(decideAs(w.cw, asInput(w, g.id, decisionOf(g.target, 'upheld'), { actor: 'sam', role: 'senior', takeOver: true, onTakeOver: failing }))).rejects.toThrow('audit unavailable');
    expect(w.cw.cases.holder(g.target)?.by).toBe('ann');
    expect(w.cw.reports.get(g.id)?.status).toBe('open');
  });

  it('a takeover hook is not called when nobody else holds the case, or the actor holds it', async () => {
    const w = await world();
    const f = await w.file();
    const calls: string[] = [];
    const hook = (p: string): void => void calls.push(p);
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'no_action'), { actor: 'sam', role: 'senior', takeOver: true, onTakeOver: hook })).toMatchObject({ status: 200 });
    const g = await w.file();
    w.cw.cases.claim(g.target, 'sam');
    expect(await viaDecideAs(w, g.id, decisionOf(g.target, 'no_action'), { actor: 'sam', role: 'senior', takeOver: true, onTakeOver: hook })).toMatchObject({ status: 200 });
    expect(calls).toEqual([]);
  });

  it('a claim taken after the report was decided does not turn a replay into a 409', async () => {
    const w = await world();
    const f = await w.file();
    await viaDecideAs(w, f.id, decisionOf(f.target, 'no_action'));
    const again = await w.file(); // another open report on someone else, so the world has an open case
    w.cw.cases.claim(again.target, 'ann');
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'no_action'), { actor: 'bea' })).toMatchObject({ status: 200, replay: true });
  });

  it('releases the case on the last open report and not on a replay', async () => {
    const w = await world();
    const first = await w.file();
    const second = await w.fileAgainst(first, 'other');
    expect(w.cw.cases.claim(first.target, 'ann').ok).toBe(true);
    // one of two open reports: the claim is kept
    await viaDecideAs(w, first.id, decisionOf(first.target, 'no_action'), { actor: 'ann' });
    expect(w.cw.cases.holder(first.target)?.by).toBe('ann');
    // the last one: released
    await viaDecideAs(w, second.id, decisionOf(second.target, 'no_action'), { actor: 'ann' });
    expect(w.cw.cases.holder(first.target)).toBeNull();
    // a new claim on a fresh report, then a replay of an old decision: the new claim is not released by it
    const third = await w.fileAgainst(first, 'other');
    expect(w.cw.cases.claim(third.target, 'ann').ok).toBe(true);
    const replayed = await viaDecideAs(w, second.id, decisionOf(second.target, 'no_action'), { actor: 'ann' });
    expect(replayed).toMatchObject({ status: 200, replay: true });
    expect(w.cw.cases.holder(first.target)?.by).toBe('ann');
  });

  it("with claims 'ignore' no claim is ended: neither another holder's nor one under the actor's own name", async () => {
    const w = await world();
    const f = await w.file();
    w.cw.cases.claim(f.target, 'ann');
    await viaDecideAs(w, f.id, decisionOf(f.target, 'no_action'), { actor: 'coop', claims: 'ignore' });
    expect(w.cw.cases.holder(f.target)?.by).toBe('ann');
    const g = await w.file();
    w.cw.cases.claim(g.target, 'coop');
    await viaDecideAs(w, g.id, decisionOf(g.target, 'no_action'), { actor: 'coop', claims: 'ignore' });
    expect(w.cw.cases.holder(g.target)?.by).toBe('coop');
  });

  it('a failing release is logged by class and never turns the decision into an error', async () => {
    const w = await world();
    const f = await w.file();
    const warned: string[] = [];
    const cw = Object.create(w.cw, { cases: { value: { ...w.cw.cases, holder: w.cw.cases.holder.bind(w.cw.cases), releaseWhenDone: () => { throw new Error('zorbak-secret'); } } } }) as typeof w.cw;
    const out = await decideAs(cw, asInput(w, f.id, decisionOf(f.target, 'no_action'), { logger: { warn: (event, detail) => void warned.push(JSON.stringify([event, detail])) } }));
    expect(out.replay).toBe(false);
    expect(warned).toEqual([JSON.stringify(['chatwarden.http_release_failed', undefined])]);
    expect(warned.join()).not.toContain('zorbak-secret');
  });
});

describe('decideAs and what a decision may do', () => {
  it('refuses a permanent ban below the senior permission, and allows it for a senior', async () => {
    const w = await world();
    const f = await w.file();
    const ban = decisionOf(f.target, 'upheld', { actions: [{ subject: f.target, kind: 'ban', durationMs: null, rule: 2 }] });
    expect(await viaDecideAs(w, f.id, ban, { role: 'moderator' })).toEqual({ status: 403, error: 'forbidden' });
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    expect(await viaDecideAs(w, f.id, ban, { role: 'senior' })).toMatchObject({ status: 200, replay: false });
  });

  it('a lowered ban_permanent permission is honoured (the permissions are the caller\'s)', async () => {
    const w = await world();
    const f = await w.file();
    const ban = decisionOf(f.target, 'upheld', { actions: [{ subject: f.target, kind: 'ban', durationMs: null, rule: 2 }] });
    const lowered = resolvePermissions({ 'sanctions.apply.ban_permanent': 'moderator' });
    expect(await viaDecideAs(w, f.id, ban, { role: 'moderator', permissions: lowered })).toMatchObject({ status: 200 });
  });

  it('refuses an acting decision below sanctions.apply, and a decision below reports.decide, before reading anything', async () => {
    const w = await world();
    const f = await w.file();
    const strict = resolvePermissions({ 'sanctions.apply': 'senior' });
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { permissions: strict })).toEqual({ status: 403, error: 'forbidden' });
    // a dismissal needs no sanctions.apply
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'no_action'), { permissions: strict })).toMatchObject({ status: 200 });
    const g = await w.file();
    const nobody = resolvePermissions({ 'reports.decide': 'owner' });
    expect(await viaDecideAs(w, g.id, decisionOf(g.target, 'no_action'), { permissions: nobody })).toEqual({ status: 403, error: 'forbidden' });
    // 403 comes before 404: an unauthorised caller learns nothing about the report
    expect(await viaDecideAs(w, 'no-such-report', decisionOf('s_x', 'no_action'), { permissions: nobody })).toEqual({ status: 403, error: 'forbidden' });
  });

  it('a decision whose length is not offered is refused when customDuration is off, and allowed when it is on or the length is offered', async () => {
    const off = await world({ overrides: { customDuration: false } });
    const f = await off.file();
    const offered = off.cw.profile.durations[0];
    expect(offered).toBeDefined();
    const odd = decisionOf(f.target, 'upheld', { actions: [{ subject: f.target, kind: 'chat', durationMs: 12_345_000, rule: 2 }] });
    expect(await viaDecideAs(off, f.id, odd)).toEqual({ status: 400, error: 'duration_not_offered' });
    expect(off.cw.reports.get(f.id)?.status).toBe('open');
    const fine = decisionOf(f.target, 'upheld', { actions: [{ subject: f.target, kind: 'chat', durationMs: offered as number, rule: 2 }] });
    expect(await viaDecideAs(off, f.id, fine)).toMatchObject({ status: 200 });

    const on = await world();
    const g = await on.file();
    expect(await viaDecideAs(on, g.id, decisionOf(g.target, 'upheld', { actions: [{ subject: g.target, kind: 'chat', durationMs: 12_345_000, rule: 2 }] }))).toMatchObject({ status: 200 });
  });

  it('the duration check applies only to an open report: a replay or an already_decided is answered as such whatever the rule says today', async () => {
    const w = await world({ overrides: { customDuration: false } });
    const f = await w.file();
    const offered = w.cw.profile.durations[0] as number;
    const body = decisionOf(f.target, 'upheld', { actions: [{ subject: f.target, kind: 'chat', durationMs: offered, rule: 2 }] });
    await viaDecideAs(w, f.id, body);
    const odd = decisionOf(f.target, 'upheld', { actions: [{ subject: f.target, kind: 'chat', durationMs: 12_345_000, rule: 2 }] });
    expect(await viaDecideAs(w, f.id, odd)).toEqual({ status: 409, error: 'already_decided' });
  });
});

describe('decideAs source', () => {
  it('defaults to moderator, as the route does', async () => {
    const w = await world();
    const f = await w.file();
    await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'));
    expect(w.cw.sanctions.forPerson(f.target).map((s) => [s.source, s.automated])).toEqual([['moderator', false]]);
  });

  it('with source coop writes the sanction row with source coop and automated false', async () => {
    const w = await world();
    const f = await w.file();
    const out = await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { source: 'coop', claims: 'ignore', actor: 'coop' });
    expect(out).toMatchObject({ status: 200, replay: false });
    const [row] = w.cw.sanctions.forPerson(f.target);
    expect(row).toMatchObject({ source: 'coop', automated: false, actor: 'coop' });
  });

  it.each(['api', 'auto_filter'] as const)('passes source %s through to the sanction row', async (source) => {
    const w = await world();
    const f = await w.file();
    await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { source, claims: 'ignore' });
    expect(w.cw.sanctions.forPerson(f.target)[0]?.source).toBe(source);
  });

  // `ai` is the kit's own AI actor's (design 6.1): decideAs cannot be handed it, and nothing is written, not the decision and not a sanction.
  it.each(['ai', 'AI', ' ai', 'ai '])('refuses the internal source %j: a plain bad request, with the report still open and no sanction', async (source) => {
    const w = await world();
    const f = await w.file();
    const out = await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { source: source as never, claims: 'ignore' });
    expect(out).toMatchObject({ status: 400 });
    expect(w.cw.sanctions.forPerson(f.target)).toEqual([]);
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
  });

  it('the actor, role and source are the caller\'s: a body cannot change them', async () => {
    const w = await world();
    const f = await w.file();
    const body = { ...decisionOf(f.target, 'upheld'), actor: 'mallory', source: 'api', role: 'owner' };
    await viaDecideAs(w, f.id, body, { actor: 'ann', source: 'coop' });
    expect(w.cw.sanctions.forPerson(f.target)[0]).toMatchObject({ actor: 'ann', source: 'coop' });
  });
});

describe('decideAs is exported and not a route', () => {
  it('has an unambiguous error class for every refusal it throws (an HttpError with a fixed code)', async () => {
    const w = await world();
    const f = await w.file();
    const codes = new Set<ErrorCode>();
    const attempt = async (over: Partial<DecideAsInput>, body: Record<string, unknown>, id = f.id): Promise<void> => {
      try {
        await decideAs(w.cw, asInput(w, id, body, over));
      } catch (err) {
        if (err instanceof HttpError) codes.add(err.code);
        else throw err;
      }
    };
    await attempt({}, decisionOf('s_nobody', 'upheld'));
    await attempt({}, decisionOf(f.target, 'upheld'), 'no-such-report');
    await attempt({ permissions: resolvePermissions({ 'reports.decide': 'owner' }) }, decisionOf(f.target, 'no_action'));
    expect([...codes].sort()).toEqual(['forbidden', 'invalid_request', 'not_found']);
    expect(NOW).toBeGreaterThan(0);
  });
});

describe('decideAs and the takeover hook (K5a review 1, 3, 6)', () => {
  it('takeOver without an onTakeOver is refused before anything is read or written, for every role', async () => {
    const w = await world();
    const f = await w.file();
    w.cw.cases.claim(f.target, 'ann');
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const input = asInput(w, f.id, decisionOf(f.target, 'upheld'), { actor: 'sam', role, takeOver: true } as Partial<DecideAsInput>);
      await expect(decideAs(w.cw, input)).rejects.toThrow(TypeError);
    }
    // a takeOver nobody could use (nobody holds the case) is the same programming error
    const g = await w.file();
    await expect(decideAs(w.cw, asInput(w, g.id, decisionOf(g.target, 'no_action'), { actor: 'sam', role: 'senior', takeOver: true } as Partial<DecideAsInput>))).rejects.toThrow(TypeError);
    expect(w.cw.cases.holder(f.target)?.by).toBe('ann');
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    expect(w.cw.reports.get(g.id)?.status).toBe('open');
  });

  it('the refusal never names the actor, the person or the report', async () => {
    const w = await world();
    const f = await w.file();
    let message = '';
    try {
      await decideAs(w.cw, asInput(w, f.id, decisionOf(f.target, 'no_action'), { actor: 'sam-secret', role: 'senior', takeOver: true } as Partial<DecideAsInput>));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    for (const s of ['sam-secret', f.target, f.id]) expect(message).not.toContain(s);
  });

  it('takeOver with a hook still works for a senior, and a caller-supplied canOverride is ignored (the role decides)', async () => {
    const w = await world();
    const f = await w.file();
    w.cw.cases.claim(f.target, 'ann');
    const forged = { actor: 'bea', role: 'moderator', takeOver: true, onTakeOver: () => undefined, canOverride: true } as unknown as Partial<DecideAsInput>;
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), forged)).toEqual({ status: 409, error: 'claimed' });
    expect(w.cw.cases.holder(f.target)?.by).toBe('ann');
    const hook = vi.fn();
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { actor: 'sam', role: 'senior', takeOver: true, onTakeOver: hook })).toMatchObject({ status: 200 });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('canOverride follows the effective permission table: lowering claims.override lets a moderator take over, raising it stops a senior', async () => {
    const w = await world();
    const f = await w.file();
    w.cw.cases.claim(f.target, 'ann');
    const hook = vi.fn();
    const raised = resolvePermissions({ 'claims.override': 'owner' });
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { actor: 'sam', role: 'senior', takeOver: true, onTakeOver: hook, permissions: raised })).toEqual({ status: 409, error: 'claimed' });
    expect(hook).not.toHaveBeenCalled();
    const lowered = resolvePermissions({ 'claims.override': 'moderator' });
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'upheld'), { actor: 'bea', role: 'moderator', takeOver: true, onTakeOver: hook, permissions: lowered })).toMatchObject({ status: 200 });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('claims ignore does not end any claim (releaseWhenDone is not called)', async () => {
    const w = await world();
    const f = await w.file();
    const spy = vi.spyOn(w.cw.cases, 'releaseWhenDone');
    expect(await viaDecideAs(w, f.id, decisionOf(f.target, 'no_action'), { actor: 'coop:ops', claims: 'ignore' })).toMatchObject({ status: 200, replay: false });
    expect(spy).not.toHaveBeenCalled();
    const g = await w.file();
    expect(await viaDecideAs(w, g.id, decisionOf(g.target, 'no_action'), { actor: 'ann' })).toMatchObject({ status: 200 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
