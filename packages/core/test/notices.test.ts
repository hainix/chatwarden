import { describe, expect, it } from 'vitest';
import { maskSpans } from '../src/mask.js';
import { ExcerptError, NoticeService, ownLines } from '../src/notices.js';
import type { PlayerNotice } from '../src/notices.js';
import { CommunityRules, STARTER_RULES } from '../src/rules.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Logger, Matcher, ReportExcerptLine, StoredReport, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);

/** Synthetic term only. Finds every `zorbak` / `vlemmo` on the original text. */
const fakeMatcher: Matcher = {
  match: (t) => (/zorbak|vlemmo/i.test(t) ? { termId: 'syn' } : null),
  spans: (t) => {
    const out: Array<{ start: number; end: number; termId: string }> = [];
    for (const m of t.matchAll(/zorbak|vlemmo/gi)) out.push({ start: m.index, end: m.index + m[0].length, termId: 'syn' });
    return out;
  },
};
const noSpansMatcher: Matcher = { match: fakeMatcher.match };

const rules = new CommunityRules(STARTER_RULES);

function setup(opts: { matcher?: Matcher; notify?: (s: SubjectId, e: { type: 'notice_pending'; count: number }) => unknown; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const pushed: Array<{ subject: SubjectId; count: number }> = [];
  const notify =
    opts.notify ?? ((subject: SubjectId, e: { type: 'notice_pending'; count: number }) => void pushed.push({ subject, count: e.count }));
  const svc = new NoticeService({
    store,
    subjects,
    rules,
    clock,
    matcher: 'matcher' in opts ? opts.matcher : fakeMatcher,
    logger,
    notify: notify as never,
  });
  const person = (key: string, account: string | null = null): SubjectId => {
    const s = subjects.resolve({ clientKey: key, accountId: account, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  let g = 0;
  const group = (subject: SubjectId, over: Partial<Parameters<NoticeService['createForSanction']>[0]> = {}) => ({
    groupId: `grp${++g}`,
    refCode: `M-AB${g}CD`.slice(0, 7),
    kind: 'chat' as 'chat' | 'area' | 'ban' | 'warning',
    until: NOW + DAY,
    rule: 2 as number | 'uncovered' | null,
    subject,
    ...over,
  });
  return { store, clock, subjects, svc, logs, pushed, person, group };
}

const line = (over: Partial<ReportExcerptLine> = {}): ReportExcerptLine => ({
  lineId: 'L1',
  ts: Date.UTC(2027, 0, 14, 23, 59, 59),
  seatId: 'seat-secret',
  handle: 'HandleSecret',
  raw: 'hello there',
  delivered: 'hello there',
  blocked: false,
  audience: null,
  p: 0,
  ...over,
});

const report = (people: SubjectId[], excerpt: ReportExcerptLine[]): StoredReport => ({
  id: 'rep1',
  createdAt: NOW,
  roomId: 'ROOM-SECRET',
  tags: {},
  reporterSubject: 's_reporterreporterrep',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: people[0] ?? 's_none',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt,
  people,
  status: 'open',
});

const KEYS: Array<keyof PlayerNotice> = ['id', 'kind', 'rule', 'ruleLabel', 'until', 'refCode', 'excerpt', 'createdAt', 'mustAcknowledge'];

describe('PlayerNotice shape', () => {
  it('has exactly the documented keys for a sanction notice', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line()]);
    const [n] = t.svc.pending(a);
    expect(Object.keys(n ?? {}).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(n?.excerpt[0] ?? {}).sort()).toEqual(['day', 'text']);
  });

  it('carries the rule, its label, the end and the reference code', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { refCode: 'M-ABCDE', rule: 2, until: NOW + 5 * DAY }), []);
    const [n] = t.svc.pending(a);
    expect(n).toMatchObject({
      kind: 'chat',
      rule: 2,
      ruleLabel: rules.label(2),
      until: NOW + 5 * DAY,
      refCode: 'M-ABCDE',
      createdAt: NOW,
      mustAcknowledge: false,
      excerpt: [],
    });
  });

  it("'uncovered' round-trips as a rule and a label", () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { rule: 'uncovered' }), []);
    expect(t.svc.pending(a)[0]).toMatchObject({ rule: 'uncovered', ruleLabel: rules.label('uncovered') });
  });

  it('a null rule gives a null label', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { rule: null }), []);
    expect(t.svc.pending(a)[0]).toMatchObject({ rule: null, ruleLabel: null });
  });

  it('a permanent notice has until null', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { kind: 'ban', until: null }), []);
    expect(t.svc.pending(a)[0]?.until).toBeNull();
  });

  it('mustAcknowledge is true for a warning only', () => {
    const t = setup();
    const a = t.person('ka');
    for (const kind of ['warning', 'chat', 'area', 'ban'] as const) {
      t.svc.createForSanction(t.group(a, { kind, until: kind === 'warning' ? null : NOW + DAY }), []);
    }
    t.svc.createReportOutcome(a);
    const byKind = Object.fromEntries(t.svc.pending(a).map((n) => [n.kind, n.mustAcknowledge]));
    expect(byKind).toEqual({ warning: true, chat: false, area: false, ban: false, report_outcome: false });
  });

  it('a report outcome has no rule, reference code, end or excerpt', () => {
    const t = setup();
    const r = t.person('kr');
    t.svc.createReportOutcome(r);
    const [n] = t.svc.pending(r);
    expect(n).toMatchObject({ kind: 'report_outcome', rule: null, ruleLabel: null, refCode: null, until: null, excerpt: [], mustAcknowledge: false });
  });

  it('returned notices are copies: mutating one does not change the next read', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line()]);
    const first = t.svc.pending(a)[0];
    if (first === undefined) throw new Error('expected a notice');
    first.excerpt[0] = { text: 'changed', day: 'x' };
    first.excerpt.push({ text: 'more', day: 'y' });
    expect(t.svc.pending(a)[0]?.excerpt).toEqual([{ text: 'hello there', day: '2027-01-14' }]);
  });

  it('rejects an unknown kind', () => {
    const t = setup();
    const a = t.person('ka');
    expect(() => t.svc.createForSanction(t.group(a, { kind: 'report_outcome' as never }), [])).toThrow();
    expect(() => t.svc.createForSanction(t.group(a, { kind: 'nope' as never }), [])).toThrow();
    expect(t.svc.pending(a)).toEqual([]);
  });
});

