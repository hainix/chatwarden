import { toHubError } from '../client.js';
import type { HubClient, HubError } from '../client.js';
import { CLAIM_TTL_MS, actorName, holderOf } from '../claims.js';
import type { HubT } from '../i18n.js';
import { errorText, groupName } from '../labels.js';
import { nextOpenReport } from '../queue.js';
import type { Claim, Me } from '../types.js';
import { hasLeft } from './decisions.js';
import type { DecisionStore } from './decisions.js';
import type { ActionResult, PageSource, Timers } from './env.js';
import type { LiveQueueStore } from './liveQueue.js';
import { createStore } from './store.js';
import type { Store } from './store.js';
import type { Toasts } from './toasts.js';

// Working a case: claiming it when it is opened, keeping the claim and the "viewing" hint alive while it stays open, and the
// things a moderator does about a claim from the queue: take the next case, release one, take one over.

/** While a case is open and the tab is visible, the claim is renewed this often. */
export const CLAIM_BEAT_MS = 60_000;
/** The "viewing" hint lasts 30 seconds on the server, so it is renewed more often than that. */
export const VIEWING_BEAT_MS = 20_000;
/** After taking a case, "Take next" ignores another press for this long (a double click, a held key). */
export const TAKE_COOLDOWN_MS = 500;

/** The case the moderator has open: the report, and the person it is about once the queue has shown it (else null). */
export interface OpenCase {
  reportId: string;
  person: string | null;
}

/** How Take next went. */
export type TakeOutcome =
  /** A case is yours now: open `reportId`. */
  | { status: 'taken'; reportId: string; person: string }
  /** Nobody is waiting. */
  | { status: 'none' }
  /** Another Take next is running, or ended a moment ago. */
  | { status: 'busy' }
  | { status: 'failed'; error: HubError };

/** What to do once a decision is on its way: the same person's next open report (`same`), else how Take next went. */
export type ContinueOutcome = { status: 'same'; reportId: string } | TakeOutcome;

export interface CaseStore {
  /** The case that is open (see `open`), or null. */
  opened: Store<OpenCase | null>;
  /**
   * Opens a case: makes the moderator its handler if nobody is, renews the claim every 60 seconds and the viewing hint every 20
   * while the tab is visible, and keeps its row in the queue. A case someone else holds is opened to read, with a notice. Opening
   * another report of the same person is the same case (nothing is released); opening another person's leaves this one.
   * Resolves once the first claim and viewing calls have answered (at once when the queue does not show the case yet).
   */
  open: (reportId: string) => Promise<void>;
  /**
   * Leaves the open case (a given report only counts when it is the open one) and lets it go, unless a decision on it is waiting:
   * sending that releases it. Only a claim that is yours is released.
   */
  leave: (reportId?: string) => void;
  /** Claim and open the oldest unclaimed case that matches the category filter. Says how it went. */
  takeNext: () => Promise<TakeOutcome>;
  /**
   * What to do once `decided` is on its way: go on to the same person's next open report (they are one case: the claim is kept and
   * `/cases/next` is not asked), and only when there is none take the next case.
   */
  continueFrom: (decided: { reportId: string; person: string }) => Promise<ContinueOutcome>;
  /** Claim a free case (after you let it go). */
  claim: (person: string) => Promise<ActionResult<Claim>>;
  /** A senior or owner moving another moderator's live claim to themselves. The server audits it. */
  takeOver: (person: string) => Promise<ActionResult<{ claim: Claim; tookOverFrom: string | null }>>;
  /** Release your claim on a case. The toast offers Undo, which claims it again. */
  release: (person: string) => Promise<ActionResult<{ released: boolean }>>;
  /** Leaves the open case and stops everything. */
  dispose: () => void;
}

