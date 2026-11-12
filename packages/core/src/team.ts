import { randomId } from './crypto.js';
import { isValidAuditActor } from './audit.js';
import { RANK_DOWN_SCAN_MAX, REPORTER_ACCURACY_BATCH_MAX, REPORTER_RANK_LAPSE_MS } from './reporterAccuracy.js';
import type { ReporterAccuracy } from './reporterAccuracy.js';
import { REPORT_CATEGORIES } from './reports.js';
import { canonicalReasonId, isReasonId } from './reporting.js';
import type { ReportReason } from './reporting.js';
import type { SubjectIndex } from './subjects.js';
import { CLAIM_TTL_MS } from './types.js';
import type { Clock, ReasonRow, ReportCategory, Store, SubjectId } from './types.js';

// The team workbench behind `cw.cases`, `cw.changes` and `cw.reasons`: soft claims on a person's case, take next, who
// has a case open, and the saved decision reasons. Staff only. Claims and reasons live in the store (so several
// processes on one database agree); viewing presence is a hint kept in this process's memory and never stored.

/** How long a viewing beat counts: 30 seconds. */
export const VIEWING_TTL_MS = 30_000;

/** The longest saved-reason label, in characters (code points), after trimming. */
export const REASON_LABEL_MAX = 40;
/** The longest saved-reason text, in characters (code points), after trimming. */
export const REASON_TEXT_MAX = 500;
/** The most saved reasons the kit keeps. */
export const REASONS_MAX = 200;

/** The most cases one actor keeps open at once for viewing; a newer beat drops their oldest. */
export const VIEWING_PER_ACTOR_MAX = 20;

/** How many times a claim is attempted when another process wins the database lock race in between (SQLITE_BUSY). */
export const CLAIM_BUSY_TRIES = 3;

/** The most distinct people viewing presence tracks at once; past it new people are not tracked (it is a hint). */
const VIEWING_PEOPLE_MAX = 10_000;
/** Above this many tracked people a beat first sweeps the expired ones. */
const VIEWING_SWEEP_AT = 1_000;
/** Reports read per page while take next scans for a free case. */
const NEXT_PAGE = 200;

/** With `rankDownHabitual`, candidates are ranked this many at a time (see `next`). */
const RANK_SLICE = 20;
/** The most "handed to this moderator" markers `next` keeps (the oldest go). */
const SERVED_MAX = 1000;

/** With `signalBoost`, take-next looks at most this many people (oldest first) for an overdue or boosted case. @experimental */
export const SIGNAL_BOOST_SCAN_MAX = 200;

/** A claim as staff see it. Staff only: `by` is a staff actor. */
export interface CaseClaim {
  by: string;
  /** Epoch ms the holder took the case (kept across heartbeats). */
  since: number;
  /** Epoch ms it lapses without another beat; the case is held strictly before it. */
  until: number;
}

/**
 * What `cases.claim` answers: the claim now in force (`tookOverFrom` names the actor whose live claim a take over
 * replaced, else null), or why not: the person has no open case, or somebody else holds it (their live claim comes back).
 */
export type ClaimOutcome =
  | { ok: true; claim: CaseClaim; tookOverFrom: string | null }
  | { ok: false; error: 'no_case' }
  | { ok: false; error: 'claimed'; claim: CaseClaim };

/** The case take next claimed: the person, their newest open report, and the claim just taken. */
export interface NextCase {
  person: SubjectId;
  reportId: string;
  claim: CaseClaim;
}

/** A saved reason that cannot be stored: a label or text outside its limits, a bad id, or the list is full. Fixed message. */
export class ReasonError extends Error {
  readonly field: 'label' | 'text' | 'id' | 'active' | 'input' | 'limit';
  constructor(field: ReasonError['field']) {
    super(`reasons: invalid ${field}`);
    this.name = 'ReasonError';
    this.field = field;
  }
}

