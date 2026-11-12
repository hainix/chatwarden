import { buildAIInput, defineRules, PRESETS, starterRules } from '@chatwarden/core';
import type { AIReadInput, ChosenLines } from '@chatwarden/core';
import type { AnthropicLike } from '../src/anthropic.ts';

// Shared by the adapter tests: a rendered read input, a scriptable fake client and a canned response. No network, no key.

export const policy = { profile: PRESETS.standard, rules: defineRules(starterRules('standard')) };

const chosen: ChosenLines = {
  lines: [
    { ref: 'L1', lineId: 'line-1', secondsIn: 0, who: 'P2', text: 'please stop', blocked: false, filtered: false, byReported: false },
    { ref: 'L2', lineId: 'line-2', secondsIn: 4, who: 'P1', text: 'go glarn yourself you useless drakkuun', blocked: false, filtered: false, byReported: true },
  ],
  truncated: false,
  people: [
    { alias: 'P1', role: 'reported' },
    { alias: 'P2', role: 'reporter' },
  ],
  reportedLine: 'L2',
};

/** A read input rendered by core, as the service would hand it to the adapter. */
export function makeInput(): AIReadInput {
  return buildAIInput({ policy, reason: { id: 'harassment', label: 'Insults or harassment' }, note: 'told me to go away', chosen });
}

/** A valid model answer for {@link makeInput}. */
export const GOOD_OUTPUT = {
  severity: 'rude',
  rule: 2,
  summary: 'The reported player swore at the reporter once.',
  evidence: ['L2'],
  confidence: 'high',
  injectionSuspected: false,
  recommendation: { verdict: 'noted', severity: 'rude', rule: 2, evidence: ['L2'] },
};

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

/** A response the way the Messages API returns it, with the fields the adapter reads. */
export function reply(over: { content?: unknown[]; stop_reason?: string | null; stop_details?: unknown; usage?: FakeUsage } = {}) {
  return {
    id: 'msg_test',
    content: over.content ?? [{ type: 'text', text: JSON.stringify(GOOD_OUTPUT) }],
    stop_reason: over.stop_reason === undefined ? 'end_turn' : over.stop_reason,
    stop_details: over.stop_details ?? null,
    usage: { input_tokens: 900, output_tokens: 360, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, cache_creation: null, ...over.usage },
  };
}

export interface Call {
  body: Record<string, unknown>;
  options: { signal?: AbortSignal | null } | undefined;
}

/** A client whose `messages.create` records every call and answers with `respond` (a value, or a function that may throw). */
export function fakeClient(respond: unknown | ((call: Call) => unknown) = () => reply()): { client: AnthropicLike; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    messages: {
      create: (body: unknown, options?: { signal?: AbortSignal | null }) => {
        const call: Call = { body: body as Record<string, unknown>, options };
        calls.push(call);
        try {
          return Promise.resolve(typeof respond === 'function' ? (respond as (c: Call) => unknown)(call) : respond);
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  } as unknown as AnthropicLike;
  return { client, calls };
}

export const signal = (): AbortSignal => new AbortController().signal;