describe('notice ids', () => {
  it('are random 16-byte base64url, never derived from the group or subject', () => {
    const t = setup();
    const a = t.person('ka');
    const ids = [t.svc.createForSanction(t.group(a, { groupId: 'same', refCode: 'M-SAMEE' }), []), t.svc.createForSanction(t.group(a, { groupId: 'same', refCode: 'M-SAMEE' }), [])];
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(id).not.toContain('same');
    }
    expect(t.svc.pending(a).map((n) => n.id).sort()).toEqual([...ids].sort());
  });
});

describe('no identifier in a PlayerNotice', () => {
  const scan = (value: unknown): void => {
    const text = JSON.stringify(value);
    expect(text).not.toMatch(/s_[A-Za-z0-9_-]{22}/);
    expect(text).not.toMatch(/[0-9a-f]{32}/i);
    expect(text).not.toMatch(/ROOM-SECRET|HandleSecret|seat-secret/);
  };

  it('a full notice with an excerpt, a record entry and an outcome carry none', () => {
    const t = setup();
    const a = t.person('ka');
    const r = t.person('kr');
    t.svc.createForSanction(t.group(a), [line(), line({ lineId: 'L2', raw: 'you zorbak', delivered: null, blocked: true })]);
    t.svc.createForSanction(t.group(a, { kind: 'warning', until: null }), []);
    t.svc.createReportOutcome(r);
    scan(t.svc.pending(a));
    scan(t.svc.record(a));
    scan(t.svc.pending(r));
  });

  it('positive control: the scan does fire on a leaky value', () => {
    const a = 's_' + 'A'.repeat(22);
    expect(() => scan({ x: a })).toThrow();
    expect(() => scan({ x: 'abcdef0123456789abcdef0123456789' })).toThrow();
    expect(() => scan({ x: 'ROOM-SECRET' })).toThrow();
    expect(() => scan({ x: 'HandleSecret' })).toThrow();
    expect(() => scan({ x: 'seat-secret' })).toThrow();
  });

  it('a stored subject id never shows even though the row is keyed by it', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line()]);
    expect(JSON.stringify(t.svc.pending(a))).not.toContain(a);
  });
});

