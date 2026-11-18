import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { NOTICE_WORDS, noticeView } from '../src/noticeCopy.js';
import type { DecisionInput } from '../src/decide.js';
import { appealsKit, HOUR } from './appealsWorld.js';
import { world } from './reportingWorld.js';

// Evidence kind on a decision (0.2.2, audit P4, P1, P2, P11, S10): the decision's kind is the report reason's kind, falling back to the rule. The server
// refuses a chat line for play and name evidence, and the player's notice carries the kind so every surface can word it. The Moxgate repro is the first test.

const view = (n: Parameters<typeof noticeView>[0]) => noticeView(n, { words: NOTICE_WORDS, locale: 'en', now: () => 0 });

/** A table with a few lines from the target, a report under `reason`, and the target's line ids. */
async function filed(reason: string | undefined, over: Record<string, unknown> = {}, store = new MemoryStore()) {
  const w = await world(over, store);
  const t = w.table({ target: 'key-target-ev' });
  const who = { clientKey: 'key-target-ev' };
  for (const text of ['Hello', 'good game', 'nice one']) {
    w.cw.chat.accept(t.room, 'p2', text);
    w.clock.t += 1000;
  }
  const res = await w.submit(t.room, reason === undefined ? {} : { reason });
  if (!res.ok) throw new Error(`refused ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  if (report === null) throw new Error('no report');
  const own = report.ownLineIds[report.targetPerson] ?? [];
  const decide = (input: Partial<DecisionInput> & { lineIds?: string[]; rule?: number; kind?: 'warning' | 'chat' | 'area' | 'ban' }) =>
    w.cw.decide({
      reportId: res.reportId,
      verdict: 'upheld',
      actor: 'mod_ann',
      reason: 'private reason',
      ...(input.evidenceKind === undefined ? {} : { evidenceKind: input.evidenceKind }),
      actions: [
        {
          subject: report.targetPerson,
          kind: input.kind ?? 'warning',
          durationMs: input.kind === undefined || input.kind === 'warning' ? null : 3_600_000,
          rule: input.rule ?? 6,
          ...(input.lineIds === undefined ? {} : { lineIds: input.lineIds }),
        },
      ],
    } as DecisionInput);
  const pending = () => w.cw.notices.pending(who);
  return { w, report, own, decide, pending, res, who };
}

describe('the Moxgate repro: an AFK report decided with a warning', () => {
  it('the player gets a warning that names no message and shows no line, and the notice says it is about play', async () => {
    const f = await filed('afk');
    expect(f.own.length).toBe(3);
    const out = await f.decide({});
    expect(out.ok).toBe(true);
    const [n] = f.pending();
    expect(n?.kind).toBe('warning');
    expect(n?.excerpt).toEqual([]);
    expect(n?.evidence).toBe('play');
    const v = view(n as never);
    expect(v.body).not.toMatch(/wrote|message|chat/i);
    expect(v.linesLabel).toBeNull();
    expect(v.lines).toEqual([]);
  });
});

describe('the notice carries the decision kind', () => {
  it.each([
    ['harassment', 2, 'chat'],
    ['hate', 1, 'chat'],
    ['cheating', 5, 'play'],
    ['griefing', 6, 'play'],
    ['afk', 6, 'play'],
    ['name', 7, 'name'],
  ] as const)('a %s report decided under CR %i makes a notice of kind %s', async (reason, rule, kind) => {
    const f = await filed(reason);
    expect((await f.decide({ rule })).ok).toBe(true);
    expect(f.pending()[0]?.evidence).toBe(kind);
    // "My record" reads the same.
    expect(f.w.cw.notices.record(f.who)[0]?.evidence).toBe(kind);
  });

  it('a restriction and a ban carry it too', async () => {
    for (const kind of ['chat', 'area', 'ban'] as const) {
      const f = await filed('afk');
      expect((await f.decide({ kind })).ok).toBe(true);
      expect(f.pending()[0]).toMatchObject({ kind, evidence: 'play' });
    }
  });

  it('a custom reason with no kind is neutral: no kind on the notice (ruling 1)', async () => {
    const f = await filed('zorbak', { overrides: { reporting: { reasons: [{ id: 'zorbak', label: 'Zorbak', rules: [2] }, { id: 'other', label: 'Something else' }] } } });
    expect((await f.decide({ rule: 2 })).ok).toBe(true);
    const n = f.pending()[0];
    expect(n?.evidence).toBeUndefined();
    expect(Object.hasOwn(n as object, 'evidence')).toBe(false);
  });

  it('a custom reason that says play is play', async () => {
    const f = await filed('zorbak', { overrides: { reporting: { reasons: [{ id: 'zorbak', label: 'Zorbak', evidence: 'play' }, { id: 'other', label: 'Something else' }] } } });
    expect((await f.decide({ rule: 2 })).ok).toBe(true);
    expect(f.pending()[0]?.evidence).toBe('play');
  });

  it('no reason: the rule is the fallback (CR 6 is play, CR 2 is neutral)', async () => {
    const play = await filed(undefined);
    expect((await play.decide({ rule: 6 })).ok).toBe(true);
    expect(play.pending()[0]?.evidence).toBe('play');
    const neutral = await filed(undefined);
    expect((await neutral.decide({ rule: 2 })).ok).toBe(true);
    expect(neutral.pending()[0]?.evidence).toBeUndefined();
  });

  it('the reason wins over the rule: a chat reason under CR 6 stays chat', async () => {
    const f = await filed('harassment');
    expect((await f.decide({ rule: 6 })).ok).toBe(true);
    expect(f.pending()[0]?.evidence).toBe('chat');
  });
});

describe('the server takes chat lines for play and name (P4, review R2 M1)', () => {
  it.each([
    ['afk', 6],
    ['griefing', 6],
    ['cheating', 5],
    ['name', 7],
  ] as const)('a %s report takes lineIds: stored on the notice, the kind unchanged', async (reason, rule) => {
    const f = await filed(reason);
    expect((await f.decide({ rule, lineIds: [f.own[0] as string] })).ok).toBe(true);
    const n = f.pending()[0];
    expect(n?.excerpt).toHaveLength(1);
    expect(n?.evidence).toBe(reason === 'name' ? 'name' : 'play');
  });

  it('an empty lineIds list is not a refusal', async () => {
    const f = await filed('afk');
    expect((await f.decide({ lineIds: [] })).ok).toBe(true);
  });

  it('the rule is a fallback for the kind too: no reason and CR 7 takes a line and stays a name', async () => {
    const f = await filed(undefined);
    expect((await f.decide({ rule: 7, lineIds: [f.own[0] as string] })).ok).toBe(true);
    expect(f.pending()[0]?.evidence).toBe('name');
  });

  it('chat evidence still takes up to five of the target own lines, as before', async () => {
    const f = await filed('harassment');
    expect((await f.decide({ rule: 2, lineIds: f.own.slice(0, 2) })).ok).toBe(true);
    const n = f.pending()[0];
    expect(n?.excerpt).toHaveLength(2);
    expect(n?.evidence).toBe('chat');
    expect(view(n as never).linesLabel).toBe('Your messages that led to this');
  });

  it('neutral evidence may take a line (a moderator can still add one)', async () => {
    const f = await filed(undefined);
    expect((await f.decide({ rule: 2, lineIds: [f.own[0] as string] })).ok).toBe(true);
    const n = f.pending()[0];
    expect(n?.excerpt).toHaveLength(1);
    expect(view(n as never).linesLabel).toBe('What led to this');
  });
});

describe('a decision may override the kind', () => {
  it('chat over an AFK report: a line is accepted and the notice says chat', async () => {
    const f = await filed('afk');
    expect((await f.decide({ evidenceKind: 'chat', lineIds: [f.own[0] as string] })).ok).toBe(true);
    expect(f.pending()[0]).toMatchObject({ evidence: 'chat' });
  });
  it('name over a chat report: the line is taken and the kind is name', async () => {
    const f = await filed('harassment');
    expect((await f.decide({ rule: 2, evidenceKind: 'name', lineIds: [f.own[0] as string] })).ok).toBe(true);
    expect(f.pending()[0]).toMatchObject({ evidence: 'name' });
  });
  it('null clears the kind to neutral', async () => {
    const f = await filed('afk');
    expect((await f.decide({ evidenceKind: null as never })).ok).toBe(true);
    expect(f.pending()[0]?.evidence).toBeUndefined();
  });
  it.each(['gameplay', '', 3, {}])('a bad kind %j is refused', async (bad) => {
    const f = await filed('afk');
    expect(await f.decide({ evidenceKind: bad as never })).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('stored notices', () => {
  it('a notice stored without a kind (0.2.1) reads with none', async () => {
    const store = new MemoryStore();
    const f = await filed('harassment', {}, store);
    expect((await f.decide({ rule: 2 })).ok).toBe(true);
    const raw = store.rawNotices().find((r) => r.kind === 'warning');
    expect(raw?.evidence).toBe('chat');
    // Take the kind away, as an old row has it.
    const stored = store.loadNotice(raw?.id as string) as { evidence?: unknown } | null;
    expect(stored).not.toBeNull();
    delete (store as unknown as { notices: Array<{ id: string; evidence?: unknown }> }).notices.find((n) => n.id === raw?.id)?.evidence;
    expect(Object.hasOwn(f.pending()[0] as object, 'evidence')).toBe(false);
  });

  it('a report-outcome notice for the reporter has no kind', async () => {
    const f = await filed('afk');
    expect((await f.decide({})).ok).toBe(true);
    const n = f.w.cw.notices.pending({ clientKey: 'key-reporter' })[0];
    expect(n?.kind).toBe('report_outcome');
    expect(n?.evidence).toBeUndefined();
  });

  it('the replay of the same decision does not make a second notice', async () => {
    const f = await filed('afk');
    expect((await f.decide({})).ok).toBe(true);
    const again = await f.decide({});
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(f.pending().filter((n) => n.kind === 'warning')).toHaveLength(1);
  });
});

describe('an appeal that reduces a sanction keeps the kind', () => {
  it('the replacement notice is worded for the same evidence, and the appeal outcome message has none', async () => {
    const k = await appealsKit();
    const f = await k.file({ reason: 'afk' }, { target: 'key-afk-appeal' });
    const res = await k.cw.decide({
      reportId: f.id,
      verdict: 'upheld',
      actor: 'mod_ann',
      reason: 'private reason',
      actions: [{ subject: f.target, kind: 'chat', durationMs: 6 * HOUR, rule: 6, lineIds: [] }],
    } as DecisionInput);
    if (!res.ok) throw new Error('refused');
    const who = { clientKey: 'key-afk-appeal' };
    const noticeId = res.groups[0]?.noticeId as string;
    expect(k.store.loadNotice(noticeId)?.evidence).toBe('play');
    const filedAppeal = k.cw.appeals.file(who, { noticeId, statement: 'I lost connection.' });
    if (!filedAppeal.ok) throw new Error('appeal refused');
    const out = await k.cw.appeals.decide({ appealId: filedAppeal.appeal.id, outcome: 'reduce', actor: 'senior_bea', reason: 'lighter fits', to: { kind: 'warning', durationMs: null } });
    expect(out).toMatchObject({ ok: true, status: 'reduced' });
    const pending = k.cw.notices.pending(who);
    expect(pending.find((n) => n.kind === 'warning')?.evidence).toBe('play');
    expect(pending.find((n) => n.kind === 'appeal_reduced')?.evidence).toBeUndefined();
  });
});