const claimOf = (c: { by: string; since: number; until: number }): CaseClaim => ({ by: c.by, since: c.since, until: c.until });

/**
 * Is this the store telling us another process got in between our read and our write (SQLite's "database is locked":
 * BUSY, LOCKED or BUSY_SNAPSHOT)? Read from the error's `errcode` (low byte 5 or 6) or, failing that, its message.
 */
function isBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { errcode?: unknown }).errcode;
  if (typeof code === 'number') return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((err as { message?: unknown }).message));
}

/**
 * Run a store transaction that reads then writes, again when it lost a lock race: the retry starts a fresh read, so the
 * loser of a race for a case sees the winner's claim and answers the normal "claimed", not an error. Bounded by
 * {@link CLAIM_BUSY_TRIES}; any other error, and the last busy one, is thrown.
 */
export function retryBusy<T>(run: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (err) {
      if (attempt >= CLAIM_BUSY_TRIES || !isBusy(err)) throw err;
    }
  }
}

const needActor = (actor: unknown): string => {
  if (!isValidAuditActor(actor)) throw new RangeError('cases: the actor is not a valid staff ref');
  return actor;
};

const needPerson = (person: unknown): string => {
  if (typeof person !== 'string' || person === '') throw new RangeError('cases: the person must be a staff ref');
  return person;
};

/** Who has a case open, per person, each beat lasting {@link VIEWING_TTL_MS}. In memory, per process, never stored. */
export class ViewingPresence {
  private readonly clock: Clock;
  /** person -> actor -> the instant the beat stops counting. */
  private readonly seen = new Map<SubjectId, Map<string, number>>();
  /** actor -> the people they have open, oldest beat first (refreshing a beat moves it last). */
  private readonly byActor = new Map<string, Set<SubjectId>>();
  /** When the last sweep of expired beats ran; a sweep runs at most once per beat lifetime. */
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Record that `actor` has `person`'s case open now. */
  touch(person: SubjectId, actor: string): void {
    const now = this.clock.now();
    if (this.seen.size >= VIEWING_SWEEP_AT && now - this.lastSweep >= VIEWING_TTL_MS) this.sweep(now);
    let who = this.seen.get(person);
    if (who === undefined) {
      if (this.seen.size >= VIEWING_PEOPLE_MAX) return;
      who = new Map();
      this.seen.set(person, who);
    }
    who.set(actor, now + VIEWING_TTL_MS);
    // One actor holds at most VIEWING_PER_ACTOR_MAX cases open: the oldest beat makes room for the newest.
    let mine = this.byActor.get(actor);
    if (mine === undefined) {
      mine = new Set();
      this.byActor.set(actor, mine);
    }
    mine.delete(person);
    mine.add(person);
    if (mine.size > VIEWING_PER_ACTOR_MAX) {
      const oldest = mine.values().next().value as SubjectId;
      mine.delete(oldest);
      this.forget(oldest, actor);
    }
  }

  private forget(person: SubjectId, actor: string): void {
    const who = this.seen.get(person);
    if (who === undefined) return;
    who.delete(actor);
    if (who.size === 0) this.seen.delete(person);
  }

  /** The actors whose beat still counts for `person`, sorted, leaving `except` out. */
  viewers(person: SubjectId, except?: string): string[] {
    const who = this.seen.get(person);
    if (who === undefined) return [];
    const now = this.clock.now();
    const out: string[] = [];
    for (const [actor, until] of who) if (until > now && actor !== except) out.push(actor);
    return out.sort();
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [person, who] of this.seen) {
      for (const [actor, until] of who) {
        if (until > now) continue;
        who.delete(actor);
        const mine = this.byActor.get(actor);
        mine?.delete(person);
        if (mine?.size === 0) this.byActor.delete(actor);
      }
      if (who.size === 0) this.seen.delete(person);
    }
  }
}

