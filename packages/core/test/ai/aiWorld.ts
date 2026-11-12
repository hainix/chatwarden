import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import { createFakeModerationAI } from '../../src/ai/fake.js';
import type { FakeModerationAI, FakeScript } from '../../src/ai/fake.js';
import type { AiOptions } from '../../src/ai/service.js';
import type { Chatwarden, ChatwardenOptions } from '../../src/chatwarden.js';
import type { Store } from '../../src/types.js';
import { MIN, NOW, OWNER, world } from '../reportingWorld.js';
import type { World } from '../reportingWorld.js';

// A kit with the AI on, over a MemoryStore with a manual clock and the scripted fake. No network, no key.

export { MIN, NOW, OWNER };
export const DAY = 24 * 3_600_000;

export interface AiWorldOptions {
  level?: 0 | 1 | 2;
  /** The owner's daily call ceiling (profile.ai.dailyCalls). */
  dailyCalls?: number;
  script?: FakeScript;
  adapter?: FakeModerationAI;
  ai?: Partial<AiOptions>;
  over?: Partial<ChatwardenOptions>;
  store?: Store;
}

export async function aiWorld(o: AiWorldOptions = {}) {
  const adapter = o.adapter ?? createFakeModerationAI(o.script ?? []);
  const level = o.level ?? 1;
  const w = await world(
    {
      ai: { adapter, ...(o.ai ?? {}) },
      overrides: { ai: { level, ...(o.dailyCalls === undefined ? {} : { dailyCalls: o.dailyCalls }) } },
      ...(o.over ?? {}),
    },
    o.store ?? withMemoryAi(new MemoryStore()),
  );
  /** A fresh room, a few lines by the target, then the report. Returns the report id. */
  let reporters = 0;
  const report = async (texts: string[] = ['you are trash', 'uninstall the game'], extra: Parameters<World['submit']>[1] = {}) => {
    // A new reporter each time: one reporter may file 10 reports a day.
    reporters += 1;
    const t = w.table({ reporter: `key-ai-reporter-${reporters}` });
    for (const text of texts) {
      w.clock.t += 6_000;
      w.cw.chat.accept(t.room, 'p2', text);
    }
    w.clock.t += 1_000;
    const res = await w.submit(t.room, extra);
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { ...t, id: res.reportId };
  };
  const idle = async (): Promise<void> => {
    // A job may queue another (a follow-up, a retry); settle until nothing moves.
    for (let i = 0; i < 5; i += 1) await w.cw.ai.idle();
  };
  return { ...w, adapter, report, idle };
}

export type AiWorld = Awaited<ReturnType<typeof aiWorld>>;

export type { Chatwarden };
