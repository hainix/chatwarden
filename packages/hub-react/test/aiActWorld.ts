import { MemoryStore, withMemoryAi, withMemoryAppeals } from '@chatwarden/store-memory';
import type { AiActionRow } from '@chatwarden/core';
import { hubWorld, DAY, MINUTE, T0 } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The hub's test world for acting (AI levels 3 and 4, release 2): the AI on at Recommend, the code's ceiling at 3 with an `act` block, appeals on, over
// a store that keeps the acting state and the action rows. Each option takes one of those away, to see the reason the hub gives.

export interface ActWorldOptions extends WorldOptions {
  /** The code's ceiling (default 3). */
  maxLevel?: 2 | 3;
  /** The hub's AI level (default 2). */
  level?: 0 | 1 | 2;
  /** Appeals on (default true). */
  appeals?: boolean;
  /** No adapter at all (the AI is not set up). */
  noAdapter?: boolean;
}

type ActStore = MemoryStore & { insertAiAction(row: AiActionRow): boolean };

export async function actWorld(o: ActWorldOptions = {}) {
  const { maxLevel = 3, level = 2, appeals = true, noAdapter = false, ...rest } = o;
  const store = withMemoryAppeals(withMemoryAi(new MemoryStore())) as unknown as ActStore;
  const w = await hubWorld({
    role: 'owner',
    actor: 'owen@example.test',
    store,
    ...(noAdapter ? {} : { ai: { level, options: maxLevel === 3 ? { maxLevel: 3, act: {} } : {} } }),
    ...rest,
    overrides: { ...(appeals ? { appeals: { enabled: true, perPlayerPerWeek: 20 } } : {}), ...(rest.overrides ?? {}) },
  });
  /** The owner starts shadow through the kit itself (the real transition), so a test starts from a state the server holds. */
  const startShadow = (): void => {
    const r = w.cw.ai.acting.startShadow('owen@example.test', { confirm: 'ACT', reason: 'Trying shadow' });
    if (!r.ok) throw new Error(`startShadow refused: ${r.error}`);
  };
  /** A "would have applied" row for a report that exists: a 24 hour chat restriction by default. */
  let n = 0;
  const shadowRow = (reportId: string, over: Partial<AiActionRow> = {}): AiActionRow => {
    n += 1;
    const row: AiActionRow = {
      id: `act-${n}`,
      reportId,
      readId: `read-${n}`,
      confirmReadId: `confirm-${n}`,
      rule: '2',
      severity: 'hostile',
      state: 'shadow',
      refusedCode: null,
      notBefore: T0 - DAY,
      createdAt: T0 + MINUTE * n,
      groupId: null,
      kind: 'chat',
      durationMs: DAY,
      actedAt: T0 + MINUTE * n,
      reviewDueAt: null,
      reviewedAt: null,
      reviewedBy: null,
      undoCode: null,
      undoNote: null,
      adapter: 'fake',
      promptVersion: 5,
      ...over,
    };
    if (!store.insertAiAction(row)) throw new Error('row not inserted');
    return row;
  };
  return { w: w as HubWorld, store, startShadow, shadowRow };
}