export interface TeamDeps {
  store: Store;
  subjects: SubjectIndex;
  clock: Clock;
  /** The reporting reasons in force, so an old id (`disruption`) finds the reason that replaced it. Default: none. */
  reasons?: () => readonly ReportReason[];
  /** How each person's reports have turned out (see `cw.reports.reporterAccuracy`). Without it, `rankDownHabitual` ranks nobody down. */
  accuracy?: (people: readonly SubjectId[]) => Map<SubjectId, ReporterAccuracy>;
  /**
   * Which of these people meet the queue signal feed (`cw.signals.boosted`), as canonical ids. Only asked when `next` is given
   * `signalBoost`, once per page of candidates. Without it nobody is boosted. A throw reads as nobody boosted.
   */
  boosted?: (people: readonly SubjectId[]) => Set<SubjectId>;
}

/** The key of a lapsed-claim marker: the moderator and the person, apart by a character neither can hold. */
const markerKey = (actor: string, person: SubjectId): string => `${actor}\u0000${person}`;

/** Claims, take next and viewing. The facade exposes it as `cw.cases`. */
export class CaseDesk {
  private readonly store: Store;
  private readonly subjects: SubjectIndex;
  private readonly clock: Clock;
  private readonly reasons: () => readonly ReportReason[];
  private readonly accuracy: NonNullable<TeamDeps['accuracy']>;
  private readonly boosted: TeamDeps['boosted'];
  private readonly presence: ViewingPresence;
  /** `moderator, person` -> when the claim `next` handed that moderator ran out (this process only). See `lapsedByMe`. */
  private readonly served = new Map<string, number>();

  constructor(deps: TeamDeps) {
    this.store = deps.store;
    this.subjects = deps.subjects;
    this.clock = deps.clock;
    this.reasons = deps.reasons ?? (() => []);
    this.accuracy = deps.accuracy ?? (() => new Map());
    this.boosted = deps.boosted;
    this.presence = new ViewingPresence(deps.clock);
  }

  /** The live claim on a person's case, or null. */
  holder(person: SubjectId): CaseClaim | null {
    const canonical = this.subjects.canonical(needPerson(person));
    const [claim] = this.store.loadClaims([canonical], this.clock.now());
    return claim === undefined ? null : claimOf(claim);
  }

  /** The live claims among these people (one store read), keyed by canonical person. People nobody holds are absent. */
  holders(people: readonly SubjectId[]): Map<SubjectId, CaseClaim> {
    const out = new Map<SubjectId, CaseClaim>();
    if (people.length === 0) return out;
    const canonical = [...new Set(people.map((p) => this.subjects.canonical(p)))];
    for (const c of this.store.loadClaims(canonical, this.clock.now())) out.set(c.person, claimOf(c));
    return out;
  }

  /**
   * Claim a person's case for `actor`, or beat the claim they already hold. Needs at least one OPEN report against the
   * person (else `no_case`). `takeOver` moves a live claim of someone else to `actor`; the caller decides who may use it.
   * One atomic conditional write in the store: of two moderators racing, exactly one wins.
   */
  claim(person: SubjectId, actor: string, opts: { takeOver?: boolean } = {}): ClaimOutcome {
    needActor(actor);
    const canonical = this.subjects.canonical(needPerson(person));
    return retryBusy(() =>
      this.store.transaction((): ClaimOutcome => {
        if (this.store.listOpenReportsByPerson(this.subjects.aliasesOf(canonical), 1).length === 0) {
          return { ok: false, error: 'no_case' };
        }
        const now = this.clock.now();
        const res = this.store.claimCase(canonical, actor, now, now + CLAIM_TTL_MS, opts.takeOver === true ? 'takeover' : 'claim');
        // The holder keeping the claim alive (or taking it again) is not one who let it lapse.
        if (res.won) this.served.delete(markerKey(actor, canonical));
        return res.won
          ? { ok: true, claim: claimOf(res.claim), tookOverFrom: res.from }
          : { ok: false, error: 'claimed', claim: claimOf(res.claim) };
      }),
    );
  }