describe('excerpt text and day', () => {
  it('formats the day as UTC YYYY-MM-DD from the line ts', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [
      line({ lineId: 'a', ts: Date.UTC(2027, 0, 14, 23, 59, 59, 999) }),
      line({ lineId: 'b', ts: Date.UTC(2027, 0, 15, 0, 0, 0, 0) }),
      line({ lineId: 'c', ts: Date.UTC(2026, 11, 31, 23, 0, 0) }),
      line({ lineId: 'd', ts: Date.UTC(2028, 1, 29, 5, 0, 0) }),
    ]);
    expect(t.svc.pending(a)[0]?.excerpt.map((l) => l.day)).toEqual(['2027-01-14', '2027-01-15', '2026-12-31', '2028-02-29']);
  });

  it('carries no time of day', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line()]);
    expect(JSON.stringify(t.svc.pending(a)[0]?.excerpt)).not.toMatch(/\d\d:\d\d/);
  });

  it('a clean line shows its delivered text', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'raw words', delivered: 'delivered words' })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('delivered words');
  });

  it('a clean line with starring shows the starred form, never the raw one', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'what the heck', delivered: 'what the h***' })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('what the h***');
  });

  it('a blocked line is masked by the matcher spans: no synthetic term remains', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [
      line({ lineId: 'a', raw: 'you zorbak and vlemmo', delivered: null, blocked: true }),
      line({ lineId: 'b', raw: 'ZORBAK', delivered: null, blocked: true }),
    ]);
    const texts = t.svc.pending(a)[0]?.excerpt.map((l) => l.text);
    expect(texts).toEqual(['you ****** and ******', '******']);
    for (const x of texts ?? []) expect(x).not.toMatch(/zorbak|vlemmo/i);
  });

  it('a blocked line is not given the delivered text even when one is present', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: 'you zorbak', blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('you ******');
  });

  it('a blocked line with no matcher is fully masked', () => {
    const t = setup({ matcher: undefined });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: null, blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('**********');
  });

  it('a blocked line with a matcher that has no spans is fully masked', () => {
    const t = setup({ matcher: noSpansMatcher });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: null, blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('**********');
  });

  it('a blocked line is fully masked when the matcher finds no span (the term was switched off since)', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you glarn', delivered: null, blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('*********');
  });

  it('a blocked line is fully masked when the matcher throws', () => {
    const t = setup({
      matcher: {
        match: () => null,
        spans: () => {
          throw new Error('boom');
        },
      },
    });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: null, blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('**********');
    expect(t.logs.map((l) => l.event)).toContain('notices.mask_failed');
    expect(JSON.stringify(t.logs)).not.toContain('zorbak');
  });

  it('a blocked line is fully masked when the matcher returns junk', () => {
    const t = setup({ matcher: { match: () => null, spans: (() => 'nope') as never } });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: null, blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe('**********');
  });

  it('a not-blocked line with no delivered text never falls back to raw', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: null, blocked: false })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).not.toMatch(/zorbak/);
  });

  it('keeps the masked text the same length as the original', () => {
    const t = setup();
    const a = t.person('ka');
    const raw = 'x zorbak y';
    t.svc.createForSanction(t.group(a), [line({ raw, delivered: null, blocked: true })]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe(maskSpans(raw, [{ start: 2, end: 8 }]));
  });

  it('allows five lines and refuses six', () => {
    const t = setup();
    const a = t.person('ka');
    const lines = (n: number) => Array.from({ length: n }, (_, i) => line({ lineId: `L${i}` }));
    t.svc.createForSanction(t.group(a), lines(5));
    expect(t.svc.pending(a)[0]?.excerpt).toHaveLength(5);
    expect(() => t.svc.createForSanction(t.group(a), lines(6))).toThrow(ExcerptError);
    expect(t.svc.pending(a)).toHaveLength(1);
  });

  it('refuses a line with a bad timestamp', () => {
    const t = setup();
    const a = t.person('ka');
    expect(() => t.svc.createForSanction(t.group(a), [line({ ts: Number.NaN })])).toThrow(ExcerptError);
    expect(t.svc.pending(a)).toEqual([]);
  });

  it('stores only the masked text: the store never holds the raw blocked line', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line({ raw: 'you zorbak', delivered: null, blocked: true })]);
    expect(JSON.stringify(t.store.rawNotices())).not.toMatch(/zorbak/);
  });
});

