// `@chatwarden/http/eos`: the Epic Online Services adapter (K5). Not exported from the package root. Nothing here runs at import; `eos` is a function the adopter calls.
import type { Chatwarden } from '@chatwarden/core';
import { createEosClient } from './client.js';
import { resolveOptions } from './options.js';
import type { EosOptions } from './options.js';
import { createTokenSource } from './token.js';

export type { EosKind, EosOptions, EosSeat } from './options.js';

/** What a poll did: how many reports EOS returned, how many became kit reports, and what was left out or refused, counted by reason code. */
export interface PollResult {
  seen: number;
  filed: number;
  skipped: Record<string, number>;
  refused: Record<string, number>;
}

/** What `eos` returns. @experimental */
export interface EosAdapter {
  /** One pass over `reports.players()`: find reports about them since the cursor, file the ones both of whose players are seated together. */
  pollReports(): Promise<PollResult>;
  /** Poll every `pollMs` on a timer that does not keep the process alive. `stop()` or `dispose()` ends it. */
  start(): void;
  stop(): void;
  /** Unsubscribe, clear timers, abort what is in flight and drop the queue. Safe to call more than once; nothing is written afterwards. */
  dispose(): void;
}

/**
 * The EOS adapter: kit sanctions are pushed to EOS (and removed when the kit revokes them), and EOS player reports about players your server can seat are filed as kit
 * reports. The kit stays the source of truth. You supply the two maps from your own tables (`sanctions.productUserIdsOf`, `reports.seatOf`): the kit stores no EOS id.
 * Throws `RangeError` at construction for a bad option or a store without `cw.links`.
 *
 * @experimental
 */
export function eos(cw: Chatwarden, options: EosOptions): EosAdapter {
  const o = resolveOptions(options);
  if (!cw.links.supported) throw new RangeError('eos: the store does not support links (use a store from 0.1.12 or later)');
  const call = o.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const tokens = createTokenSource({ clientId: o.clientId, clientSecret: o.clientSecret, deploymentId: o.deploymentId, baseUrl: o.baseUrl, fetch: call, clock: o.clock, logger: o.logger });
  const client = createEosClient({ tokens, baseUrl: o.baseUrl, deploymentId: o.deploymentId, fetch: call });
  void client;
  let disposed = false;
  return {
    pollReports: () => Promise.resolve({ seen: 0, filed: 0, skipped: {}, refused: {} }),
    start() {},
    stop() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      tokens.dispose();
    },
  };
}
