import { describe, expect, it } from 'vitest';
import { buildMatcher } from '../src/index.js';
import type { ExceptionRow, Matcher, TermRow } from '../src/index.js';
import { UNSPACED_WORK_MAX, coverIndex } from '../src/unspaced.js';

// Review m12: the unspaced matcher's cost is bounded. A bucket of terms that share their first two characters, a line of tens of thousands of characters with a hit at every position, and a pile of exception
// phrases covering them must all answer in well under a second, and a normal line must answer exactly as before. Timing bounds are generous (500 ms) so a slow machine does not fail them. Invented strings only.

const BOUND_MS = 500;
const han = (...cps: number[]): string => String.fromCodePoint(...cps);
const row = (term: string, language: string, matchMode?: TermRow['matchMode'], id = term): TermRow => ({ id, term, language, active: true, ...(matchMode === undefined ? {} : { matchMode }) });
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

/** `n` distinct 3-letter Han terms with the given first letter (and, when `second` is given, the same second letter too). */
function crowd(n: number, first: number, second?: number): TermRow[] {
  const rows: TermRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = second ?? 0x4e10 + (i % 80);
    const b = 0x4f00 + Math.floor(i / 80);
    rows.push(row(second === undefined ? han(first, a, b) : han(first, second, 0x4e20 + i), 'zh', 'contains'));
  }
  return rows;
}

describe('the first two characters pick the bucket (same answers, far fewer comparisons)', () => {
  it('6000 terms that share only their first character and a 2000-character line: match and spans answer fast', () => {
    const rows = crowd(6000, 0x4e00);
    const m = buildMatcher(rows, []);
    const line = han(0x4e00).repeat(2000);
    expect(timed(() => m.match(line)).ms).toBeLessThan(BOUND_MS);
    expect(timed(() => m.spans?.(line)).ms).toBeLessThan(BOUND_MS);
    // and it still finds a term in the middle of such a line
    const target = rows[4321] as TermRow;
    const hit = timed(() => m.match(`${line}${target.term}${line}`));
    expect(hit.ms).toBeLessThan(BOUND_MS);
    expect(hit.value).toEqual({ termId: target.id });
  });

  it('every one of 300 terms is found in a line that holds it, whichever its position in the bucket, and a line with none is clean', () => {
    const rows = crowd(300, 0x4e00);
    const m = buildMatcher(rows, []);
    for (const r of rows) expect(m.match(`${han(0x4e01)}${r.term}${han(0x4e02)}`), r.term).toEqual({ termId: r.id });
    expect(m.match(han(0x4e00, 0x4e01, 0x4e02, 0x4e00, 0x4e00))).toBeNull();
  });

  it('spans give the exact ranges of every term in a crowded bucket, matching a plain search of the line', () => {
    const rows = crowd(200, 0x4e00);
    const m = buildMatcher(rows, []);
    const picked = [rows[3], rows[77], rows[150], rows[3]] as TermRow[];
    const line = picked.map((r) => `${han(0x4e50)}${r.term}`).join('');
    const said = (m.spans?.(line) ?? []).map((s) => line.slice(s.start, s.end)).sort();
    expect(said).toEqual([...new Set(picked.map((r) => r.term))].flatMap((t) => Array(picked.filter((r) => r.term === t).length).fill(t) as string[]).sort());
  });
});

describe('the work of one call is bounded', () => {
  it('terms that share their first TWO characters and a long line of that prefix stop at the work budget, fast', () => {
    expect(UNSPACED_WORK_MAX).toBeGreaterThan(100_000);
    const m = buildMatcher(crowd(6000, 0x4e00, 0x4e01), []);
    const line = han(0x4e00, 0x4e01).repeat(10_000);
    const r = timed(() => m.match(line));
    expect(r.ms).toBeLessThan(BOUND_MS);
    const s = timed(() => m.spans?.(line));
    expect(s.ms).toBeLessThan(BOUND_MS);
  });

  it('a normal term list and a normal line never come near the budget: a hit at the end of a 2000-character line is still found', () => {
    const rows = crowd(500, 0x4e00, 0x4e01);
    const m = buildMatcher(rows, []);
    const line = `${han(0x4e00, 0x4e01).repeat(1000)}${(rows[499] as TermRow).term}`;
    expect(m.match(line)).toEqual({ termId: (rows[499] as TermRow).id });
  });
});

