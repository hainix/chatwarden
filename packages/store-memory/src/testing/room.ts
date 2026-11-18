// A room whose players are named by you. A player is a string: the first mention seats them with the key `test-key:<name>`, and the seat id is the name.
import type { Chatwarden, ChatResult, KitEvent, RawWho, ReportResult } from '@chatwarden/core';
import type { FakeClock } from './clock.js';

/**
 * What a line came to: `delivered`, `starred` (delivered with different text), or `refused:<reason>` with the kit's own reason (`length`, `rate`, `gate`,
 * `restricted`, `blocked`, `profanity`, `empty`, `slow_mode`, `flood`, `duplicate`).
 */
export type SayLabel = 'delivered' | 'starred' | `refused:${string}`;

/**
 * The outcome of one line.
 */
export interface SayOutcome {
  kind: 'say';
  player: string;
  /** The text as it was sent. */
  text: string;
  /** The kit's clock when it was sent. */
  at: number;
  /** Exactly what `cw.chat.accept` returned. */
  result: ChatResult;
  label: SayLabel;
  /** Set when this line earned an automatic timeout (`auto.restricted`): `'first'` or `'second'`. */
  autoRestricted?: 'first' | 'second';
}

export type ReportLabel = 'filed' | `refused:${string}`;

/**
 * The outcome of one report.
 */
export interface ReportOutcome {
  kind: 'report';
  player: string;
  target: string;
  at: number;
  result: ReportResult;
  label: ReportLabel;
}

/**
 * A room for a test. `say`, `report`, `mute` and `sees` seat a player on first use.
 */
export interface TestRoom {
  readonly id: string;
  /** Seat a player (idempotent). Optional: the other methods seat on first use. `who` replaces the default `{ clientKey: 'test-key:' + player }`. */
  join(player: string, who?: RawWho): void;
  say(player: string, text: string): SayOutcome;
  report(player: string, target: string, input?: { reason?: string; note?: string }): Promise<ReportOutcome>;
  /** `player` mutes (`on`, the default) or unmutes `target`. */
  mute(player: string, target: string, on?: boolean): void;
  leave(player: string): void;
  /** True when `viewer` is shown what `sender` sent (mutes applied): `cw.chat.visibleTo`. */
  sees(viewer: string, sender: string): boolean;
}

/** What a room needs from its kit. */
export interface RoomContext {
  cw: Chatwarden;
  clock: FakeClock;
  /** Every event so far, in order (the kit appends to it). */
  events: readonly KitEvent[];
}

function named(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('A player is a non-empty string.');
  return value;
}

export function createRoom(ctx: RoomContext, id: string): TestRoom {
  const { cw, clock } = ctx;
  const seated = new Set<string>();

  const join = (player: string, who?: RawWho): void => {
    const name = named(player);
    if (seated.has(name)) return;
    cw.rooms.seat(id, name, who ?? { clientKey: `test-key:${name}` }, name);
    seated.add(name);
  };

  return {
    id,
    join,
    say(player, text) {
      join(player);
      const at = clock.now();
      const seen = ctx.events.length;
      const result = cw.chat.accept(id, player, text);
      const earned = ctx.events.slice(seen).find((event) => event.type === 'auto.restricted');
      const base = { kind: 'say' as const, player, text, at, result };
      const label: SayLabel = 'deliver' in result ? (result.deliver.text === text ? 'delivered' : 'starred') : `refused:${result.refuse.reason}`;
      return earned !== undefined && earned.type === 'auto.restricted' ? { ...base, label, autoRestricted: earned.second ? 'second' : 'first' } : { ...base, label };
    },
    async report(player, target, input = {}) {
      join(player);
      join(target);
      const at = clock.now();
      const result = await cw.reports.submit({ roomId: id, reporterSeat: player, targetSeat: target, ...input });
      return { kind: 'report', player, target, at, result, label: result.ok ? 'filed' : `refused:${result.refused}` };
    },
    mute(player, target, on = true) {
      join(player);
      join(target);
      cw.mutes.set(id, player, target, on);
    },
    leave(player) {
      const name = named(player);
      cw.rooms.unseat(id, name);
      seated.delete(name);
    },
    sees(viewer, sender) {
      join(viewer);
      join(sender);
      return cw.chat.visibleTo(id, viewer, sender);
    },
  };
}