  /** Release `actor`'s claim on the person. True only when it ended a live claim of theirs. */
  release(person: SubjectId, actor: string): boolean {
    needActor(actor);
    const canonical = this.subjects.canonical(needPerson(person));
    // Released on purpose: not a claim that ran out (`lapsedByMe`).
    this.served.delete(markerKey(actor, canonical));
    return this.store.transaction(() => this.store.releaseClaim(canonical, actor, this.clock.now()));
  }

  /**
   * After a decision: end `actor`'s own claim on the person only when the person has no open report left (any alias counts).
   * While another report about them is open the claim is kept untouched, so its heartbeat and its 10 minutes go on as normal and
   * nobody else can take the case from under the moderator who is working through it. True only when it ended a live claim.
   * The check and the release are one transaction.
   */
  releaseWhenDone(person: SubjectId, actor: string): boolean {
    needActor(actor);
    const canonical = this.subjects.canonical(needPerson(person));
    return this.store.transaction(() => {
      if (this.store.listOpenReportsByPerson(this.subjects.aliasesOf(canonical), 1).length > 0) return false;
      // Decided and done: the claim ending is not "let it lapse".
      this.served.delete(markerKey(actor, canonical));
      return this.store.releaseClaim(canonical, actor, this.clock.now());
    });
  }

