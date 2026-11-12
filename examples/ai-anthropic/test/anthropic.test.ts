import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AnthropicError } from '@anthropic-ai/sdk';
import { AIError, AI_OUTPUT_SCHEMA, validateAIOutput } from '@chatwarden/core';
import type { AIReadInput } from '@chatwarden/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClient, createAnthropicAI } from '../src/anthropic.ts';
import { costMicros, HAIKU_5_5_PRICES } from '../src/prices.ts';
import { fakeClient, GOOD_OUTPUT, makeInput, reply, signal } from './support.ts';

afterEach(() => vi.restoreAllMocks());

const ctx = { sent: new Set(['L1', 'L2']), activeRules: new Set([1, 2, 3, 4, 5, 6, 7, 8]), ownRefs: new Set(['L2']) };

/** The error `read` rejects with, or fails the test when it resolves. */
async function failure(ai: ReturnType<typeof createAnthropicAI>, input: AIReadInput = makeInput()): Promise<AIError> {
  try {
    await ai.read(input, { signal: signal() });
  } catch (e) {
    expect(e).toBeInstanceOf(AIError);
    return e as AIError;
  }
  throw new Error('read resolved');
}

const apiError = (status: number) => APIError.generate(status, { type: 'error', error: { type: 'x', message: 'detail' } }, 'detail', new Headers());

