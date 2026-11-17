import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import {
  backlogOf,
  checkInsightsDays,
  computeInsights,
  INSIGHTS_MIN_DECIDED,
  INSIGHTS_MIN_URGENT,
  INSIGHTS_ROW_CAP,
  percentileOf,
} from '../src/insights.js';
import type { KitEvent } from '../src/events.js';
import type { ChatDayRow, InsightRow } from '../src/types.js';
import { NOW as WORLD_NOW, world } from './reportingWorld.js';

// U7: Insights are computed from rows the kit already holds. Times and counts only: never a person, a handle, text or a staff member.

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const D = 24 * H;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const row = (over: Partial<InsightRow> = {}): InsightRow => ({
  createdAt: NOW - 2 * D,
  actionedAt: null,
  status: 'open',
  reportedReason: 'harassment',
  urgent: false,
  badFaith: false,
  ...over,
});
/** A decided report that took `took` ms, filed `ago` before NOW. */
const decided = (took: number, over: Partial<InsightRow> = {}): InsightRow =>
  row({ createdAt: NOW - 2 * D, actionedAt: NOW - 2 * D + took, status: 'actioned', ...over });
const calc = (rows: InsightRow[], over: { counts?: ChatDayRow[]; rules?: Array<{ rule: string | null; count: number }>; days?: number } = {}) =>
  computeInsights(rows, over.counts ?? [], over.rules ?? [], NOW, over.days ?? 7);