describe('ownLines', () => {
  function env() {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb');
    return { ...t, a, b };
  }

  it('keeps only the target person lines, in the report order', () => {
    const { subjects, a, b } = env();
    const r = report([a, b], [line({ lineId: 'x1', p: 0 }), line({ lineId: 'y1', p: 1 }), line({ lineId: 'x2', p: 0 }), line({ lineId: 'x3', p: 0 })]);
    expect(ownLines(r, a, ['x3', 'x1', 'x2'], subjects).map((l) => l.lineId)).toEqual(['x1', 'x2', 'x3']);
  });

  it('returns nothing for no ids', () => {
    const { subjects, a, b } = env();
    expect(ownLines(report([a, b], [line()]), a, [], subjects)).toEqual([]);
  });

  it('throws foreign_line when one requested id belongs to someone else', () => {
    const { subjects, a, b } = env();
    const r = report([a, b], [line({ lineId: 'x1', p: 0 }), line({ lineId: 'y1', p: 1 })]);
    expect(() => ownLines(r, a, ['x1', 'y1'], subjects)).toThrow(ExcerptError);
    try {
      ownLines(r, a, ['x1', 'y1'], subjects);
    } catch (e) {
      expect((e as ExcerptError).code).toBe('foreign_line');
      expect((e as Error).message).not.toContain('y1');
    }
  });

  it('throws foreign_line for an id that is not in the excerpt', () => {
    const { subjects, a, b } = env();
    const r = report([a, b], [line({ lineId: 'x1', p: 0 })]);
    expect(() => ownLines(r, a, ['nope'], subjects)).toThrow(expect.objectContaining({ code: 'foreign_line' }));
    expect(() => ownLines(r, a, ['x1', 'nope'], subjects)).toThrow(expect.objectContaining({ code: 'foreign_line' }));
  });

  it('a line with no writer (p null) is never own', () => {
    const { subjects, a, b } = env();
    const r = report([a, b], [line({ lineId: 'n1', p: null })]);
    expect(() => ownLines(r, a, ['n1'], subjects)).toThrow(expect.objectContaining({ code: 'foreign_line' }));
  });

  it('a p index outside people is never own', () => {
    const { subjects, a, b } = env();
    const r = report([a, b], [line({ lineId: 'o1', p: 7 }), line({ lineId: 'o2', p: -1 }), line({ lineId: 'o3', p: 0.5 })]);
    for (const id of ['o1', 'o2', 'o3']) {
      expect(() => ownLines(r, a, [id], subjects)).toThrow(expect.objectContaining({ code: 'foreign_line' }));
    }
  });

  it("a merged alias's line IS own (people[p] canonicalises to the subject)", () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    const r = report([a, b], [line({ lineId: 'a1', p: 0 }), line({ lineId: 'b1', p: 1 })]);
    // before the merge b1 is someone else's
    expect(() => ownLines(r, a, ['a1', 'b1'], t.subjects)).toThrow(ExcerptError);
    // ka and acct-b are seen together: the two subjects merge
    const merged = t.person('ka', 'acct-b');
    expect(t.subjects.canonical(a)).toBe(merged);
    expect(t.subjects.canonical(b)).toBe(merged);
    expect(ownLines(r, merged, ['a1', 'b1'], t.subjects).map((l) => l.lineId)).toEqual(['a1', 'b1']);
    // the caller may also pass the alias id
    const alias = merged === a ? b : a;
    expect(ownLines(r, alias, ['a1', 'b1'], t.subjects).map((l) => l.lineId)).toEqual(['a1', 'b1']);
  });

  it('allows five ids and throws too_many for six', () => {
    const { subjects, a } = env();
    const lines = Array.from({ length: 6 }, (_, i) => line({ lineId: `x${i}`, p: 0 }));
    const r = report([a], lines);
    expect(ownLines(r, a, lines.slice(0, 5).map((l) => l.lineId), subjects)).toHaveLength(5);
    expect(() => ownLines(r, a, lines.map((l) => l.lineId), subjects)).toThrow(expect.objectContaining({ code: 'too_many' }));
  });

  it('counts distinct ids: a repeated id is one line', () => {
    const { subjects, a } = env();
    const r = report([a], [line({ lineId: 'x0', p: 0 })]);
    expect(ownLines(r, a, ['x0', 'x0', 'x0', 'x0', 'x0', 'x0'], subjects).map((l) => l.lineId)).toEqual(['x0']);
  });

  it('too many foreign ids is still refused', () => {
    const { subjects, a, b } = env();
    const lines = Array.from({ length: 6 }, (_, i) => line({ lineId: `y${i}`, p: 1 }));
    expect(() => ownLines(report([a, b], lines), a, lines.map((l) => l.lineId), subjects)).toThrow(ExcerptError);
  });

  it('refuses when the subject is not in the report at all', () => {
    const { subjects, a, b } = env();
    const c = 's_cccccccccccccccccccccc';
    expect(() => ownLines(report([a, b], [line({ lineId: 'x1', p: 0 })]), c, ['x1'], subjects)).toThrow(ExcerptError);
  });

  it('a non-array id list is refused', () => {
    const { subjects, a } = env();
    expect(() => ownLines(report([a], [line({ p: 0 })]), a, 'L1' as never, subjects)).toThrow(ExcerptError);
  });

  it('returns copies: editing a result does not change the report', () => {
    const { subjects, a } = env();
    const r = report([a], [line({ lineId: 'x1', p: 0, audience: ['p1'] })]);
    const [got] = ownLines(r, a, ['x1'], subjects);
    if (got === undefined) throw new Error('expected a line');
    got.raw = 'changed';
    got.audience?.push('p9');
    expect(r.excerpt[0]?.raw).toBe('hello there');
    expect(r.excerpt[0]?.audience).toEqual(['p1']);
  });

  it('ownLines output feeds the notice: only own text reaches the player', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb');
    const r = report([a, b], [line({ lineId: 'x1', p: 0, raw: 'mine', delivered: 'mine' }), line({ lineId: 'y1', p: 1, raw: 'theirs', delivered: 'theirs' })]);
    t.svc.createForSanction(t.group(a), ownLines(r, a, ['x1'], t.subjects));
    const text = JSON.stringify(t.svc.pending(a));
    expect(text).toContain('mine');
    expect(text).not.toContain('theirs');
  });
});

