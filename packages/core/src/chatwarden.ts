import { ChatService } from './chat.js';
import type { ChatResult, Starrer } from './chat.js';
import { DoorService } from './doors.js';
import type { DoorKind, DoorRefusal } from './doors.js';
import { EvidenceBuffer, RoomRoster } from './evidence.js';
import { hashWho, makeHasher } from './hasher.js';
import { MuteService } from './mutes.js';
import { ReportService } from './reports.js';
import type { ReportCounts, ReportInput, ReportResult } from './reports.js';
import { purge } from './retention.js';
import type { PurgeResult, RetentionPolicy } from './retention.js';
import { applySanction, revokeSanction, SanctionIndex } from './sanctions.js';
import type { SanctionInput } from './sanctions.js';
import { StrikeService } from './strikes.js';
import { SubjectIndex } from './subjects.js';
import type { Clock, Logger, Matcher, Platform, RawWho, Store, StoredReport, SubjectId } from './types.js';

/** The wall clock, used only when the adopter injects none. Tests and replays pass their own. */
const systemClock: Clock = { now: () => Date.now() };

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
  /** Told once for each stored report. Fenced: a throw never reaches the reporter. */
  onReport?: (report: StoredReport, counts: ReportCounts) => void;
  /** Told once when a blocked line earned an automatic timeout; `second` is true for the 24 h repeat. */
  onAutoRestrict?: (subject: SubjectId | null, second: boolean) => void;
  /** Passed to every component. Defaults to `console.warn`. */
  logger?: Logger;
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
    /** Write one sanction group and make it live at once. Resolves with the group id and the player-quotable ref code. */
    apply(input: SanctionInput): Promise<{ groupId: string; refCode: string }>;
    /** Revoke a whole group. Resolves true when this call revoked something. */
    revoke(groupId: string, actor: string, reason: string): Promise<boolean>;
  };
  /** Delete rows past retention. Run it from a timer or a maintenance job. */
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
  const doors = new DoorService({ hasher, subjects, sanctions, clock, logger });

  const seat: Chatwarden['rooms']['seat'] = (roomId, seatId, who, handle, tags) => {
    const subject = subjects.resolve(hashWho(hasher, who));
    roster.seat(roomId, seatId, subject, handle, tags);
  };

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
      revoke: (groupId, actor, reason) => revokeSanction(store, groupId, actor, clock.now(), reason, sanctions),
    },
    purge: (policy) => purge(store, clock.now(), policy),
    flush: () => subjects.flush(),
    close: async () => {
      await subjects.flush();
      store.close();
    },
  };
}
