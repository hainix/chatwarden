import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AnthropicError, AuthenticationError, BadRequestError, InternalServerError, PermissionDeniedError, RateLimitError } from '@anthropic-ai/sdk';
import { AIError } from '@chatwarden/core';
import type { AIReadInput, AIReadResult, ModerationAI } from '@chatwarden/core';
import { costMicros, HAIKU_5_5_PRICES } from './prices.ts';
import type { PriceTable } from './prices.ts';

// A ModerationAI for the Anthropic Messages API (design 2026-11-11, sections 3, 4 and 7). Core renders the prompt, redacts the
// text and validates the answer; this file only sends the rendered prompt and maps what comes back. It never edits prompt text,
// never sends an identifier (no `metadata.user_id`, nothing but the prompt and the schema), and never throws anything but an
// `AIError`. It is written so it can be copied into a server as it is.

export type { PriceTable } from './prices.ts';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** The one response shape the adapter reads. The SDK's `Message` satisfies it; a test fake can be this small. */
export interface AnthropicResponseLike {
  content: ReadonlyArray<{ type: string; text?: unknown }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  } | null;
}

/** The one method used, so a test injects a fake and a real `new Anthropic()` fits. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.Messages.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal | null }): PromiseLike<AnthropicResponseLike>;
  };
}

export interface AnthropicAIOptions {
  /** Default: the `ANTHROPIC_API_KEY` environment variable (the SDK reads it). Never logged, never put in an error. */
  apiKey?: string;
  /** Default `claude-haiku-5-5`. */
  model?: string;
  /** Default `low`. How much the model thinks before it answers; thinking tokens bill as output. */
  effort?: 'low' | 'medium' | 'high';
  /** Default `5m`. `off` sends no `cache_control`; `1h` keeps the stable prompt cached for an hour (a dearer write). */
  cache?: 'off' | '5m' | '1h';
  /** SDK timeout per attempt, milliseconds. Default 20 000. */
  timeoutMs?: number;
  /** SDK retries (408, 409, 429, 5xx, connection errors). Default 2. */
  maxRetries?: number;
  /** Default 1024: the hard ceiling on one answer. */
  maxTokens?: number;
  /** `off` sends `thinking: { type: 'disabled' }` (the eval's cost experiment). Default `adaptive`: the field is left unset. */
  thinking?: 'adaptive' | 'off';
  /** Default: the Haiku 5.5 table. Pass your own when you change the model. */
  prices?: PriceTable;
  /** A client to use instead of building one (tests, or a client you configured yourself). */
  client?: AnthropicLike;
}

/** The SDK client the adapter builds: 20 s timeout and 2 retries unless told otherwise. */
export function buildClient(opts: Pick<AnthropicAIOptions, 'apiKey' | 'timeoutMs' | 'maxRetries'> = {}): Anthropic {
  return new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 20_000, maxRetries: opts.maxRetries ?? 2 });
}

const fail = (kind: AIError['kind'], message: string): AIError => new AIError(kind, message);

/** A provider error as an AIError. The message is a fixed phrase and a status number: provider text is never copied (it can echo a header). */
function toAIError(e: unknown, signal: AbortSignal): AIError {
  if (e instanceof AIError) return e;
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  if (signal.aborted || e instanceof APIUserAbortError || e instanceof APIConnectionTimeoutError || name === 'AbortError' || name === 'TimeoutError') {
    return fail('timeout', 'timeout');
  }
  // APIConnectionError is a subclass of APIError in the TypeScript SDK, so it is checked first.
  if (e instanceof APIConnectionError) return fail('retryable', 'connection error');
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError || e instanceof BadRequestError) return fail('fatal', `rejected (${e.status})`);
  if (e instanceof RateLimitError || e instanceof InternalServerError) return fail('retryable', `provider error (${e.status})`);
  if (e instanceof APIError) {
    const s = e.status;
    if (s === 408) return fail('timeout', 'timeout');
    if (s === undefined || s === 409 || s === 429 || s >= 500) return fail('retryable', `provider error (${String(s)})`);
    return fail('fatal', `rejected (${s})`);
  }
  // Any other SDK error is a setup problem (no key, bad option): retrying cannot fix it. With no credentials the SDK throws a plain
  // Error (not an AnthropicError) before any request is made.
  if (e instanceof AnthropicError || (e instanceof Error && e.message.startsWith('Could not resolve authentication'))) return fail('fatal', 'client setup error');
  return fail('retryable', 'unexpected error');
}