describe('pending and merge', () => {
  it('lists unacked notices oldest first', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { refCode: 'M-AAAAA' }), []);
    t.clock.t += 1000;
    t.svc.createForSanction(t.group(a, { refCode: 'M-BBBBB' }), []);
    t.clock.t += 1000;
    t.svc.createReportOutcome(a);
    expect(t.svc.pending(a).map((n) => n.refCode)).toEqual(['M-AAAAA', 'M-BBBBB', null]);
  });

  it('is empty for someone with none, and for an unknown subject', () => {
    const t = setup();
    expect(t.svc.pending(t.person('ka'))).toEqual([]);
    expect(t.svc.pending('s_unknownunknownunknown')).toEqual([]);
  });

  it("one person's notices do not show for another", () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb');
    t.svc.createForSanction(t.group(a), []);
    expect(t.svc.pending(b)).toEqual([]);
    expect(t.svc.pending(a)).toHaveLength(1);
  });

  it('a notice for A is still pending after A merges into B, read through either id', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    t.svc.createForSanction(t.group(a), []);
    t.svc.createForSanction(t.group(b), []);
    const merged = t.person('ka', 'acct-b');
    expect(t.svc.pending(merged)).toHaveLength(2);
    expect(t.svc.pending(a)).toHaveLength(2);
    expect(t.svc.pending(b)).toHaveLength(2);
  });

  it('a notice created for a merged-away id lands on the survivor', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    const merged = t.person('ka', 'acct-b');
    const loser = merged === a ? b : a;
    t.svc.createForSanction(t.group(loser), []);
    expect(t.svc.pending(merged)).toHaveLength(1);
    expect(t.store.rawNotices()[0]?.subject).toBe(merged);
  });

  it('the survivor can ack a notice made for the alias', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    const id = t.svc.createForSanction(t.group(a), []);
    const merged = t.person('ka', 'acct-b');
    expect(t.svc.ack(merged, id)).toBe(true);
    expect(t.svc.pending(b)).toEqual([]);
  });

  it('a report outcome for a reporter follows the reporter through a merge', () => {
    const t = setup();
    const r1 = t.person('kr');
    const r2 = t.person('kq', 'acct-q');
    t.svc.createReportOutcome(r1);
    const merged = t.person('kr', 'acct-q');
    expect(t.svc.pending(merged)).toHaveLength(1);
    expect(t.svc.pending(r2)).toHaveLength(1);
  });
});

describe('ack', () => {
  it('removes the notice from pending and is idempotent', () => {
    const t = setup();
    const a = t.person('ka');
    const id = t.svc.createForSanction(t.group(a), []);
    expect(t.svc.ack(a, id)).toBe(true);
    expect(t.svc.pending(a)).toEqual([]);
    expect(t.svc.ack(a, id)).toBe(true);
  });

  it('keeps the first ack time', () => {
    const t = setup();
    const a = t.person('ka');
    const id = t.svc.createForSanction(t.group(a), []);
    t.clock.t += 5000;
    t.svc.ack(a, id);
    t.clock.t += 5000;
    t.svc.ack(a, id);
    expect(t.store.rawNotices()[0]?.ackedAt).toBe(NOW + 5000);
  });

  it('only the target person may ack: someone else gets false and nothing changes', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb');
    const id = t.svc.createForSanction(t.group(a), []);
    expect(t.svc.ack(b, id)).toBe(false);
    expect(t.svc.pending(a)).toHaveLength(1);
    expect(t.store.rawNotices()[0]?.ackedAt).toBeNull();
  });

  it('an unknown or malformed id is false', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), []);
    expect(t.svc.ack(a, 'nope')).toBe(false);
    expect(t.svc.ack(a, '')).toBe(false);
    expect(t.svc.ack(a, undefined as never)).toBe(false);
    expect(t.svc.ack(a, 42 as never)).toBe(false);
    expect(t.svc.pending(a)).toHaveLength(1);
  });

  it('a withdrawn notice cannot be acked', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a);
    const id = t.svc.createForSanction(g, []);
    t.svc.withdrawGroup(g.groupId);
    expect(t.svc.ack(a, id)).toBe(false);
    expect(t.store.rawNotices()[0]?.ackedAt).toBeNull();
  });

  it('a report outcome can be acked by the reporter', () => {
    const t = setup();
    const r = t.person('kr');
    const id = t.svc.createReportOutcome(r);
    expect(t.svc.ack(r, id)).toBe(true);
    expect(t.svc.pending(r)).toEqual([]);
  });

  it('acking one notice leaves the others pending', () => {
    const t = setup();
    const a = t.person('ka');
    const id1 = t.svc.createForSanction(t.group(a), []);
    t.svc.createForSanction(t.group(a), []);
    t.svc.ack(a, id1);
    expect(t.svc.pending(a)).toHaveLength(1);
  });
});