  /**
   * Claim and return the oldest open case nobody holds (`category` limits it to cases with an open report of that
   * category, `reason` to cases with an open report that gave that reason id, or none at all for `null`; both may be given), or null. A case is a person, ranked by their OLDEST open report; it opens on their NEWEST. A case
   * `actor` already holds is skipped. Each candidate is one atomic conditional claim, so two moderators racing never
   * get the same case.
   *
   * With `rankDownHabitual`, a case is ranked DOWN when none of its open reports has waited {@link REPORTER_RANK_LAPSE_MS} and
   * every open report against the person was filed by a habitual false reporter (`ReporterAccuracy.habitual`: one ordinary
   * reporter, or no accuracy data, keeps the case normal). The first normal case in oldest-first order is claimed; ranked-down
   * ones are remembered in order and, when the scan ends (end of the queue, or {@link RANK_DOWN_SCAN_MAX} reports read), the
   * oldest of them is claimed. Nothing is skipped for good: a queue holding only habitual cases still serves them, oldest first.
   *
   * With `signalBoost` (default false: behaviour unchanged), the scan stays oldest first but a case is claimed only when it is OVERDUE (its
   * oldest open report has waited {@link REPORTER_RANK_LAPSE_MS}) or BOOSTED (the person meets the queue signal feed, `TeamDeps.boosted`);
   * the first such case wins. When the queue ends, or {@link SIGNAL_BOOST_SCAN_MAX} people have been looked at, with neither, the oldest
   * free case is claimed as it would be without the filter. A boosted case is never ranked down as a habitual reporter's. Because the
   * queue is oldest first an overdue case is always met before anything newer, so boosted cases cannot starve an old one past 24 hours.
   * Nothing leaves the queue.
   *
   * Also with `signalBoost`: a case `next` handed this moderator whose claim then ran out (they did not decide it, and did not hold it)
   * is served to them after every other free case for one claim window ({@link CLAIM_TTL_MS}) from the moment it ran out, so a boosted or
   * overdue case does not come straight back to the person who let it lapse. Other moderators are not affected, it is still served when it
   * is all that is left, and it is kept in this process only (a restart forgets it).
   */
  next(actor: string, filter: { category?: ReportCategory; reason?: string | null; rankDownHabitual?: boolean; signalBoost?: boolean } = {}): NextCase | null {
    needActor(actor);
    const category = filter.category;
    if (category !== undefined && !REPORT_CATEGORIES.includes(category)) throw new RangeError('cases: unknown category');
    const asked = filter.reason;
    if (asked !== undefined && asked !== null && !isReasonId(asked)) throw new RangeError('cases: unknown reason');
    const reason = asked === undefined || asked === null ? asked : canonicalReasonId(this.reasons(), asked);
    const rank = filter.rankDownHabitual;
    if (rank !== undefined && typeof rank !== 'boolean') throw new RangeError('cases: rankDownHabitual must be a boolean');
    const rankDown = rank === true;
    const boost = filter.signalBoost;
    if (boost !== undefined && typeof boost !== 'boolean') throw new RangeError('cases: signalBoost must be a boolean');
    const boostMode = boost === true;
    const seen = new Set<SubjectId>();
    // Ranked-down people in the order the scan met them (oldest first).
    const deferred: SubjectId[] = [];
    // With signalBoost: free people who are neither overdue nor boosted, in scan order, claimed when the scan ends (before the ranked-down).
    const ordinary: SubjectId[] = [];
    // With signalBoost: free people whose claim this moderator let lapse in the last claim window, claimed last of all.
    const lapsed: SubjectId[] = [];
    // With signalBoost: when each person's oldest open report was filed (the first one the scan met), and how many people were looked at.
    const oldestAt = new Map<SubjectId, number>();
    let scanned = 0;
    let read = 0;
    let after: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = this.store.listOpenReports({
        ...(category === undefined ? {} : { category }),
        ...(reason === undefined ? {} : { reason }),
        ...(after === undefined ? {} : { after: after.createdAt, afterId: after.id }),
        limit: NEXT_PAGE,
      });
      read += page.length;
      // New people on this page, oldest report first. Who already holds one is read once for the whole page, so a held case
      // costs no write; only the rest get the atomic 'free' claim (which stays the arbiter if a rival slips in).
      const candidates: SubjectId[] = [];
      for (const report of page) {
        const person = this.subjects.canonical(report.targetSubject);
        if (seen.has(person)) continue;
        seen.add(person);
        candidates.push(person);
        if (boostMode) oldestAt.set(person, report.createdAt);
      }
      if (boostMode) {
        // At most SIGNAL_BOOST_SCAN_MAX people in all, held ones included: they are looked at too.
        candidates.length = Math.max(0, Math.min(candidates.length, SIGNAL_BOOST_SCAN_MAX - scanned));
        scanned += candidates.length;
      }
      const held = new Set(this.store.loadClaims(candidates, this.clock.now()).map((c) => c.person));
      const free = candidates.filter((p) => !held.has(p));
      // One grouped read for the page.
      const boosted = boostMode ? this.boostedAmong(free) : new Set<SubjectId>();
      const now = this.clock.now();
      // Ranked lazily, a slice at a time: the first ordinary case ends the scan, so "next, next, next" does not read the open
      // reports of a whole page of candidates to claim the first one.
      for (let i = 0; i < free.length; i += RANK_SLICE) {
        const slice = free.slice(i, i + RANK_SLICE);
        const down = rankDown ? this.rankedDown(slice) : new Set<SubjectId>();
        for (const person of slice) {
          if (boostMode && this.lapsedByMe(actor, person, now)) {
            lapsed.push(person);
            continue;
          }
          const isBoosted = boosted.has(person);
          if (down.has(person) && !isBoosted) {
            deferred.push(person);
            continue;
          }
          if (boostMode && !isBoosted && now - (oldestAt.get(person) ?? now) < REPORTER_RANK_LAPSE_MS) {
            ordinary.push(person);
            continue;
          }
          const won = this.tryClaim(person, actor);
          if (won !== null) return won;
        }
      }
      const last = page[page.length - 1];
      if (page.length < NEXT_PAGE || last === undefined) break;
      if (boostMode && scanned >= SIGNAL_BOOST_SCAN_MAX) break;
      // Enough read to have looked for a normal case: serve the oldest ranked-down one rather than scan the whole queue.
      if (rankDown && read >= RANK_DOWN_SCAN_MAX && deferred.length > 0) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    const rest = [...ordinary, ...deferred, ...lapsed];
    if (rest.length === 0) return null;
    // A rival may have taken one meanwhile: one read of the claims, so a held case costs no write.
    const heldNow = new Set(this.store.loadClaims(rest, this.clock.now()).map((c) => c.person));
    for (const person of rest) {
      if (heldNow.has(person)) continue;
      const won = this.tryClaim(person, actor);
      if (won !== null) return won;
    }
    return null;
  }

