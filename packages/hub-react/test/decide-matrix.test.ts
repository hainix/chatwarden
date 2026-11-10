// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HubError } from '../src/client.js';
import { MAX_ACTIONS, addAction, emptyForm, newDraft, presets, choiceKey, toInput, validate } from '../src/decision.js';
import type { DecisionForm, Draft, UiVerdict, ValidationContext } from '../src/decision.js';
import { peopleOfReport } from '../src/excerpt.js';
import type { Role } from '../src/types.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The form's checks against the server's, case by case. For every combination the server accepts or refuses, the form must
// agree: it lets through exactly what the server takes, and stops everything the server refuses. Each case files a fresh
// report, sends the form's own body to the real `POST /reports/:id/decide` and compares.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const MANY: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  ...Array.from({ length: 7 }, (_, i): RichLine => ({ who: 'target', text: `target line ${i + 1}` })),
];

interface Case {
  w: HubWorld;
  id: string;
  ctx: ValidationContext;
  target: string;
  reporter: string;
  other: string;
  lines: Record<'target' | 'reporter' | 'other', string[]>;
  rule: number;
}

let n = 0;
async function setup(w: HubWorld, role: Role): Promise<Case> {
  const f = await w.fileRich({ lines: TALK, reporter: `Rep${++n}`, target: `Tgt${n}`, bystander: `By${n}`, room: `m-${n}` });
  const detail = await w.client.getReport(f.id);
  const me = await w.client.me();
  const policy = await w.client.policy();
  const people = peopleOfReport(detail.report);
  const ctx: ValidationContext = {
    target: detail.report.targetPerson,
    people: people.map((p) => p.ref),
    rules: policy.rules.filter((r) => r.retired !== true).map((r) => r.number),
    canApply: me.can['sanctions.apply'],
    canPermanent: me.can['sanctions.apply.ban_permanent'],
    ownLineIds: detail.report.ownLineIds,
  };
  expect(me.role).toBe(role);
  return {
    w,
    id: f.id,
    ctx,
    target: f.person,
    reporter: f.reporter,
    other: f.bystander as string,
    lines: {
      target: detail.report.ownLineIds[f.person] ?? [],
      reporter: detail.report.ownLineIds[f.reporter] ?? [],
      other: detail.report.ownLineIds[f.bystander as string] ?? [],
    },
    rule: 2,
  };
}

type ServerRefusal = 'invalid_request' | 'forbidden' | 'invalid_sanction' | 'invalid_excerpt';

/** What the server says to the form's body: 'ok', 'replay', or the error code. */
async function serverSays(c: Case, form: DecisionForm): Promise<string> {
  try {
    const res = await c.w.client.decide(c.id, toInput(form));
    return res.replay ? 'replay' : 'ok';
  } catch (e) {
    if (e instanceof HubError) return e.code;
    throw e;
  }
}

const draft = (c: Case, over: Partial<Draft>): Draft => ({ ...newDraft(`u${++n}`, c.target, c.rule), what: 'warning:null', ...over });
const form = (verdict: UiVerdict, actions: Draft[], over: Partial<DecisionForm> = {}): DecisionForm => ({
  ...emptyForm(),
  verdict,
  reason: 'A reason.',
  evidence: verdict === 'bad_faith' ? 'Some evidence.' : '',
  actions,
  ...over,
});

/**
 * The form and the server agree: the form passes it exactly when the server takes it. A refused case names the error code the
 * server must answer with, so a case refused for some other reason than the one under test fails here.
 */
async function agree(c: Case, f: DecisionForm, expectServer: 'ok' | ServerRefusal) {
  const problems = validate(f, c.ctx);
  const says = await serverSays(c, f);
  if (expectServer === 'ok') {
    expect(problems.count, `form should pass: ${JSON.stringify(problems)}`).toBe(0);
    expect(says).toBe('ok');
  } else {
    expect(problems.count, 'form should stop it').toBeGreaterThan(0);
    expect(says, 'server should refuse it with exactly this code').toBe(expectServer);
  }
}

const w = await hubWorld({ role: 'moderator' });
const sw = await hubWorld({ role: 'senior' });