describe('withdrawGroup', () => {
  it('hides a pending notice and returns how many it withdrew', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a);
    t.svc.createForSanction(g, []);
    const other = t.group(a);
    t.svc.createForSanction(other, []);
    expect(t.svc.withdrawGroup(g.groupId)).toBe(1);
    expect(t.svc.pending(a)).toHaveLength(1);
    expect(t.svc.withdrawGroup(g.groupId)).toBe(0);
  });

  it('removes a seen notice from My record', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a);
    const id = t.svc.createForSanction(g, []);
    t.svc.ack(a, id);
    expect(t.svc.record(a)).toHaveLength(1);
    t.svc.withdrawGroup(g.groupId);
    expect(t.svc.record(a)).toEqual([]);
  });

  it('removes an unseen notice from the record too', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a);
    t.svc.createForSanction(g, []);
    t.svc.withdrawGroup(g.groupId);
    expect(t.svc.record(a)).toEqual([]);
    expect(t.svc.pending(a)).toEqual([]);
  });

  it('an unknown or empty group withdraws nothing', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), []);
    expect(t.svc.withdrawGroup('nope')).toBe(0);
    expect(t.svc.withdrawGroup('')).toBe(0);
    expect(t.svc.pending(a)).toHaveLength(1);
  });

  it('never touches report outcomes (they have no group)', () => {
    const t = setup();
    const r = t.person('kr');
    t.svc.createReportOutcome(r);
    expect(t.svc.withdrawGroup('')).toBe(0);
    expect(t.svc.pending(r)).toHaveLength(1);
  });

  it('keeps the first withdrawn time', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a);
    t.svc.createForSanction(g, []);
    t.clock.t += 1000;
    t.svc.withdrawGroup(g.groupId);
    t.clock.t += 1000;
    t.svc.withdrawGroup(g.groupId);
    expect(t.store.rawNotices()[0]?.withdrawnAt).toBe(NOW + 1000);
  });
});

describe('record (My record)', () => {
  it('lists unacked and acked sanction notices with their reference code and end', () => {
    const t = setup();
    const a = t.person('ka');
    const id = t.svc.createForSanction(t.group(a, { refCode: 'M-AAAAA', until: NOW + DAY }), []);
    t.svc.createForSanction(t.group(a, { refCode: 'M-BBBBB', until: null, kind: 'ban' }), []);
    t.svc.ack(a, id);
    const rec = t.svc.record(a);
    expect(rec.map((n) => [n.refCode, n.until])).toEqual([
      ['M-AAAAA', NOW + DAY],
      ['M-BBBBB', null],
    ]);
  });

  it('excludes report outcomes', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createReportOutcome(a);
    expect(t.svc.record(a)).toEqual([]);
    t.svc.createForSanction(t.group(a), []);
    expect(t.svc.record(a).map((n) => n.kind)).toEqual(['chat']);
  });

  it('keeps an ended sanction for 90 days from when the notice was made, then drops it', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { until: NOW + DAY }), []);
    t.clock.t = NOW + 2 * DAY; // ended, but started within 90 days
    expect(t.svc.record(a)).toHaveLength(1);
    t.clock.t = NOW + 90 * DAY; // exactly 90 days since created: still in
    expect(t.svc.record(a)).toHaveLength(1);
    t.clock.t = NOW + 90 * DAY + 1;
    expect(t.svc.record(a)).toEqual([]);
  });

  it('keeps a still-active sanction even when it started more than 90 days ago', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { until: NOW + 400 * DAY }), []);
    t.clock.t = NOW + 200 * DAY;
    expect(t.svc.record(a)).toHaveLength(1);
    t.clock.t = NOW + 400 * DAY; // until is exclusive: ended now, started long ago
    expect(t.svc.record(a)).toEqual([]);
  });

  it('keeps a permanent sanction on the record until it is withdrawn', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { kind: 'ban', until: null }), []);
    t.clock.t = NOW + 1000 * DAY;
    expect(t.svc.record(a)).toHaveLength(1);
  });

  it('keeps a permanent sanction on the record after it is acked, until it is withdrawn', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a, { kind: 'ban', until: null });
    const id = t.svc.createForSanction(g, []);
    t.svc.ack(a, id);
    t.clock.t = NOW + 400 * DAY;
    expect(t.svc.record(a)).toHaveLength(1);
    expect(t.svc.record(a)[0]?.refCode).toBe(g.refCode);
    t.svc.withdrawGroup(g.groupId);
    expect(t.svc.record(a)).toEqual([]);
  });

  it('keeps a warning on the record for 90 days only, from when it was made', () => {
    const t = setup();
    const a = t.person('ka');
    const id = t.svc.createForSanction(t.group(a, { kind: 'warning', until: null }), [line()]);
    t.svc.ack(a, id);
    t.clock.t = NOW + 90 * DAY;
    expect(t.svc.record(a)[0]).toMatchObject({ kind: 'warning', until: null, mustAcknowledge: true });
    t.clock.t = NOW + 90 * DAY + 1;
    expect(t.svc.record(a)).toEqual([]);
  });

  it('an unacked warning older than 90 days is off the record but still pending', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { kind: 'warning', until: null }), []);
    t.clock.t = NOW + 91 * DAY;
    expect(t.svc.record(a)).toEqual([]);
    expect(t.svc.pending(a)).toHaveLength(1);
    expect(t.svc.pendingWarning(a)).toBe(true);
  });

  it('is oldest first, and follows a merge', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    t.svc.createForSanction(t.group(a, { refCode: 'M-AAAAA' }), []);
    t.clock.t += 1000;
    t.svc.createForSanction(t.group(b, { refCode: 'M-BBBBB' }), []);
    const merged = t.person('ka', 'acct-b');
    expect(t.svc.record(merged).map((n) => n.refCode)).toEqual(['M-AAAAA', 'M-BBBBB']);
  });

  it("does not show another person's record", () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb');
    t.svc.createForSanction(t.group(a), []);
    expect(t.svc.record(b)).toEqual([]);
  });

  it('decides from the notice row only: no sanction lookup happens', () => {
    class NoSanctions extends MemoryStore {
      override loadSanctions(): never {
        throw new Error('record must not read sanctions');
      }
      override loadSubjectActions(): never {
        throw new Error('record must not read sanctions');
      }
    }
    const t = setup({ store: new NoSanctions() });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), []);
    expect(t.svc.record(a)).toHaveLength(1);
  });
});

