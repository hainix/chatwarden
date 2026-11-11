// What only the REAL kit does, checked through KitEngine: the refusal comes from the matcher, the automatic strikes and
// timeouts are the kit's, and the scripted players are written so they never trip any of it. (The ladder suggestion and the
// decision are the hub's, over the staff routes: see demoHub.test.tsx and hubPane.test.ts.)
import { LiveTerms } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINE_MAX } from '../src/demo/engine';
import type { ChatResult } from '../src/demo/engine';
import { LOOP, SEED } from '../src/demo/script';
import { StaffEngine } from './helpers/staffEngine';

const START = Date.UTC(2026, 10, 10, 12, 0, 0);
function make() {
  let t = START;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { engine: new StaffEngine({ clock }), clock };
}
const refusal = (r: ChatResult) => ('refuse' in r ? r.refuse : null);

afterEach(() => vi.restoreAllMocks());

describe('the refusal comes from the matcher', () => {
  it('asks the real LiveTerms, which answers with the fixtures pack term id', async () => {
    const spy = vi.spyOn(LiveTerms.prototype, 'match');
    const { engine } = make();
    const r = await engine.chat.accept('you', 'you absolute zorbak');
    expect(r).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
    const hits = spy.mock.results.map((x) => x.value as { termId: string } | null);
    expect(spy).toHaveBeenCalled();
    expect(hits.some((h) => h?.termId === 'syn:zorbak')).toBe(true);
  });
  it('each invented word is refused by its own term id (not by a copy of the list in the demo)', async () => {
    const spy = vi.spyOn(LiveTerms.prototype, 'match');
    for (const [word, id] of [
      ['vlemmo', 'syn:vlemmo'],
      ['quissel', 'syn:quissel'],
      ['drakkuun', 'syn:drakkuun'],
      ['fenrisk', 'syn:fenrisk'],
      ['snerp', 'syn:snerp'],
    ] as const) {
      spy.mockClear();
      const { engine } = make();
      expect(refusal(await engine.chat.accept('bo', `you ${word}`))).toMatchObject({ reason: 'blocked', rule: 1 });
      expect(spy.mock.results.map((x) => (x.value as { termId: string } | null)?.termId)).toContain(id);
    }
  });
  it('a line the matcher lets through never gets a term id (control)', async () => {
    const spy = vi.spyOn(LiveTerms.prototype, 'match');
    const { engine } = make();
    expect('deliver' in (await engine.chat.accept('you', 'good game everyone'))).toBe(true);
    expect(spy.mock.results.every((x) => x.value === null)).toBe(true);
  });
  it('every line of the pack positive corpus is refused as blocked, each on a fresh kit', async () => {
    const corpus = syntheticTermPack().positiveCorpus ?? [];
    expect(corpus.length).toBeGreaterThan(3);
    for (const line of corpus) {
      const { engine } = make();
      expect(refusal(await engine.chat.accept('you', line)), line).toMatchObject({ reason: 'blocked' });
    }
  });
  it('keeps the doubled letter the real matcher keeps: quisel is not quissel', async () => {
    const { engine } = make();
    expect('deliver' in (await engine.chat.accept('you', 'quisel'))).toBe(true);
    expect(refusal(await engine.chat.accept('you', 'quissel'))).toMatchObject({ reason: 'blocked' });
  });
  it('the 200 character cap the composer shows is the kit default', async () => {
    const { engine } = make();
    expect((await engine.kit()).limits.chatMaxLength).toBe(LINE_MAX);
  });
});