describe('the time to a decision', () => {
  it('median, p90, longest open wait and the five backlog buckets on a fixture with exact edges (1 h, 4 h, 1 d, 3 d)', () => {
    const rows = [
      // five decided reports taking 1, 2, 3, 4 and 10 hours: the median is the 3rd (3 h), the p90 the 5th (10 h)
      ...[1, 2, 3, 4, 10].map((h) => decided(h * H)),
      // open: 59 min and 1 h exactly (under1h / under4h), 4 h exactly (under1d), 1 d exactly (under3d), 3 d exactly (over3d), 5 d (over3d)
      row({ createdAt: NOW - (H - 60_000) }),
      row({ createdAt: NOW - H }),
      row({ createdAt: NOW - 4 * H }),
      row({ createdAt: NOW - D }),
      row({ createdAt: NOW - 3 * D }),
      row({ createdAt: NOW - 5 * D }),
    ];
    const r = calc(rows, { days: 30 });
    expect(r.decision).toEqual({ decided: 5, medianMs: 3 * H, p90Ms: 10 * H });
    expect(r.wait.longestOpenMs).toBe(5 * D);
    expect(r.wait.backlog).toEqual({ under1h: 1, under4h: 1, under1d: 1, under3d: 1, over3d: 2 });
    expect(r.reports).toEqual({ filed: 11, decided: 5, open: 6 });
  });

  it('medianMs is null at 4 decided and exact at 5; p90 follows', () => {
    expect(INSIGHTS_MIN_DECIDED).toBe(5);
    const four = calc([1, 2, 3, 4].map((h) => decided(h * H)));
    expect(four.decision).toEqual({ decided: 4, medianMs: null, p90Ms: null });
    const five = calc([1, 2, 3, 4, 5].map((h) => decided(h * H)));
    expect(five.decision).toEqual({ decided: 5, medianMs: 3 * H, p90Ms: 5 * H });
  });

  it('urgent medianMs is null at 2 and exact at 3', () => {
    expect(INSIGHTS_MIN_URGENT).toBe(3);
    const two = calc([decided(H, { urgent: true }), decided(2 * H, { urgent: true }), decided(9 * H)]);
    expect(two.urgent).toEqual({ filed: 2, decided: 2, medianMs: null });
    const three = calc([decided(H, { urgent: true }), decided(2 * H, { urgent: true }), decided(5 * H, { urgent: true }), decided(9 * H)]);
    expect(three.urgent).toEqual({ filed: 3, decided: 3, medianMs: 2 * H });
  });

  it('an open urgent report counts as filed and not as decided; a dismissed one counts as decided', () => {
    const r = calc([row({ urgent: true }), decided(H, { urgent: true, status: 'dismissed' })]);
    expect(r.urgent).toEqual({ filed: 2, decided: 1, medianMs: null });
  });

  it('a decision time can never be negative (a clock that stepped back reads as 0)', () => {
    const rows = [0, 0, 0, 0, 0].map(() => row({ status: 'actioned', createdAt: NOW - D, actionedAt: NOW - D - 5 * H }));
    expect(calc(rows).decision).toEqual({ decided: 5, medianMs: 0, p90Ms: 0 });
  });

  it('percentileOf is nearest-rank and null for an empty list; backlogOf puts exact edges in the older bucket', () => {
    expect(percentileOf([], 0.5)).toBeNull();
    expect(percentileOf([7], 0.5)).toBe(7);
    expect(percentileOf([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(backlogOf([0, H - 1, H, 4 * H - 1, 4 * H, D - 1, D, 3 * D - 1, 3 * D])).toEqual({ under1h: 2, under4h: 2, under1d: 2, under3d: 2, over3d: 1 });
  });
});

describe('volume', () => {
  it('by reason includes "none", highest first, with the label the profile gives; by outcome counts actioned, dismissed and bad faith', () => {
    const rows = [
      row({ reportedReason: 'harassment' }),
      row({ reportedReason: 'harassment' }),
      row({ reportedReason: 'spam' }),
      row({ reportedReason: null }),
      row({ reportedReason: null }),
      row({ reportedReason: null }),
      row({ reportedReason: null }),
      decided(H, { reportedReason: 'spam' }),
      decided(H, { status: 'dismissed' }),
      decided(H, { status: 'dismissed', badFaith: true }),
    ];
    const r = computeInsights(rows, [], [], NOW, 7, (id) => (id === 'harassment' ? 'Harassment' : undefined));
    expect(r.byReason).toEqual([
      { reason: 'harassment', label: 'Harassment', count: 4 },
      { reason: 'none', label: 'No reason given', count: 4 },
      { reason: 'spam', label: 'spam', count: 2 },
    ]);
    expect(r.byOutcome).toEqual({ actioned: 1, dismissed: 1, badFaith: 1 });
  });

  it('by rule comes from the sanctions in the window, rule numbers ascending, uncovered last; a null rule reads as uncovered', () => {
    const r = calc([], {
      rules: [
        { rule: 'uncovered', count: 2 },
        { rule: '3', count: 4 },
        { rule: null, count: 1 },
        { rule: '1', count: 5 },
      ],
    });
    expect(r.byRule).toEqual([
      { rule: 1, count: 5 },
      { rule: 3, count: 4 },
      { rule: 'uncovered', count: 3 },
    ]);
  });

  it('an empty store gives zeros and nulls and never NaN', () => {
    const r = calc([]);
    expect(r).toEqual({
      days: 7,
      from: NOW - 7 * D,
      to: NOW,
      reports: { filed: 0, decided: 0, open: 0 },
      decision: { decided: 0, medianMs: null, p90Ms: null },
      urgent: { filed: 0, decided: 0, medianMs: null },
      wait: { longestOpenMs: 0, backlog: { under1h: 0, under4h: 0, under1d: 0, under3d: 0, over3d: 0 } },
      byReason: [],
      byOutcome: { actioned: 0, dismissed: 0, badFaith: 0 },
      byRule: [],
      chat: null,
      partial: false,
    });
    expect(JSON.stringify(r)).not.toMatch(/NaN|null.*Infinity/);
  });

  it('a report filed before the window is not counted as filed, but an old open one still shows in the wait', () => {
    const r = calc([row({ createdAt: NOW - 20 * D }), row({ createdAt: NOW - D })], { days: 7 });
    expect(r.reports).toEqual({ filed: 1, decided: 0, open: 2 });
    expect(r.wait.longestOpenMs).toBe(20 * D);
  });
});

describe('what never appears', () => {
  const rows = [
    decided(H, { reportedReason: 'harassment' }),
    row({ urgent: true, reportedReason: 'welfare' }),
    // a store row with extra fields: the result copies nothing it was not asked to
    { ...row(), actionedBy: 'mod_ann', subject: 's_secret', handle: 'HANDLE', note: 'NOTE-TEXT' } as unknown as InsightRow,
  ];

  it('actionedBy, subject ids, handles and text never appear in the result (key scan)', () => {
    const text = JSON.stringify(calc(rows));
    for (const needle of ['actionedBy', 'mod_ann', 's_secret', 'HANDLE', 'NOTE-TEXT', 'subject', 'handle', 'note']) expect(text, needle).not.toContain(needle);
  });

  it('the result has no per-person field of any kind', () => {
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v !== null) {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(calc(rows, { counts: [{ day: day(NOW), delivered: 10, refused: 1 }] }));
    for (const k of keys) expect(k, k).not.toMatch(/person|subject|actor|actioned_?by|staff|moderator|reporter|handle|name|text|note/i);
  });
});

describe('the cap and the window', () => {
  it('reports at the 20 000 cap set partial true; below it false', () => {
    expect(INSIGHTS_ROW_CAP).toBe(20_000);
    const many = (n: number): InsightRow[] => Array.from({ length: n }, (_, i) => row({ createdAt: NOW - D - i }));
    expect(calc(many(INSIGHTS_ROW_CAP)).partial).toBe(true);
    expect(calc(many(INSIGHTS_ROW_CAP - 1)).partial).toBe(false);
  });

  it('a cap that cut only reports older than the window does not make the window partial', () => {
    const rows = Array.from({ length: INSIGHTS_ROW_CAP }, (_, i) => row({ createdAt: NOW - 8 * D - i }));
    expect(calc(rows, { days: 7 }).partial).toBe(false);
  });

  it('days other than 7, 30 and 90 are invalid', () => {
    for (const bad of [0, 1, 6, 8, 29, 31, 89, 91, 365, -7, 7.5, NaN, Infinity, '7', null, undefined, {}]) {
      expect(() => checkInsightsDays(bad), String(bad)).toThrow(RangeError);
      expect(() => computeInsights([], [], [], NOW, bad as never), String(bad)).toThrow(RangeError);
    }
    for (const ok of [7, 30, 90]) expect(checkInsightsDays(ok)).toBe(ok);
  });

  it('from and to are the window ends', () => {
    const r = calc([], { days: 30 });
    expect([r.days, r.from, r.to]).toEqual([30, NOW - 30 * D, NOW]);
  });
});

describe('the report rate', () => {
  const counts = (over: Partial<ChatDayRow>[]): ChatDayRow[] => over.map((o, i) => ({ day: day(NOW - (over.length - 1 - i) * D), delivered: 0, refused: 0, ...o }));

  it('reportsPer1000 is reports over delivered lines times 1000', () => {
    const rows = [row(), row(), row(), row()];
    const full = Array.from({ length: 8 }, (_, i) => ({ day: day(NOW - (7 - i) * D), delivered: 500, refused: 50 }));
    const r = calc(rows, { counts: full });
    expect(r.chat).toEqual({ delivered: 4000, refused: 400, reportsPer1000: 1 });
  });

  it('is null when delivered is 0', () => {
    const full = Array.from({ length: 8 }, (_, i) => ({ day: day(NOW - (7 - i) * D), delivered: 0, refused: 3 }));
    expect(calc([row()], { counts: full }).chat).toEqual({ delivered: 0, refused: 24, reportsPer1000: null });
  });

  it('is null when counting began inside the window, with the counts still shown', () => {
    const late = counts([{ delivered: 100, refused: 1 }, { delivered: 100, refused: 1 }]);
    expect(calc([row()], { counts: late }).chat).toEqual({ delivered: 200, refused: 2, reportsPer1000: null });
  });

  it('chat is null when counting was off for the whole window (no rows)', () => {
    expect(calc([row()], { counts: [] }).chat).toBeNull();
  });

  it('count rows outside the window are ignored', () => {
    const rows = [{ day: day(NOW - 40 * D), delivered: 999, refused: 999 }, ...Array.from({ length: 8 }, (_, i) => ({ day: day(NOW - (7 - i) * D), delivered: 10, refused: 0 }))];
    expect(calc([row()], { counts: rows }).chat?.delivered).toBe(80);
  });
});

describe('cw.insights over a store', () => {
  const on = { overrides: { desk: { insights: true } } };

  it('is off by default: enabled false, read and digest null, emitDigest raises nothing', async () => {
    const w = await world();
    const seen: KitEvent[] = [];
    w.cw.on('insights.digest', (e) => void seen.push(e));
    expect(w.cw.insights.enabled()).toBe(false);
    expect(w.cw.insights.read(7)).toBeNull();
    expect(w.cw.insights.digest(7)).toBeNull();
    expect(w.cw.insights.emitDigest(7)).toBeNull();
    expect(seen).toEqual([]);
  });

  it('is off over a store that cannot read insight rows, even with the setting on', async () => {
    const bare = new MemoryStore();
    (bare as unknown as { insightRows?: unknown }).insightRows = undefined;
    const w = await world(on, bare);
    expect(w.cw.insights.enabled()).toBe(false);
    expect(w.cw.insights.read()).toBeNull();
  });

  it('read counts what was filed and decided, with the reason labels of the profile; days default to 30 and invalid days throw RangeError', async () => {
    const w = await world(on);
    const a = await w.file({ reason: 'harassment' });
    await w.file({ reason: 'spam' });
    w.clock.t += 3_600_000;
    expect(await w.cw.decide({ reportId: a.id, verdict: 'no_action', reason: 'ok', actions: [], actor: 'mod_ann' })).toMatchObject({ ok: true });
    const r = w.cw.insights.read();
    expect(r?.days).toBe(30);
    expect(r?.reports).toEqual({ filed: 2, decided: 1, open: 1 });
    expect(r?.byReason.map((x) => x.reason).sort()).toEqual(['harassment', 'spam']);
    expect(r?.byReason.find((x) => x.reason === 'harassment')?.label).toBe('Insults or harassment');
    expect(() => w.cw.insights.read(14 as never)).toThrow(RangeError);
    expect(() => w.cw.insights.digest(0 as never)).toThrow(RangeError);
  });

  it('read flushes the line counter first, so the rate includes the open minute', async () => {
    const w = await world(on);
    w.cw.rooms.seat('R1', 'p1', { clientKey: 'key-one-aaaaaaaaaaaa' }, 'One');
    w.cw.chat.accept('R1', 'p1', 'hello');
    const r = w.cw.insights.read(7);
    expect(r?.chat).toEqual({ delivered: 1, refused: 0, reportsPer1000: null });
  });

  it('digest holds counts and times only; emitDigest raises insights.digest once with the same numbers', async () => {
    const w = await world(on);
    await w.file({ reason: 'harassment' });
    w.clock.t += 2 * 3_600_000;
    const seen: KitEvent[] = [];
    w.cw.on('insights.digest', (e) => void seen.push(e));
    const d = w.cw.insights.digest(7);
    expect(d).toEqual({ days: 7, from: WORLD_NOW + 2 * 3_600_000 - 7 * D, to: WORLD_NOW + 2 * 3_600_000, filed: 1, decided: 0, open: 1, urgentFiled: 0, urgentOpen: 0, medianMs: null, p90Ms: null, longestOpenMs: 2 * 3_600_000 });
    expect(w.cw.insights.emitDigest()).toEqual({ ...d, days: 7 });
    expect(seen).toEqual([{ type: 'insights.digest', at: w.clock.t, digest: d }]);
    const text = JSON.stringify(seen);
    for (const needle of ['actionedBy', 'subject', 'handle', 'reason', 'text', 'note']) expect(text, needle).not.toContain(needle);
  });

  it('a throwing digest listener does not stop emitDigest', async () => {
    const w = await world(on);
    w.cw.on('insights.digest', () => {
      throw new Error('listener down');
    });
    expect(() => w.cw.insights.emitDigest(7)).not.toThrow();
  });

  it('by rule reads the sanctions written in the window, uncovered last', async () => {
    const w = await world(on, withMemoryAppeals(new MemoryStore()));
    const t = w.table();
    await w.cw.sanctions.apply({ kind: 'chat', subject: t.target, includeIp: false, durationMs: 3_600_000, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });
    await w.cw.sanctions.apply({ kind: 'warning', subject: t.target, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, gapNote: 'a gap' });
    const r = w.cw.insights.read(7);
    expect(r?.byRule).toEqual([{ rule: 2, count: 1 }, { rule: 'uncovered', count: 1 }]);
  });
});