describe('pendingWarning', () => {
  it('is true only while an unacked, unwithdrawn warning exists', () => {
    const t = setup();
    const a = t.person('ka');
    expect(t.svc.pendingWarning(a)).toBe(false);
    const w = t.group(a, { kind: 'warning', until: null });
    const id = t.svc.createForSanction(w, []);
    expect(t.svc.pendingWarning(a)).toBe(true);
    t.svc.ack(a, id);
    expect(t.svc.pendingWarning(a)).toBe(false);

    const w2 = t.group(a, { kind: 'warning', until: null });
    t.svc.createForSanction(w2, []);
    expect(t.svc.pendingWarning(a)).toBe(true);
    t.svc.withdrawGroup(w2.groupId);
    expect(t.svc.pendingWarning(a)).toBe(false);
  });

  it('other kinds do not count', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a, { kind: 'ban', until: null }), []);
    t.svc.createReportOutcome(a);
    expect(t.svc.pendingWarning(a)).toBe(false);
  });

  it('follows a merge and does not leak to other people', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    const c = t.person('kc');
    t.svc.createForSanction(t.group(a, { kind: 'warning', until: null }), []);
    const merged = t.person('ka', 'acct-b');
    expect(t.svc.pendingWarning(merged)).toBe(true);
    expect(t.svc.pendingWarning(b)).toBe(true);
    expect(t.svc.pendingWarning(c)).toBe(false);
  });
});

describe('notify', () => {
  it('is called once per create with the pending count after it', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), []);
    t.svc.createForSanction(t.group(a), []);
    expect(t.pushed).toEqual([
      { subject: a, count: 1 },
      { subject: a, count: 2 },
    ]);
    t.svc.createReportOutcome(a);
    expect(t.pushed.at(-1)).toEqual({ subject: a, count: 3 });
  });

  it('the event has the exact shape and no identifier', () => {
    const events: unknown[] = [];
    const t = setup({ notify: (_s, e) => void events.push(e) });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [line()]);
    expect(events).toEqual([{ type: 'notice_pending', count: 1 }]);
  });

  it('is told about the survivor after a merge', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    const merged = t.person('ka', 'acct-b');
    const loser = merged === a ? b : a;
    t.svc.createForSanction(t.group(loser), []);
    expect(t.pushed).toEqual([{ subject: merged, count: 1 }]);
  });

  it('runs after the commit: the notice is already readable inside notify', () => {
    let seen = -1;
    const t = setup({
      notify: (s) => {
        seen = t.svc.pending(s).length;
      },
    });
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), []);
    expect(seen).toBe(1);
  });

  it('is not called when the write fails, and the notice is not stored', () => {
    class Failing extends MemoryStore {
      override insertNotice(): never {
        throw new Error('disk full');
      }
    }
    const t = setup({ store: new Failing() });
    const a = t.person('ka');
    expect(() => t.svc.createForSanction(t.group(a), [])).toThrow('disk full');
    expect(t.pushed).toEqual([]);
  });

  it('is not called when the excerpt is refused', () => {
    const t = setup();
    const a = t.person('ka');
    expect(() => t.svc.createForSanction(t.group(a), Array.from({ length: 6 }, (_, i) => line({ lineId: `L${i}` })))).toThrow();
    expect(t.pushed).toEqual([]);
  });

  it('a notify that throws is fenced: the create still returns the id and the notice is stored', () => {
    const t = setup({
      notify: () => {
        throw new Error('push broke');
      },
    });
    const a = t.person('ka');
    const id = t.svc.createForSanction(t.group(a), []);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(t.svc.pending(a)).toHaveLength(1);
    expect(t.logs).toEqual([{ event: 'notices.notify_failed', detail: { error: 'Error' } }]);
  });

  it('a notify that rejects is fenced, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const t = setup({ notify: () => Promise.reject(new TypeError('push broke')) });
      const a = t.person('ka');
      t.svc.createReportOutcome(a);
      t.svc.createForSanction(t.group(a), []);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(t.svc.pending(a)).toHaveLength(2);
      expect(t.logs.map((l) => l.event)).toEqual(['notices.notify_failed', 'notices.notify_failed']);
      expect(t.logs[0]?.detail).toEqual({ error: 'TypeError' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a notify returning a hostile thenable is fenced', () => {
    const t = setup({
      notify: () => ({
        get then(): never {
          throw new Error('hostile');
        },
      }),
    });
    const a = t.person('ka');
    expect(() => t.svc.createReportOutcome(a)).not.toThrow();
    expect(t.svc.pending(a)).toHaveLength(1);
  });

  it('a logger that throws cannot break a create', () => {
    const store = new MemoryStore();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const svc = new NoticeService({
      store,
      subjects,
      rules,
      clock,
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
      notify: () => {
        throw new Error('push broke');
      },
    });
    const a = subjects.resolve({ clientKey: 'ka', accountId: null, ipHash: null }) ?? '';
    expect(() => svc.createReportOutcome(a)).not.toThrow();
    expect(svc.pending(a)).toHaveLength(1);
  });

  it('works with no notify at all', () => {
    const store = new MemoryStore();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const svc = new NoticeService({ store, subjects, rules, clock });
    const a = subjects.resolve({ clientKey: 'ka', accountId: null, ipHash: null }) ?? '';
    svc.createReportOutcome(a);
    expect(svc.pending(a)).toHaveLength(1);
  });

  it('the log lines carry the event and the error class only', () => {
    const t = setup({
      notify: () => {
        throw new RangeError('secret detail zorbak');
      },
    });
    const a = t.person('ka');
    t.svc.createReportOutcome(a);
    expect(JSON.stringify(t.logs)).not.toMatch(/secret|zorbak|s_[A-Za-z0-9_-]{22}/);
  });
});

