import { errorClass, safeWarn } from './log.js';
import type { Clock, Logger, Store } from './types.js';

// The daily line counter behind Insights' report rate (`desk.insights`). A count of lines delivered and lines refused per UTC day: no player, room, seat or text. It is held in memory and
// written to the store (`addChatCounts`, which adds) when the minute changes or at `flush()`, so `accept` pays for at most one small write a minute and a crash loses at most the open minute.
// It does nothing while the setting is off, and it never throws.

/** The UTC date of an instant as `YYYY-MM-DD`: the key of a daily count. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface ChatCounterDeps {
  clock: Clock;
  /** Read on every call, so the setting applies at once. */
  enabled: () => boolean;
  store: Pick<Store, 'addChatCounts'>;
  logger?: Logger;
}

export class ChatCounter {
  private readonly clock: Clock;
  private readonly enabled: () => boolean;
  private readonly store: Pick<Store, 'addChatCounts'>;
  private readonly logger: Logger | undefined;
  /** Counts not yet written, by UTC day. */
  private pending = new Map<string, { delivered: number; refused: number }>();
  /** The minute (epoch minutes) the held counts belong to; null when nothing is held. */
  private minute: number | null = null;

  constructor(deps: ChatCounterDeps) {
    this.clock = deps.clock;
    this.enabled = deps.enabled;
    this.store = deps.store;
    this.logger = deps.logger;
  }

  /** A line was delivered. */
  delivered(): void {
    this.note('delivered');
  }

  /** A line was refused (an empty line is not a line and is never counted by the caller). */
  refused(): void {
    this.note('refused');
  }

  /** Write what is held now. A failure is logged by class; the counts stay and go with the next flush. Does nothing while the setting is off (what was held is dropped). */
  flush(): void {
    try {
      if (!this.enabled()) {
        this.pending.clear();
        this.minute = null;
        return;
      }
      this.write();
    } catch (err) {
      this.fail(err);
    }
  }

  private note(kind: 'delivered' | 'refused'): void {
    try {
      if (!this.enabled()) {
        // Off: nothing is counted and nothing held from an earlier "on" is ever written.
        if (this.pending.size > 0) this.pending.clear();
        this.minute = null;
        return;
      }
      const now = this.clock.now();
      const minute = Math.floor(now / 60_000);
      if (this.minute !== null && minute !== this.minute) this.write();
      this.minute = minute;
      const day = utcDay(now);
      let slot = this.pending.get(day);
      if (slot === undefined) this.pending.set(day, (slot = { delivered: 0, refused: 0 }));
      slot[kind] += 1;
    } catch (err) {
      this.fail(err);
    }
  }

  /** One `addChatCounts` per held day; a day that is written is forgotten, one that fails stays. */
  private write(): void {
    if (typeof this.store.addChatCounts !== 'function') {
      this.pending.clear();
      return;
    }
    for (const [day, slot] of [...this.pending]) {
      if (slot.delivered === 0 && slot.refused === 0) {
        this.pending.delete(day);
        continue;
      }
      try {
        this.store.addChatCounts(day, slot.delivered, slot.refused);
        this.pending.delete(day);
      } catch (err) {
        this.fail(err);
      }
    }
  }

  private fail(err: unknown): void {
    safeWarn(this.logger, 'chatwarden.chat_counts_failed', { error: errorClass(err) });
  }
}