  /** Did a claim `next` handed this moderator on this person run out within the last claim window? Forgets markers older than that. */
  private lapsedByMe(actor: string, person: SubjectId, now: number): boolean {
    const key = markerKey(actor, person);
    const until = this.served.get(key);
    if (until === undefined) return false;
    if (now - until >= CLAIM_TTL_MS) this.served.delete(key);
    return until <= now && now - until < CLAIM_TTL_MS;
  }

  /** Who of these people the queue signal feed boosts (canonical ids). Nobody without the dependency, or when it throws. */
  private boostedAmong(people: readonly SubjectId[]): Set<SubjectId> {
    if (this.boosted === undefined || people.length === 0) return new Set();
    try {
      return this.boosted(people);
    } catch {
      return new Set();
    }
  }

  /** One atomic 'free' claim of a person's case, opened on their newest open report; null when a rival won or the case closed. */
  private tryClaim(person: SubjectId, actor: string): NextCase | null {
    return retryBusy(() =>
      this.store.transaction(() => {
        const now = this.clock.now();
        const res = this.store.claimCase(person, actor, now, now + CLAIM_TTL_MS, 'free');
        if (!res.won) return null;
        const key = markerKey(actor, person);
        this.served.delete(key);
        this.served.set(key, res.claim.until);
        if (this.served.size > SERVED_MAX) this.served.delete(this.served.keys().next().value!);
        const newest = this.store.listOpenReportsByPerson(this.subjects.aliasesOf(person), 1)[0];
        if (newest === undefined) {
          // The case closed under us: do not leave a claim on nothing.
          this.store.releaseClaim(person, actor, now);
          return null;
        }
        return { person, reportId: newest.id, claim: claimOf(res.claim) };
      }),
    );
  }

  /**
   * Which of these people's cases are ranked down: no open report has waited {@link REPORTER_RANK_LAPSE_MS} and every open report
   * against them came from a habitual reporter. One read of each person's open reports and the accuracy of all their reporters
   * (chunked at the accuracy batch limit). A person with more open reports than one read returns is never ranked down.
   */
  private rankedDown(people: readonly SubjectId[]): Set<SubjectId> {
    const out = new Set<SubjectId>();
    if (people.length === 0) return out;
    const now = this.clock.now();
    const reporters = new Map<SubjectId, SubjectId[]>();
    for (const person of people) {
      const open = this.store.listOpenReportsByPerson(this.subjects.aliasesOf(person), 201);
      // 201 or more is a case of its own kind: never bury it. One report past the lapse is a case that has waited long enough.
      if (open.length === 0 || open.length > 200) continue;
      if (open.some((r) => now - r.createdAt >= REPORTER_RANK_LAPSE_MS)) continue;
      reporters.set(person, [...new Set(open.map((r) => this.subjects.canonical(r.reporterSubject)))]);
    }
    const all = [...new Set([...reporters.values()].flat())];
    const habitual = new Set<SubjectId>();
    for (let i = 0; i < all.length; i += REPORTER_ACCURACY_BATCH_MAX) {
      for (const [who, acc] of this.accuracy(all.slice(i, i + REPORTER_ACCURACY_BATCH_MAX))) if (acc.habitual) habitual.add(who);
    }
    for (const [person, who] of reporters) if (who.length > 0 && who.every((r) => habitual.has(r))) out.add(person);
    return out;
  }

