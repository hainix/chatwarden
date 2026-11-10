import { useCallback, useEffect, useRef } from 'react';
import { toHubError } from './client.js';
import { useHub } from './context.js';
import { groupName, errorText } from './labels.js';
import { CLAIM_TTL_MS, actorName, holderOf } from './claims.js';
import { useOptionalDecisions } from './decisions.js';
import { useOptionalQueue, useQueue } from './liveQueue.js';
import { useToasts } from './toasts.js';

// Working a case: claiming it when it is opened, keeping the claim and the "viewing" hint alive while it stays open, and the
// three things a moderator does about a claim from the queue: take the next case, release one, open one.

export { CLAIM_TTL_MS };
/** While a case is open and the tab is visible, the claim is renewed this often. */
export const CLAIM_BEAT_MS = 60_000;
/** The "viewing" hint lasts 30 seconds on the server, so it is renewed more often than that. */
export const VIEWING_BEAT_MS = 20_000;
/** After taking a case, "Take next" ignores another press for this long (a double click, a held key). */
export const TAKE_COOLDOWN_MS = 500;

const visible = (): boolean => document.visibilityState !== 'hidden';

/**
 * Renders nothing. While the report page is open it makes the moderator the handler of that case if nobody is, renews the claim
 * every 60 seconds and the viewing hint every 20 while the tab is visible, and keeps their row in the queue while it is open.
 * A case someone else holds is opened to read, with a notice. Leaving the case (another case, another screen, closing the hub)
 * releases the claim, unless a decision on it is waiting: sending that releases it.
 */
