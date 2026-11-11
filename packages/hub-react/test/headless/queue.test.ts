// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../../src/client.js';
import { BANNER_AFTER_FAILURES, POLL_FAILING_MS, POLL_HIDDEN_MS, POLL_VISIBLE_MS } from '../../src/live.js';
import { MINUTE } from '../world.js';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// The live queue, driven directly: no DOM, timers and page in the test's hand, the kit's real staff routes behind it.

async function started(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig(options);
  return r;
}
const changes = (r: Rig): number => r.count('GET', '/changes');
const reads = (r: Rig): number => r.count('GET', '/reports');
const queue = (r: Rig) => r.controller.queue.getSnapshot();
const toastTexts = (r: Rig): string[] => r.controller.toasts.getSnapshot().map((t) => t.text);

describe('the live queue: the first load', () => {
  it('is loading until started, then ready with the cases longest-waiting first', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    const b = await r.w.file({ target: 'Bravo' });
    expect(queue(r).status).toBe('loading');
    expect(queue(r).rows).toEqual([]);
    await r.controller.start();
    await settle();
    const s = queue(r);
    expect(s.status).toBe('ready');
    expect(s.error).toBeNull();
    expect(s.groups.map((g) => g.person)).toEqual([a.person, b.person]);
    expect(s.rows.map((x) => x.group.person)).toEqual([a.person, b.person]);
    expect(s.visible.map((x) => x.group.person)).toEqual([a.person, b.person]);
    expect(s.reports).toBe(2);
    expect(s.partial).toBe(false);
    expect(s.incoming).toBe(0);
    expect(s.connection).toBe('live');
    expect(s.revision).toBe(1);
    expect(s.updatedAt).toBe(r.w.now());
  });

  it('start() resolves once the first read is in: the cases (or the error) are in the snapshot', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    expect(queue(r).status).toBe('ready');
    expect(queue(r).groups.map((g) => g.person)).toEqual([a.person]);
    const failing = await started();
    failing.w.intercept.fn = (req) => (req.path === '/me' ? undefined : { status: 500, body: { error: 'boom', message: 'x' } });
    await failing.controller.start();
    expect(failing.controller.queue.getSnapshot().status).toBe('error');
    // And it never rejects, even asked twice.
    await expect(failing.controller.queue.start()).resolves.toBeUndefined();
  });

  it('start() says who is signed in, from GET /me', async () => {
    const r = await started({ world: { role: 'senior', actor: 'sam@example.test' } });
    const answer = await r.controller.start();
    expect(answer.ok).toBe(true);
    expect(answer.ok && answer.value.actor).toBe('sam@example.test');
    expect(r.controller.me.getSnapshot()?.role).toBe('senior');
  });

  it('a role that cannot read reports starts no queue and polls nothing', async () => {
    const r = await started();
    r.w.session.who = { actor: 'x@example.test', role: 'moderator' };
    const me = await r.w.client.me();
    r.controller.identify({ ...me, can: { ...me.can, 'reports.read': false } });
    await r.controller.start();
    await settle();
    await r.timers.advance(60_000);
    expect(changes(r)).toBe(0);
    expect(reads(r)).toBe(0);
    expect(queue(r).status).toBe('loading');
  });

  it('start() with no sign-in answers the error, and the queue stays loading', async () => {
    const r = await started({ world: { role: null } });
    const answer = await r.controller.start();
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error.status).toBe(401);
    expect(r.timers.count()).toBe(0);
  });
});

describe('the live queue: running', () => {
  it('says whether it is polling: false before start, true after, false after stop, and a start after a stop polls again', async () => {
    const r = await started();
    expect(r.controller.queue.running).toBe(false);
    await r.controller.start();
    expect(r.controller.queue.running).toBe(true);
    await r.controller.queue.start();
    expect(r.controller.queue.running).toBe(true);
    r.controller.queue.stop();
    expect(r.controller.queue.running).toBe(false);
    await r.controller.queue.start();
    expect(r.controller.queue.running).toBe(true);
  });

  it('is false after dispose, and a disposed queue never runs again', async () => {
    const r = await started();
    await r.controller.start();
    r.controller.dispose();
    expect(r.controller.queue.running).toBe(false);
    await r.controller.queue.start();
    expect(r.controller.queue.running).toBe(false);
  });

  it('a role that cannot read reports never runs', async () => {
    const r = await started({ world: { role: 'moderator', permissions: { 'reports.read': 'owner' } } });
    await r.controller.start();
    expect(r.controller.queue.running).toBe(false);
  });
});

