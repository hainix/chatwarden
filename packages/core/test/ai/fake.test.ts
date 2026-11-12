import { describe, expect, it } from 'vitest';
import { createFakeModerationAI, fakeRead, FAKE_USAGE } from '../../src/ai/fake.js';
import { chooseLines } from '../../src/ai/lines.js';
import { buildAIInput } from '../../src/ai/prompt.js';
import { aiActorOf } from '../../src/ai/service.js';
import { validateAIOutput } from '../../src/ai/validate.js';
import { AIError } from '../../src/ai/types.js';
import { PRESETS } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import { mkReport } from './reportFixtures.js';

const inputFor = (specs: Parameters<typeof mkReport>[0], opts: { mask?: boolean } = {}) =>
  buildAIInput({
    policy: { profile: PRESETS.standard, rules: defineRules(starterRules('standard')) },
    reason: null,
    chosen: chooseLines(mkReport(specs), opts),
  });

describe('the fake adapter', () => {
  it('plays a queue of steps one per call, then reads by the simple rule', async () => {
    const input = inputFor([{ who: 'target', text: 'you are trash' }]);
    const ai = createFakeModerationAI([{ error: new AIError('retryable') }, { usage: { costMicros: 5 } }]);
    const signal = new AbortController().signal;
    await expect(ai.read(input, { signal })).rejects.toBeInstanceOf(AIError);
    expect((await ai.read(input, { signal })).usage.costMicros).toBe(5);
    expect((await ai.read(input, { signal })).usage).toEqual(FAKE_USAGE);
    expect(ai.callCount).toBe(3);
    expect(ai.calls[0]).toBe(input);
    expect(ai.signals[0]).toBe(signal);
  });

  it('a function script is given the input and the call number', async () => {
    const input = inputFor([{ who: 'target', text: 'x' }]);
    const seen: number[] = [];
    const ai = createFakeModerationAI((_i, ctx) => {
      seen.push(ctx.call);
      return { output: { n: ctx.call } };
    });
    const signal = new AbortController().signal;
    expect((await ai.read(input, { signal })).output).toEqual({ n: 1 });
    expect((await ai.read(input, { signal })).output).toEqual({ n: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it('a hanging call settles only when aborted, with a timeout error', async () => {
    const input = inputFor([{ who: 'target', text: 'x' }]);
    const ai = createFakeModerationAI([{ hang: true }]);
    const c = new AbortController();
    const p = ai.read(input, { signal: c.signal });
    let settled = false;
    p.catch(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    c.abort();
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('push adds a step; the default id is fake:model and can be set', () => {
    const ai = createFakeModerationAI([], { id: 'fake:two' });
    expect(ai.id).toBe('fake:two');
    expect(createFakeModerationAI().id).toBe('fake:model');
  });

  it('its default answer passes the core validator, with and without a line by P1', () => {
    for (const specs of [
      [{ who: 'target' as const, text: 'you are trash' }, { who: 'reporter' as const, text: 'stop it' }],
      [{ who: 'reporter' as const, text: 'hello there' }],
    ]) {
      const input = inputFor(specs);
      const v = validateAIOutput(fakeRead(input), {
        sent: new Set(input.lines.map((l) => l.ref)),
        activeRules: new Set(input.rules.map((r) => r.number)),
        ownRefs: new Set(input.lines.filter((l) => l.who === 'P1').map((l) => l.ref)),
      });
      expect(v.ok).toBe(true);
    }
  });

  it('fakeRead takes overrides', () => {
    const input = inputFor([{ who: 'target', text: 'x' }]);
    expect(fakeRead(input, { confidence: 'high' }).confidence).toBe('high');
  });
});

describe('the audit actor of the AI', () => {
  it('keeps the characters the trail accepts and turns the rest into underscores', () => {
    expect(aiActorOf('anthropic:claude-haiku-5-5')).toBe('ai:anthropic:claude-haiku-5-5');
    expect(aiActorOf('my adapter/v1')).toBe('ai:my_adapter_v1');
    expect(aiActorOf('a@b+c.d_e-f:g')).toBe('ai:a@b+c.d_e-f:g');
  });

  it('is never longer than 128 characters and never bare', () => {
    expect(aiActorOf('x'.repeat(500)).length).toBe(128);
    expect(aiActorOf('')).toBe('ai:adapter');
    expect(aiActorOf('\u{1F600}')).toMatch(/^ai:_+$/u);
  });
});

describe('blockedLines mask in the line choice', () => {
  const specs = [
    { who: 'target', text: 'zorbak is a vlemmo', blocked: true },
    { who: 'target', text: 'what the snerp', delivered: 'what the *****' },
    { who: 'target', text: 'plain words' },
  ];

  it('sends the raw text by default', () => {
    const lines = chooseLines(mkReport(specs)).lines;
    expect(lines.map((l) => l.text)).toEqual(['zorbak is a vlemmo', 'what the snerp', 'plain words']);
  });

  it('with mask a blocked line is stars, a starred line is what the room saw, and a plain line is untouched', () => {
    const lines = chooseLines(mkReport(specs), { mask: true }).lines;
    expect(lines[0]?.text).toBe('****** ** * ******');
    expect(lines[1]?.text).toBe('what the *****');
    expect(lines[2]?.text).toBe('plain words');
    expect(lines.map((l) => [l.blocked, l.filtered])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it('the mask never leaks the raw words into the rendered prompt', () => {
    const input = inputFor(specs, { mask: true });
    expect(input.prompt.variable).not.toMatch(/zorbak|vlemmo|snerp/);
    expect(inputFor(specs).prompt.variable).toMatch(/zorbak/);
  });
});
