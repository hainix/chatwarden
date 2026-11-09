import { ChatService } from './chat.js';
import { DecisionService, revokeAndWithdraw } from './decide.js';
import type { DecisionInput, DecisionResult } from './decide.js';
import type { ChatResult, Starrer } from './chat.js';
import { DoorService } from './doors.js';
import type { DoorKind, DoorRefusal } from './doors.js';
import { EvidenceBuffer, RoomRoster } from './evidence.js';
import { hashWho, makeHasher } from './hasher.js';
import { safeWarn } from './log.js';
import { historyOf, recordStep, suggestAction } from './ladder.js';
import type { ActionRecord } from './ladder.js';
import { MuteService } from './mutes.js';
import { NoticeService } from './notices.js';
import type { PlayerNotice } from './notices.js';
import { ReportService } from './reports.js';
import type { ReportCounts, ReportInput, ReportResult } from './reports.js';
import { purge } from './retention.js';
import type { PurgeResult, RetentionPolicy } from './retention.js';
import { defineRules, STARTER_RULES } from './rules.js';
import type { CommunityRules, RuleRef } from './rules.js';
import { applySanction, SanctionIndex } from './sanctions.js';
import type { SanctionInput } from './sanctions.js';
import { StrikeService } from './strikes.js';
import { SubjectIndex } from './subjects.js';
import type {
  Clock,
  Logger,
  Matcher,
  Platform,
  RawWho,
  SanctionKind,
  Severity,
  Store,
  StoredReport,
  SubjectId,
} from './types.js';

/** The wall clock, used only when the adopter injects none. Tests and replays pass their own. */
const systemClock: Clock = { now: () => Date.now() };

/** How often the built-in retention purge runs unless `retention.everyMs` says otherwise: 6 hours. */
const DEFAULT_PURGE_EVERY_MS = 21_600_000;

/** The longest delay `setInterval` honours: Node clamps anything above 2^31-1 ms to 1 ms. */
const MAX_PURGE_EVERY_MS = 2_147_483_647;

/**
 * One rule gap, for the moderators' rules review. It names the sanction group and its reference code but never
 * a person: no subject id, key or hash.
 */
export interface GapRow {
  groupId: string;
  refCode: string;
  /** Epoch ms the sanction was made. */
  at: number;
  /** The moderator who cited `'uncovered'`. */
  actor: string;
  /** The moderator's private note on what the rules did not cover. Staff only: never show it to a player. */
  note: string;
  rule: 'uncovered';
  status: 'open' | 'ruled' | 'not_a_rule';
}

/** Everything {@link createChatwarden} needs. Only the store, the secret and the platform are required. */
export interface ChatwardenOptions {
  /** Where moderation state lives (for example `openStore(...)` from `@chatwarden/store-sqlite`). */
  store: Store;
  /** Secret that keys the client-key and IP hashes. Keep it stable: changing it unlinks every stored hash. */
  secret: string;
  platform: Platform;
  /** Without one, nothing is ever blocked. An adopter holding `LiveTerms` passes it here. */
  matcher?: Matcher;
  starrer?: Starrer;
  /** Defaults to the system clock. */
  clock?: Clock;
  /** The kill switch, read per call. Drives both sanction enforcement and report intake. Defaults to always on. */
  enabled?: () => boolean;
  /** Who may chat: false refuses the line with `'gate'`. Called with the room and the sender's subject. */
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
  /**
   * Told once for each stored report. Fenced: a throw never reaches the reporter.
   *
   * The report carries SUBJECT IDS (reporter and target) and the evidence lines, so it is for staff channels
   * only (a moderator queue, a private log). Never forward it, or any part of it, to a player.
   */
  onReport?: (report: StoredReport, counts: ReportCounts) => void;
  /** Told once when a blocked line earned an automatic timeout; `second` is true for the 24 h repeat. */
  onAutoRestrict?: (subject: SubjectId | null, second: boolean) => void;
  /**
   * Retention purge. On by default: the kit deletes rows past their retention (see `RETENTION_DEFAULTS`) every
   * `everyMs` (default 6 hours) on a timer that does not keep the process alive. Give a policy to change how
   * long rows are kept, `{ everyMs }` (at most 2147483647) to change how often it runs, or `false` to turn it off and run
   * `purge()` yourself. A failing purge is logged (`chatwarden.purge_failed`) and never thrown; `close()`
   * stops the timer.
   */
  retention?: false | ({ everyMs?: number } & Partial<RetentionPolicy>);
  /** Passed to every component. Defaults to `console.warn`. */
  logger?: Logger;
  /**
   * The numbered Community Rules, from `defineRules`. Default: `defineRules(STARTER_RULES)`. A decision may cite
   * only an active rule here, and notices show the rule's title.
   */
  rules?: CommunityRules;
  /**
   * The Community Rule the automatic slur filter cites: on a `blocked` refusal, on the automatic timeout it earns
   * and on the notice for it. Default 1. Must be a rule in `rules` that is not retired, else creation throws a
   * `RangeError`; set it when your registry numbers slurs differently.
   */
  autoRestrictRule?: number;
}

