import { describe, expect, it } from 'vitest';
import { ScriptMismatch, checkLines, createTestKit, expectOutcomes } from '../src/testing/index.js';
import type { Step } from '../src/testing/index.js';

const HOUR = 3_600_000;

describe('steps', () => {
  it('say, report, mute, wait and suggest steps; expect on say accepts one label or a list', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const preview = kit.cw.policy.preview({});
    if (!preview.ok) throw new Error('the default profile must preview');
    const run = await kit.play([
      { player: 'tarvo', say: 'good game', expect: 'delivered' },
      { player: 'fenrisk', say: 'good game too', expect: ['delivered', 'starred'] },
      { player: 'fenrisk', say: 'you zorbak', expect: 'refused:blocked' },
      { wait: '10m' },
      { player: 'tarvo', mute: 'fenrisk' },
      { player: 'tarvo', report: 'fenrisk', reason: 'other', expect: 'filed' },
      { suggest: 'fenrisk', level: 'banter', expect: preview.samples.clean.banter.label },
    ]);
    expect(run.outcomes).toEqual(['delivered', 'delivered', 'refused:blocked', 'filed']);
    expect(run.steps.map((s) => s.kind)).toEqual(['say', 'say', 'say', 'wait', 'mute', 'report', 'suggest']);
    expect(run.steps.every((s) => typeof s.at === 'number')).toBe(true);
    const at = run.steps.map((s) => s.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at[4]! - at[2]!).toBe(600_000);
    expect(run.events.length).toBeGreaterThan(0);
  });

  it('a wait moves the kit clock and nothing else does', async () => {
    const kit = await createTestKit();
    const start = kit.clock.now();
    await kit.play([{ player: 'a', say: 'one' }, { wait: '1h' }, { wait: 30_000 }, { player: 'a', say: 'two' }]);
    expect(kit.clock.now()).toBe(start + HOUR + 30_000);
  });

  it('a step may name another room, and rooms keep their lines apart', async () => {
    const kit = await createTestKit();
    await kit.play([{ player: 'a', say: 'hi' }], { room: 'arena' });
    expect(kit.cw.rooms.subjectAt('arena', 'a')).not.toBeNull();
    expect(kit.cw.rooms.subjectAt('lobby', 'a')).toBeNull();
  });

  it('a step that is none of the five kinds is a TypeError naming the step number', async () => {
    const kit = await createTestKit();
    await expect(kit.play([{ player: 'a', say: 'x' }, { nothing: true } as unknown as Step])).rejects.toThrow(/step 2/);
  });
});

