// A kit for tests: `createChatwarden` over a fresh memory store with a fake clock, a fixed test secret, retention off, a logger that records, the events
// recorded in order, and rooms and scripts to drive it. Nothing here is for production: it is named `testing`, it uses the memory store, and the secret is
// public. It imports no test runner and no `node:` module.
import { KIT_EVENT_TYPES, createChatwarden } from '@chatwarden/core';
import type { Chatwarden, ChatwardenOptions, ConductLevel, KitEvent, Logger, RawWho, RuleRef, Store, Suggestion } from '@chatwarden/core';
import { MemoryStore } from '../memoryStore.js';
import { createFakeClock } from './clock.js';
import type { FakeClock } from './clock.js';
import { createRoom } from './room.js';
import type { SayLabel, TestRoom } from './room.js';
import { ScriptMismatch, runScript } from './script.js';
import type { Run, Step } from './script.js';
import { wordFilter, wordMatcher } from './words.js';

/** A public secret: a test kit's hashes are keyed with it, so they match across runs and mean nothing outside a test. */
const TEST_SECRET = 'testing-secret-do-not-use-in-production';

/**
 * Options for a test kit: anything `createChatwarden` takes except the store, platform, clock, logger and secret (the kit sets those), plus two word-list
 * shorthands.
 */
export interface TestKitOptions extends Partial<Omit<ChatwardenOptions, 'store' | 'platform' | 'clock' | 'logger' | 'secret'>> {
  /** Shorthand for `matcher: wordMatcher(blocked)`. Ignored when `matcher` is given. Pass your real matcher as `matcher` to test your own term list. */
  blocked?: readonly string[];
  /** Shorthand for `profanity: wordFilter(swears)`. Ignored when `profanity` or `profanityPackage` is given. */
  swears?: readonly string[];
  /** Another store (a failing subclass, a SQLite store). Default: a fresh `MemoryStore`. */
  store?: Store;
  /** Where the clock starts. Default 1_800_000_000_000. */
  start?: number;
}

/**
 * A kit for tests.
 */
export interface TestKit {
  readonly cw: Chatwarden;
  readonly store: Store;
  readonly clock: FakeClock;
  /** Every kit event, in order (one `cw.on` subscription per event type). */
  readonly events: readonly KitEvent[];
  /** Every warning the kit logged, in order: an event name and its detail, never text. */
  readonly logged: ReadonlyArray<{ event: string; detail?: Record<string, string | number | boolean> }>;
  /** A room whose players are named by you. The same room for the same id; the default is `lobby`. */
  room(id?: string): TestRoom;
  /** Run a script and return what happened. Throws a `ScriptMismatch` at the first step whose `expect` is not met. */
  play(steps: readonly Step[], options?: { room?: string }): Promise<Run>;
  /** What the profile suggests for this player now, at this conduct level and rule (`cw.suggest` by name). */
  suggest(player: string, level: ConductLevel | null, rule?: RuleRef, room?: string): Suggestion;
  /** Close the kit. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Build a test kit.
 */
export async function createTestKit(options: TestKitOptions = {}): Promise<TestKit> {
  const { blocked, swears, store: given, start, ...rest } = options;
  const clock = createFakeClock(start);
  const store = given ?? new MemoryStore();
  const events: KitEvent[] = [];
  const logged: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logged.push(detail === undefined ? { event } : { event, detail }) };

  const matcher = rest.matcher ?? (blocked === undefined ? undefined : wordMatcher(blocked));
  const profanity = rest.profanity ?? (rest.profanityPackage === undefined && swears !== undefined ? wordFilter(swears) : undefined);

  const cw = await createChatwarden({
    retention: false,
    ...rest,
    ...(matcher === undefined ? {} : { matcher }),
    ...(profanity === undefined ? {} : { profanity }),
    store,
    secret: TEST_SECRET,
    platform: { identify: (context) => context as RawWho },
    clock,
    logger,
  });
  for (const type of KIT_EVENT_TYPES) cw.on(type, (event) => void events.push(event));

  const rooms = new Map<string, TestRoom>();
  const roomOf = (id = 'lobby'): TestRoom => {
    let room = rooms.get(id);
    if (room === undefined) {
      room = createRoom({ cw, clock, events }, id);
      rooms.set(id, room);
    }
    return room;
  };

  const suggest = (player: string, level: ConductLevel | null, rule: RuleRef = 'uncovered', room = 'lobby'): Suggestion => {
    roomOf(room).join(player);
    const subject = cw.rooms.subjectAt(room, player);
    if (subject === null) throw new Error(`${player} has no seat in ${room}.`);
    return cw.suggest(subject, level, rule);
  };

  let closed = false;
  const kit: TestKit = {
    cw,
    store,
    clock,
    events,
    logged,
    room: roomOf,
    play: (steps, playOptions) => runScript({ room: roomOf, clock, events, suggest }, steps, playOptions),
    suggest,
    async close() {
      if (closed) return;
      closed = true;
      await cw.close();
    },
  };
  return kit;
}

/**
 * For each case, build a fresh kit and one player, say the text, and compare the label. Throws one `ScriptMismatch` listing every case that differs, not
 * only the first. Each case is independent of the others (strikes and rate limits do not carry over).
 */
export async function checkLines(options: TestKitOptions, cases: ReadonlyArray<{ text: string; expect: SayLabel }>): Promise<void> {
  const differing: string[] = [];
  for (const [index, line] of cases.entries()) {
    const kit = await createTestKit(options);
    try {
      const outcome = kit.room().say('player', line.text);
      if (outcome.label !== line.expect) {
        const text = line.text.length > 40 ? `${line.text.slice(0, 37)}...` : line.text;
        differing.push(`  case ${index + 1} ${JSON.stringify(text)}: expected ${line.expect}, got ${outcome.label}`);
      }
    } finally {
      await kit.close();
    }
  }
  if (differing.length === 0) return;
  throw new ScriptMismatch(`${differing.length} of ${cases.length} lines differ:\n${differing.join('\n')}`, { step: 0, expected: String(cases.length), actual: String(differing.length) });
}