/** The moderation kit as an adopter uses it. Nothing here returns an identifier meant for a player. */
export interface Chatwarden {
  rooms: {
    /**
     * Seat a person: hash `who`, resolve them to a subject (creating or linking as needed) and put them in the
     * seat. A seat that is already held changes hands; earlier evidence keeps naming the earlier occupant.
     */
    seat(roomId: string, seatId: string, who: RawWho, handle: string, tags?: Record<string, string>): void;
    /** `seat` with `who` taken from `platform.identify(ctx)`. */
    seatConnection(roomId: string, seatId: string, ctx: unknown, handle: string, tags?: Record<string, string>): void;
    unseat(roomId: string, seatId: string): void;
    /** Forget the room's seats and tags and drop its evidence. */
    close(roomId: string): void;
    /**
     * The subject id of the seat's current occupant, or null. A server-side helper for admin tooling and
     * sanctions. NEVER send the result to a player: a subject id is an identifier.
     */
    subjectAt(roomId: string, seatId: string): SubjectId | null;
  };
  chat: {
    accept(roomId: string, seatId: string, text: string, opts?: { audience?: string[] }): ChatResult;
    /** Should `viewerSeat` be shown a line `senderSeat` sent (mutes applied)? */
    visibleTo(roomId: string, viewerSeat: string, senderSeat: string): boolean;
  };
  mutes: {
    /** `viewerSeat`'s occupant mutes (`on`) or unmutes `targetSeat`'s occupant. Does nothing if either seat has no subject. */
    set(roomId: string, viewerSeat: string, targetSeat: string, on: boolean): void;
    /** The seats whose current occupant the viewer has muted. Seat ids only. */
    mutedSeats(roomId: string, viewerSeat: string): string[];
  };
  reports: { submit(input: ReportInput): Promise<ReportResult> };
  doors: { check(kind: DoorKind, who: RawWho): DoorRefusal | null };
  sanctions: {
    /**
     * Write one sanction group and make it live at once. Resolves with the group id and the player-quotable ref
     * code. This writes no player notice: `decide` is the path that does.
     */
    apply(input: SanctionInput): Promise<{ groupId: string; refCode: string }>;
    /**
     * Revoke a whole group and withdraw its player notice in the same transaction: an unseen notice is never shown,
     * a seen one leaves "My record". Resolves true when this call revoked something.
     */
    revoke(groupId: string, actor: string, reason: string): Promise<boolean>;
  };
  /** The registry in use (the one given, or the starter rules). Retired rules stay listed. */
  rules: CommunityRules;
  /**
   * Player-facing notices and "My record". Each takes the same `RawWho` as the doors, hashes it and FINDS the person
   * (never creates one): an unknown person gets empty lists and `false`. An IP alone finds nobody. A failure in the
   * store is logged (`chatwarden.notices_failed`) and reads as empty or `false`. The values are `PlayerNotice`s:
   * no subject, key, hash, moderator or reason.
   */
  notices: {
    /** Notices not yet seen, oldest first. A pending warning must be shown and acked before the next game starts. */
    pending(who: RawWho): PlayerNotice[];
    /** Mark one of this person's notices seen. False for another person's, an unknown id or a withdrawn notice. */
    ack(who: RawWho, id: string): boolean;
    /** "My record": the person's sanction notices that still apply, seen or not. */
    record(who: RawWho): PlayerNotice[];
    /** True while the person has a warning they have not acknowledged. */
    pendingWarning(who: RawWho): boolean;
  };
  /**
   * Decide a report: close it, write each sanction and its notice, and tell the people involved, in one
   * transaction. Idempotent (the same decision again is a replay). A malformed or disallowed decision resolves
   * `{ ok: false, error: 'invalid' }`; a STORE failure REJECTS with the store's own error and writes nothing, so a
   * route handler should catch it. Moderator-side: the result carries subject ids, so never forward it to a player.
   */
  decide(input: DecisionInput): Promise<DecisionResult>;
  /** The person's counted actions in the last 90 days. Server-side: for the moderator's view only. */
  history(subject: SubjectId): ActionRecord[];
  /** The next step the ladder suggests for this person's record. It selects nothing; show it as one line. */
  suggest(
    subject: SubjectId,
    severity: Severity | null,
    rule: RuleRef,
  ): { kind: SanctionKind; durationMs: number | null; label: string };
  /** Rule gaps: sanctions a moderator filed under `'uncovered'`, for the periodic rules review. Staff only. */
  gaps: {
    list(): GapRow[];
    /** Close an open gap as `ruled` (with the new rule number as `ref`) or `not_a_rule` (`ref` null). True when this call closed it. */
    close(groupId: string, status: 'ruled' | 'not_a_rule', ref: string | null, actor: string): boolean;
  };
  /**
   * Delete rows past retention now. The built-in timer already does this (unless `retention: false`); the
   * policy given at creation is the default here, and `policy` overrides it field by field.
   */
  purge(policy?: Partial<RetentionPolicy>): Promise<PurgeResult>;
  /** Wait for background store writes (identity linking) to land. */
  flush(): Promise<void>;
  /** Flush, then close the store (a database handed in by the host stays open). */
  close(): Promise<void>;
}