  /**
   * `actor` has the person's case open now (a beat; it counts for 30 seconds). Never stored, never blocks anyone. Only a
   * person with an open report is tracked (false otherwise, nothing recorded), and one actor keeps at most
   * {@link VIEWING_PER_ACTOR_MAX} cases open: a newer beat drops their oldest. True when the beat was recorded.
   */
  view(person: SubjectId, actor: string): boolean {
    needActor(actor);
    const canonical = this.subjects.canonical(needPerson(person));
    if (this.store.listOpenReportsByPerson(this.subjects.aliasesOf(canonical), 1).length === 0) return false;
    this.presence.touch(canonical, actor);
    return true;
  }

  /** Who has the person's case open now, sorted, leaving `except` out. */
  viewers(person: SubjectId, except?: string): string[] {
    return this.presence.viewers(this.subjects.canonical(needPerson(person)), except);
  }

  /** {@link viewers} for several people at once; people nobody is viewing are absent. */
  viewersOf(people: readonly SubjectId[], except?: string): Map<SubjectId, string[]> {
    const out = new Map<SubjectId, string[]>();
    for (const p of people) {
      const canonical = this.subjects.canonical(p);
      if (out.has(canonical)) continue;
      const v = this.presence.viewers(canonical, except);
      if (v.length > 0) out.set(canonical, v);
    }
    return out;
  }
}

/** Saved decision reasons. The facade exposes it as `cw.reasons`. */
export class ReasonBook {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  list(): ReasonRow[] {
    return this.store.listReasons();
  }

  add(input: { label: string; text: string }): ReasonRow {
    if (typeof input !== 'object' || input === null) throw new ReasonError('input');
    const label = cleanLabel(input.label);
    const text = cleanText(input.text);
    return this.store.transaction(() => {
      if (this.store.listReasons().length >= REASONS_MAX) throw new ReasonError('limit');
      const row: ReasonRow = { id: randomId(16), label, text, active: true };
      this.store.insertReason(row);
      return row;
    });
  }

  /** Change the label and/or text. Null for an unknown id. At least one of the two is required. */
  update(id: string, patch: { label?: string; text?: string }): ReasonRow | null {
    if (typeof id !== 'string' || id === '') throw new ReasonError('id');
    if (typeof patch !== 'object' || patch === null) throw new ReasonError('input');
    const change: { label?: string; text?: string } = {};
    if (patch.label !== undefined) change.label = cleanLabel(patch.label);
    if (patch.text !== undefined) change.text = cleanText(patch.text);
    if (change.label === undefined && change.text === undefined) throw new ReasonError('input');
    return this.store.transaction(() => (this.store.updateReason(id, change) ? this.find(id) : null));
  }

  /** Switch a reason on or off. Null for an unknown id. */
  setActive(id: string, active: boolean): ReasonRow | null {
    if (typeof id !== 'string' || id === '') return null;
    if (typeof active !== 'boolean') throw new ReasonError('active');
    return this.store.transaction(() => (this.store.setReasonActive(id, active) ? this.find(id) : null));
  }

  private find(id: string): ReasonRow | null {
    return this.store.listReasons().find((r) => r.id === id) ?? null;
  }
}

/** Any control character: a label is one line. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Any control character but the newline: a text may run over several lines. */
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Length in characters (code points), so an emoji counts once. */
const length = (s: string): number => [...s].length;

function cleanLabel(v: unknown): string {
  if (typeof v !== 'string') throw new ReasonError('label');
  const label = v.trim();
  if (label === '' || length(label) > REASON_LABEL_MAX || CONTROL.test(label)) throw new ReasonError('label');
  return label;
}

function cleanText(v: unknown): string {
  if (typeof v !== 'string') throw new ReasonError('text');
  const text = v.trim();
  if (text === '' || length(text) > REASON_TEXT_MAX || CONTROL_EXCEPT_NEWLINE.test(text)) throw new ReasonError('text');
  return text;
}
