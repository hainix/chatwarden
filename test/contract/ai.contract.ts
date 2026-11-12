import { describe, expect, it } from 'vitest';
import type {
  AIExample,
  AIRead,
  AiCallUsage,
  AiExampleRow,
  AiOutcomeDetail,
  AiOutcomeInsert,
  AiOutcomeRow,
  AiReadDone,
  AiReadPending,
  AiReadRow,
  AiReserveResult,
  AiStatsRow,
  Store,
  StoredReport,
} from '@chatwarden/core';

// The contract of the optional AI methods of the Store (AI levels 1 and 2, design section 5): the read rows (reserve with a lease,
// complete, fail, load, retry list, spend), the casebook outcomes (insert, mark, examples, stats) and their purge. One suite, run
// against every Store; SqliteStore is the reference.

/** The page sizes used when a limit is omitted, not finite or below 1 (the prompt takes at most 2 examples; the sweeper enqueues 20). */
const EXAMPLES_DEFAULT = 2;
const RETRIES_DEFAULT = 20;

const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
/** The UTC midnight at or before NOW: the start of "today" for the spend cap. */
const MIDNIGHT = Math.floor(NOW / DAY) * DAY;

/** The methods a first-party store has and a custom one may leave out. */
type Ai = Required<
  Pick<
    Store,
    | 'reserveAiRead'
    | 'completeAiRead'
    | 'failAiRead'
    | 'loadAiRead'
    | 'loadAiReads'
    | 'listAiRetries'
    | 'aiSpendSince'
    | 'insertAiOutcome'
    | 'loadAiOutcome'
    | 'markAiOutcome'
    | 'aiExamples'
    | 'aiTeachableCount'
    | 'aiStats'
    | 'purgeAi'
  >
>;
const METHODS: Array<keyof Ai> = [
  'reserveAiRead',
  'completeAiRead',
  'failAiRead',
  'loadAiRead',
  'loadAiReads',
  'listAiRetries',
  'aiSpendSince',
  'insertAiOutcome',
  'loadAiOutcome',
  'markAiOutcome',
  'aiExamples',
  'aiTeachableCount',
  'aiStats',
  'purgeAi',
];
const ai = (s: Store): Store & Ai => {
  for (const m of METHODS) if (s[m] === undefined) throw new Error(`this store has no ${m}`);
  return s as Store & Ai;
};

const pending = (over: Partial<AiReadPending> = {}): AiReadPending => ({
  reportId: 'r1',
  inputHash: 'h1',
  promptVersion: 1,
  adapter: 'fake:one',
  ...over,
});

const usage = (over: Partial<AiCallUsage> = {}): AiCallUsage => ({
  model: 'fake-model',
  inputTokens: 1200,
  outputTokens: 80,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
  costMicros: 500,
  latencyMs: 640,
  ...over,
});

const read = (over: Partial<AIRead> = {}): AIRead => ({
  severity: 'hostile',
  rule: 3,
  summary: 'P1 insulted P2 twice after being asked to stop.',
  evidence: ['L2', 'L5'],
  confidence: 'high',
  injectionSuspected: false,
  recommendation: { verdict: 'upheld', severity: 'hostile', rule: 3, evidence: ['L2'] },
  ...over,
});

const done = (over: Partial<AiReadDone> = {}): AiReadDone => ({ ...usage(), read: read(), ...over });

/** The lease token of every row this suite reserved, by row id: what `completeAiRead` and `failAiRead` must be given. */
const leases = new Map<string, number>();
function rsv(s: Store & Ai, row: AiReadPending, leaseUntil: number, now: number): AiReserveResult {
  const r = s.reserveAiRead(row, leaseUntil, now);
  if (r.reserved) leases.set(r.id, r.lease);
  return r;
}
const complete = (s: Store & Ai, id: string, result: AiReadDone): boolean => s.completeAiRead(id, leases.get(id) ?? 0, result);
const fail = (
  s: Store & Ai,
  id: string,
  status: 'failed' | 'declined' | 'invalid' | 'skipped',
  kind: Parameters<Ai['failAiRead']>[3],
  retryAt: number | null,
  u?: AiCallUsage,
): boolean => s.failAiRead(id, leases.get(id) ?? 0, status, kind, retryAt, u);

/** Reserve a row and return its id (the row is `pending`). */
function reserve(s: Store & Ai, over: Partial<AiReadPending> = {}, now = NOW, lease = now + 5 * MIN): string {
  const r = rsv(s, pending(over), lease, now);
  if (!r.reserved) throw new Error('expected a reservation');
  return r.id;
}
/** An `ok` read for a report, reserved at `now`. */
function okRead(s: Store & Ai, reportId: string, hash: string, now: number, r: AIRead = read(), cost = 500): string {
  const id = reserve(s, { reportId, inputHash: hash }, now);
  expect(complete(s, id, done({ read: r, costMicros: cost }))).toBe(true);
  return id;
}

const example = (over: Partial<AIExample> = {}): AIExample => ({
  rule: 3,
  severity: 'hostile',
  verdict: 'upheld',
  lines: [
    { who: 'P1', text: 'zorbak you vlemmo' },
    { who: 'P2', text: 'please stop' },
  ],
  ...over,
});

const DETAIL: AiOutcomeDetail = { verdict: true, rule: true, lines: 2, outcome: 'same', oneClick: true };

let oseq = 0;
const outcome = (over: Partial<AiOutcomeInsert> = {}): AiOutcomeInsert => {
  oseq += 1;
  return {
    reportId: `o${oseq}`,
    readId: `read${oseq}`,
    decidedAt: NOW,
    level: 2,
    verdict: 'upheld',
    rule: '3',
    severity: 'hostile',
    aiVerdict: 'upheld',
    agreement: 'agree',
    detail: DETAIL,
    badFaith: false,
    example: example(),
    ...over,
  };
};

const report = (id: string, createdAt: number, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  ...over,
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);
const reportIds = (rows: Array<{ reportId: string }>): string[] => rows.map((r) => r.reportId);