/**
 * Wire every component and return the kit. This is the recommended entry point: the component classes stay
 * exported for adapters and advanced use, but an adopter needs only this.
 *
 * Every index is loaded from the store before this resolves, so the first chat line already sees stored
 * sanctions, mutes and strikes. The facade has no term list: an adopter that edits terms holds `LiveTerms`
 * from `@chatwarden/matcher` itself and passes it as `matcher`.
 */
export async function createChatwarden(opts: ChatwardenOptions): Promise<Chatwarden> {
  const { store, platform } = opts;
  const clock = opts.clock ?? systemClock;
  const enabled = opts.enabled ?? ((): boolean => true);
  const logger = opts.logger;
  const hasher = makeHasher(opts.secret);

  const { everyMs, ...retentionPolicy } = opts.retention === false ? {} : (opts.retention ?? {});
  const purgeEveryMs = everyMs ?? DEFAULT_PURGE_EVERY_MS;
  if (opts.retention !== false && (!Number.isFinite(purgeEveryMs) || purgeEveryMs <= 0)) {
    throw new Error('createChatwarden: retention.everyMs must be a positive finite number');
  }
  if (opts.retention !== false && purgeEveryMs > MAX_PURGE_EVERY_MS) {
    throw new RangeError(`retention.everyMs must be at most ${MAX_PURGE_EVERY_MS}`);
  }
  const rules = opts.rules ?? defineRules(STARTER_RULES);
  const autoRestrictRule = opts.autoRestrictRule ?? 1;
  const autoRule = rules.get(autoRestrictRule);
  if (autoRule === undefined || autoRule.retired === true) {
    throw new RangeError('autoRestrictRule must be the number of an active rule in the registry');
  }
  if (opts.matcher === undefined) safeWarn(logger, 'chatwarden.no_matcher');

  const subjects = new SubjectIndex(store, clock, { logger });
  const sanctions = new SanctionIndex({ enabled, subjects });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const mutes = new MuteService(store, clock, subjects, { logger });
  const strikes = new StrikeService(store, clock, subjects, { logger });

  await subjects.load();
  await sanctions.load(store, clock.now());
  await mutes.load();
  await strikes.load();

  // ONE notice service for the whole kit: chat (the automatic timeout), the doors (the refusal's pointer) and
  // decisions all write to and read from it, and `platform.notify` hears of every new notice through it.
  const platformNotify = platform.notify;
  const notices = new NoticeService({
    store,
    subjects,
    rules,
    clock,
    matcher: opts.matcher,
    logger,
    notify: typeof platformNotify === 'function' ? (who, event) => platformNotify.call(platform, who, event) : undefined,
  });

  const chat = new ChatService({
    roster,
    buffer,
    subjects,
    sanctions,
    store,
    strikes,
    mutes,
    clock,
    matcher: opts.matcher,
    starrer: opts.starrer,
    gate: opts.gate,
    onAutoRestrict: opts.onAutoRestrict,
    logger,
    notices,
    autoRestrictRule,
  });
  const reports = new ReportService({
    roster,
    buffer,
    subjects,
    store,
    clock,
    enabled,
    onReport: opts.onReport,
    logger,
  });
  const doors = new DoorService({ hasher, subjects, sanctions, clock, logger, notices });
  const decisions = new DecisionService({ store, subjects, rules, notices, clock, index: sanctions, logger });

  // The person behind a player's connection details, FOUND and never created. An IP alone finds nobody.
  const personOf = (who: RawWho): SubjectId | null => {
    const ids = hashWho(hasher, who);
    return subjects.lookup({ clientKey: ids.clientKey, accountId: ids.accountId, ipHash: null });
  };
  /** A player-facing read: a store failure is logged (class only) and reads as `fallback`. */
  const forPlayer = <T>(who: RawWho, fallback: T, read: (subject: SubjectId) => T): T => {
    try {
      const subject = personOf(who);
      return subject === null ? fallback : read(subject);
    } catch (err) {
      safeWarn(logger, 'chatwarden.notices_failed', { error: err instanceof Error ? err.name : typeof err });
      return fallback;
    }
  };

  const seat: Chatwarden['rooms']['seat'] = (roomId, seatId, who, handle, tags) => {
    const subject = subjects.resolve(hashWho(hasher, who));
    roster.seat(roomId, seatId, subject, handle, tags);
  };

  // The retention timer. `setInterval` is not a clock read, so Date.now() stays out of it; `unref` so it never
  // keeps a process alive.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.retention !== false) {
    // The whole callback is fenced, `clock.now()` included, and so is the logging: nothing here may ever become
    // an unhandled rejection or an uncaught exception from a timer, which would crash the process.
    const failed = (err: unknown): void => {
      safeWarn(logger, 'chatwarden.purge_failed', { error: err instanceof Error ? err.name : typeof err });
    };
    timer = setInterval(() => {
      try {
        purge(store, clock.now(), retentionPolicy).then(undefined, failed);
      } catch (err) {
        failed(err);
      }
    }, purgeEveryMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    rooms: {
      seat,
      seatConnection: (roomId, seatId, ctx, handle, tags) => {
        seat(roomId, seatId, platform.identify(ctx), handle, tags);
      },
      unseat: (roomId, seatId) => {
        roster.unseat(roomId, seatId);
      },
      close: (roomId) => {
        roster.close(roomId);
        buffer.drop(roomId);
      },
      subjectAt: (roomId, seatId) => roster.occupant(roomId, seatId)?.subject ?? null,
    },
    chat: {
      accept: (roomId, seatId, text, o) => chat.accept(roomId, seatId, text, o),
      visibleTo: (roomId, viewerSeat, senderSeat) => chat.visibleTo(roomId, viewerSeat, senderSeat),
    },
    mutes: {
      set: (roomId, viewerSeat, targetSeat, on) => {
        const viewer = roster.occupant(roomId, viewerSeat)?.subject ?? null;
        const target = roster.occupant(roomId, targetSeat)?.subject ?? null;
        if (viewer === null || target === null) return;
        mutes.set(viewer, target, on);
      },
      mutedSeats: (roomId, viewerSeat) => mutes.mutedSeats(roomId, viewerSeat, roster),
    },
    reports: { submit: (input) => reports.submit(input) },
    doors: { check: (kind, who) => doors.check(kind, who) },
    sanctions: {
      apply: (input) => applySanction(store, subjects, input, clock.now(), sanctions),
      revoke: async (groupId, actor, reason) =>
        (await revokeAndWithdraw(store, groupId, actor, reason, { notices, clock, index: sanctions })).revoked,
    },
    rules,
    notices: {
      pending: (who) => forPlayer<PlayerNotice[]>(who, [], (s) => notices.pending(s)),
      ack: (who, id) => forPlayer(who, false, (s) => notices.ack(s, id)),
      record: (who) => forPlayer<PlayerNotice[]>(who, [], (s) => notices.record(s)),
      pendingWarning: (who) => forPlayer(who, false, (s) => notices.pendingWarning(s)),
    },
    decide: (input) => decisions.decide(input),
    history: (subject) => historyOf(store, subjects, subject, clock.now()),
    suggest: (subject, severity, rule) =>
      suggestAction(recordStep(historyOf(store, subjects, subject, clock.now())), severity, rule),
    gaps: {
      list: () =>
        store.listGaps().map(
          (r): GapRow => ({
            groupId: r.groupId,
            refCode: r.refCode,
            at: r.startsAt,
            actor: r.actor,
            note: r.gapNote ?? '',
            rule: 'uncovered',
            status: r.gapStatus ?? 'open',
          }),
        ),
      close: (groupId, status, ref, actor) => store.transaction(() => store.closeGap(groupId, status, ref, actor, clock.now())),
    },
    purge: (policy) => purge(store, clock.now(), { ...retentionPolicy, ...policy }),
    flush: () => subjects.flush(),
    close: async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await subjects.flush();
      store.close();
    },
  };
}