describe('the request', () => {
  it('sends the stable part as the cached system block and the variable part as the only user message', async () => {
    const { client, calls } = fakeClient();
    const input = makeInput();
    await createAnthropicAI({ client }).read(input, { signal: signal() });
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body;
    expect(body?.model).toBe('claude-haiku-5-5');
    expect(body?.max_tokens).toBe(1024);
    expect(body?.system).toEqual([{ type: 'text', text: input.prompt.stable, cache_control: { type: 'ephemeral' } }]);
    expect(body?.messages).toEqual([{ role: 'user', content: input.prompt.variable }]);
  });

  it('never edits the prompt text (byte for byte what core rendered)', async () => {
    const { client, calls } = fakeClient();
    const input = makeInput();
    await createAnthropicAI({ client }).read(input, { signal: signal() });
    const system = calls[0]?.body.system as Array<{ text: string }>;
    const messages = calls[0]?.body.messages as Array<{ content: string }>;
    expect(system[0]?.text).toBe(input.prompt.stable);
    expect(messages[0]?.content).toBe(input.prompt.variable);
  });

  it('sends output_config.format json_schema with the static schema and effort low', async () => {
    const { client, calls } = fakeClient();
    await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(calls[0]?.body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } });
  });

  it('passes effort medium and high through, and the schema of the input it was given', async () => {
    for (const effort of ['medium', 'high'] as const) {
      const { client, calls } = fakeClient();
      const input = makeInput();
      await createAnthropicAI({ client, effort }).read(input, { signal: signal() });
      expect(calls[0]?.body.output_config).toEqual({ effort, format: { type: 'json_schema', schema: input.prompt.schema } });
    }
  });

  it('sends no temperature, top_p, top_k, prefill, budget_tokens or fallbacks, and leaves thinking unset', async () => {
    const { client, calls } = fakeClient();
    await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    const body = calls[0]?.body ?? {};
    const text = JSON.stringify(body);
    for (const key of ['temperature', 'top_p', 'top_k', 'budget_tokens', 'fallbacks', 'thinking', 'tools', 'tool_choice', 'stop_sequences', 'stream']) {
      expect(text, key).not.toContain(`"${key}"`);
      expect(key in body, key).toBe(false);
    }
    // One user message and nothing after it: no assistant turn to prefill.
    const messages = body.messages as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('sends only model, max_tokens, system, messages and output_config (no metadata, no user id, no identifier)', async () => {
    const { client, calls } = fakeClient();
    await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
  });

  it('carries nothing of the structured input beyond the rendered prompt and schema (no ids, no seat, no hash)', async () => {
    const { client, calls } = fakeClient();
    const input = makeInput();
    // Fields an adapter could be tempted to forward. They are not part of the prompt, so none may reach the wire.
    const tagged = {
      ...input,
      report: { reason: { id: 'REASON-ID-SENTINEL', label: 'LABEL-SENTINEL' }, note: 'NOTE-SENTINEL' },
      standard: 'STANDARD-SENTINEL',
    } satisfies AIReadInput;
    await createAnthropicAI({ client, apiKey: 'sk-ant-key-sentinel' }).read(tagged, { signal: signal() });
    const wire = JSON.stringify(calls[0]?.body);
    for (const s of ['REASON-ID-SENTINEL', 'LABEL-SENTINEL', 'NOTE-SENTINEL', 'STANDARD-SENTINEL', 'sk-ant-key-sentinel']) expect(wire).not.toContain(s);
    for (const s of ['seatId', 'lineId', 'roomId', 'subject', 'handle', 'line-1', 'line-2']) expect(wire).not.toContain(s);
  });

  it('puts cache_control on the stable system block only, never on the user message', async () => {
    const { client, calls } = fakeClient();
    await createAnthropicAI({ client, cache: '1h' }).read(makeInput(), { signal: signal() });
    const body = calls[0]?.body ?? {};
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(JSON.stringify(messages)).not.toContain('cache_control');
    expect(typeof messages[0]?.content).toBe('string');
    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0]?.cache_control).toBeDefined();
  });

  it('cache off omits cache_control; 5m is the default ephemeral block; 1h sets ttl', async () => {
    const run = async (cache?: 'off' | '5m' | '1h') => {
      const { client, calls } = fakeClient();
      await createAnthropicAI({ client, ...(cache ? { cache } : {}) }).read(makeInput(), { signal: signal() });
      return (calls[0]?.body.system as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    };
    expect('cache_control' in (await run('off'))).toBe(false);
    expect((await run('5m')).cache_control).toEqual({ type: 'ephemeral' });
    expect((await run()).cache_control).toEqual({ type: 'ephemeral' });
    expect((await run('1h')).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('honours model and maxTokens, and thinking off sends the disabled form (the eval experiment)', async () => {
    const { client, calls } = fakeClient();
    await createAnthropicAI({ client, model: 'claude-sonnet-5-5', maxTokens: 512, thinking: 'off' }).read(makeInput(), { signal: signal() });
    expect(calls[0]?.body.model).toBe('claude-sonnet-5-5');
    expect(calls[0]?.body.max_tokens).toBe(512);
    expect(calls[0]?.body.thinking).toEqual({ type: 'disabled' });
  });

  it('the abort signal is passed through to the request', async () => {
    const { client, calls } = fakeClient();
    const controller = new AbortController();
    await createAnthropicAI({ client }).read(makeInput(), { signal: controller.signal });
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  it('an already-aborted signal is a timeout and makes no request', async () => {
    const { client, calls } = fakeClient();
    const controller = new AbortController();
    controller.abort();
    try {
      await createAnthropicAI({ client }).read(makeInput(), { signal: controller.signal });
      expect.unreachable();
    } catch (e) {
      expect((e as AIError).kind).toBe('timeout');
    }
    expect(calls).toHaveLength(0);
  });

  it('builds the SDK client with timeout 20 000 ms and 2 retries by default, and takes both as options', () => {
    const a = buildClient({ apiKey: 'sk-ant-x' });
    expect(a.timeout).toBe(20_000);
    expect(a.maxRetries).toBe(2);
    const b = buildClient({ apiKey: 'sk-ant-x', timeoutMs: 5_000, maxRetries: 0 });
    expect(b.timeout).toBe(5_000);
    expect(b.maxRetries).toBe(0);
    expect(b).toBeInstanceOf(Anthropic);
  });

  it('the id is anthropic:claude-haiku-5-5, and follows the model option', () => {
    expect(createAnthropicAI({ client: fakeClient().client }).id).toBe('anthropic:claude-haiku-5-5');
    expect(createAnthropicAI({ client: fakeClient().client, model: 'claude-sonnet-5-5' }).id).toBe('anthropic:claude-sonnet-5-5');
  });
});

describe('the answer', () => {
  it('returns the parsed JSON of the text block', async () => {
    const { client } = fakeClient();
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(r.output).toEqual(GOOD_OUTPUT);
    expect(validateAIOutput(r.output, ctx).ok).toBe(true);
  });

  it('reads the text block after leading thinking blocks', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'text', text: JSON.stringify(GOOD_OUTPUT) },
    ];
    const { client } = fakeClient(reply({ content }));
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(r.output).toEqual(GOOD_OUTPUT);
  });

  it('reads by block type, not position (a text block first, a thinking block after)', async () => {
    const content = [{ type: 'text', text: JSON.stringify(GOOD_OUTPUT) }, { type: 'thinking', thinking: '', signature: 's' }];
    const r = await createAnthropicAI({ client: fakeClient(reply({ content })).client }).read(makeInput(), { signal: signal() });
    expect(r.output).toEqual(GOOD_OUTPUT);
  });

  it('refusal throws declined, naming only the category', async () => {
    const { client } = fakeClient(reply({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'EXPLANATION-TEXT' }, content: [] }));
    const e = await failure(createAnthropicAI({ client }));
    expect(e.kind).toBe('declined');
    expect(e.message).toContain('cyber');
    expect(e.message).not.toContain('EXPLANATION-TEXT');
  });

  it('refusal with no category, or an odd one, is still declined and never echoes the category text', async () => {
    for (const details of [null, { category: null }, { category: 'Not A Category!<script>' }]) {
      const { client } = fakeClient(reply({ stop_reason: 'refusal', stop_details: details, content: [{ type: 'text', text: 'I cannot help' }] }));
      const e = await failure(createAnthropicAI({ client }));
      expect(e.kind).toBe('declined');
      expect(e.message).not.toContain('script');
      expect(e.message).not.toContain('I cannot help');
    }
  });

  it('max_tokens becomes an unparseable answer, not a crash, and keeps its usage', async () => {
    const truncated = '{"severity":"rude","rule":2,"summary":"The reported pla';
    const { client } = fakeClient(reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: truncated }], usage: { output_tokens: 1024 } }));
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(validateAIOutput(r.output, ctx).ok).toBe(false);
    expect(r.usage.outputTokens).toBe(1024);
  });

  it('max_tokens never yields a valid read even when the cut-off text happens to parse', async () => {
    const { client } = fakeClient(reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: JSON.stringify(GOOD_OUTPUT) }] }));
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(validateAIOutput(r.output, ctx).ok).toBe(false);
  });

  it('every other stop reason (tool_use, pause_turn, context window, none) is an unparseable answer, not a crash', async () => {
    for (const stop_reason of ['tool_use', 'pause_turn', 'model_context_window_exceeded', 'something_new', null]) {
      const { client } = fakeClient(reply({ stop_reason }));
      const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
      expect(validateAIOutput(r.output, ctx).ok, String(stop_reason)).toBe(false);
    }
  });

  it('stop_sequence counts as a normal end', async () => {
    const { client } = fakeClient(reply({ stop_reason: 'stop_sequence' }));
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(r.output).toEqual(GOOD_OUTPUT);
  });

  it('bad JSON becomes an unparseable answer', async () => {
    for (const text of ['not json at all', '{"severity":', '```json\n{}\n```', '', '   ']) {
      const { client } = fakeClient(reply({ content: [{ type: 'text', text }] }));
      const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
      expect(validateAIOutput(r.output, ctx).ok, text).toBe(false);
    }
  });

  it('a response with no text block (thinking only, or empty) is an unparseable answer', async () => {
    for (const content of [[], [{ type: 'thinking', thinking: '', signature: 's' }]]) {
      const { client } = fakeClient(reply({ content }));
      const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
      expect(validateAIOutput(r.output, ctx).ok).toBe(false);
    }
  });

  it('JSON that is not an object, and an object that fails the schema, are returned for core to reject', async () => {
    for (const text of ['"hello"', '42', 'null', '[]', '{}', JSON.stringify({ ...GOOD_OUTPUT, severity: 'catastrophic' }), JSON.stringify({ ...GOOD_OUTPUT, extra: 1 }), JSON.stringify({ ...GOOD_OUTPUT, rule: 99 })]) {
      const { client } = fakeClient(reply({ content: [{ type: 'text', text }] }));
      const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
      expect(r.output).toEqual(JSON.parse(text));
      expect(validateAIOutput(r.output, ctx).ok, text).toBe(false);
    }
  });

  it('a text block whose text is not a string is skipped, not a crash', async () => {
    const { client } = fakeClient(reply({ content: [{ type: 'text', text: 42 }, { type: 'text', text: JSON.stringify(GOOD_OUTPUT) }] }));
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(r.output).toEqual(GOOD_OUTPUT);
  });

  it('a response that is not a message at all is a retryable failure, not a crash', async () => {
    for (const bad of [undefined, null, 'oops', {}]) {
      const e = await failure(createAnthropicAI({ client: fakeClient(() => bad).client }));
      expect(e.kind).toBe('retryable');
    }
  });
});

