import { safeWarn } from './log.js';
import type { RuleRef } from './rules.js';
import type { Logger, ReportCategory, SanctionKind, Source, SubjectId } from './types.js';

// The kit's events: what a staff channel (a webhook, a Discord post, a dashboard) hears when moderation state
// changes. They are announced from the facade AFTER the operation has committed, never for a refused or failed
// one, and a listener can never hurt the operation that raised them.

/**
 * The canonical subject id of a person, as staff tools see it. Events are staff-only: a StaffRef is an identifier,
 * so an event must never be forwarded to a player.
 */
export type StaffRef = SubjectId;

/**
 * Something that happened in the kit. Staff only: `target` is a {@link StaffRef}. An event carries ids, codes,
 * rule numbers and times; it never carries chat text, a moderator's reason, evidence, a reporter's note or a rule-gap
 * note.
 */
export type KitEvent =
  /** A report was stored. `roomTags` are the adopter's own room tags at the time, not player text. */
  | { type: 'report.created'; reportId: string; createdAt: number; category: ReportCategory; roomTags: Readonly<Record<string, string>> }
  /** A decision closed a report. Emitted once per decision, never for a replay. */
  | { type: 'report.closed'; reportId: string; verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith'; at: number }
  /**
   * A sanction group was written (by `decide` or `sanctions.apply`, a note included). `until` is when it ends, or
   * null for a permanent one and for a warning or note (read `kind`). The automatic slur timeout is
   * `auto.restricted`, not this.
   */
  | {
      type: 'sanction.applied';
      groupId: string;
      refCode: string;
      kind: SanctionKind;
      until: number | null;
      rule: RuleRef;
      source: Source;
      automated: boolean;
      target: StaffRef;
    }
  /** A sanction group was revoked by this call. */
  | { type: 'sanction.revoked'; groupId: string; refCode: string; at: number }
  /** A moderator filed a sanction under `'uncovered'` and a rule-gap row now exists for the group. */
  | { type: 'gap.created'; groupId: string; refCode: string; at: number }
  /** A blocked line earned an automatic timeout that was stored; `second` is true for the 24 h repeat. */
  | { type: 'auto.restricted'; groupId: string; refCode: string; second: boolean };

/** Every event type, for checking a subscription. */
export const KIT_EVENT_TYPES: readonly KitEvent['type'][] = [
  'report.created',
  'report.closed',
  'sanction.applied',
  'sanction.revoked',
  'gap.created',
  'auto.restricted',
];

/** The event of a type. */
export type KitEventOf<T extends KitEvent['type']> = Extract<KitEvent, { type: T }>;

/** A listener. It may be async; a throw or a rejection is logged by class and ignored. */
export type KitListener<E extends KitEvent = KitEvent> = (event: E) => void | Promise<void>;

/** `cw.on`: subscribe to one event type, or `'*'` for all; returns the unsubscribe function. */
export interface Subscribe {
  <T extends KitEvent['type']>(type: T, listener: KitListener<KitEventOf<T>>): () => void;
  (type: '*', listener: KitListener): () => void;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function';

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

interface Entry {
  type: KitEvent['type'] | '*';
  listener: KitListener;
  active: boolean;
}

/** Freeze an event, and the tag map inside it, so no listener can change what the next one sees. */
function freezeEvent<E extends KitEvent>(event: E): E {
  if (event.type === 'report.created') Object.freeze(event.roomTags);
  return Object.freeze(event);
}

/**
 * The listeners of one kit. Listeners run in registration order, synchronously, in the emitter's call. Each is fenced:
 * a sync throw or an async rejection is logged (`chatwarden.listener_failed`, error class only) and nothing else
 * happens, so no listener can fail the operation or starve the others.
 */
export class EventBus {
  private entries: Entry[] = [];
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  readonly on: Subscribe = ((type: KitEvent['type'] | '*', listener: KitListener): (() => void) => {
    if (type !== '*' && !KIT_EVENT_TYPES.includes(type)) throw new TypeError('on: unknown event type');
    if (typeof listener !== 'function') throw new TypeError('on: the listener must be a function');
    const entry: Entry = { type, listener, active: true };
    this.entries = [...this.entries, entry];
    return () => {
      entry.active = false;
      this.entries = this.entries.filter((e) => e !== entry);
    };
  }) as Subscribe;

  /** Announce an event. Never throws. */
  emit(event: KitEvent): void {
    try {
      const frozen = freezeEvent(event);
      // The list is replaced on every (un)subscribe, so this snapshot is stable while listeners run.
      for (const entry of this.entries) {
        if (!entry.active || (entry.type !== '*' && entry.type !== frozen.type)) continue;
        try {
          const out: unknown = entry.listener(frozen);
          if (isThenable(out)) out.then(undefined, (err: unknown) => this.failed(err));
        } catch (err) {
          this.failed(err);
        }
      }
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    safeWarn(this.logger, 'chatwarden.listener_failed', { error: errName(err) });
  }
}
