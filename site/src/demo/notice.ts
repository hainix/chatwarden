// Words for what the real kit says to the visitor in the chat: how long a timeout lasts, when it ends, why a line was refused.
// (The notices a player reads and the report dialog are player-react's words, and the moderator's are the hub's.) Plain functions
// with no React in them, so each case is easy to test. The `switch` ends in a `never` check: when the kit grows a new refusal, the
// demo stops compiling instead of quietly saying something else.
import type { RefuseReason } from './engine';

const MIN = 60_000;
const HOUR_MS = 60 * MIN;
const DAY_MS = 24 * HOUR_MS;

function assertNever(x: never): never {
  throw new Error(`unhandled value: ${String(x)}`);
}

/**
 * A length of time in the largest whole unit that fits, the way the kit words it: `30 minutes`, `24 hours`, `7 days`.
 * A timeout's start and the notice's timestamp can differ by a few milliseconds, so the length is rounded to the minute first.
 */
function unit(ms: number): { n: number; unit: 'minute' | 'hour' | 'day' } {
  const minutes = Math.max(1, Math.round(ms / MIN));
  if (minutes >= 2 * 1440 && minutes % 1440 === 0) return { n: minutes / 1440, unit: 'day' };
  if (minutes >= 60 && minutes % 60 === 0) return { n: minutes / 60, unit: 'hour' };
  return { n: minutes, unit: 'minute' };
}

export function durationWords(ms: number): string {
  const u = unit(ms);
  return `${u.n} ${u.unit}${u.n === 1 ? '' : 's'}`;
}

/**
 * When a timeout ends, for every place that shows one (the seat chip, the notice, "My record", the composer note). A bare
 * clock time is only honest when the end is soon and today: a 24 hour or 7 day timeout ending at "12:14 AM" reads as "now".
 * So: the time alone when it ends within 12 hours on the same day; the weekday and time when it is further off or on another
 * day (up to five days); the date and time beyond that.
 */
export function formatUntil(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const away = ms - now;
  if (away <= 12 * HOUR_MS && d.toDateString() === new Date(now).toDateString()) return time;
  if (away < 6 * DAY_MS) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A timeout longer than this leaves a scripted player silent for long enough that the visitor needs to be told why. */
export const QUIET_AFTER_MS = 5 * MIN;

/** Why a timed out scripted player has gone quiet, with the way out. Null for a timeout of a few minutes or less. */
export function quietNote(name: string, ms: number, pronoun: 'he' | 'she'): string | null {
  if (ms <= QUIET_AFTER_MS) return null;
  return `${name} is timed out for ${durationWords(ms)}, so ${pronoun}'s gone quiet. Press Start over to replay.`;
}

interface Refusal {
  reason: RefuseReason;
  until?: number | null;
  byModerator?: boolean;
  rule?: number;
}

/**
 * Why a line did not go out, for the sender. `at` formats a time; `rule` names a Community Rule number.
 * `blocked` is shown in the chat itself (the stamp), so it is only worded here for completeness.
 */
export function refusalMessage(r: Refusal, lineMax: number, at: (ms: number) => string, rule: (n: number) => string): string {
  switch (r.reason) {
    case 'empty':
      return 'Type something first.';
    case 'length':
      return `That line is too long. Keep it to ${lineMax} characters or fewer.`;
    case 'rate':
      return 'Too fast: three lines every five seconds. Wait a moment, then send again.';
    case 'gate':
      return 'You cannot chat in this lobby right now.';
    case 'profanity':
      return 'That line has language this lobby does not allow. Change it and send again.';
    case 'blocked':
      return `Blocked (rule ${r.rule ?? 1}). Only you can see this.`;
    case 'restricted': {
      const by = r.byModerator === true ? 'A moderator' : 'The automatic filter';
      const under = typeof r.rule === 'number' ? ` (${rule(r.rule)})` : '';
      if (typeof r.until !== 'number') return `${by} has banned you from chat${under}. Press Start over to replay.`;
      return `${by} has put you on a chat timeout until ${at(r.until)}${under}. Press Start over to replay.`;
    }
    // Pacing (0.1.8): the demo profile turns none of these on, so they are worded only for completeness.
    case 'slow_mode':
      return 'Slow mode is on. Wait a moment, then send again.';
    case 'flood':
      return 'Too many lines at once. Wait a moment, then send again.';
    case 'duplicate':
      return 'You just sent that. Say something new.';
    default:
      return assertNever(r.reason);
  }
}