describe('usage and cost', () => {
  const usageOf = async (u: Parameters<typeof reply>[0], opts: Parameters<typeof createAnthropicAI>[0] = {}) => {
    const { client } = fakeClient(reply(u));
    return (await createAnthropicAI({ client, ...opts }).read(makeInput(), { signal: signal() })).usage;
  };

  it('usage and cost: hit, miss and no-cache cases give the design numbers within 1 micro-dollar', async () => {
    // Design section 7: 2 000 stable, 900 variable, 360 output tokens.
    const hit = await usageOf({ usage: { input_tokens: 900, output_tokens: 360, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } });
    expect(hit).toMatchObject({ model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 360, cacheReadTokens: 2000, cacheWriteTokens: 0 });
    expect(Math.abs(hit.costMicros - 290)).toBeLessThanOrEqual(1);
    const miss = await usageOf({ usage: { input_tokens: 900, output_tokens: 360, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 } });
    expect(miss.cacheWriteTokens).toBe(2000);
    expect(Math.abs(miss.costMicros - 520)).toBeLessThanOrEqual(1);
    const none = await usageOf({ usage: { input_tokens: 2900, output_tokens: 360, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, { cache: 'off' });
    expect(Math.abs(none.costMicros - 470)).toBeLessThanOrEqual(1);
    for (const u of [hit, miss, none]) expect(Number.isInteger(u.costMicros)).toBe(true);
  });

  it('prices a 1-hour cache write at the 1-hour rate (from the cache_creation split, or from the cache option)', async () => {
    const split = await usageOf({ usage: { input_tokens: 900, output_tokens: 360, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } } });
    expect(Math.abs(split.costMicros - 670)).toBeLessThanOrEqual(1);
    const byOption = await usageOf({ usage: { input_tokens: 900, output_tokens: 360, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 } }, { cache: '1h' });
    expect(Math.abs(byOption.costMicros - 670)).toBeLessThanOrEqual(1);
  });

  it('reads null and missing token fields as zero', async () => {
    const u = await usageOf({ usage: { cache_read_input_tokens: null, cache_creation_input_tokens: null, input_tokens: 100, output_tokens: 10 } });
    expect(u).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100, outputTokens: 10 });
    const { client } = fakeClient({ ...reply(), usage: undefined });
    const r = await createAnthropicAI({ client }).read(makeInput(), { signal: signal() });
    expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 });
  });

  it('uses the price table it is given', async () => {
    const prices = { inputPerMTok: 1_000_000, outputPerMTok: 2_000_000, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0 };
    const u = await usageOf({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, { prices });
    expect(u.costMicros).toBe(20);
  });

  it('prices.ts holds the design table as integer micro-dollars per million tokens', () => {
    expect(HAIKU_5_5_PRICES).toEqual({ inputPerMTok: 100_000, outputPerMTok: 500_000, cacheWrite5mPerMTok: 125_000, cacheWrite1hPerMTok: 200_000, cacheReadPerMTok: 10_000 });
    expect(costMicros({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, HAIKU_5_5_PRICES)).toBe(100_000);
    expect(costMicros({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, HAIKU_5_5_PRICES)).toBe(500_000);
    expect(costMicros({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }, HAIKU_5_5_PRICES)).toBe(335_000);
    expect(costMicros({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, HAIKU_5_5_PRICES)).toBe(0);
  });
});

describe('errors', () => {
  const kindFor = async (thrown: unknown, sig: AbortSignal = signal()) => {
    const ai = createAnthropicAI({ client: fakeClient(() => { throw thrown; }).client });
    try {
      await ai.read(makeInput(), { signal: sig });
    } catch (e) {
      expect(e).toBeInstanceOf(AIError);
      return (e as AIError).kind;
    }
    throw new Error('read resolved');
  };

  it('400, 401 and 403 are fatal (and so are the other rejected-request statuses)', async () => {
    for (const status of [400, 401, 403, 404, 413, 422]) expect(await kindFor(apiError(status)), String(status)).toBe('fatal');
  });

  it('429 and 5xx and connection errors are retryable', async () => {
    for (const status of [409, 429, 500, 502, 503, 504, 529]) expect(await kindFor(apiError(status)), String(status)).toBe('retryable');
    expect(await kindFor(new APIConnectionError({ message: 'socket hang up' }))).toBe('retryable');
  });

  it('rate limit 429 and overloaded 529 are retryable, with a message that names only the status', async () => {
    for (const status of [429, 529]) {
      const ai = createAnthropicAI({ client: fakeClient(() => { throw apiError(status); }).client });
      const e = await failure(ai);
      expect(e.kind).toBe('retryable');
      expect(e.message).toContain(String(status));
      expect(e.message).not.toContain('detail');
    }
  });

  it('a timeout is timeout (connection timeout, 408, and an aborted signal)', async () => {
    expect(await kindFor(new APIConnectionTimeoutError())).toBe('timeout');
    expect(await kindFor(apiError(408))).toBe('timeout');
    const controller = new AbortController();
    const ai = createAnthropicAI({
      client: fakeClient(() => {
        controller.abort();
        throw new APIUserAbortError();
      }).client,
    });
    try {
      await ai.read(makeInput(), { signal: controller.signal });
      expect.unreachable();
    } catch (e) {
      expect((e as AIError).kind).toBe('timeout');
    }
  });

  it('a DOMException abort or timeout name is a timeout', async () => {
    expect(await kindFor(new DOMException('aborted', 'AbortError'))).toBe('timeout');
    expect(await kindFor(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
  });

  it('an SDK error that is not an API error (no key, bad setup) is fatal; anything else unknown is retryable', async () => {
    expect(await kindFor(new AnthropicError('Could not resolve authentication method.'))).toBe('fatal');
    expect(await kindFor(new TypeError('boom'))).toBe('retryable');
    expect(await kindFor('a string')).toBe('retryable');
    expect(await kindFor(undefined)).toBe('retryable');
    expect(await kindFor(null)).toBe('retryable');
  });

  it('an AIError thrown by the client is passed through unchanged', async () => {
    const original = new AIError('declined', 'declined');
    const ai = createAnthropicAI({ client: fakeClient(() => { throw original; }).client });
    expect(await failure(ai)).toBe(original);
  });

  it('the key is never in an error message, a log line, or anything the adapter exposes', async () => {
    const key = 'sk-ant-api03-SECRET-KEY-VALUE';
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const thrown: unknown[] = [
      APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${key}` } }, `401 invalid x-api-key ${key}`, new Headers({ 'x-api-key': key })),
      apiError(429),
      new APIConnectionError({ message: `fetch failed for ${key}`, cause: new Error(key) }),
      new Error(`leak ${key}`),
      new AnthropicError(`bad ${key}`),
    ];
    for (const t of thrown) {
      const ai = createAnthropicAI({ apiKey: key, client: fakeClient(() => { throw t; }).client });
      const e = await failure(ai);
      expect(e.message).not.toContain(key);
      expect(String(e.stack)).not.toContain(key);
      expect(JSON.stringify({ ...e, message: e.message })).not.toContain(key);
      expect((e as { cause?: unknown }).cause).toBeUndefined();
    }
    const ai = createAnthropicAI({ apiKey: key, client: fakeClient().client });
    expect(JSON.stringify(ai)).not.toContain(key);
    expect(Object.keys(ai).sort()).toEqual(['id', 'read']);
    expect(ai.id).not.toContain(key);
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c.join(' '))));
    expect(logged.join('\n')).not.toContain(key);
  });
});