describe('labels', () => {
  it('delivered, starred (text changed), refused:length, rate, restricted, blocked, profanity, empty, and gate with a closing gate', async () => {
    let open = true;
    const kit = await createTestKit({ blocked: ['zorbak'], swears: ['snerp'], gate: () => open });
    const room = kit.room();
    const max = kit.cw.limits.chatMaxLength;
    const rate = kit.cw.limits.chatRate;
    expect(room.say('a', 'plain').label).toBe('delivered');
    expect(room.say('b', 'a snerp').label).toBe('starred');
    expect(room.say('c', 'x'.repeat(max + 1)).label).toBe('refused:length');
    expect(room.say('d', '   ').label).toBe('refused:empty');
    expect(room.say('e', 'zorbak').label).toBe('refused:blocked');
    for (let i = 0; i < rate.count; i += 1) expect(room.say('f', `line ${i}`).label).toBe('delivered');
    expect(room.say('f', 'one too many').label).toBe('refused:rate');
    kit.clock.advance(rate.windowMs + 1);
    expect(room.say('f', 'later').label).toBe('delivered');
    open = false;
    expect(room.say('g', 'anything').label).toBe('refused:gate');
    open = true;

    const strict = await createTestKit({ profile: 'strict', swears: ['snerp'] });
    expect(strict.room().say('h', 'snerp').label).toBe('refused:profanity');

    const limited = await createTestKit({ blocked: ['zorbak'] });
    const strikes = limited.cw.limits.strikes.count;
    for (let i = 0; i < strikes; i += 1) {
      limited.clock.advance('10s');
      limited.room().say('i', 'zorbak');
    }
    expect(limited.room().say('i', 'hello').label).toBe('refused:restricted');
  });

  it('the outcome carries what cw.chat.accept returned, the player, the text as sent and the time', async () => {
    const kit = await createTestKit();
    const out = kit.room().say('tarvo', ' hello there ');
    expect(out).toMatchObject({ kind: 'say', player: 'tarvo', text: ' hello there ', at: 1_800_000_000_000 });
    expect('deliver' in out.result).toBe(true);
  });

  it("a line that earns the first automatic timeout has autoRestricted 'first', the repeat 'second'", async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const room = kit.room();
    const { count, firstMs } = kit.cw.limits.strikes;
    const outcomes = [];
    for (let i = 0; i < count; i += 1) {
      kit.clock.advance('10s');
      outcomes.push(room.say('fenrisk', 'zorbak'));
    }
    expect(outcomes.map((o) => o.autoRestricted)).toEqual([...Array(count - 1).fill(undefined), 'first']);
    // The restriction ends; a fresh run of strikes earns the longer one.
    kit.clock.advance(firstMs + 1_000);
    const again = [];
    for (let i = 0; i < count; i += 1) {
      kit.clock.advance('10s');
      again.push(room.say('fenrisk', 'zorbak'));
    }
    expect(again.map((o) => o.autoRestricted)).toEqual([...Array(count - 1).fill(undefined), 'second']);
  });

  it('after the third blocked line in an hour the next say is refused:restricted and wait past the restriction delivers again (numbers read from cw.limits)', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const { count, firstMs } = kit.cw.limits.strikes;
    const steps: Step[] = [];
    for (let i = 0; i < count; i += 1) steps.push({ player: 'fenrisk', say: 'zorbak', expect: 'refused:blocked' }, { wait: '10s' });
    steps.push({ player: 'fenrisk', say: 'hello', expect: 'refused:restricted' }, { wait: firstMs + 1_000 }, { player: 'fenrisk', say: 'hello again', expect: 'delivered' });
    const run = await kit.play(steps);
    expect(run.outcomes.slice(-2)).toEqual(['refused:restricted', 'delivered']);
    expect(run.events.some((e) => e.type === 'auto.restricted')).toBe(true);
  });

  it('pacing: slow_mode, flood and duplicate are the kit\'s own refusals and are labelled refused:<reason>', async () => {
    const slow = await createTestKit({ overrides: { pace: { slowModeMs: 2_000 } } });
    const sr = slow.room();
    expect(sr.say('a', 'one').label).toBe('delivered');
    expect(sr.say('a', 'two').label).toBe('refused:slow_mode');
    slow.clock.advance(2_000);
    expect(sr.say('a', 'three').label).toBe('delivered');

    const flood = await createTestKit({ overrides: { pace: { burst: { lines: 2, windowMs: 10_000 } } } });
    const fr = flood.room();
    expect(fr.say('a', 'one').label).toBe('delivered');
    expect(fr.say('a', 'two').label).toBe('delivered');
    expect(fr.say('a', 'three').label).toBe('refused:flood');

    const dup = await createTestKit({ overrides: { pace: { duplicateWindowMs: 20_000 } } });
    const dr = dup.room();
    expect(dr.say('a', 'the same line').label).toBe('delivered');
    dup.clock.advance(1_500);
    expect(dr.say('a', 'The Same Line').label).toBe('refused:duplicate');
    dup.clock.advance(30_000);
    expect(dr.say('a', 'the same line').label).toBe('delivered');
  });

  it('flood control is in this repo (0.1.7), so the three pacing labels above come from the real kit, not a scripted facade', async () => {
    const kit = await createTestKit();
    expect(typeof kit.cw.rooms.setPace).toBe('function');
  });
});

describe('report and mute', () => {
  it("report: filed, then refused:duplicate/self/rate as the kit answers; the report's reporter and target are the named players", async () => {
    const kit = await createTestKit();
    const room = kit.room();
    room.say('tarvo', 'hello');
    room.say('fenrisk', 'rude words');
    const first = await room.report('tarvo', 'fenrisk', { reason: 'other' });
    expect(first.label).toBe('filed');
    expect(first).toMatchObject({ kind: 'report', player: 'tarvo', target: 'fenrisk' });
    const created = kit.events.filter((e) => e.type === 'report.created');
    expect(created.length).toBe(1);
    expect(JSON.stringify(created[0])).not.toContain('tarvo');
    expect((await room.report('tarvo', 'fenrisk')).label).toBe('refused:duplicate');
    expect((await room.report('tarvo', 'tarvo')).label).toBe('refused:self');
    // A different target each time runs into the reporter's daily limit.
    const limit = kit.cw.limits.reports;
    let last = first.label as string;
    for (let i = 0; i < 40 && last !== 'refused:rate'; i += 1) {
      room.say(`target${i}`, 'hi');
      last = (await room.report('tarvo', `target${i}`)).label;
    }
    expect(last).toBe('refused:rate');
    expect(limit).toBeDefined();
  });

  it("mute hides one player's lines from the muter only (sees)", async () => {
    const kit = await createTestKit();
    const room = kit.room();
    for (const name of ['a', 'b', 'c']) room.join(name);
    expect(room.sees('a', 'b')).toBe(true);
    room.mute('a', 'b');
    expect(room.sees('a', 'b')).toBe(false);
    expect(room.sees('b', 'a')).toBe(true);
    expect(room.sees('c', 'b')).toBe(true);
    room.mute('a', 'b', false);
    expect(room.sees('a', 'b')).toBe(true);
    // The same through a script.
    await kit.play([{ player: 'c', mute: 'a' }]);
    expect(room.sees('c', 'a')).toBe(false);
    await kit.play([{ player: 'c', mute: 'a', on: false }]);
    expect(room.sees('c', 'a')).toBe(true);
  });
});