describe('exception phrases covering every hit do not make a line quadratic', () => {
  it('a 30000-character line with a term at every position and an exception phrase at every position answers fast', () => {
    const term = han(0x4e00, 0x4e00, 0x4e00);
    const exception: ExceptionRow = { id: 'x', phrase: han(0x4e00, 0x4e00), language: 'zh', active: true };
    const m: Matcher = buildMatcher([row(term, 'zh', 'contains')], [exception]);
    const line = han(0x4e00).repeat(30_000);
    const r = timed(() => m.spans?.(line));
    expect(r.ms).toBeLessThan(BOUND_MS);
    const first = timed(() => m.match(line));
    expect(first.ms).toBeLessThan(BOUND_MS);
  });
});

describe('coverIndex answers "is [i, end] inside a cover" exactly, in logarithmic time', () => {
  const brute = (covers: Array<[number, number]>, i: number, end: number): boolean => covers.some(([x, y]) => x <= i && end <= y);

  it('agrees with a plain scan over random covers and queries, sorted or not, with ties and nesting', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round += 1) {
      const covers: Array<[number, number]> = [];
      for (let k = rnd(12); k > 0; k -= 1) {
        const x = rnd(40);
        covers.push([x, x + 1 + rnd(15)]);
      }
      const index = coverIndex(covers);
      for (let q = 0; q < 40; q += 1) {
        const i = rnd(45);
        const end = i + 1 + rnd(12);
        expect(index.covers(i, end), `${JSON.stringify(covers)} ${i} ${end}`).toBe(brute(covers, i, end));
      }
    }
  });

  it('no covers cover nothing; a cover covers its own range and any inside it, not one that sticks out', () => {
    expect(coverIndex([]).covers(0, 1)).toBe(false);
    const index = coverIndex([[5, 10]]);
    expect(index.covers(5, 10)).toBe(true);
    expect(index.covers(6, 9)).toBe(true);
    expect(index.covers(4, 9)).toBe(false);
    expect(index.covers(6, 11)).toBe(false);
    expect(index.covers(10, 11)).toBe(false);
  });

  it('50000 covers and 50000 queries run in a fraction of a second', () => {
    const covers: Array<[number, number]> = Array.from({ length: 50_000 }, (_, i) => [i, i + 2]);
    const index = coverIndex(covers);
    const r = timed(() => {
      let n = 0;
      for (let i = 0; i < 50_000; i += 1) if (index.covers(i, i + 3)) n += 1;
      return n;
    });
    expect(r.value).toBe(0);
    expect(r.ms).toBeLessThan(BOUND_MS);
  });
});

describe('the bucketing changes no answer: random terms and lines against a plain search', () => {
  it('the characters covered by spans() are exactly those inside an occurrence of some term, over 150 random worlds', () => {
    let seed = 99;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = [0x4e00, 0x4e01, 0x4e02, 0x4e03];
    const word = (len: number): string => han(...Array.from({ length: len }, () => alphabet[rnd(alphabet.length)] as number));
    for (let round = 0; round < 150; round += 1) {
      const terms = [...new Set(Array.from({ length: 1 + rnd(12) }, () => word(3 + rnd(2))))];
      const m = buildMatcher(terms.map((t) => row(t, 'zh', 'contains')), []);
      const line = word(5 + rnd(60));
      const expected = new Set<number>();
      for (const t of terms) for (let at = line.indexOf(t); at !== -1; at = line.indexOf(t, at + 1)) for (let k = 0; k < t.length; k += 1) expected.add(at + k);
      const got = new Set<number>();
      for (const s of m.spans?.(line) ?? []) for (let k = s.start; k < s.end; k += 1) got.add(k);
      expect([...got].sort((x, y) => x - y), `${terms.join(',')} / ${line}`).toEqual([...expected].sort((x, y) => x - y));
      expect(m.match(line) !== null, `match ${line}`).toBe(expected.size > 0);
    }
  });
});