describe('the live queue: holds', () => {
  it('runs while any hold is unreleased and stops with the last release', async () => {
    const r = await started();
    await r.controller.start();
    r.controller.queue.stop();
    const one = r.controller.queue.acquire();
    const two = r.controller.queue.acquire();
    expect(r.controller.queue.running).toBe(true);
    await one.ready;
    one.release();
    expect(r.controller.queue.running).toBe(true);
    two.release();
    expect(r.controller.queue.running).toBe(false);
  });

  it('a release works once: a second release of the same hold takes nothing from another', async () => {
    const r = await started();
    await r.controller.start();
    r.controller.queue.stop();
    const one = r.controller.queue.acquire();
    const two = r.controller.queue.acquire();
    one.release();
    one.release();
    expect(r.controller.queue.running).toBe(true);
    two.release();
    expect(r.controller.queue.running).toBe(false);
  });

  it('controller.start() is a hold: its result still says ok and the Me, and carries the release', async () => {
    const r = await started();
    const answer = await r.controller.start();
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.value.actor).toBe('ann@example.test');
    const other = r.controller.queue.acquire();
    other.release();
    expect(r.controller.queue.running).toBe(true);
    answer.release();
    expect(r.controller.queue.running).toBe(false);
  });

  it('the older queue.start() and queue.stop() work as they did: start is idempotent and held until stop, stop ends every hold', async () => {
    const r = await started();
    await r.controller.start();
    r.controller.queue.stop();
    await r.controller.queue.start();
    await r.controller.queue.start();
    const hold = r.controller.queue.acquire();
    hold.release();
    expect(r.controller.queue.running).toBe(true);
    const again = r.controller.queue.acquire();
    r.controller.queue.stop();
    expect(r.controller.queue.running).toBe(false);
    again.release();
    expect(r.controller.queue.running).toBe(false);
  });

  it('a disposed queue takes no hold', async () => {
    const r = await started();
    await r.controller.start();
    r.controller.dispose();
    const hold = r.controller.queue.acquire();
    expect(r.controller.queue.running).toBe(false);
    hold.release();
  });
});

describe('the live queue: polling', () => {
  it('asks GET /changes every 5 seconds while visible, and reads the queue again only when the token moved', async () => {
    const r = await started();
    await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    expect(POLL_VISIBLE_MS).toBe(5_000);
    expect([changes(r), reads(r)]).toEqual([1, 1]);
    await r.timers.advance(4_999);
    expect(changes(r)).toBe(1);
    await r.timers.advance(1);
    expect([changes(r), reads(r)]).toEqual([2, 1]);
    await r.timers.advance(POLL_VISIBLE_MS * 3);
    expect([changes(r), reads(r)]).toEqual([5, 1]);
    expect(queue(r).revision).toBe(1);
  });

  it('a change reads the queue once more and bumps the revision', async () => {
    const r = await started();
    await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    await r.w.file({ target: 'Bravo' });
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(reads(r)).toBe(2);
    expect(queue(r).revision).toBe(2);
    expect(queue(r).groups).toHaveLength(2);
  });

  it('while the tab is hidden it asks every 30 seconds, and showing it asks at once', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.page.hide();
    await settle();
    const before = changes(r);
    expect(POLL_HIDDEN_MS).toBe(30_000);
    await r.timers.advance(29_999);
    expect(changes(r)).toBe(before);
    await r.timers.advance(1);
    expect(changes(r)).toBe(before + 1);
    await r.timers.advance(30_000);
    expect(changes(r)).toBe(before + 2);
    r.page.show();
    await settle();
    expect(changes(r)).toBe(before + 3);
    await r.timers.advance(5_000);
    expect(changes(r)).toBe(before + 4);
  });

  it('hiding the tab while a 5 second timer is waiting slows it to 30 from then on', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    await r.timers.advance(2_000);
    r.page.hide();
    await settle();
    const before = changes(r);
    await r.timers.advance(29_000);
    expect(changes(r)).toBe(before);
    await r.timers.advance(1_000);
    expect(changes(r)).toBe(before + 1);
  });

  it('one request at a time: an overlapping tick waits for the next timer', async () => {
    const r = await started();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await r.controller.start();
    await settle();
    r.w.intercept.fn = async (req) => {
      if (req.path === '/changes') await gate;
      return undefined;
    };
    await r.timers.advance(POLL_VISIBLE_MS);
    const inFlight = changes(r);
    r.page.show();
    r.page.show();
    await settle();
    expect(changes(r)).toBe(inFlight);
    release();
    await settle();
  });

  it('while offline it asks nothing, and coming back asks at once', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.page.goOffline();
    await settle();
    expect(queue(r).connection).toBe('offline');
    const before = changes(r);
    await r.timers.advance(120_000);
    expect(changes(r)).toBe(before);
    r.page.goOnline();
    await settle();
    expect(changes(r)).toBe(before + 1);
    expect(queue(r).connection).toBe('live');
    expect(toastTexts(r)).toContain('Back online.');
  });

  it('a poll that finishes after the browser went offline does not set the next timer', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.w.intercept.fn = async (req) => {
      if (req.path === '/changes') await gate;
      return undefined;
    };
    await r.timers.advance(POLL_VISIBLE_MS);
    r.page.goOffline();
    release();
    await settle();
    const before = changes(r);
    await r.timers.advance(120_000);
    expect(changes(r)).toBe(before);
  });

  it('a hub that starts offline says so and waits', async () => {
    const r = await started({ controller: { page: { online: () => false } } });
    await r.controller.start();
    await settle();
    expect(queue(r).connection).toBe('offline');
    expect(changes(r)).toBe(0);
  });

  it('stop() clears the timer and every listener; start() after it begins again', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    expect(r.page.listeners()).toBeGreaterThan(0);
    r.controller.queue.stop();
    expect(r.timers.count()).toBe(0);
    expect(r.page.listeners()).toBe(0);
    const before = changes(r);
    await r.timers.advance(60_000);
    expect(changes(r)).toBe(before);
    r.controller.queue.start();
    await settle();
    expect(changes(r)).toBe(before + 1);
  });
});