export function aiContract(name: string, make: () => Store): void {
  describe(`ai contract: ${name}`, () => {
    it('has every optional AI method', () => {
      const s = make();
      for (const m of METHODS) expect(typeof s[m]).toBe('function');
    });

    describe('reserveAiRead', () => {
      it('reserve is exclusive for the same report and hash', () => {
        const s = ai(make());
        const first = rsv(s, pending(), NOW + 5 * MIN, NOW);
        expect(first).toEqual({ reserved: true, id: expect.any(String), lease: 1 });
        const second = rsv(s, pending(), NOW + 5 * MIN, NOW + 1);
        expect(second.reserved).toBe(false);
        if (first.reserved && !second.reserved) expect(second.existing.id).toBe(first.id);
      });

      it('a new row is pending, owned by the lease, one attempt, no read and no cost', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW, NOW + 5 * MIN);
        expect(s.loadAiReads(['r1'])).toEqual([]); // not ok yet
        const dup = rsv(s, pending(), NOW + 9 * MIN, NOW);
        expect(dup).toEqual({
          reserved: false,
          existing: {
            id,
            reportId: 'r1',
            inputHash: 'h1',
            status: 'pending',
            attempts: 1,
            retryAt: null,
            leaseUntil: NOW + 5 * MIN,
            errorKind: null,
            adapter: 'fake:one',
            model: null,
            promptVersion: 1,
            read: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            exampleIds: [],
            costMicros: 0,
            latencyMs: null,
            createdAt: NOW,
          } satisfies AiReadRow,
        });
      });

      it('a second reserve returns the existing row, whatever state it is in', () => {
        const s = ai(make());
        const id = okRead(s, 'r1', 'h1', NOW);
        const again = rsv(s, pending(), NOW + DAY, NOW + 10 * DAY);
        expect(again.reserved).toBe(false);
        if (!again.reserved) {
          expect(again.existing.id).toBe(id);
          expect(again.existing.status).toBe('ok');
          expect(again.existing.read).toEqual(read());
        }
        // The returned row is a copy: changing it does not change the store.
        if (!again.reserved) again.existing.read = null;
        expect(s.loadAiRead('r1')?.read).toEqual(read());
      });

      it('another hash, or another report, reserves separately', () => {
        const s = ai(make());
        const a = reserve(s);
        const b = reserve(s, { inputHash: 'h2' });
        const c = reserve(s, { reportId: 'r2' });
        const d = reserve(s, { reportId: 'r2', inputHash: 'h2' });
        expect(new Set([a, b, c, d]).size).toBe(4);
      });

      it('an expired lease can be taken again', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW, NOW + MIN);
        // Live strictly before lease_until.
        expect(rsv(s, pending(), NOW + 10 * MIN, NOW + MIN - 1).reserved).toBe(false);
        const taken = rsv(s, pending(), NOW + 11 * MIN, NOW + MIN);
        expect(taken).toEqual({ reserved: true, id, lease: 2 }); // the same row, taken over, with the next fence
        const next = rsv(s, pending(), NOW + 20 * MIN, NOW + MIN + 1);
        expect(next.reserved).toBe(false);
        if (!next.reserved) {
          expect(next.existing).toMatchObject({ id, status: 'pending', attempts: 2, leaseUntil: NOW + 11 * MIN, retryAt: null, createdAt: NOW });
        }
      });

      it('a take-over keeps created_at (spend has its own per-attempt ledger)', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW, NOW + MIN);
        expect(rsv(s, pending(), NOW + 9 * MIN, NOW + 2 * MIN)).toEqual({ reserved: true, id, lease: 2 });
        expect(complete(s, id, done())).toBe(true);
        expect(s.loadAiRead('r1')?.createdAt).toBe(NOW);
      });

      it('a failed read can be taken again once its retry time has come, not before', () => {
        const s = ai(make());
        const id = reserve(s);
        expect(fail(s, id, 'failed', 'retryable', NOW + MIN)).toBe(true);
        expect(rsv(s, pending(), NOW + 9 * MIN, NOW + MIN - 1).reserved).toBe(false);
        expect(rsv(s, pending(), NOW + 9 * MIN, NOW + MIN)).toEqual({ reserved: true, id, lease: 2 });
        const row = rsv(s, pending(), NOW + 9 * MIN, NOW + MIN + 1);
        expect(row.reserved).toBe(false);
        if (!row.reserved) {
          expect(row.existing).toMatchObject({ status: 'pending', attempts: 2, retryAt: null, errorKind: null, leaseUntil: NOW + 9 * MIN });
        }
      });

      it('a skipped read with a retry time (the daily limit) is retaken at that time; without one it is final', () => {
        const s = ai(make());
        const a = reserve(s, { reportId: 'a' });
        const b = reserve(s, { reportId: 'b' });
        expect(fail(s, a, 'skipped', 'budget', MIDNIGHT + DAY)).toBe(true);
        expect(fail(s, b, 'skipped', 'budget', null)).toBe(true);
        expect(rsv(s, pending({ reportId: 'a' }), NOW + 9 * MIN, MIDNIGHT + DAY - 1).reserved).toBe(false);
        expect(rsv(s, pending({ reportId: 'a' }), MIDNIGHT + DAY + 9 * MIN, MIDNIGHT + DAY)).toEqual({ reserved: true, id: a, lease: 2 });
        expect(rsv(s, pending({ reportId: 'b' }), MIDNIGHT + 9 * DAY, MIDNIGHT + 8 * DAY).reserved).toBe(false);
      });

      it.each([
        ['declined', 'declined'],
        ['invalid', 'invalid'],
        ['failed', 'fatal'],
      ] as const)('a %s read with no retry time is final (control)', (status, kind) => {
        const s = ai(make());
        const id = reserve(s);
        expect(fail(s, id, status, kind, null)).toBe(true);
        const again = rsv(s, pending(), NOW + 9 * DAY, NOW + 8 * DAY);
        expect(again.reserved).toBe(false);
        if (!again.reserved) expect(again.existing).toMatchObject({ id, status, errorKind: kind, retryAt: null });
      });

      it('an ok read is never retaken, however old its lease', () => {
        const s = ai(make());
        okRead(s, 'r1', 'h1', NOW);
        expect(rsv(s, pending(), NOW + 99 * DAY, NOW + 98 * DAY).reserved).toBe(false);
      });

      it('does not move the change token', () => {
        const s = ai(make());
        const before = s.changeToken();
        reserve(s);
        expect(s.changeToken()).toBe(before);
      });

      it('an undone transaction leaves no reservation behind', () => {
        const s = ai(make());
        expect(() =>
          s.transaction(() => {
            reserve(s);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(rsv(s, pending(), NOW + MIN, NOW).reserved).toBe(true);
      });
    });

    describe('completeAiRead / failAiRead', () => {
      it('complete stores the validated read and bumps the change token', () => {
        const s = ai(make());
        const id = reserve(s);
        const before = s.changeToken();
        const r = read({ rule: 'uncovered', injectionSuspected: true, confidence: 'low' });
        expect(complete(s, id, done({ read: r }))).toBe(true);
        expect(s.changeToken()).not.toBe(before);
        expect(s.loadAiRead('r1')).toEqual({
          id,
          reportId: 'r1',
          inputHash: 'h1',
          status: 'ok',
          attempts: 1,
          retryAt: null,
          leaseUntil: null,
          errorKind: null,
          adapter: 'fake:one',
          model: 'fake-model',
          promptVersion: 1,
          read: r,
          inputTokens: 1200,
          outputTokens: 80,
          cacheReadTokens: 900,
          cacheWriteTokens: 0,
          exampleIds: [],
          costMicros: 500,
          latencyMs: 640,
          createdAt: NOW,
        } satisfies AiReadRow);
      });

      it.each([
        ['a numbered rule', 3],
        ['uncovered', 'uncovered'],
        ['no rule', null],
      ] as const)('a read with %s round-trips', (_label, rule) => {
        const s = ai(make());
        const r = read({ rule, recommendation: { verdict: 'noted', severity: 'rude', rule, evidence: ['L1'] } });
        okRead(s, 'r1', 'h1', NOW, r);
        expect(s.loadAiRead('r1')?.read).toEqual(r);
      });

      it('the ids of the casebook examples a read saw are stored with it, and default to none', () => {
        const s = ai(make());
        okRead(s, 'r1', 'h1', NOW);
        expect(s.loadAiRead('r1')?.exampleIds).toEqual([]);
        const id = reserve(s, { reportId: 'r2' });
        expect(complete(s, id, done({ exampleIds: ['o1', 'o7'] }))).toBe(true);
        expect(s.loadAiRead('r2')?.exampleIds).toEqual(['o1', 'o7']);
        expect(s.loadAiReads(['r2'])[0]?.exampleIds).toEqual(['o1', 'o7']);
      });

      it('a null recommendation, an empty evidence list and a multi-digit rule round-trip', () => {
        const s = ai(make());
        const r = read({ rule: 12, evidence: [], recommendation: null });
        okRead(s, 'r1', 'h1', NOW, r);
        expect(s.loadAiRead('r1')?.read).toEqual(r);
      });

      it('complete is true once: unknown, already ok, failed and declined rows answer false and do not move the token', () => {
        const s = ai(make());
        const ok = okRead(s, 'r1', 'h1', NOW);
        const bad = reserve(s, { reportId: 'r2' });
        fail(s, bad, 'failed', 'retryable', NOW + MIN);
        const dec = reserve(s, { reportId: 'r3' });
        fail(s, dec, 'declined', 'declined', null);
        const before = s.changeToken();
        expect(complete(s, ok, done({ read: read({ summary: 'other' }) }))).toBe(false);
        expect(complete(s, bad, done())).toBe(false);
        expect(complete(s, dec, done())).toBe(false);
        expect(complete(s, 'nope', done())).toBe(false);
        expect(s.changeToken()).toBe(before);
        expect(s.loadAiRead('r1')?.read?.summary).toBe(read().summary);
      });

      it('an undone transaction undoes a completion and its token move', () => {
        const s = ai(make());
        const id = reserve(s);
        const before = s.changeToken();
        expect(() =>
          s.transaction(() => {
            complete(s, id, done());
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.changeToken()).toBe(before);
        expect(s.loadAiRead('r1')).toBeNull();
        expect(complete(s, id, done())).toBe(true);
      });

      it('fail records the kind and the retry time', () => {
        const s = ai(make());
        const id = reserve(s);
        expect(fail(s, id, 'failed', 'timeout', NOW + 10 * MIN)).toBe(true);
        const row = rsv(s, pending(), NOW + 99 * MIN, NOW + 31_000);
        expect(row.reserved).toBe(false);
        if (!row.reserved) {
          expect(row.existing).toMatchObject({
            id,
            status: 'failed',
            errorKind: 'timeout',
            retryAt: NOW + 10 * MIN,
            leaseUntil: null,
            attempts: 1,
            read: null,
            costMicros: 0,
          });
        }
      });

      it('fail does not move the change token and refuses a row that is not pending', () => {
        const s = ai(make());
        const id = reserve(s);
        const before = s.changeToken();
        expect(fail(s, id, 'failed', 'retryable', NOW + MIN)).toBe(true);
        expect(s.changeToken()).toBe(before);
        expect(fail(s, id, 'invalid', 'invalid', null)).toBe(false); // already failed
        expect(fail(s, 'nope', 'failed', 'fatal', null)).toBe(false);
        const ok = okRead(s, 'r2', 'h1', NOW);
        expect(fail(s, ok, 'failed', 'fatal', null)).toBe(false);
        expect(s.loadAiRead('r2')?.status).toBe('ok');
      });

      it('a failure that carries usage records the model, tokens, cost and latency', () => {
        const s = ai(make());
        const id = reserve(s);
        expect(fail(s, id, 'invalid', 'invalid', null, usage({ costMicros: 321, latencyMs: 77, model: 'm2' }))).toBe(true);
        const row = rsv(s, pending(), NOW + MIN, NOW + 1);
        if (!row.reserved) {
          expect(row.existing).toMatchObject({ status: 'invalid', model: 'm2', costMicros: 321, latencyMs: 77, inputTokens: 1200, outputTokens: 80, read: null });
        } else {
          throw new Error('expected the existing row');
        }
      });
    });

    describe('loadAiRead / loadAiReads', () => {
      it('loadAiRead returns the newest ok read, whatever its hash', () => {
        const s = ai(make());
        okRead(s, 'r1', 'old', NOW, read({ summary: 'older' }));
        const newer = okRead(s, 'r1', 'new', NOW + MIN, read({ summary: 'newer' }));
        okRead(s, 'r2', 'x', NOW + 5 * MIN, read({ summary: 'other report' }));
        expect(s.loadAiRead('r1')).toMatchObject({ id: newer, inputHash: 'new', read: { summary: 'newer' } });
      });

      it('on equal creation times the larger id wins, in both stores', () => {
        const s = ai(make());
        const a = okRead(s, 'r1', 'a', NOW);
        const b = okRead(s, 'r1', 'b', NOW);
        const winner = a > b ? a : b;
        expect(s.loadAiRead('r1')?.id).toBe(winner);
        expect(s.loadAiReads(['r1'])[0]?.id).toBe(winner);
      });

      it('loadAiRead ignores pending, failed, declined, invalid and skipped rows', () => {
        const s = ai(make());
        const good = okRead(s, 'r1', 'good', NOW);
        reserve(s, { inputHash: 'p' }, NOW + 1 * MIN);
        const f = reserve(s, { inputHash: 'f' }, NOW + 2 * MIN);
        fail(s, f, 'failed', 'retryable', NOW + 99 * MIN);
        const d = reserve(s, { inputHash: 'd' }, NOW + 3 * MIN);
        fail(s, d, 'declined', 'declined', null);
        const i = reserve(s, { inputHash: 'i' }, NOW + 4 * MIN);
        fail(s, i, 'invalid', 'invalid', null);
        const k = reserve(s, { inputHash: 'k' }, NOW + 5 * MIN);
        fail(s, k, 'skipped', 'budget', null);
        expect(s.loadAiRead('r1')?.id).toBe(good);
        expect(s.loadAiRead('r1')?.status).toBe('ok');
      });

      it('loadAiRead is null for an unknown report, or one with no ok read', () => {
        const s = ai(make());
        reserve(s);
        expect(s.loadAiRead('r1')).toBeNull();
        expect(s.loadAiRead('nope')).toBeNull();
      });

      it('loadAiReads returns nothing for unknown ids and at most 200', () => {
        const s = ai(make());
        expect(s.loadAiReads([])).toEqual([]);
        expect(s.loadAiReads(['nope', 'nada'])).toEqual([]);
        const many: string[] = [];
        for (let i = 0; i < 230; i++) {
          const rid = `bulk${String(i).padStart(3, '0')}`;
          many.push(rid);
          okRead(s, rid, 'h', NOW + i);
        }
        expect(s.loadAiReads(many)).toHaveLength(200);
        expect(s.loadAiReads(many.slice(0, 5))).toHaveLength(5);
        expect(s.loadAiReads(['nope', ...many.slice(0, 3)])).toHaveLength(3);
      });

      it('loadAiReads gives each report its newest ok read once, even for a repeated id', () => {
        const s = ai(make());
        okRead(s, 'r1', 'a', NOW, read({ summary: 'one old' }));
        okRead(s, 'r1', 'b', NOW + MIN, read({ summary: 'one new' }));
        okRead(s, 'r2', 'a', NOW, read({ summary: 'two' }));
        reserve(s, { reportId: 'r3' }); // pending: no read
        const rows = s.loadAiReads(['r1', 'r2', 'r3', 'r1']);
        expect(rows.map((r) => [r.reportId, r.read?.summary]).sort()).toEqual([
          ['r1', 'one new'],
          ['r2', 'two'],
        ]);
      });
    });

    describe('aiSpendSince', () => {
      it('sums micros and counts calls from the given time (inclusive)', () => {
        const s = ai(make());
        expect(s.aiSpendSince(0)).toEqual({ micros: 0, calls: 0 });
        okRead(s, 'a', 'h', MIDNIGHT - 1, read(), 900); // yesterday
        okRead(s, 'b', 'h', MIDNIGHT, read(), 100);
        okRead(s, 'c', 'h', MIDNIGHT + H, read(), 250);
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 350, calls: 2 });
        expect(s.aiSpendSince(MIDNIGHT + 1)).toEqual({ micros: 250, calls: 1 });
        expect(s.aiSpendSince(MIDNIGHT - 1)).toEqual({ micros: 1250, calls: 3 });
        expect(s.aiSpendSince(MIDNIGHT + DAY)).toEqual({ micros: 0, calls: 0 });
      });

      it('a failed read with cost counts', () => {
        const s = ai(make());
        const a = reserve(s, { reportId: 'a' }, MIDNIGHT + H);
        fail(s, a, 'invalid', 'invalid', null, usage({ costMicros: 420 }));
        const b = reserve(s, { reportId: 'b' }, MIDNIGHT + H);
        fail(s, b, 'declined', 'declined', null, usage({ costMicros: 30 }));
        const c = reserve(s, { reportId: 'c' }, MIDNIGHT + H);
        fail(s, c, 'failed', 'retryable', NOW);
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 450, calls: 3 });
      });

      it('a skipped read costs nothing and is not a call; a pending one is a call that has not cost yet', () => {
        const s = ai(make());
        const k = reserve(s, { reportId: 'k' }, MIDNIGHT + H);
        fail(s, k, 'skipped', 'budget', null);
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 0, calls: 0 });
        reserve(s, { reportId: 'p' }, MIDNIGHT + H);
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 0, calls: 1 });
      });

      it('survives a day boundary from the clock: yesterday spend does not count today', () => {
        const s = ai(make());
        okRead(s, 'y1', 'h', MIDNIGHT - 2 * H, read(), 600_000);
        okRead(s, 'y2', 'h', MIDNIGHT - 1, read(), 399_999);
        expect(s.aiSpendSince(MIDNIGHT).micros).toBe(0);
        okRead(s, 't1', 'h', MIDNIGHT, read(), 1);
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 1, calls: 1 });
        expect(s.aiSpendSince(MIDNIGHT - DAY).micros).toBe(1_000_000);
      });

      it('spend accumulates per attempt: a failed attempt that cost 500, then a retry that cost 700, is 1200 micros and 2 calls', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW);
        expect(fail(s, id, 'failed', 'retryable', NOW + MIN, usage({ costMicros: 500 }))).toBe(true);
        expect(rsv(s, pending(), NOW + 9 * MIN, NOW + MIN)).toEqual({ reserved: true, id, lease: 2 });
        expect(complete(s, id, done({ costMicros: 700 }))).toBe(true);
        expect(s.aiSpendSince(0)).toEqual({ micros: 1200, calls: 2 });
        expect(s.loadAiRead('r1')).toMatchObject({ attempts: 2, costMicros: 1200 });
      });

      it('a take-over across midnight books each attempt to the day it was made', () => {
        const s = ai(make());
        const late = MIDNIGHT + DAY - 30_000; // 23:59:30 on day 1
        const id = reserve(s, {}, late, late + MIN);
        expect(fail(s, id, 'failed', 'retryable', late + MIN, usage({ costMicros: 500 }))).toBe(true);
        const nextDay = MIDNIGHT + DAY + 30_000; // 00:00:30 on day 2
        expect(rsv(s, pending(), nextDay + MIN, nextDay)).toEqual({ reserved: true, id, lease: 2 });
        expect(complete(s, id, done({ costMicros: 700 }))).toBe(true);
        expect(s.aiSpendSince(MIDNIGHT + DAY)).toEqual({ micros: 700, calls: 1 }); // day 2
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 1200, calls: 2 }); // day 1 and day 2
        expect(s.aiSpendSince(nextDay + 1)).toEqual({ micros: 0, calls: 0 });
      });

      it('an abandoned attempt (its lease lapsed) is still one call; the retry is a second', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW, NOW + MIN);
        expect(rsv(s, pending(), NOW + 9 * MIN, NOW + 2 * MIN).reserved).toBe(true);
        expect(complete(s, id, done({ costMicros: 40 }))).toBe(true);
        expect(s.aiSpendSince(0)).toEqual({ micros: 40, calls: 2 });
        expect(s.aiSpendSince(NOW + MIN)).toEqual({ micros: 40, calls: 1 });
      });

      it('a skipped attempt was never a call: it leaves the ledger, an earlier attempt stays', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW);
        fail(s, id, 'failed', 'retryable', NOW + MIN, usage({ costMicros: 10 }));
        rsv(s, pending(), NOW + 9 * MIN, NOW + MIN);
        expect(fail(s, id, 'skipped', 'budget', null)).toBe(true);
        expect(s.aiSpendSince(0)).toEqual({ micros: 10, calls: 1 });
      });
    });


    describe('the lease fence', () => {
      /** A reserves, stalls; B takes the lease over at the next attempt. Returns both tokens. */
      function takeOver(s: Store & Ai): { id: string; a: number; b: number } {
        const r1 = s.reserveAiRead(pending(), NOW + MIN, NOW);
        const r2 = s.reserveAiRead(pending(), NOW + 9 * MIN, NOW + 2 * MIN);
        if (!r1.reserved || !r2.reserved) throw new Error('expected two reservations');
        expect(r2.id).toBe(r1.id);
        return { id: r1.id, a: r1.lease, b: r2.lease };
      }

      it('each take-over issues a larger token', () => {
        const s = ai(make());
        const { a, b } = takeOver(s);
        expect(a).toBe(1);
        expect(b).toBe(2);
      });

      it('a stale owner cannot complete a row that was taken over, and the new owner still can', () => {
        const s = ai(make());
        const { id, a, b } = takeOver(s);
        const token = s.changeToken();
        expect(s.completeAiRead(id, a, done({ costMicros: 300, read: read({ summary: 'stale' }) }))).toBe(false);
        expect(s.changeToken()).toBe(token);
        expect(s.loadAiRead('r1')).toBeNull();
        expect(s.completeAiRead(id, b, done({ costMicros: 400, read: read({ summary: 'fresh' }) }))).toBe(true);
        expect(s.loadAiRead('r1')).toMatchObject({ status: 'ok', costMicros: 400, read: { summary: 'fresh' } });
        expect(s.aiSpendSince(0)).toEqual({ micros: 700, calls: 2 }); // the stale 300 is booked as well
      });

      it('a stale owner that finishes with usage still has its paid call booked; the row keeps only the new owner result', () => {
        const s = ai(make());
        const { id, a, b } = takeOver(s);
        const token = s.changeToken();
        expect(s.completeAiRead(id, a, done({ costMicros: 300, inputTokens: 11, read: read({ summary: 'stale' }) }))).toBe(false);
        expect(s.changeToken()).toBe(token);
        expect(s.aiSpendSince(0)).toEqual({ micros: 300, calls: 2 });
        expect(s.completeAiRead(id, b, done({ costMicros: 700, inputTokens: 22, read: read({ summary: 'fresh' }) }))).toBe(true);
        expect(s.aiSpendSince(0)).toEqual({ micros: 1000, calls: 2 });
        expect(s.loadAiRead('r1')).toMatchObject({ costMicros: 700, inputTokens: 22, read: { summary: 'fresh' }, attempts: 2 });
      });

      it('a stale owner that fails with usage is booked too, to the day of its own attempt', () => {
        const s = ai(make());
        const late = MIDNIGHT + DAY - 30_000;
        const r1 = s.reserveAiRead(pending(), late + MIN, late);
        const nextDay = MIDNIGHT + DAY + 2 * MIN;
        const r2 = s.reserveAiRead(pending(), nextDay + 9 * MIN, nextDay);
        if (!r1.reserved || !r2.reserved) throw new Error('expected two reservations');
        expect(s.failAiRead(r1.id, r1.lease, 'invalid', 'invalid', null, usage({ costMicros: 250 }))).toBe(false);
        expect(s.aiSpendSince(MIDNIGHT + DAY)).toEqual({ micros: 0, calls: 1 }); // day 2 holds only the new attempt
        expect(s.aiSpendSince(MIDNIGHT)).toEqual({ micros: 250, calls: 2 });
        expect(s.loadAiRead('r1')).toBeNull();
        expect(s.completeAiRead(r2.id, r2.lease, done({ costMicros: 5 }))).toBe(true);
        expect(s.loadAiRead('r1')?.costMicros).toBe(5);
      });

      it('a stale call is booked once: repeating it, or a second stale call, adds nothing more', () => {
        const s = ai(make());
        const { id, a } = takeOver(s);
        expect(s.completeAiRead(id, a, done({ costMicros: 300 }))).toBe(false);
        expect(s.completeAiRead(id, a, done({ costMicros: 300 }))).toBe(false);
        expect(s.failAiRead(id, a, 'invalid', 'invalid', null, usage({ costMicros: 300 }))).toBe(false);
        expect(s.aiSpendSince(0).micros).toBe(300);
      });

      it('a repeated call by the current owner after it finished is not booked again', () => {
        const s = ai(make());
        const id = reserve(s);
        expect(complete(s, id, done({ costMicros: 40 }))).toBe(true);
        expect(complete(s, id, done({ costMicros: 40 }))).toBe(false);
        expect(fail(s, id, 'invalid', 'invalid', null, usage({ costMicros: 40 }))).toBe(false);
        expect(s.aiSpendSince(0)).toEqual({ micros: 40, calls: 1 });
      });

      it('a stale call for an unknown row or a future token books nothing', () => {
        const s = ai(make());
        const id = reserve(s);
        expect(s.completeAiRead('nope', 1, done({ costMicros: 9 }))).toBe(false);
        expect(s.completeAiRead(id, 9, done({ costMicros: 9 }))).toBe(false);
        expect(s.failAiRead(id, 0, 'invalid', 'invalid', null, usage({ costMicros: 9 }))).toBe(false);
        expect(s.aiSpendSince(0)).toEqual({ micros: 0, calls: 1 });
      });

      it('a stale owner cannot fail a row the new owner is working on', () => {
        const s = ai(make());
        const { id, a, b } = takeOver(s);
        expect(s.failAiRead(id, a, 'failed', 'fatal', null, usage({ costMicros: 999 }))).toBe(false);
        const row = s.listAiRetries(NOW + 3 * MIN, 10);
        expect(row).toEqual([]); // still pending under B's live lease
        expect(s.completeAiRead(id, b, done({ costMicros: 5 }))).toBe(true);
        expect(s.aiSpendSince(0).micros).toBe(1004); // 999 from the stale owner, 5 from the new one
      });

      it('a stale owner cannot touch the row after the new owner has finished it either', () => {
        const s = ai(make());
        const { id, a, b } = takeOver(s);
        expect(s.failAiRead(id, b, 'failed', 'retryable', NOW + 10 * MIN)).toBe(true);
        expect(s.completeAiRead(id, a, done())).toBe(false);
        expect(s.failAiRead(id, a, 'invalid', 'invalid', null)).toBe(false);
        expect(s.listAiRetries(NOW + 11 * MIN, 10)).toHaveLength(1);
      });

      it('a token from the future, zero or a non-integer matches nothing', () => {
        const s = ai(make());
        const id = reserve(s);
        expect(s.completeAiRead(id, 2, done())).toBe(false);
        expect(s.completeAiRead(id, 0, done())).toBe(false);
        expect(s.completeAiRead(id, 1.5, done())).toBe(false);
        expect(s.failAiRead(id, 2, 'failed', 'fatal', null)).toBe(false);
        expect(complete(s, id, done())).toBe(true);
      });
    });

    describe('listAiRetries', () => {
      it('returns due failed reads and expired leases, oldest first, bounded', () => {
        const s = ai(make());
        const late = reserve(s, { reportId: 'late' }, NOW + 4 * MIN, NOW + 99 * MIN);
        fail(s, late, 'failed', 'retryable', NOW + 10 * MIN);
        const expired = reserve(s, { reportId: 'expired' }, NOW + 2 * MIN, NOW + 3 * MIN);
        const due = reserve(s, { reportId: 'due' }, NOW + 1 * MIN, NOW + 99 * MIN);
        fail(s, due, 'failed', 'timeout', NOW + 5 * MIN);
        const asOf = NOW + 20 * MIN;
        expect(ids(s.listAiRetries(asOf, 10))).toEqual([due, expired, late]);
        expect(ids(s.listAiRetries(asOf, 2))).toEqual([due, expired]);
        expect(ids(s.listAiRetries(asOf, 1))).toEqual([due]);
      });

      it('leaves out reads not yet due, live leases, final rows and ok reads', () => {
        const s = ai(make());
        const notYet = reserve(s, { reportId: 'notyet' });
        fail(s, notYet, 'failed', 'retryable', NOW + 50 * MIN);
        const live = reserve(s, { reportId: 'live' }, NOW, NOW + 50 * MIN);
        const fatal = reserve(s, { reportId: 'fatal' });
        fail(s, fatal, 'failed', 'fatal', null);
        const dec = reserve(s, { reportId: 'dec' });
        fail(s, dec, 'declined', 'declined', null);
        const inv = reserve(s, { reportId: 'inv' });
        fail(s, inv, 'invalid', 'invalid', null);
        okRead(s, 'ok', 'h', NOW);
        expect(s.listAiRetries(NOW + 10 * MIN, 50)).toEqual([]);
        // The boundaries are inclusive for a retry time and for a lease end (a lease is live strictly before its end).
        expect(ids(s.listAiRetries(NOW + 50 * MIN, 50)).sort()).toEqual([notYet, live].sort());
      });

      it('includes a skipped read once its retry time has come', () => {
        const s = ai(make());
        const k = reserve(s, { reportId: 'k' });
        fail(s, k, 'skipped', 'budget', MIDNIGHT + DAY);
        expect(s.listAiRetries(MIDNIGHT + DAY - 1, 10)).toEqual([]);
        expect(ids(s.listAiRetries(MIDNIGHT + DAY, 10))).toEqual([k]);
      });

      it('returns whole rows, and a taken-over row drops out of the list', () => {
        const s = ai(make());
        const id = reserve(s, {}, NOW, NOW + MIN);
        const [row] = s.listAiRetries(NOW + 2 * MIN, 5);
        expect(row).toMatchObject({ id, reportId: 'r1', status: 'pending', attempts: 1, read: null });
        rsv(s, pending(), NOW + 9 * MIN, NOW + 2 * MIN);
        expect(s.listAiRetries(NOW + 3 * MIN, 5)).toEqual([]);
      });

      it('a limit is floored and used as given; at most 200', () => {
        const s = ai(make());
        for (let i = 0; i < 205; i++) reserve(s, { reportId: `lim${String(i).padStart(3, '0')}` }, NOW + i, NOW + MIN);
        expect(s.listAiRetries(NOW + 9 * MIN, 1.9)).toHaveLength(1);
        expect(s.listAiRetries(NOW + 9 * MIN, 7)).toHaveLength(7);
        expect(s.listAiRetries(NOW + 9 * MIN, 5000)).toHaveLength(200);
      });

      it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5, 0.4])(
        'a limit of %s falls back to the default page of %i rows, the same as an omitted limit',
        (limit) => {
          const s = ai(make());
          for (let i = 0; i < 25; i++) reserve(s, { reportId: `dflt${String(i).padStart(2, '0')}` }, NOW + i, NOW + MIN);
          expect(s.listAiRetries(NOW + 9 * MIN, limit)).toHaveLength(RETRIES_DEFAULT);
          expect(s.listAiRetries(NOW + 9 * MIN, undefined)).toHaveLength(RETRIES_DEFAULT);
        },
      );
    });

    describe('outcomes', () => {
      it('outcomes: insert is once per report; markAiOutcome reversed and dontTeach exclude a row from aiExamples', () => {
        const s = ai(make());
        const first = outcome({ reportId: 'x1' });
        expect(s.insertAiOutcome(first)).toBe(true);
        expect(s.insertAiOutcome(outcome({ reportId: 'x1', verdict: 'no_action', agreement: 'override' }))).toBe(false);
        expect(s.loadAiOutcome('x1')).toEqual({ ...first, reversed: false, dontTeach: false } satisfies AiOutcomeRow);
        for (const id of ['x2', 'x3']) s.insertAiOutcome(outcome({ reportId: id, decidedAt: NOW + (id === 'x2' ? 1 : 2) }));
        expect(reportIds(s.aiExamples('3', 'hostile', 10, 0)).sort()).toEqual(['x1', 'x2', 'x3']);
        expect(s.markAiOutcome('x2', { reversed: true })).toBe(true);
        expect(s.markAiOutcome('x3', { dontTeach: true })).toBe(true);
        expect(reportIds(s.aiExamples('3', 'hostile', 10, 0))).toEqual(['x1']);
        expect(s.aiTeachableCount(0)).toBe(1);
        expect(s.loadAiOutcome('x2')).toMatchObject({ reversed: true, dontTeach: false });
        expect(s.loadAiOutcome('x3')).toMatchObject({ reversed: false, dontTeach: true });
      });

      it('loadAiOutcome is null for an unknown report; a null readId, rule, severity and example round-trip', () => {
        const s = ai(make());
        expect(s.loadAiOutcome('nope')).toBeNull();
        const bare = outcome({ reportId: 'bare', readId: null, rule: null, severity: null, aiVerdict: null, agreement: 'none', level: 1, example: null });
        s.insertAiOutcome(bare);
        expect(s.loadAiOutcome('bare')).toEqual({ ...bare, reversed: false, dontTeach: false });
      });

      it('a bad-faith dismissal keeps its flag on the row', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'bf', verdict: 'no_action', agreement: 'override', badFaith: true }));
        expect(s.loadAiOutcome('bf')).toMatchObject({ badFaith: true, agreement: 'override' });
      });

      it('markAiOutcome answers false for an unknown report, true for a known one, and flags stay set', () => {
        const s = ai(make());
        expect(s.markAiOutcome('nope', { reversed: true })).toBe(false);
        s.insertAiOutcome(outcome({ reportId: 'k' }));
        expect(s.markAiOutcome('k', { reversed: true, dontTeach: true })).toBe(true);
        expect(s.markAiOutcome('k', {})).toBe(true);
        expect(s.markAiOutcome('k', { reversed: true })).toBe(true);
        expect(s.loadAiOutcome('k')).toMatchObject({ reversed: true, dontTeach: true });
      });

      it('markAiOutcome bumps the change token for a known report, and an unknown one does not', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'k' }));
        const a = s.changeToken();
        s.markAiOutcome('nope', { reversed: true });
        expect(s.changeToken()).toBe(a);
        s.markAiOutcome('k', { dontTeach: true });
        expect(s.changeToken()).not.toBe(a);
      });

      it('an outcome insert does not move the change token (the decision it joins does)', () => {
        const s = ai(make());
        const a = s.changeToken();
        s.insertAiOutcome(outcome());
        expect(s.changeToken()).toBe(a);
      });

      it('an undone transaction undoes an insert and a mark', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'keep' }));
        expect(() =>
          s.transaction(() => {
            s.insertAiOutcome(outcome({ reportId: 'gone' }));
            s.markAiOutcome('keep', { reversed: true });
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadAiOutcome('gone')).toBeNull();
        expect(s.loadAiOutcome('keep')?.reversed).toBe(false);
        expect(s.insertAiOutcome(outcome({ reportId: 'gone' }))).toBe(true);
      });


      it('a mark that stops a row teaching also drops its example text; the counts stay', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'a' }));
        s.insertAiOutcome(outcome({ reportId: 'b' }));
        s.insertAiOutcome(outcome({ reportId: 'c' }));
        s.markAiOutcome('a', { reversed: true });
        s.markAiOutcome('b', { dontTeach: true });
        expect(s.loadAiOutcome('a')).toMatchObject({ reversed: true, example: null, verdict: 'upheld', agreement: 'agree' });
        expect(s.loadAiOutcome('b')).toMatchObject({ dontTeach: true, example: null });
        expect(s.loadAiOutcome('c')?.example).toEqual(example()); // control: an unmarked row keeps its text
        expect(s.aiStats(0)[0]).toMatchObject({ decided: 3 });
      });

      it('a bad-faith outcome is stored without example text', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'bf', badFaith: true, verdict: 'no_action', agreement: 'override' }));
        expect(s.loadAiOutcome('bf')).toMatchObject({ badFaith: true, example: null, agreement: 'override' });
      });

      it('returns copies', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'c' }));
        const row = s.loadAiOutcome('c');
        if (row?.example) row.example.lines.length = 0;
        if (row) row.reversed = true;
        expect(s.loadAiOutcome('c')?.example?.lines).toHaveLength(2);
        expect(s.loadAiOutcome('c')?.reversed).toBe(false);
      });
    });

    describe('aiExamples / aiTeachableCount', () => {
      it('aiExamples picks the same rule and severity, newest first, teachable only, within the example window', () => {
        const s = ai(make());
        const add = (reportId: string, over: Partial<AiOutcomeInsert>) => s.insertAiOutcome(outcome({ reportId, ...over }));
        add('old', { decidedAt: NOW - 200 * DAY });
        add('a', { decidedAt: NOW - 3 * DAY });
        add('b', { decidedAt: NOW - 1 * DAY, agreement: 'override', verdict: 'no_action', aiVerdict: 'upheld' });
        add('c', { decidedAt: NOW - 2 * DAY });
        add('otherRule', { decidedAt: NOW, rule: '4' });
        add('otherSeverity', { decidedAt: NOW, severity: 'rude' });
        add('uncoveredRule', { decidedAt: NOW, rule: 'uncovered' });
        add('noExample', { decidedAt: NOW, example: null });
        add('none', { decidedAt: NOW, agreement: 'none', aiVerdict: null });
        add('badFaith', { decidedAt: NOW, badFaith: true, verdict: 'no_action', agreement: 'override' });
        add('rev', { decidedAt: NOW });
        add('dont', { decidedAt: NOW });
        s.markAiOutcome('rev', { reversed: true });
        s.markAiOutcome('dont', { dontTeach: true });
        const since = NOW - 180 * DAY;
        const rows = s.aiExamples('3', 'hostile', 10, since);
        expect(reportIds(rows)).toEqual(['b', 'c', 'a']);
        expect(rows[0]).toEqual({ reportId: 'b', decidedAt: NOW - DAY, agreement: 'override', example: example() } satisfies AiExampleRow);
        expect(rows[2]?.agreement).toBe('agree');
        expect(reportIds(s.aiExamples('3', 'hostile', 2, since))).toEqual(['b', 'c']);
        expect(reportIds(s.aiExamples('3', 'hostile', 10, 0))).toEqual(['b', 'c', 'a', 'old']);
        expect(reportIds(s.aiExamples('uncovered', 'hostile', 10, 0))).toEqual(['uncoveredRule']);
        expect(s.aiExamples('9', 'hostile', 10, 0)).toEqual([]);
      });

      it('the window start is inclusive; equal times order by report id, newest id first', () => {
        const s = ai(make());
        for (const id of ['e1', 'e3', 'e2']) s.insertAiOutcome(outcome({ reportId: id, decidedAt: NOW }));
        s.insertAiOutcome(outcome({ reportId: 'edge', decidedAt: NOW - DAY }));
        expect(reportIds(s.aiExamples('3', 'hostile', 10, NOW - DAY))).toEqual(['e3', 'e2', 'e1', 'edge']);
        expect(reportIds(s.aiExamples('3', 'hostile', 10, NOW - DAY + 1))).toEqual(['e3', 'e2', 'e1']);
      });

      it('a limit is floored and used as given', () => {
        const s = ai(make());
        for (let i = 0; i < 6; i++) s.insertAiOutcome(outcome({ reportId: `l${i}` }));
        expect(s.aiExamples('3', 'hostile', 1.9, 0)).toHaveLength(1);
        expect(s.aiExamples('3', 'hostile', 4, 0)).toHaveLength(4);
      });

      it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5, 0.4])(
        'a limit of %s falls back to the default of %i examples, the same as an omitted limit',
        (limit) => {
          const s = ai(make());
          for (let i = 0; i < 6; i++) s.insertAiOutcome(outcome({ reportId: `d${i}` }));
          expect(s.aiExamples('3', 'hostile', limit, 0)).toHaveLength(EXAMPLES_DEFAULT);
          expect(s.aiExamples('3', 'hostile', undefined, 0)).toHaveLength(EXAMPLES_DEFAULT);
        },
      );

      it('aiTeachableCount counts every teachable example across rules, within the window', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'a' }));
        s.insertAiOutcome(outcome({ reportId: 'b', rule: '4', severity: 'rude' }));
        s.insertAiOutcome(outcome({ reportId: 'c', decidedAt: NOW - 300 * DAY }));
        s.insertAiOutcome(outcome({ reportId: 'noEx', example: null }));
        s.insertAiOutcome(outcome({ reportId: 'none', agreement: 'none', aiVerdict: null }));
        s.insertAiOutcome(outcome({ reportId: 'bf', badFaith: true }));
        s.insertAiOutcome(outcome({ reportId: 'rev' }));
        s.markAiOutcome('rev', { reversed: true });
        expect(s.aiTeachableCount(0)).toBe(3);
        expect(s.aiTeachableCount(NOW - 180 * DAY)).toBe(2);
        expect(s.aiTeachableCount(NOW + 1)).toBe(0);
      });
    });

    describe('aiStats', () => {
      it('aiStats counts agree, override, none, and ai false positives per rule', () => {
        const s = ai(make());
        const add = (reportId: string, over: Partial<AiOutcomeInsert>) => s.insertAiOutcome(outcome({ reportId, example: null, ...over }));
        // rule 3
        add('a1', {}); // agree
        add('a2', { aiVerdict: 'noted', verdict: 'noted' }); // agree
        add('a3', { aiVerdict: 'upheld', verdict: 'no_action', agreement: 'override' }); // override and false positive
        add('a4', { aiVerdict: 'noted', verdict: 'no_action', agreement: 'override' }); // override and false positive
        add('a5', { aiVerdict: 'no_action', verdict: 'upheld', agreement: 'override' }); // override, not a false positive
        add('a6', { aiVerdict: null, agreement: 'none', level: 1 }); // none
        add('a7', {}); // agree, later reversed: a false positive
        s.markAiOutcome('a7', { reversed: true });
        add('a8', { aiVerdict: 'no_action', verdict: 'no_action' }); // agree; reversed no_action is not a false positive
        s.markAiOutcome('a8', { reversed: true });
        // uncovered
        add('u1', { rule: 'uncovered', severity: null });
        // no rule
        add('n1', { rule: null, verdict: 'no_action', aiVerdict: 'no_action' });
        // outside the window
        add('old', { decidedAt: NOW - 60 * DAY });
        const stats = s.aiStats(NOW - 30 * DAY);
        expect(stats).toEqual([
          { rule: '3', decided: 8, agree: 4, override: 3, none: 1, falsePositives: 3 },
          { rule: 'uncovered', decided: 1, agree: 1, override: 0, none: 0, falsePositives: 0 },
          { rule: null, decided: 1, agree: 1, override: 0, none: 0, falsePositives: 0 },
        ] satisfies AiStatsRow[]);
        expect(s.aiStats(NOW - 90 * DAY)[0]).toMatchObject({ rule: '3', decided: 9 });
        expect(s.aiStats(NOW + 1)).toEqual([]);
      });

      it('orders numbered rules by number (10 after 2), then uncovered, then no rule', () => {
        const s = ai(make());
        for (const rule of [null, 'uncovered', '10', '2', '1']) s.insertAiOutcome(outcome({ reportId: `s${String(rule)}`, rule, example: null }));
        expect(s.aiStats(0).map((r) => r.rule)).toEqual(['1', '2', '10', 'uncovered', null]);
      });

      it('counts a bad-faith dismissal as the override it is', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'bf', verdict: 'no_action', agreement: 'override', badFaith: true, example: null }));
        expect(s.aiStats(0)).toEqual([{ rule: '3', decided: 1, agree: 0, override: 1, none: 0, falsePositives: 1 }]);
      });
    });

    describe('purge', () => {
      it('purge: reads go with their report; outcomes and examples use their own clocks; a null example_json is not an example', () => {
        const s = ai(make());
        // reads older and newer than the read window
        okRead(s, 'oldRead', 'h', NOW - 100 * DAY);
        okRead(s, 'newRead', 'h', NOW - 10 * DAY);
        reserve(s, { reportId: 'oldPending' }, NOW - 100 * DAY);
        // outcomes: a very old one, one past the examples clock only, a fresh one, and one with no example at all
        s.insertAiOutcome(outcome({ reportId: 'ancient', decidedAt: NOW - 400 * DAY }));
        s.insertAiOutcome(outcome({ reportId: 'mid', decidedAt: NOW - 200 * DAY }));
        s.insertAiOutcome(outcome({ reportId: 'fresh', decidedAt: NOW - 10 * DAY }));
        s.insertAiOutcome(outcome({ reportId: 'noText', decidedAt: NOW - 200 * DAY, example: null }));

        const res = s.purgeAi(NOW - 90 * DAY, NOW - 365 * DAY, NOW - 180 * DAY);
        expect(res).toEqual({ reads: 2, outcomes: 1 });
        expect(s.loadAiRead('oldRead')).toBeNull();
        expect(s.loadAiRead('newRead')).not.toBeNull();
        expect(rsv(s, pending({ reportId: 'oldPending' }), NOW + MIN, NOW).reserved).toBe(true);
        expect(s.loadAiOutcome('ancient')).toBeNull();
        // The row that outlives the examples clock keeps its counts but loses its text.
        expect(s.loadAiOutcome('mid')).toMatchObject({ reportId: 'mid', verdict: 'upheld', example: null });
        expect(s.loadAiOutcome('fresh')?.example).toEqual(example());
        expect(s.loadAiOutcome('noText')).not.toBeNull();
        expect(reportIds(s.aiExamples('3', 'hostile', 10, 0))).toEqual(['fresh']);
        expect(s.aiTeachableCount(0)).toBe(1);
        expect(s.aiStats(0)[0]).toMatchObject({ rule: '3', decided: 3 });
      });

      it('every cutoff is strict: a row exactly on the line is kept', () => {
        const s = ai(make());
        okRead(s, 'r', 'h', NOW - 90 * DAY);
        s.insertAiOutcome(outcome({ reportId: 'o', decidedAt: NOW - 365 * DAY }));
        s.insertAiOutcome(outcome({ reportId: 'e', decidedAt: NOW - 180 * DAY }));
        expect(s.purgeAi(NOW - 90 * DAY, NOW - 365 * DAY, NOW - 180 * DAY)).toEqual({ reads: 0, outcomes: 0 });
        expect(s.loadAiOutcome('e')?.example).not.toBeNull();
        expect(s.purgeAi(NOW - 90 * DAY + 1, NOW - 365 * DAY + 1, NOW - 180 * DAY + 1)).toEqual({ reads: 1, outcomes: 1 });
        expect(s.loadAiOutcome('e')?.example).toBeNull();
      });

      it('the retention sweep of reads also drops the spend ledger it covers (the spend cap only reads today)', () => {
        const s = ai(make());
        okRead(s, 'old', 'h', NOW - 100 * DAY, read(), 77);
        okRead(s, 'new', 'h', NOW - DAY, read(), 5);
        expect(s.aiSpendSince(0)).toEqual({ micros: 82, calls: 2 });
        s.purgeAi(NOW - 90 * DAY, 0, 0);
        expect(s.aiSpendSince(0)).toEqual({ micros: 5, calls: 1 });
      });

      it('an examples window of "now" (0 days kept) strips every example older than now and keeps the counts', () => {
        const s = ai(make());
        s.insertAiOutcome(outcome({ reportId: 'a', decidedAt: NOW - 1 }));
        s.insertAiOutcome(outcome({ reportId: 'b', decidedAt: NOW - 100 * DAY }));
        expect(s.purgeAi(0, 0, NOW)).toEqual({ reads: 0, outcomes: 0 });
        expect(s.loadAiOutcome('a')).toMatchObject({ example: null, agreement: 'agree' });
        expect(s.loadAiOutcome('b')).toMatchObject({ example: null });
        expect(s.aiTeachableCount(0)).toBe(0);
      });

      it('purging an empty store, or twice, deletes nothing', () => {
        const s = ai(make());
        expect(s.purgeAi(NOW, NOW, NOW)).toEqual({ reads: 0, outcomes: 0 });
        okRead(s, 'r', 'h', NOW - 100 * DAY);
        s.purgeAi(NOW, NOW, NOW);
        expect(s.purgeAi(NOW, NOW, NOW)).toEqual({ reads: 0, outcomes: 0 });
      });

      it('an undone transaction undoes a purge', () => {
        const s = ai(make());
        okRead(s, 'r', 'h', NOW - 100 * DAY);
        s.insertAiOutcome(outcome({ reportId: 'o', decidedAt: NOW - 100 * DAY }));
        expect(() =>
          s.transaction(() => {
            expect(s.purgeAi(NOW, NOW, NOW)).toEqual({ reads: 1, outcomes: 1 });
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadAiRead('r')).not.toBeNull();
        expect(s.loadAiOutcome('o')?.example).toEqual(example());
      });

      it('purgeReports deletes the report\'s reads in the same transaction and leaves its outcome to its own clock', () => {
        const s = ai(make());
        s.insertReport(report('old', NOW - 100 * DAY));
        s.insertReport(report('new', NOW - 10 * DAY));
        okRead(s, 'old', 'h1', NOW - 100 * DAY);
        okRead(s, 'old', 'h2', NOW - 99 * DAY);
        reserve(s, { reportId: 'old', inputHash: 'h3' }, NOW - 98 * DAY);
        okRead(s, 'new', 'h1', NOW - 10 * DAY);
        okRead(s, 'unfiled', 'h1', NOW - 100 * DAY); // a read whose report this store never saw is not an orphan sweep target
        s.insertAiOutcome(outcome({ reportId: 'old', decidedAt: NOW - 99 * DAY }));
        s.insertAiOutcome(outcome({ reportId: 'new', decidedAt: NOW - 10 * DAY }));

        expect(s.purgeReports(NOW - 90 * DAY, NOW - 30 * DAY)).toBe(1);
        expect(s.loadAiRead('old')).toBeNull();
        expect(rsv(s, pending({ reportId: 'old', inputHash: 'h3' }), NOW, NOW - 1).reserved).toBe(true); // the pending row went too
        expect(s.loadAiRead('new')).not.toBeNull();
        expect(s.loadAiRead('unfiled')).not.toBeNull();
        expect(s.loadAiOutcome('old')).not.toBeNull();
        expect(s.loadAiOutcome('new')).not.toBeNull();
      });

      it('purgeReports keeps the reads of a report it keeps (a bad-faith dismissal inside its window)', () => {
        const s = ai(make());
        s.insertReport(report('bf', NOW - 100 * DAY));
        s.closeReport('bf', 'dismissed', true, 'mod', NOW - 5 * DAY, 'n', 'evidence');
        okRead(s, 'bf', 'h', NOW - 100 * DAY);
        expect(s.purgeReports(NOW - 90 * DAY, NOW - 30 * DAY)).toBe(0);
        expect(s.loadAiRead('bf')).not.toBeNull();
      });

      it('purgeReports undone with its transaction brings the reads back', () => {
        const s = ai(make());
        s.insertReport(report('old', NOW - 100 * DAY));
        okRead(s, 'old', 'h1', NOW - 100 * DAY);
        expect(() =>
          s.transaction(() => {
            expect(s.purgeReports(NOW - 90 * DAY, NOW - 30 * DAY)).toBe(1);
            expect(s.loadAiRead('old')).toBeNull();
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadAiRead('old')).not.toBeNull();
        expect(s.loadReport('old')).not.toBeNull();
      });
    });
  });
}