describe('automatic strikes and timeouts are the kit own', () => {
  it('three blocked lines inside an hour earn an automatic 30 minute timeout, with a notice and an end time', async () => {
    const { engine, clock } = make();
    for (let i = 0; i < 3; i++) {
      expect(refusal(await engine.chat.accept('you', `you zorbak ${'!'.repeat(i)}`))).toMatchObject({ reason: 'blocked' });
      clock.advance(1_000);
    }
    const until = START + 2_000 + 30 * 60_000;
    const next = refusal(await engine.chat.accept('you', 'hello?'));
    expect(next).toMatchObject({ reason: 'restricted', until, rule: 1 });
    expect(next?.byModerator).toBe(false);
    expect((await engine.rooms.seats()).find((s) => s.id === 'you')?.restrictedUntil).toBe(until);
    const pending = await engine.notices.pending('you');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'chat', until, rule: 1 });
    expect(pending[0]?.ruleLabel).toMatch(/^Community Rule 1: /);
  });
  it('two blocked lines are not enough, and a strike older than an hour no longer counts', async () => {
    const { engine, clock } = make();
    expect(refusal(await engine.chat.accept('you', 'zorbak'))).toMatchObject({ reason: 'blocked' });
    clock.advance(10_000);
    expect(refusal(await engine.chat.accept('you', 'vlemmo'))).toMatchObject({ reason: 'blocked' });
    clock.advance(61 * 60_000);
    expect(refusal(await engine.chat.accept('you', 'snerp'))).toMatchObject({ reason: 'blocked' });
    expect('deliver' in (await engine.chat.accept('you', 'still here'))).toBe(true);
  });
  it('strikes are per player: the visitor spamming does not time out Bo', async () => {
    const { engine, clock } = make();
    for (let i = 0; i < 3; i++) {
      await engine.chat.accept('you', 'zorbak');
      clock.advance(1_000);
    }
    expect(refusal(await engine.chat.accept('you', 'hi'))).toMatchObject({ reason: 'restricted' });
    expect('deliver' in (await engine.chat.accept('bo', 'hi'))).toBe(true);
    expect((await engine.rooms.seats()).map((s) => s.restrictedUntil !== null)).toEqual([true, false, false]);
  });
  it('the timeout ends by itself, and Reset is the other way out', async () => {
    const { engine, clock } = make();
    for (let i = 0; i < 3; i++) {
      await engine.chat.accept('you', 'zorbak');
      clock.advance(1_000);
    }
    expect(refusal(await engine.chat.accept('you', 'hi'))).toMatchObject({ reason: 'restricted' });
    await engine.reset();
    expect('deliver' in (await engine.chat.accept('you', 'hi'))).toBe(true);
    expect(await engine.notices.pending('you')).toEqual([]);
    // and a fresh run of strikes starts from zero
    await engine.chat.accept('you', 'zorbak');
    clock.advance(6_000);
    expect('deliver' in (await engine.chat.accept('you', 'still ok'))).toBe(true);
  });
  it('a timeout ends at its time without Reset', async () => {
    const { engine, clock } = make();
    for (let i = 0; i < 3; i++) {
      await engine.chat.accept('you', 'zorbak');
      clock.advance(1_000);
    }
    clock.advance(30 * 60_000);
    expect('deliver' in (await engine.chat.accept('you', 'back'))).toBe(true);
  });
});