describe('the live queue: failures and the connection', () => {
  it('one failure is a blip; two in a row show the banner, and polling slows to 15 seconds', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.w.intercept.fn = (req) => (req.path === '/changes' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    expect(BANNER_AFTER_FAILURES).toBe(2);
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).connection).toBe('live');
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).connection).toBe('lost');
    expect(queue(r).status).toBe('ready');
    const before = changes(r);
    await r.timers.advance(POLL_FAILING_MS - 1);
    expect(changes(r)).toBe(before);
    await r.timers.advance(1);
    expect(changes(r)).toBe(before + 1);
  });

  it('the first answer failing leaves status error with the error; a later success is ready', async () => {
    const r = await started();
    r.w.intercept.fn = (req) => (req.path === '/changes' ? { status: 500, body: { error: 'boom', message: 'Down.' } } : undefined);
    await r.controller.start();
    await settle();
    expect(queue(r).status).toBe('error');
    expect(queue(r).error?.message).toBe('Down.');
    r.w.intercept.fn = null;
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).status).toBe('ready');
    expect(queue(r).error).toBeNull();
  });

  it('coming back says "Back online." once', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.w.intercept.fn = (req) => (req.path === '/changes' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await r.timers.advance(POLL_VISIBLE_MS * 2);
    expect(queue(r).connection).toBe('lost');
    r.w.intercept.fn = null;
    await r.timers.advance(POLL_FAILING_MS);
    expect(queue(r).connection).toBe('live');
    expect(toastTexts(r).filter((t) => t === 'Back online.')).toHaveLength(1);
  });

  it('a 401 or 403 stops the polling, says signed out with the error, and retryNow tries again', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.w.intercept.fn = (req) => (req.path === '/changes' ? { status: 401, body: { error: 'unauthorized', message: 'Sign in.' } } : undefined);
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).connection).toBe('signedOut');
    expect(queue(r).authError?.status).toBe(401);
    const before = changes(r);
    await r.timers.advance(120_000);
    expect(changes(r)).toBe(before);
    r.w.intercept.fn = null;
    r.controller.queue.retryNow();
    await settle();
    expect(changes(r)).toBe(before + 1);
    expect(queue(r).connection).toBe('live');
    expect(queue(r).authError).toBeNull();
  });

  it('a 429 with Retry-After waits at least that long', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.w.intercept.fn = (req) => (req.path === '/changes' ? { status: 429, headers: { 'retry-after': '40' }, body: { error: 'rate_limited', message: 'Slow down.' } } : undefined);
    await r.timers.advance(POLL_VISIBLE_MS);
    r.w.intercept.fn = null;
    const before = changes(r);
    await r.timers.advance(39_999);
    expect(changes(r)).toBe(before);
    await r.timers.advance(1);
    expect(changes(r)).toBe(before + 1);
  });

  it('reload answers the groups read, and the old ones when the read fails', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    expect((await r.controller.queue.reload()).map((g) => g.person)).toEqual([a.person]);
    r.w.intercept.fn = () => ({ status: 500, body: { error: 'boom', message: 'x' } });
    expect((await r.controller.queue.reload()).map((g) => g.person)).toEqual([a.person]);
  });
});