export interface CaseStoreOptions {
  client: HubClient;
  now: () => number;
  timers: Timers;
  page: PageSource;
  toasts: Toasts;
  words: () => HubT;
  /** The live queue, or null for a role that cannot read reports. */
  queue: () => LiveQueueStore | null;
  decisions: DecisionStore;
  me: () => Me | null;
  /** Bring the moderator to a report. */
  show: (reportId: string) => void;
}

interface Active {
  person: string;
  key: string;
  stop: () => void;
  /** Settles when the first claim and viewing calls have answered. */
  first: Promise<void>;
}

export function createCaseStore(options: CaseStoreOptions): CaseStore {
  const { client, now, timers, page, toasts, decisions } = options;
  const opened = createStore<OpenCase | null>(null);
  let current: { reportId: string; seen: string | null } | null = null;
  let lastOpenPerson: string | null = null;
  let active: Active | null = null;
  let offs: Array<() => void> = [];
  let deriving = false;
  let dirty = false;
  let disposed = false;

  const actor = (): string => options.me()?.actor ?? '';
  const canClaim = (): boolean => options.me()?.can['reports.decide'] === true;

  const fail = (e: unknown): HubError => {
    const error = toHubError(e);
    toasts.push({ text: errorText(options.words(), error), tone: 'bad' });
    return error;
  };

  // ---- the open case: its heartbeat, and letting it go ----------------------------------------------------------------

  /** Renews the claim and the viewing hint while `person` stays open. */
  const beat = (person: string): { stop: () => void; first: Promise<void> } => {
    const q = options.queue();
    let cancelled = false;
    // Who we last knew held it, so a change is said once and a steady state is not repeated at every heartbeat.
    let told: string | null = null;
    let mine = false;

    const claim = async (): Promise<void> => {
      if (!canClaim() || q?.isHeldOff(person) === true) return;
      try {
        const result = await client.claimCase(person);
        if (cancelled) return;
        mine = true;
        told = result.claim.by;
        q?.patchClaim(person, result.claim);
      } catch (e) {
        if (cancelled) return;
        const err = toHubError(e);
        if (err.code === 'claimed' && err.heldBy !== undefined) {
          const until = err.heldUntil ?? 0;
          q?.patchClaim(person, { by: err.heldBy, since: until - CLAIM_TTL_MS, until });
          if (told !== err.heldBy) {
            const key = mine ? 'hub.toast.lostClaim' : 'hub.toast.heldBy';
            toasts.push({ text: options.words()(key, { name: actorName(err.heldBy) }) });
            told = err.heldBy;
          }
          mine = false;
        }
        // Anything else (a 404 because the case closed, a dropped connection) is left to the queue refresh and its banner.
      }
    };
    const view = async (): Promise<void> => {
      try {
        const result = await client.viewing(person);
        if (!cancelled) q?.patchViewing(person, result.viewers);
      } catch {
        // A hint: a miss costs nothing.
      }
    };

    const first = Promise.all([claim(), view()]).then(() => undefined);
    const claimTimer = timers.setInterval(() => page.visible() && void claim(), CLAIM_BEAT_MS);
    const viewTimer = timers.setInterval(() => page.visible() && void view(), VIEWING_BEAT_MS);
    const offVisible = page.onVisibilityChange(() => {
      if (page.visible()) {
        void claim();
        void view();
      }
    });
    const stop = (): void => {
      cancelled = true;
      // A release held the case off for this visit only: opening it again claims it.
      q?.holdOff(person, false);
      timers.clearInterval(claimTimer);
      timers.clearInterval(viewTimer);
      offVisible();
    };
    return { stop, first };
  };

  /**
   * Leaving the case lets it go: a moderator who browses the queue must not leave a trail of cases only they seem to hold. A
   * decision that is still waiting is the exception (sending it releases the claim). It is said by the queue copy, not by a
   * request of its own, whether the claim is ours: a case someone else holds is theirs, and a lapsed claim is nobody's.
   */
  const letGo = (person: string): void => {
    if (decisions.willRelease(person)) return;
    const q = options.queue();
    const group = q?.getSnapshot().groups.find((g) => g.person === person);
    if (q === null || group === undefined || holderOf(group.claim, actor(), now()).kind !== 'you') return;
    q.patchClaim(person, null);
    void client.releaseCase(person).catch(() => undefined);
  };

  const stopActive = (): void => {
    const was = active;
    active = null;
    if (was === null) return;
    was.stop();
    letGo(was.person);
  };

  /** Works out which person the open case is about, and starts or stops what depends on it. */
  const derive = (): void => {
    if (current === null || disposed) return;
    if (deriving) {
      dirty = true;
      return;
    }
    deriving = true;
    try {
      do {
        dirty = false;
        const open = current;
        if (open === null) break;
        const q = options.queue();
        const group = q?.getSnapshot().groups.find((g) => g.reportIds.includes(open.reportId)) ?? null;
        // The person this page is about, remembered once seen: if the case closes while it is open, its row stays (marked) in the
        // queue, but nothing is claimed or viewed any more.
        if (group !== null) open.seen = group.person;
        const openPerson = open.seen;
        // The report I just decided is no longer in the open queue, but its person is still the case I am working (their other
        // reports may be open: one case per person), so the claim and the heartbeat go on. A case that closed for any other reason is
        // not mine.
        const decidedHere = hasLeft(decisions.entry(open.reportId));
        const person = group?.person ?? (decidedHere ? openPerson : null);
        const next: OpenCase = { reportId: open.reportId, person };
        const was = opened.getSnapshot();
        if (was === null || was.reportId !== next.reportId || was.person !== next.person) opened.set(next);
        if (openPerson !== lastOpenPerson) {
          const had = lastOpenPerson;
          lastOpenPerson = openPerson;
          q?.setOpenPerson(openPerson);
          // The cursor has moved off the old person's row: a case that closed while it was on it can go now.
          if (had !== null && openPerson !== null) q?.settle();
        }
        const key = person === null ? null : `${person}|${canClaim()}|${actor()}`;
        if (key !== (active?.key ?? null)) {
          stopActive();
          if (person !== null && key !== null) active = { person, key, ...beat(person) };
        }
      } while (dirty);
    } finally {
      deriving = false;
    }
  };

  const stopWatching = (): void => {
    for (const off of offs) off();
    offs = [];
  };

  const leave = (reportId?: string): void => {
    if (current === null || (reportId !== undefined && reportId !== current.reportId)) return;
    stopWatching();
    current = null;
    const q = options.queue();
    lastOpenPerson = null;
    q?.setOpenPerson(null);
    stopActive();
    opened.set(null);
  };

  const open = (reportId: string): Promise<void> => {
    if (disposed || current?.reportId === reportId) return Promise.resolve();
    if (current !== null) {
      // Another report while one is open: the same person's other report is the same case (the claim and the beat go on); a
      // different person's lets the first go, as `derive` finds out.
      current = { reportId, seen: null };
      derive();
      return active?.first ?? Promise.resolve();
    }
    current = { reportId, seen: null };
    const q = options.queue();
    offs = [decisions.subscribe(derive)];
    if (q !== null) offs.push(q.subscribe(derive));
    derive();
    return active?.first ?? Promise.resolve();
  };

  // ---- what a moderator does about a claim -----------------------------------------------------------------------------

  const heldBy = (q: LiveQueueStore | null, person: string, err: HubError): boolean => {
    if (err.code !== 'claimed' || err.heldBy === undefined) return false;
    const until = err.heldUntil ?? 0;
    q?.patchClaim(person, { by: err.heldBy, since: until - CLAIM_TTL_MS, until });
    toasts.push({ text: options.words()('hub.toast.heldBy', { name: actorName(err.heldBy) }), tone: 'bad' });
    return true;
  };

  const takeNext = async (): Promise<TakeOutcome> => {
    const q = options.queue();
    if (q === null || !q.beginTake()) return { status: 'busy' };
    const words = options.words();
    try {
      const category = q.getSnapshot().filter.category;
      const { case: next } = await client.takeNext(category === 'all' ? {} : { category });
      if (next === null) {
        toasts.push({ text: words('hub.toast.nothing') });
        return { status: 'none' };
      }
      // The case may be newer than the list on screen: read again so it is there, then show it as the moderator's.
      if (!q.getSnapshot().groups.some((g) => g.person === next.person)) await q.reload();
      q.patchClaim(next.person, next.claim);
      // A filter that would hide the case just taken is cleared: the moderator should see what they took.
      if (q.getSnapshot().filter.claim === 'unclaimed') q.setFilter({ claim: 'all' });
      q.holdOff(next.person, false);
      // No toast: the case opens, and its banner says "You're handling this".
      options.show(next.reportId);
      return { status: 'taken', reportId: next.reportId, person: next.person };
    } catch (e) {
      return { status: 'failed', error: fail(e) };
    } finally {
      // A short cooldown, not just "while it runs": a double click is two clicks 100 ms apart, and a fast server has answered
      // the first by then. The guard is the queue's, so a click, the N key and the command bar share it.
      q.endTake(TAKE_COOLDOWN_MS);
    }
  };

  return {
    opened: { subscribe: opened.subscribe, getSnapshot: opened.getSnapshot },
    open,
    leave,
    takeNext,
    async continueFrom(decided) {
      const q = options.queue();
      const next = q === null ? null : nextOpenReport(q.getSnapshot().groups, decided.person, decided.reportId, decisions.decidedIds());
      if (next !== null) {
        options.show(next.id);
        return { status: 'same', reportId: next.id };
      }
      return takeNext();
    },
    async claim(person) {
      const q = options.queue();
      try {
        const result = await client.claimCase(person);
        q?.holdOff(person, false);
        q?.patchClaim(person, result.claim);
        return { ok: true, value: result.claim };
      } catch (e) {
        const err = toHubError(e);
        if (!heldBy(q, person, err)) fail(e);
        return { ok: false, error: err };
      }
    },
    async takeOver(person) {
      const q = options.queue();
      try {
        const result = await client.claimCase(person, { takeOver: true });
        q?.holdOff(person, false);
        q?.patchClaim(person, result.claim);
        const words = options.words();
        toasts.push({ text: result.tookOverFrom === null ? words('hub.toast.tookCase') : words('hub.toast.tookOver', { name: actorName(result.tookOverFrom) }) });
        return { ok: true, value: { claim: result.claim, tookOverFrom: result.tookOverFrom } };
      } catch (e) {
        return { ok: false, error: fail(e) };
      }
    },
    async release(person) {
      const q = options.queue();
      if (q === null) return { ok: true, value: { released: false } };
      const words = options.words();
      const group = q.getSnapshot().groups.find((g) => g.person === person);
      const who = group === undefined ? words('hub.person.prefix') : groupName(words, group);
      try {
        const result = await client.releaseCase(person);
        q.patchClaim(person, null);
        if (!result.released) return { ok: true, value: { released: false } };
        q.holdOff(person, true);
        toasts.push({
          text: words('hub.toast.released', { who }),
          action: {
            label: words('hub.toast.undo'),
            run: () => {
              void (async () => {
                try {
                  const again = await client.claimCase(person);
                  q.holdOff(person, false);
                  q.patchClaim(person, again.claim);
                  toasts.push({ text: options.words()('hub.toast.reclaimed', { who }) });
                } catch (e) {
                  const err = toHubError(e);
                  if (!heldBy(null, person, err)) fail(e);
                }
              })();
            },
          },
        });
        return { ok: true, value: { released: true } };
      } catch (e) {
        return { ok: false, error: fail(e) };
      }
    },
    dispose() {
      if (disposed) return;
      leave();
      disposed = true;
    },
  };
}