/** True when a key can be found the way the SDK finds it: the option, or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the environment. */
function hasCredentials(apiKey: string | undefined): boolean {
  const env = typeof process === 'undefined' ? {} : process.env;
  return [apiKey, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some((v) => typeof v === 'string' && v.trim() !== '');
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function usageOf(r: AnthropicResponseLike, model: string, cache: 'off' | '5m' | '1h', prices: PriceTable): AIReadResult['usage'] {
  const u = r.usage ?? {};
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const cacheRead = count(u.cache_read_input_tokens);
  const cacheWrite = count(u.cache_creation_input_tokens);
  // Price each write at its own rate when the response splits them; any rest at the rate of the configured TTL.
  let w5 = count(u.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = count(u.cache_creation?.ephemeral_1h_input_tokens);
  const rest = Math.max(0, cacheWrite - w5 - w1);
  if (cache === '1h') {
    return { model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costMicros: costMicros({ input, output, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1 + rest }, prices) };
  }
  w5 += rest;
  return { model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costMicros: costMicros({ input, output, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1 }, prices) };
}

/** The first text block, found by type: the answer can follow `thinking` blocks. */
function textOf(content: AnthropicResponseLike['content']): string | null {
  for (const block of content) if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') return block.text;
  return null;
}

/**
 * A {@link ModerationAI} on the Anthropic Messages API. One non-streaming call per read: the stable prompt is the (cached) system
 * block, the data block is the only user message, and the answer is shaped by the static JSON schema (`output_config.format`).
 *
 * A refusal throws `AIError('declined')`; auth, permission and rejected-request errors are `fatal`; rate limits, overload,
 * 5xx and connection errors are `retryable`; timeouts and aborts are `timeout`. A truncated (`max_tokens`) or unparseable answer
 * is returned as it is, unparseable, so core stores one `invalid` read.
 */
export function createAnthropicAI(opts: AnthropicAIOptions = {}): ModerationAI {
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? 'low';
  const cache = opts.cache ?? '5m';
  const maxTokens = opts.maxTokens ?? 1024;
  const prices = opts.prices ?? HAIKU_5_5_PRICES;
  let client: AnthropicLike | undefined = opts.client;

  return {
    id: `anthropic:${model}`,

    async read(input: AIReadInput, options: { signal: AbortSignal }): Promise<AIReadResult> {
      const { signal } = options;
      if (signal.aborted) throw fail('timeout', 'timeout');
      // No key anywhere is a setup mistake: fatal at once, before a client or a request exists. (Credential profiles and config files the
      // SDK can also read are not looked for here; build the client yourself and pass it as `client`.)
      if (client === undefined && !hasCredentials(opts.apiKey)) throw fail('fatal', 'no API key');
      let response: AnthropicResponseLike;
      try {
        client ??= buildClient(opts);
        const cacheControl = cache === 'off' ? {} : { cache_control: cache === '1h' ? { type: 'ephemeral' as const, ttl: '1h' as const } : { type: 'ephemeral' as const } };
        response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: [{ type: 'text', text: input.prompt.stable, ...cacheControl }],
            messages: [{ role: 'user', content: input.prompt.variable }],
            output_config: { effort, format: { type: 'json_schema', schema: input.prompt.schema as { [key: string]: unknown } } },
            ...(opts.thinking === 'off' ? { thinking: { type: 'disabled' as const } } : {}),
          },
          { signal },
        );
      } catch (e) {
        throw toAIError(e, signal);
      }
      if (typeof response !== 'object' || response === null || !Array.isArray(response.content)) throw fail('retryable', 'unexpected response');

      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category;
        throw fail('declined', typeof category === 'string' && /^[a-z_]{1,40}$/.test(category) ? `declined (${category})` : 'declined');
      }
      const usage = usageOf(response, model, cache, prices);
      const text = textOf(response.content);
      // Anything but a normal end (a cut-off at max_tokens, a tool call, a pause) is not a complete answer: hand core what there is, unparsed.
      if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence') return { output: text, usage };
      if (text === null) return { output: null, usage };
      try {
        return { output: JSON.parse(text) as unknown, usage };
      } catch {
        return { output: text, usage };
      }
    },
  };
}