describe('the notify seam (notify: false, announce)', () => {
  it('a create with notify:false inside a transaction that throws never notifies and leaves no notice', () => {
    const t = setup();
    const a = t.person('ka');
    expect(() =>
      t.store.transaction(() => {
        t.svc.createForSanction(t.group(a), [], { notify: false });
        t.svc.createReportOutcome(a, { notify: false });
        throw new Error('outer failed');
      }),
    ).toThrow('outer failed');
    expect(t.pushed).toEqual([]);
    expect(t.svc.pending(a)).toEqual([]);
    expect(t.store.rawNotices()).toEqual([]);
  });

  it('announce after a successful outer transaction notifies once with the right count', () => {
    const t = setup();
    const a = t.person('ka');
    t.store.transaction(() => {
      t.svc.createForSanction(t.group(a), [], { notify: false });
      t.svc.createForSanction(t.group(a), [], { notify: false });
    });
    expect(t.pushed).toEqual([]);
    t.svc.announce(a);
    expect(t.pushed).toEqual([{ subject: a, count: 2 }]);
  });

  it('the default and notify:true still notify; only an explicit false suppresses', () => {
    const t = setup();
    const a = t.person('ka');
    t.svc.createForSanction(t.group(a), [], { notify: true });
    t.svc.createForSanction(t.group(a), [], {});
    t.svc.createReportOutcome(a, { notify: true });
    t.svc.createReportOutcome(a, { notify: false });
    expect(t.pushed.map((p) => p.count)).toEqual([1, 2, 3]);
  });

  it('announce recomputes the count and canonicalises the subject', () => {
    const t = setup();
    const a = t.person('ka');
    const b = t.person('kb', 'acct-b');
    t.svc.createForSanction(t.group(a), [], { notify: false });
    const merged = t.person('ka', 'acct-b');
    const alias = merged === a ? b : a;
    t.svc.announce(alias);
    expect(t.pushed).toEqual([{ subject: merged, count: 1 }]);
    t.svc.ack(merged, t.svc.pending(merged)[0]?.id ?? '');
    t.svc.announce(merged);
    expect(t.pushed.at(-1)).toEqual({ subject: merged, count: 0 });
  });

  it('announce is fenced: a throwing, rejecting or missing notify never reaches the caller', async () => {
    const t = setup({ notify: () => Promise.reject(new TypeError('x')) });
    const a = t.person('ka');
    expect(() => t.svc.announce(a)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.logs.map((l) => l.event)).toEqual(['notices.notify_failed']);
    const t2 = setup({
      notify: () => {
        throw new Error('x');
      },
    });
    expect(() => t2.svc.announce(t2.person('kb'))).not.toThrow();
    expect(() => t2.svc.announce('' as never)).not.toThrow();
  });
});

describe('a journaled store undoes a failed transaction', () => {
  it('a notice written in a transaction that throws is gone', () => {
    const t = setup();
    const a = t.person('ka');
    expect(() =>
      t.store.transaction(() => {
        t.svc.createForSanction(t.group(a), []);
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    expect(t.svc.pending(a)).toEqual([]);
  });

  it('an ack and a withdraw are undone too', () => {
    const t = setup();
    const a = t.person('ka');
    const g = t.group(a);
    const id = t.svc.createForSanction(g, []);
    expect(() =>
      t.store.transaction(() => {
        t.svc.ack(a, id);
        t.svc.withdrawGroup(g.groupId);
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(t.svc.pending(a)).toHaveLength(1);
  });
});
