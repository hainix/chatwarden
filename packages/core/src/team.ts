import { randomId } from './crypto.js';
import { isValidAuditActor } from './audit.js';
import { REPORT_CATEGORIES } from './reports.js';
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
function retryBusy<T>(run: () => T): T {
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
}

/** Claims, take next and viewing. The facade exposes it as `cw.cases`. */
export class CaseDesk {
  private readonly store: Store;
  private readonly subjects: SubjectIndex;
  private readonly clock: Clock;
  private readonly presence: ViewingPresence;

  constructor(deps: TeamDeps) {
    this.store = deps.store;
    this.subjects = deps.subjects;
    this.clock = deps.clock;
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
    return this.store.transaction(() => this.store.releaseClaim(canonical, actor, this.clock.now()));
  }

  /**
   * Claim and return the oldest open case nobody holds (`category` limits it to cases with an open report of that
   * category), or null. A case is a person, ranked by their OLDEST open report; it opens on their NEWEST. A case
   * `actor` already holds is skipped. Each candidate is one atomic conditional claim, so two moderators racing never
   * get the same case.
   */
  next(actor: string, filter: { category?: ReportCategory } = {}): NextCase | null {
    needActor(actor);
    const category = filter.category;
    if (category !== undefined && !REPORT_CATEGORIES.includes(category)) throw new RangeError('cases: unknown category');
    const seen = new Set<SubjectId>();
    let after: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = this.store.listOpenReports({
        ...(category === undefined ? {} : { category }),
        ...(after === undefined ? {} : { after: after.createdAt, afterId: after.id }),
        limit: NEXT_PAGE,
      });
      // New people on this page, oldest report first. Who already holds one is read once for the whole page, so a held case
      // costs no write; only the rest get the atomic 'free' claim (which stays the arbiter if a rival slips in).
      const candidates: SubjectId[] = [];
      for (const report of page) {
        const person = this.subjects.canonical(report.targetSubject);
        if (seen.has(person)) continue;
        seen.add(person);
        candidates.push(person);
      }
      const held = new Set(this.store.loadClaims(candidates, this.clock.now()).map((c) => c.person));
      for (const person of candidates) {
        if (held.has(person)) continue;
        const won = retryBusy(() =>
          this.store.transaction(() => {
            const now = this.clock.now();
            const res = this.store.claimCase(person, actor, now, now + CLAIM_TTL_MS, 'free');
            if (!res.won) return null;
            const newest = this.store.listOpenReportsByPerson(this.subjects.aliasesOf(person), 1)[0];
            if (newest === undefined) {
              // The case closed under us: do not leave a claim on nothing.
              this.store.releaseClaim(person, actor, now);
              return null;
            }
            return { person, reportId: newest.id, claim: claimOf(res.claim) };
          }),
        );
        if (won !== null) return won;
      }
      const last = page[page.length - 1];
      if (page.length < NEXT_PAGE || last === undefined) return null;
      after = { createdAt: last.createdAt, id: last.id };
    }
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