describe('the scripted players never trip the filter', () => {
  const blockedLines = (seat: 'ada' | 'bo') => [...SEED, ...LOOP].filter((l) => l.seat === seat && /zorbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp/i.test(l.text));

  it('Ada never says a blocked word, and Bo says at most one (in the opening), not one per loop', () => {
    expect(blockedLines('ada')).toEqual([]);
    expect(SEED.filter((l) => l.seat === 'bo' && blockedLines('bo').includes(l))).toHaveLength(1);
    expect(LOOP.filter((l) => blockedLines('bo').includes(l))).toEqual([]);
  });
  it('ten full loops at the fastest cadence (4 s a line) never refuse, rate-limit or time out anyone', async () => {
    const { engine, clock } = make();
    const refused: string[] = [];
    const play = async (line: { seat: string; text: string }) => {
      const r = refusal(await engine.chat.accept(line.seat, line.text));
      if (r !== null && !(r.reason === 'blocked' && blockedLines('bo').some((b) => b.text === line.text))) refused.push(`${line.seat}: ${line.text} -> ${r.reason}`);
    };
    for (const line of SEED) await play(line); // all at once, as the page boots
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const line of LOOP) {
        clock.advance(4_000);
        await play(line);
      }
    }
    expect(refused).toEqual([]);
    expect((await engine.rooms.seats()).map((s) => s.restrictedUntil)).toEqual([null, null, null]);
    expect(await engine.notices.pending('bo')).toEqual([]);
    expect(await engine.notices.pending('ada')).toEqual([]);
  });
  it('the opening, played in one burst, stays inside the real rate limit for every seat', async () => {
    const { engine } = make();
    const verdicts: Array<[string, string]> = [];
    for (const line of SEED) {
      const r = refusal(await engine.chat.accept(line.seat, line.text));
      verdicts.push([line.seat, r?.reason ?? 'deliver']);
    }
    expect(verdicts.filter(([, v]) => v === 'rate')).toEqual([]);
    expect(verdicts.filter(([, v]) => v === 'blocked')).toHaveLength(1);
  });
  it('the visitor keeps her own rate budget: scripted lines do not spend it', async () => {
    const { engine } = make();
    for (const line of SEED) await engine.chat.accept(line.seat, line.text);
    for (let i = 0; i < 3; i++) expect('deliver' in (await engine.chat.accept('you', `mine ${i}`))).toBe(true);
    expect(refusal(await engine.chat.accept('you', 'one too many'))).toMatchObject({ reason: 'rate' });
  });
});

describe('the kit’s settings the demo changes, and the ones it leaves alone', () => {
  it('the reporter gets no "action taken" notice (the demo sets reporterFeedback false), so only Bo has a screen', async () => {
    const { engine, clock } = make();
    const line = await engine.chat.accept('bo', "you're hopeless");
    clock.advance(1_500);
    if (!('deliver' in line)) throw new Error('setup');
    const res = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: line.deliver.lineId, category: 'harassment' });
    if (!res.ok) throw new Error('setup');
    const report = (await engine.staff.get(res.reportId))!;
    await engine.staff.decide({ reportId: res.reportId, verdict: 'upheld', reason: 'r', actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 2 }] });
    expect(await engine.notices.pending('you')).toEqual([]);
    expect(await engine.notices.pending('bo')).toHaveLength(1);
    expect((await engine.kit()).limits.reporterFeedback).toBe(false);
  });
  it('every other limit is the kit default', async () => {
    const { engine } = make();
    const { limits } = await engine.kit();
    expect(limits.chatRate).toEqual({ count: 3, windowMs: 5_000 });
    expect(limits.strikes).toMatchObject({ count: 3, windowMs: 3_600_000, firstMs: 30 * 60_000 });
    expect(limits.reports.perDay).toBe(10);
  });
});

describe('reset and unknown people', () => {
  it('reset builds a different kit and closes the old one', async () => {
    const { engine } = make();
    const before = await engine.kit();
    const close = vi.spyOn(before, 'close');
    await engine.reset();
    expect(await engine.kit()).not.toBe(before);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('reset still works when the old kit refuses to close', async () => {
    const { engine } = make();
    vi.spyOn(await engine.kit(), 'close').mockRejectedValue(new Error('already closed'));
    await expect(engine.reset()).resolves.toBeUndefined();
    expect('deliver' in (await engine.chat.accept('you', 'fresh'))).toBe(true);
  });
  it('the first reset (the page boot) builds exactly one kit', async () => {
    const { engine } = make();
    await engine.reset();
    const a = await engine.kit();
    expect(a).toBe(await engine.kit());
  });
  it('notices for an unknown seat are empty and ack is false', async () => {
    const { engine } = make();
    expect(await engine.notices.pending('nobody')).toEqual([]);
    expect(await engine.notices.record('nobody')).toEqual([]);
    expect(await engine.notices.ack('nobody', 'x')).toBe(false);
  });
  it('rule labels are the kit own, for numbered rules and the gap', () => {
    const { engine } = make();
    expect(engine.rules.label(1)).toMatch(/^Community Rule 1: /);
    expect(engine.rules.label(8)).toMatch(/^Community Rule 8: /);
    expect(engine.rules.label('uncovered')).toBe('Not covered by a rule yet');
  });
});
