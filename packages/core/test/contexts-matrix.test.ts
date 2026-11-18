import { describe, expect, it } from 'vitest';
import type { ContextSettings } from '../src/contexts.js';
import type { PresetName, ProfileOverrides } from '../src/profile.js';
import { contextsWorld, SEC, verdictOf } from './contextsWorld.js';

// M1, differential: a room in a context gives the verdict an equivalent whole profile gives, for each preset, three contexts and the base.
// The script is 12 lines on one seat (clean, swearing, a slur, a repeat, a burst, a long line, a link), the clock moving between them.

const LONG = 'x'.repeat(201);
const SCRIPT: Array<{ text: string; after: number }> = [
  { text: 'good game everyone', after: 6 * SEC },
  { text: 'you absolute snerp', after: 6 * SEC },
  { text: 'you zorbak', after: 6 * SEC },
  { text: 'same words again', after: 4 * SEC },
  { text: 'same words again', after: 6 * SEC },
  { text: LONG, after: 6 * SEC },
  { text: 'see http://example.org/x', after: 6 * SEC },
  { text: 'b1', after: 200 },
  { text: 'b2', after: 200 },
  { text: 'b3', after: 200 },
  { text: 'b4', after: 6 * SEC },
  { text: 'clean again', after: 6 * SEC },
];

const CONTEXTS: Record<string, ContextSettings> = {
  kids: { profanity: { mode: 'refuse' }, pace: { slowModeMs: 3000, duplicateWindowMs: 10_000 }, filters: { links: { action: 'refuse' } } },
  ranked: { profanity: { mode: 'allow' }, pace: { burst: { lines: 3, windowMs: 10_000 } } },
  quiet: { pace: { slowModeMs: 5000, burst: null }, filters: { links: { action: 'mask' } } },
};

/** The same sections as top-level profile overrides. */
const wholeProfile = (c: ContextSettings): ProfileOverrides => ({
  ...(c.profanity === undefined ? {} : { profanity: c.profanity }),
  ...(c.pace === undefined ? {} : { pace: c.pace }),
  ...(c.filters === undefined ? {} : { filters: c.filters }),
});

async function run(preset: PresetName, contexts: Record<string, ContextSettings>, tag: string | null, overrides: ProfileOverrides): Promise<string[]> {
  const w = await contextsWorld(contexts, { profile: preset }, overrides);
  const seat = w.player('R', tag === null ? {} : { tags: { context: tag } });
  const out: string[] = [];
  for (const line of SCRIPT) {
    out.push(verdictOf(w.cw.chat.accept('R', seat, line.text)));
    w.clock.t += line.after;
  }
  return out;
}

describe('contexts-matrix: a context gives the verdict of an equivalent whole profile', () => {
  for (const preset of ['relaxed', 'standard', 'strict'] as const) {
    for (const [name, ctx] of Object.entries(CONTEXTS)) {
      it(`${preset} / ${name}`, async () => {
        const inContext = await run(preset, CONTEXTS, name, {});
        const whole = await run(preset, {}, null, wholeProfile(ctx));
        expect(inContext).toEqual(whole);
      });
    }
    it(`${preset} / base: a room with no tag, and a kit with contexts declared but unused, match a kit with none`, async () => {
      const none = await run(preset, {}, null, {});
      expect(await run(preset, CONTEXTS, null, {})).toEqual(none);
    });
  }

  it('the script is not vacuous: the contexts give different verdicts from each other and from the base', async () => {
    const base = await run('standard', CONTEXTS, null, {});
    const results = await Promise.all(Object.keys(CONTEXTS).map((n) => run('standard', CONTEXTS, n, {})));
    for (const r of results) expect(r).not.toEqual(base);
    expect(new Set(results.map((r) => r.join('|'))).size).toBe(results.length);
    expect(base).toHaveLength(12);
    expect(base.some((v) => v === 'refuse:blocked')).toBe(true);
    expect(base.some((v) => v === 'refuse:length')).toBe(true);
  });
});