describe('the live queue: "N new" and the cursor', () => {
  it('a new case waits behind the pill, the list does not move, and showIncoming takes it', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    const b = await r.w.file({ target: 'Bravo' });
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).incoming).toBe(1);
    expect(queue(r).rows.map((x) => x.group.person)).toEqual([a.person]);
    expect(queue(r).groups.map((g) => g.person)).toEqual([a.person, b.person]);
    r.controller.queue.showIncoming();
    expect(queue(r).incoming).toBe(0);
    expect(queue(r).rows.map((x) => x.group.person)).toEqual([a.person, b.person]);
  });

  it('a case that closes is dropped, unless the cursor is on its row: then it stays, marked gone, until the cursor leaves', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    const b = await r.w.file({ target: 'Bravo' });
    await r.controller.start();
    await settle();
    r.controller.queue.setInteracting(true);
    await r.w.client.decide(a.id, { verdict: 'no_action', reason: 'x', actions: [] });
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).rows.map((x) => [x.group.person, x.gone])).toEqual([
      [a.person, true],
      [b.person, false],
    ]);
    r.controller.queue.setInteracting(false);
    expect(queue(r).rows.map((x) => x.group.person)).toEqual([b.person]);
  });

  it('the open case keeps its row too, and lets go when it is closed', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.w.file({ target: 'Bravo' });
    await r.controller.start();
    await settle();
    r.controller.queue.setOpenPerson(a.person);
    await r.w.client.decide(a.id, { verdict: 'no_action', reason: 'x', actions: [] });
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(queue(r).rows.find((x) => x.group.person === a.person)?.gone).toBe(true);
    r.controller.queue.setOpenPerson(null);
    expect(queue(r).rows.find((x) => x.group.person === a.person)).toBeUndefined();
  });
});

describe('the live queue: claims, pending, filters', () => {
  it('patchClaim and patchViewing change the group on screen and in the list, at once', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    const claim = { by: 'ann@example.test', since: r.w.now(), until: r.w.now() + 10 * MINUTE };
    r.controller.queue.patchClaim(a.person, claim);
    r.controller.queue.patchViewing(a.person, ['zed', 'amy']);
    expect(queue(r).groups[0]?.claim).toEqual(claim);
    expect(queue(r).rows[0]?.group.claim).toEqual(claim);
    expect(queue(r).rows[0]?.group.viewing).toEqual(['amy', 'zed']);
    r.controller.queue.patchClaim(a.person, null);
    expect(queue(r).groups[0]?.claim).toBeNull();
  });

  it('a person whose decision is on its way leaves visible at once and comes back when it is not', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    r.controller.queue.setPending(a.person, true);
    expect(queue(r).visible).toEqual([]);
    expect(queue(r).rows).toHaveLength(1);
    expect(queue(r).pending.has(a.person)).toBe(true);
    const snap = queue(r);
    r.controller.queue.setPending(a.person, true);
    expect(queue(r)).toBe(snap);
    r.controller.queue.setPending(a.person, false);
    expect(queue(r).visible).toHaveLength(1);
  });

  it('the filters narrow visible and nothing else', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha', category: 'harassment' });
    await r.w.file({ target: 'Bravo', category: 'cheating' });
    await r.controller.start();
    await settle();
    r.controller.queue.setFilter({ category: 'cheating' });
    expect(queue(r).filter).toEqual({ claim: 'all', category: 'cheating' });
    expect(queue(r).visible).toHaveLength(1);
    expect(queue(r).rows).toHaveLength(2);
    r.controller.queue.setFilter({ category: 'all', claim: 'mine' });
    expect(queue(r).visible).toEqual([]);
    const claim = { by: 'ann@example.test', since: r.w.now(), until: r.w.now() + 10 * MINUTE };
    r.controller.queue.patchClaim(a.person, claim);
    expect(queue(r).visible.map((x) => x.group.person)).toEqual([a.person]);
  });

  it('a held-off person is remembered until it is cleared', async () => {
    const r = await started();
    expect(r.controller.queue.isHeldOff('p')).toBe(false);
    r.controller.queue.holdOff('p', true);
    expect(r.controller.queue.isHeldOff('p')).toBe(true);
    r.controller.queue.holdOff('p', false);
    expect(r.controller.queue.isHeldOff('p')).toBe(false);
  });
});