export function CaseSession({ reportId }: { reportId: string }) {
  const { client, t, can, me, now } = useHub();
  const queue = useQueue();
  const decisions = useOptionalDecisions();
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const nowRef = useRef(now);
  nowRef.current = now;
  const toasts = useToasts();
  const group = queue.groups.find((g) => g.reportIds.includes(reportId)) ?? null;
  // The person this page is about, remembered once seen: if the case closes while it is open, its row stays (marked) in the
  // queue, but nothing is claimed or viewed any more.
  const seen = useRef<{ reportId: string; person: string } | null>(null);
  if (group !== null) seen.current = { reportId, person: group.person };
  else if (seen.current !== null && seen.current.reportId !== reportId) seen.current = null;
  const openPerson = seen.current?.person ?? null;
  const person = group?.person ?? null;
  const canClaim = can('reports.decide');

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  const tRef = useRef(t);
  tRef.current = t;
  const nameRef = useRef('');
  nameRef.current = group === null ? '' : groupName(t, group);

  useEffect(() => {
    queueRef.current.setOpenPerson(openPerson);
    return () => queueRef.current.setOpenPerson(null);
  }, [openPerson]);

  useEffect(() => {
    if (person === null) return;
    let cancelled = false;
    // Who we last knew held it, so a change is said once and a steady state is not repeated at every heartbeat.
    let told: string | null = null;
    let mine = false;

    const claim = async (): Promise<void> => {
      if (!canClaim || queueRef.current.isHeldOff(person)) return;
      try {
        const result = await client.claimCase(person);
        if (cancelled) return;
        mine = true;
        told = result.claim.by;
        queueRef.current.patchClaim(person, result.claim);
      } catch (e) {
        if (cancelled) return;
        const err = toHubError(e);
        if (err.code === 'claimed' && err.heldBy !== undefined) {
          const until = err.heldUntil ?? 0;
          queueRef.current.patchClaim(person, { by: err.heldBy, since: until - CLAIM_TTL_MS, until });
          if (told !== err.heldBy) {
            const key = mine ? 'hub.toast.lostClaim' : 'hub.toast.heldBy';
            toastsRef.current.push({ text: tRef.current(key, { name: actorName(err.heldBy) }) });
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
        if (!cancelled) queueRef.current.patchViewing(person, result.viewers);
      } catch {
        // A hint: a miss costs nothing.
      }
    };

    void claim();
    void view();
    const claimTimer = setInterval(() => visible() && void claim(), CLAIM_BEAT_MS);
    const viewTimer = setInterval(() => visible() && void view(), VIEWING_BEAT_MS);
    const onVisible = (): void => {
      if (visible()) {
        void claim();
        void view();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      // A release held the case off for this visit only: opening it again claims it.
      queueRef.current.holdOff(person, false);
      clearInterval(claimTimer);
      clearInterval(viewTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, person, canClaim, me.actor]);

  // Leaving the case lets it go: a moderator who browses the queue must not leave a trail of cases only they seem to hold. A
  // decision that is still waiting is the exception (sending it releases the claim). It is said by the queue copy, not by a
  // request of its own, whether the claim is ours: a case someone else holds is theirs, and a lapsed claim is nobody's.
  useEffect(() => {
    if (person === null) return;
    return () => {
      if (decisionsRef.current?.isPending(person)) return;
      const q = queueRef.current;
      const group = q.groups.find((g) => g.person === person);
      if (group === undefined || holderOf(group.claim, me.actor, nowRef.current()).kind !== 'you') return;
      q.patchClaim(person, null);
      void client.releaseCase(person).catch(() => undefined);
    };
  }, [client, person, me.actor]);

  return null;
}

export type TakeResult = 'taken' | 'none' | 'busy' | 'failed';

export interface CaseActions {
  /** Claim and open the oldest unclaimed case that matches the category filter. Says how it went. */
  takeNext: () => Promise<TakeResult>;
  /** Claim a free case (after you let it go). */
  claim: (person: string) => Promise<void>;
  /** A senior or owner moving another moderator's live claim to themselves. The server audits it. */
  takeOver: (person: string) => Promise<void>;
  /** Release your claim on a case. The toast offers Undo, which claims it again. */
  release: (person: string) => Promise<void>;
}

/** What a moderator does about claims from anywhere in the hub: the queue pane, the case panel, the command bar, a shortcut. */
export function useCaseActions(): CaseActions {
  const { client, t, go } = useHub();
  const queue = useOptionalQueue();
  const toasts = useToasts();
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const fail = useCallback(
    (e: unknown): void => {
      toasts.push({ text: errorText(t, toHubError(e)), tone: 'bad' });
    },
    [t, toasts],
  );

  const takeNext = useCallback(async (): Promise<TakeResult> => {
    const q = queueRef.current;
    if (q === null || !q.beginTake()) return 'busy';
    try {
      const category = q.filter.category;
      const { case: next } = await client.takeNext(category === 'all' ? {} : { category });
      if (next === null) {
        toasts.push({ text: t('hub.toast.nothing') });
        return 'none';
      }
      // The case may be newer than the list on screen: read again so it is there, then show it as the moderator's.
      const known = q.groups.some((g) => g.person === next.person) ? q.groups : await q.reload();
      q.patchClaim(next.person, next.claim);
      // A filter that would hide the case just taken is cleared: the moderator should see what they took.
      if (q.filter.claim === 'unclaimed') q.setFilter({ claim: 'all' });
      q.holdOff(next.person, false);
      const group = known.find((g) => g.person === next.person);
      go({ name: 'report', id: next.reportId });
      toasts.push({ text: group === undefined ? t('hub.toast.tookNext') : t('hub.toast.took', { who: groupName(t, group) }) });
      return 'taken';
    } catch (e) {
      fail(e);
      return 'failed';
    } finally {
      // A short cooldown, not just "while it runs": a double click is two clicks 100 ms apart, and a fast server has answered
      // the first by then. The guard is the queue's, so a click, the N key and the command bar share it.
      q.endTake(TAKE_COOLDOWN_MS);
    }
  }, [client, fail, go, t, toasts]);

  const claimCase = useCallback(
    async (person: string): Promise<void> => {
      const q = queueRef.current;
      try {
        const result = await client.claimCase(person);
        q?.holdOff(person, false);
        q?.patchClaim(person, result.claim);
      } catch (e) {
        const err = toHubError(e);
        if (err.code === 'claimed' && err.heldBy !== undefined) {
          const until = err.heldUntil ?? 0;
          q?.patchClaim(person, { by: err.heldBy, since: until - CLAIM_TTL_MS, until });
          toasts.push({ text: t('hub.toast.heldBy', { name: actorName(err.heldBy) }), tone: 'bad' });
        } else fail(e);
      }
    },
    [client, fail, t, toasts],
  );

  const takeOver = useCallback(
    async (person: string): Promise<void> => {
      const q = queueRef.current;
      try {
        const result = await client.claimCase(person, { takeOver: true });
        q?.holdOff(person, false);
        q?.patchClaim(person, result.claim);
        toasts.push({ text: result.tookOverFrom === null ? t('hub.toast.tookCase') : t('hub.toast.tookOver', { name: actorName(result.tookOverFrom) }) });
      } catch (e) {
        fail(e);
      }
    },
    [client, fail, t, toasts],
  );

  const release = useCallback(
    async (person: string): Promise<void> => {
      const q = queueRef.current;
      if (q === null) return;
      const group = q.groups.find((g) => g.person === person);
      const who = group === undefined ? t('hub.person.prefix') : groupName(t, group);
      try {
        const result = await client.releaseCase(person);
        q.patchClaim(person, null);
        if (!result.released) return;
        q.holdOff(person, true);
        toasts.push({
          text: t('hub.toast.released', { who }),
          action: {
            label: t('hub.toast.undo'),
            run: () => {
              void (async () => {
                try {
                  const again = await client.claimCase(person);
                  q.holdOff(person, false);
                  q.patchClaim(person, again.claim);
                  toasts.push({ text: t('hub.toast.reclaimed', { who }) });
                } catch (e) {
                  const err = toHubError(e);
                  if (err.code === 'claimed' && err.heldBy !== undefined) {
                    toasts.push({ text: t('hub.toast.heldBy', { name: actorName(err.heldBy) }), tone: 'bad' });
                  } else fail(e);
                }
              })();
            },
          },
        });
      } catch (e) {
        fail(e);
      }
    },
    [client, fail, t, toasts],
  );

  return { takeNext, release, claim: claimCase, takeOver };
}