describe('assertions', () => {
  it('a mismatch throws ScriptMismatch naming the step number, expected and actual, and the table lists every step', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const steps: Step[] = [
      { player: 'tarvo', say: 'hello', expect: 'delivered' },
      { player: 'fenrisk', say: 'zorbak', expect: 'delivered' },
      { player: 'tarvo', say: 'bye', expect: 'delivered' },
    ];
    const error = await kit.play(steps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScriptMismatch);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ScriptMismatch');
    const message = (error as Error).message;
    expect(message).toContain('step 2');
    expect(message).toContain('expected delivered');
    expect(message).toContain('refused:blocked');
    for (const needle of ['tarvo', 'fenrisk', 'hello', 'bye']) expect(message).toContain(needle);
    // A step after the failing one is listed as not run.
    expect(message).toMatch(/not run/);
    expect(message.length).toBeLessThan(2000);
  });

  it('a long line is shortened in the table', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const text = `zorbak ${'long '.repeat(60)}`;
    const error = (await kit.play([{ player: 'a', say: text, expect: 'delivered' }]).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(text);
    expect(error.message).toContain('...');
  });

  it('expectOutcomes compares the whole array and reports the first difference', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const run = await kit.play([{ player: 'a', say: 'hi' }, { player: 'a', say: 'zorbak' }, { player: 'b', say: 'yo' }]);
    expect(() => expectOutcomes(run, ['delivered', 'refused:blocked', 'delivered'])).not.toThrow();
    expect(() => expectOutcomes(run, ['delivered', 'delivered', 'delivered'])).toThrow(ScriptMismatch);
    try {
      expectOutcomes(run, ['delivered', 'delivered', 'refused:blocked']);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('outcome 2');
      expect(message).toContain('expected delivered');
      expect(message).toContain('refused:blocked');
      expect(message).not.toContain('outcome 3');
    }
    expect(() => expectOutcomes(run, ['delivered'])).toThrow(/3 outcomes/);
    expect(() => expectOutcomes(run, [])).toThrow(ScriptMismatch);
  });

  it('checkLines runs every case on a fresh kit and reports ALL differing cases in one error', async () => {
    await expect(
      checkLines({ blocked: ['zorbak'], swears: ['snerp'] }, [
        { text: 'hello', expect: 'delivered' },
        { text: 'zorbak', expect: 'refused:blocked' },
        { text: 'a snerp', expect: 'starred' },
      ]),
    ).resolves.toBeUndefined();

    const error = (await checkLines({ blocked: ['zorbak'], swears: ['snerp'] }, [
      { text: 'hello', expect: 'refused:length' },
      { text: 'zorbak', expect: 'refused:blocked' },
      { text: 'a snerp', expect: 'delivered' },
      { text: 'ok', expect: 'refused:empty' },
    ]).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ScriptMismatch);
    expect(error.message).toContain('3 of 4');
    for (const needle of ['hello', 'a snerp', 'ok']) expect(error.message).toContain(needle);
    expect(error.message).not.toContain('zorbak'); // the matching case is not listed
  });

  it('checkLines gives every case a fresh kit: three blocked lines do not restrict the next case', async () => {
    const cases = [...Array(6).fill({ text: 'zorbak', expect: 'refused:blocked' as const }), { text: 'hello', expect: 'delivered' as const }];
    await expect(checkLines({ blocked: ['zorbak'] }, cases)).resolves.toBeUndefined();
  });
});