describe('the live queue: the Take-next guard and the minute', () => {
  it('one take at a time, shut for the cooldown after it ends', async () => {
    const r = await started();
    expect(r.controller.queue.beginTake()).toBe(true);
    expect(r.controller.queue.beginTake()).toBe(false);
    r.controller.queue.endTake(500);
    expect(r.controller.queue.beginTake()).toBe(false);
    await r.timers.advance(499);
    expect(r.controller.queue.beginTake()).toBe(false);
    await r.timers.advance(1);
    expect(r.controller.queue.beginTake()).toBe(true);
  });

  it('the minute counter moves each minute while visible, and not while hidden', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    expect(queue(r).minute).toBe(0);
    await r.timers.advance(MINUTE);
    expect(queue(r).minute).toBe(1);
    r.page.hide();
    await r.timers.advance(MINUTE * 2);
    expect(queue(r).minute).toBe(1);
    r.page.show();
    await settle();
    expect(queue(r).minute).toBe(2);
  });
});

describe('the live queue: snapshots', () => {
  it('the snapshot is the same object between changes, and a listener is told on a change and not on a quiet poll', async () => {
    const r = await started();
    await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    const first = queue(r);
    expect(queue(r)).toBe(first);
    const listener = vi.fn();
    const off = r.controller.queue.subscribe(listener);
    await r.timers.advance(POLL_VISIBLE_MS * 4);
    expect(listener).not.toHaveBeenCalled();
    expect(queue(r)).toBe(first);
    r.controller.queue.setFilter({ category: 'cheating' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(queue(r)).not.toBe(first);
    expect(queue(r).rows).toBe(first.rows);
    off();
  });

  it('setFilter with nothing new, and a patch for a person not in the list, change nothing', async () => {
    const r = await started();
    await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    const first = queue(r);
    r.controller.queue.setFilter({});
    expect(queue(r)).toBe(first);
    r.controller.queue.setOpenPerson(null);
    r.controller.queue.setInteracting(false);
    expect(queue(r)).toBe(first);
  });

  it('after dispose a read asks nothing and a finished Take next arms no cooldown timer', async () => {
    const r = await started();
    await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    r.controller.dispose();
    const before = r.w.sent.length;
    expect((await r.controller.queue.reload()).map((g) => g.person)).toHaveLength(1);
    r.controller.queue.beginTake();
    r.controller.queue.endTake(500);
    expect(r.w.sent.length).toBe(before);
    expect(r.timers.count()).toBe(0);
  });

  it('dispose stops the loop, and a later start does nothing', async () => {
    const r = await started();
    await r.controller.start();
    await settle();
    r.controller.dispose();
    r.controller.dispose();
    expect(r.timers.count()).toBe(0);
    expect(r.page.listeners()).toBe(0);
    const before = changes(r);
    await r.timers.advance(60_000);
    r.controller.queue.start();
    await settle();
    expect(changes(r)).toBe(before);
    expect(r.controller.disposed).toBe(true);
  });
});

describe('the live queue: reads in order', () => {
  it('a slow old read never overwrites a newer one (its answer was made before the decision, and arrives after the newer read)', async () => {
    const r = await started();
    const a = await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    r.w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/reports' && first) {
        first = false;
        // The server answers now, with the case still open; the answer is held back on the way.
        const real = await r.w.raw({ method: req.method, path: req.path, query: Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])) });
        await gate;
        return real;
      }
      return undefined;
    };
    const slow = r.controller.queue.reload();
    await settle();
    await r.w.client.decide(a.id, { verdict: 'no_action', reason: 'x', actions: [] });
    const fast = r.controller.queue.reload();
    await settle();
    expect((await fast).map((g) => g.person)).toEqual([]);
    expect(queue(r).groups).toEqual([]);
    release();
    expect((await slow).map((g) => g.person)).toEqual([a.person]);
    await settle();
    // The stale answer went back to its caller, but is not what the queue shows.
    expect(queue(r).groups).toEqual([]);
  });

  it('the error from a read is a HubError', async () => {
    const r = await started();
    r.w.intercept.fn = (req) => (req.path === '/me' ? undefined : { status: 500, body: { error: 'boom', message: 'x' } });
    await r.controller.start();
    await settle();
    expect(queue(r).error).toBeInstanceOf(HubError);
  });
});