describe('every verdict x person x action, as a moderator', () => {
  const who = ['target', 'reporter', 'other'] as const;
  const choices = presets().filter((p) => choiceKey(p) !== 'ban:null');
  const verdicts: UiVerdict[] = ['fair', 'not_a_problem', 'bad_faith'];

  for (const verdict of verdicts) {
    for (const person of who) {
      for (const choice of choices) {
        const key = choiceKey(choice);
        // The server refuses any action on the reported person unless the report is fair.
        const accepted = verdict === 'fair' || person !== 'target';
        it(`${verdict}, ${person}, ${key}: ${accepted ? 'accepted' : 'refused'}`, async () => {
          const c = await setup(w, 'moderator');
          const ref = person === 'target' ? c.target : person === 'reporter' ? c.reporter : c.other;
          await agree(c, form(verdict, [draft(c, { person: ref, what: key })]), accepted ? 'ok' : 'invalid_request');
        });
      }
    }
  }
});

describe('the form and the server agree on the rest', () => {
  it('permanent ban: refused for a moderator, accepted for a senior', async () => {
    const m = await setup(w, 'moderator');
    await agree(m, form('fair', [draft(m, { what: 'ban:null' })]), 'forbidden');
    const s = await setup(sw, 'senior');
    await agree(s, form('fair', [draft(s, { what: 'ban:null' })]), 'ok');
  });

  it('a custom permanent length: only a permanent ban needs a senior, and the form says the same as the server', async () => {
    for (const customKind of ['chat', 'area'] as const) {
      const m = await setup(w, 'moderator');
      await agree(m, form('fair', [draft(m, { what: 'other', customKind, customDuration: 'permanent' })]), 'ok');
    }
    const mb = await setup(w, 'moderator');
    await agree(mb, form('fair', [draft(mb, { what: 'other', customKind: 'ban', customDuration: 'permanent' })]), 'forbidden');
    for (const customKind of ['chat', 'area', 'ban'] as const) {
      const sc = await setup(sw, 'senior');
      await agree(sc, form('fair', [draft(sc, { what: 'other', customKind, customDuration: 'permanent' })]), 'ok');
    }
  });

  it('a one-off length from a profile ladder (3 days, 90 minutes, 365 days) is accepted; 366 days is refused by both', async () => {
    for (const durationMs of [90 * 60_000, 3 * 86_400_000, 365 * 86_400_000]) {
      const c = await setup(w, 'moderator');
      await agree(c, form('fair', [draft(c, { what: `chat:${durationMs}` })]), 'ok');
    }
    const c = await setup(w, 'moderator');
    expect(validate(form('fair', [draft(c, { what: `chat:${366 * 86_400_000}` })]), c.ctx).count).toBeGreaterThan(0);
  });

  it.each(['1h', '24h', '7d', '30d'] as const)('a custom %s length for chat, area and ban is accepted', async (customDuration) => {
    for (const customKind of ['chat', 'area', 'ban'] as const) {
      const c = await setup(w, 'moderator');
      await agree(c, form('fair', [draft(c, { what: 'other', customKind, customDuration })]), 'ok');
    }
  });

  it('a warning and a note are accepted whatever length the form last held', async () => {
    for (const customKind of ['warning', 'note'] as const) {
      const c = await setup(w, 'moderator');
      await agree(c, form('fair', [draft(c, { what: 'other', customKind, customDuration: '7d' })]), 'ok');
    }
  });

  it('noted: only notes, at least one', async () => {
    const c = await setup(w, 'moderator');
    await agree(c, form('fair', [draft(c, { what: 'note:null' })]), 'ok');
    const d = await setup(w, 'moderator');
    await agree(d, form('fair', [draft(d, { what: 'note:null' }), draft(d, { what: 'warning:null', person: d.other })]), 'ok');
    const e = await setup(w, 'moderator');
    await agree(e, form('fair', []), 'ok');
  });

  it('a rule: numbered and active is accepted; unknown is refused; retired is refused', async () => {
    const r = await hubWorld({ role: 'moderator', retire: [3] });
    const c = await setup(r, 'moderator');
    await agree(c, form('fair', [draft(c, { rule: '4' })]), 'ok');
    const d = await setup(r, 'moderator');
    await agree(d, form('fair', [draft(d, { rule: '3' })]), 'invalid_request');
    const e = await setup(r, 'moderator');
    await agree(e, form('fair', [draft(e, { rule: '99' })]), 'invalid_request');
    const f = await setup(r, 'moderator');
    await agree(f, form('fair', [draft(f, { rule: '' })]), 'invalid_request');
  });

  it('"no rule covers this": needs a gap note of 1 to 500 characters', async () => {
    for (const [gapNote, ok] of [['', false], ['   ', false], ['n', true], ['x'.repeat(500), true], ['x'.repeat(501), false]] as const) {
      const c = await setup(w, 'moderator');
      await agree(c, form('fair', [draft(c, { rule: 'uncovered', gapNote })]), ok ? 'ok' : 'invalid_request');
    }
  });

  it('a person the report does not name is refused', async () => {
    const c = await setup(w, 'moderator');
    await agree(c, form('fair', [draft(c, { person: 'stranger-0000000000' })]), 'invalid_request');
  });

  it('the same kind twice for one person is refused; different kinds and different people are accepted', async () => {
    const a = await setup(w, 'moderator');
    await agree(a, form('fair', [draft(a, { what: 'warning:null' }), draft(a, { what: 'warning:null' })]), 'invalid_request');
    const b = await setup(w, 'moderator');
    await agree(b, form('fair', [draft(b, { what: 'warning:null' }), draft(b, { what: 'chat:86400000' })]), 'ok');
    const c = await setup(w, 'moderator');
    await agree(c, form('fair', [draft(c, { what: 'warning:null' }), draft(c, { what: 'warning:null', person: c.reporter })]), 'ok');
  });

  it('lines: up to five of the person\'s own; six, or someone else\'s, are refused', async () => {
    const a = await setup(w, 'moderator');
    await agree(a, form('fair', [draft(a, { lineIds: a.lines.target })]), 'ok');
    const b = await setup(w, 'moderator');
    await agree(b, form('fair', [draft(b, { lineIds: [...b.lines.target, ...b.lines.reporter] })]), 'invalid_request');
    const c = await setup(w, 'moderator');
    await agree(c, form('fair', [draft(c, { lineIds: c.lines.reporter })]), 'invalid_request');
    const d = await setup(w, 'moderator');
    await agree(d, form('fair', [draft(d, { lineIds: ['nope'] })]), 'invalid_request');
  });

  it('the five-line limit against the route: five of their own lines are accepted, six are refused (a person with seven)', async () => {
    const many = await hubWorld({ role: 'moderator' });
    const mk = async (): Promise<Case> => {
      const f = await many.fileRich({ lines: MANY, reporter: `Rep${++n}`, target: `Tgt${n}`, room: `many-${n}` });
      const detail = await many.client.getReport(f.id);
      const me = await many.client.me();
      const policy = await many.client.policy();
      const people = peopleOfReport(detail.report);
      const ctx: ValidationContext = {
        target: detail.report.targetPerson,
        people: people.map((p) => p.ref),
        rules: policy.rules.filter((r) => r.retired !== true).map((r) => r.number),
        canApply: me.can['sanctions.apply'],
        canPermanent: me.can['sanctions.apply.ban_permanent'],
        ownLineIds: detail.report.ownLineIds,
      };
      return { w: many, id: f.id, ctx, target: f.person, reporter: f.reporter, other: f.person, lines: { target: detail.report.ownLineIds[f.person] ?? [], reporter: [], other: [] }, rule: 2 };
    };
    const five = await mk();
    expect(five.lines.target).toHaveLength(7);
    await agree(five, form('fair', [draft(five, { lineIds: five.lines.target.slice(0, 5) })]), 'ok');
    const six = await mk();
    await agree(six, form('fair', [draft(six, { lineIds: six.lines.target.slice(0, 6) })]), 'invalid_request');
    const seven = await mk();
    await agree(seven, form('fair', [draft(seven, { lineIds: seven.lines.target })]), 'invalid_request');
  });

  it('a note refuses nothing about lines it does not send: seven ticked on a note is accepted', async () => {
    const many = await hubWorld({ role: 'moderator' });
    const f = await many.fileRich({ lines: MANY, reporter: `Rep${++n}`, target: `Tgt${n}`, room: `many-n-${n}` });
    const detail = await many.client.getReport(f.id);
    const c: Case = { w: many, id: f.id, ctx: { target: f.person, people: [f.person, f.reporter], rules: [1, 2, 3, 4, 5, 6, 7], canApply: true, canPermanent: false, ownLineIds: detail.report.ownLineIds }, target: f.person, reporter: f.reporter, other: f.person, lines: { target: detail.report.ownLineIds[f.person] ?? [], reporter: [], other: [] }, rule: 2 };
    await agree(c, form('fair', [draft(c, { what: 'note:null', lineIds: c.lines.target })]), 'ok');
  });

  it('lines on a note are not sent, so a note is accepted whatever was ticked before', async () => {
    const c = await setup(w, 'moderator');
    await agree(c, form('fair', [draft(c, { what: 'note:null', lineIds: c.lines.reporter })]), 'ok');
  });

  it('the reason: 1 to 500 characters after trimming', async () => {
    for (const [reason, ok] of [['', false], ['   ', false], ['r', true], [` ${'r'.repeat(500)} `, true], ['r'.repeat(501), false]] as const) {
      const c = await setup(w, 'moderator');
      await agree(c, form('not_a_problem', [], { reason }), ok ? 'ok' : 'invalid_request');
    }
  });

  it('bad-faith evidence: 1 to 500 characters after trimming', async () => {
    for (const [evidence, ok] of [['', false], ['  ', false], ['e', true], [` ${'e'.repeat(500)} `, true], ['e'.repeat(501), false]] as const) {
      const c = await setup(w, 'moderator');
      await agree(c, form('bad_faith', [], { evidence }), ok ? 'ok' : 'invalid_request');
    }
  });

  it('evidence is never sent for the other verdicts, so left-over text cannot make the server refuse', async () => {
    for (const verdict of ['fair', 'not_a_problem'] as const) {
      const c = await setup(w, 'moderator');
      await agree(c, form(verdict, [], { evidence: 'left over from before' }), 'ok');
    }
  });

  it('a big decision: every kind for all three people (15 actions) is accepted', async () => {
    const c = await setup(sw, 'senior');
    const actions: Draft[] = [];
    for (const person of [c.target, c.reporter, c.other]) {
      actions.push(draft(c, { person, what: 'warning:null' }), draft(c, { person, what: 'chat:86400000' }), draft(c, { person, what: 'ban:604800000' }), draft(c, { person, what: 'note:null' }));
      actions.push(draft(c, { person, what: 'other', customKind: 'area', customDuration: '7d' }));
    }
    expect(actions).toHaveLength(15);
    await agree(c, form('fair', actions), 'ok');
  });

  it('more than 20 actions are refused by both (the 21st is a repeat, but the count alone is enough)', async () => {
    const c = await setup(sw, 'senior');
    const actions = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => draft(c, { person: [c.target, c.reporter, c.other][i % 3] as string, what: 'note:null' }));
    expect(validate(form('fair', actions), c.ctx).list?.key).toBe('hub.decide.error.tooMany');
    expect(await serverSays(c, form('fair', actions))).toBe('invalid_request');
    // And exactly 20 is not too many for the count: the form only objects to the repeats.
    expect(validate(form('fair', actions.slice(0, MAX_ACTIONS)), c.ctx).list).toBeUndefined();
  });

  it('a role that cannot apply sanctions: any action is refused (403), none is fine', async () => {
    const nw = await hubWorld({ role: 'moderator', permissions: { 'sanctions.apply': 'owner' } });
    const a = await setup(nw, 'moderator');
    await agree(a, form('fair', [draft(a, {})]), 'forbidden');
    const b = await setup(nw, 'moderator');
    await agree(b, form('not_a_problem', []), 'ok');
  });

  it('a role that cannot decide: the server says 403 (the panel offers no form at all)', async () => {
    const nw = await hubWorld({ role: 'moderator', permissions: { 'reports.decide': 'owner' } });
    const a = await setup(nw, 'moderator');
    expect(await serverSays(a, form('not_a_problem', []))).toBe('forbidden');
  });

  it('addAction never starts an action the server would refuse for its person', async () => {
    for (const verdict of ['fair', 'not_a_problem', 'bad_faith'] as const) {
      const c = await setup(w, 'moderator');
      const added = addAction(form(verdict, []), c.ctx, 1, 'z1');
      const d: Draft = { ...(added.actions[0] as Draft), what: 'warning:null', rule: '2' };
      await agree(c, { ...added, actions: [d] }, 'ok');
    }
  });
});
