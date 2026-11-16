import { describe, expect, it } from 'vitest';
import { LiveTerms, buildMatcher, type TermPack } from '../src/index.js';
import { MemoryTermStore } from '../src/fixtures/index.js';
import { parseTermsRelease } from '../src/corpus/release.js';
import { releaseToPack } from '../src/corpus/select.js';
import { exampleNegative, generatedTerms, inventedWords, releaseFiles } from './corpus-world.js';

// The size benchmark (design 9, "Performance"). A real list is thousands of rows, not the dozens the other tests use. The pack here is
// generated at run time from syllables, so no word of it is in the repository. The numbers print with CW_BENCH=1; the budgets are
// asserted either way, at 500 terms always and at 5 000 only when asked for (a CI run stays fast).

const FULL = process.env.CW_BENCH === '1';
const BUDGET = { buildMs: 300, matchMs: 2, changeMs: 600 };
const LINE = `honestly that was a really good game and ${'we all had a lot of fun playing together tonight '.repeat(3)}see you`.slice(0, 200);

function pack(terms: number): TermPack {
  const words = inventedWords(terms, 11);
  const rows = generatedTerms(words, () => ({ languages: ['en'], status: 'accepted', severity: 'severe' }));
  // A tenth as many exceptions as terms, every one active: with any active exception the edit check reads every positive line (the costly case).
  const exceptions = Array.from({ length: Math.floor(terms / 10) }, (_, i) => ({
    id: `CWX-2026-${String(i + 1).padStart(5, '0')}`,
    phrase: `${words[i]!} ${words[(i + 7) % words.length]!} lake`,
    languages: ['en'],
    status: 'accepted',
  }));
  const parsed = parseTermsRelease(releaseFiles({ terms: rows, exceptions, negative: { en: exampleNegative('en') } }));
  return releaseToPack(parsed, { languages: ['en'] });
}

const time = <T>(fn: () => T): { ms: number; value: T } => {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
};

async function measure(terms: number): Promise<{ build: number; match: number; seed: number; change: number }> {
  const p = pack(terms);
  expect(p.terms.length).toBe(terms);
  expect(p.exceptions.length).toBe(Math.floor(terms / 10));
  // a build: warm once so the JIT is in the same state a running server would be in, then take the best of three
  buildMatcher(p.terms, p.exceptions);
  const build = Math.min(...[0, 1, 2].map(() => time(() => buildMatcher(p.terms, p.exceptions)).ms));
  const matcher = buildMatcher(p.terms, p.exceptions);
  expect(matcher.match(LINE)).toBeNull();
  const lines = [LINE, LINE.toUpperCase(), `${LINE} ${p.terms[0]!.term}`, LINE.replace(/e/g, '3')];
  const reps = 50;
  const total = time(() => {
    for (let i = 0; i < reps; i += 1) for (const l of lines) matcher.match(l);
  }).ms;
  const match = total / (reps * lines.length);
  const store = new MemoryTermStore();
  const clock = { now: () => 1_800_000_000_000 };
  const live = new LiveTerms({ store, pack: p, clock, logger: { warn() {} } });
  const seedStart = performance.now();
  await live.load();
  const seed = performance.now() - seedStart;
  const edit = time(() => live.changeSync('bench', (e) => e.addTerm({ term: 'zzorvuxo', language: 'en' })));
  expect(edit.value.ok).toBe(true);
  return { build, match, seed, change: edit.ms };
}

describe('the size benchmark', () => {
  it('benchmark (always on, small): a generated 500-term pack builds, matches and takes an edit within the budgets', async () => {
    const m = await measure(500);
    if (FULL) console.log(`bench 500 terms: build ${m.build.toFixed(1)} ms, match ${m.match.toFixed(3)} ms, changeSync ${m.change.toFixed(1)} ms, seed ${m.seed.toFixed(0)} ms`);
    expect(m.build).toBeLessThan(BUDGET.buildMs);
    expect(m.match).toBeLessThan(BUDGET.matchMs);
    expect(m.change).toBeLessThan(BUDGET.changeMs);
  });

  it.runIf(FULL)('benchmark (CW_BENCH=1): a generated 5 000-term pack builds in under 300 ms; match of a 200-character line under 2 ms; changeSync of one edit under 600 ms', async () => {
    const m = await measure(5000);
    console.log(`bench 5000 terms: build ${m.build.toFixed(1)} ms, match ${m.match.toFixed(3)} ms, changeSync ${m.change.toFixed(1)} ms, seed ${m.seed.toFixed(0)} ms`);
    expect(m.build).toBeLessThan(BUDGET.buildMs);
    expect(m.match).toBeLessThan(BUDGET.matchMs);
    expect(m.change).toBeLessThan(BUDGET.changeMs);
  }, 300_000);
});
