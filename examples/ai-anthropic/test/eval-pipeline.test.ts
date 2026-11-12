import { AIError } from '@chatwarden/core';
import type { AIReadInput, ModerationAI } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { createAnthropicAI } from '../src/anthropic.ts';
import { loadCases, prepare } from '../eval/cases.ts';
import type { EvalCase } from '../eval/cases.ts';
import { runCase } from '../eval/pipeline.ts';
import { fakeClient, reply, signal } from './support.ts';

const cases = loadCases();
const byId = (id: string): EvalCase => cases.find((c) => c.id === id) as EvalCase;

const answering = (output: unknown): ModerationAI => ({
  id: 'fake',
  read: () => Promise.resolve({ output, usage: { model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 2 } }),
});
const failing = (e: unknown): ModerationAI => ({ id: 'fake', read: () => Promise.reject(e) });

function answer(over: Record<string, unknown>) {
  return {
    severity: 'rude',
    rule: 2,
    summary: 'The reported player swore once.',
    evidence: ['L3'],
    confidence: 'high',
    injectionSuspected: false,
    recommendation: { verdict: 'noted', severity: 'rude', rule: 2, evidence: ['L3'] },
    ...over,
  };
}

describe('runCase', () => {
  it('maps cited refs back to case line numbers and keeps the usage', async () => {
    const c = byId('rude-glarn-yourself'); // line 3 is by the reported person
    const o = await runCase(answering(answer({})), c, signal());
    expect(o.status).toBe('ok');
    expect(o.citedLines).toEqual([3]);
    expect(o.ceilingViolation).toBe(false);
    expect(o.usage?.costMicros).toBe(2);
    expect(o.read?.recommendation?.verdict).toBe('noted');
  });

  it('maps refs to line numbers in a long room, where the two numberings differ', async () => {
    const c = byId('long-room-sustained'); // 64 lines, 40 kept: the early filler is dropped, so L-numbers are not line numbers
    const p = prepare(c);
    const ref = p.refOf(52) as string;
    expect(ref).not.toBe('L52');
    const o = await runCase(answering(answer({ evidence: [ref], recommendation: { verdict: 'noted', severity: 'rude', rule: 2, evidence: [ref] } })), c, signal());
    expect(o.citedLines).toEqual([52]);
  });

  it('flags a ceiling violation when the model upholds or notes without a line by the reported person', async () => {
    const c = byId('rude-glarn-yourself'); // line 1 is by another player, line 2 by the reporter
    const o = await runCase(answering(answer({ evidence: ['L2'], recommendation: { verdict: 'upheld', severity: 'rude', rule: 2, evidence: ['L2'] } })), c, signal());
    expect(o.status).toBe('ok');
    expect(o.ceilingViolation).toBe(true);
    expect(o.read?.recommendation?.verdict).toBe('unclear'); // core softened it
  });

  it('a bad_faith verdict is invalid and a ceiling violation', async () => {
    const c = byId('rude-glarn-yourself');
    const o = await runCase(answering(answer({ recommendation: { verdict: 'bad_faith', severity: 'rude', rule: 2, evidence: ['L3'] } })), c, signal());
    expect(o).toMatchObject({ status: 'invalid', code: 'bad_faith_verdict', ceilingViolation: true });
  });

  it('output core rejects is invalid with its code and the usage still counted', async () => {
    const c = byId('rude-glarn-yourself');
    for (const [output, code] of [[null, 'not_object'], ['text', 'not_object'], [answer({ severity: 'extreme' }), 'bad_severity'], [answer({ rule: 99 }), 'bad_rule'], [answer({ evidence: ['L99'] }), 'bad_evidence']] as const) {
      const o = await runCase(answering(output), c, signal());
      expect(o).toMatchObject({ status: 'invalid', code, ceilingViolation: false });
      expect(o.usage).toBeDefined();
    }
  });

  it('a refusal is declined; a fatal error is failed with its kind; anything else is failed and retryable', async () => {
    const c = byId('rude-glarn-yourself');
    expect(await runCase(failing(new AIError('declined')), c, signal())).toMatchObject({ status: 'declined', code: 'declined' });
    expect(await runCase(failing(new AIError('fatal')), c, signal())).toMatchObject({ status: 'failed', code: 'fatal' });
    expect(await runCase(failing(new AIError('timeout')), c, signal())).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(await runCase(failing(new TypeError('boom')), c, signal())).toMatchObject({ status: 'failed', code: 'retryable' });
  });

  it("records whether core's injection tripwire fires on the lines or the note, apart from the model", async () => {
    const answerFor = (c: EvalCase) => runCase(answering(answer({})), c, signal());
    for (const id of ['inj-ignore-rules', 'inj-fake-system', 'inj-close-data-block']) expect((await answerFor(byId(id))).tripwire, id).toBe(true);
    // The tripwire is a pattern list: these attacks are not in it, which is why the model's own flag is measured too.
    for (const id of ['inj-moderator-says-fine', 'inj-note-instructs', 'inj-asks-bigger-score']) expect((await answerFor(byId(id))).tripwire, id).toBe(false);
  });

  it('the tripwire stays quiet on every case that is not an injection case, and is set on declined and invalid outcomes too', async () => {
    for (const c of cases.filter((x) => x.group !== 'injection')) expect((await runCase(answering(answer({})), c, signal())).tripwire, c.id).toBe(false);
    expect((await runCase(failing(new AIError('declined')), byId('inj-fake-system'), signal())).tripwire).toBe(true);
    expect((await runCase(answering(null), byId('inj-fake-system'), signal())).tripwire).toBe(true);
  });

  it('runs every case through the real adapter on a fake client without a throw, and sends no identifier', async () => {
    const { client, calls } = fakeClient(() => reply({ content: [{ type: 'text', text: JSON.stringify(answer({ evidence: ['L1'], recommendation: null })) }] }));
    const ai = createAnthropicAI({ client });
    for (const c of cases) {
      const o = await runCase(ai, c, signal());
      expect(['ok', 'invalid'], c.id).toContain(o.status);
    }
    expect(calls).toHaveLength(cases.length);
    for (const call of calls) {
      const wire = JSON.stringify(call.body);
      for (const marker of ['seat-', 'handle-', 'subject-', 'room-', 'ln-', 'report-']) expect(wire).not.toContain(marker);
    }
  });

  it('hands the adapter the same input the prompt tests see (stable part identical across cases of one policy)', async () => {
    const seen: AIReadInput[] = [];
    const spy: ModerationAI = { id: 'spy', read: (input) => { seen.push(input); return Promise.reject(new AIError('fatal')); } };
    await runCase(spy, byId('banter-ez'), signal());
    await runCase(spy, byId('rude-shut-up'), signal());
    expect(seen[0]?.prompt.stable).toBe(seen[1]?.prompt.stable);
    expect(seen[0]?.prompt.variable).not.toBe(seen[1]?.prompt.variable);
  });
});
