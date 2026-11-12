import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { DiscordThreadRow, KitEvent, Logger, RawWho } from '@chatwarden/core';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import { discordFeed } from '../src/feed.js';
import type { DiscordFeedOptions, FeedKit } from '../src/feed.js';
import { NOW, ROLE, WEBHOOK, fakeDiscord, leaks, settle, visibleTexts } from './support.js';

// The appeal posts of the Discord feed: `appeal.created` and `appeal.decided` go to the person's thread, with a link into the hub; `rename.required`
// is ignored (it is for the game). No statement, handle, reason or id appears in a post, except inside the hub link.

const H = 3_600_000;
const DAY = 24 * H;
const STATEMENT = 'STATEMENT-TEXT i was only joking';
const REASON = 'PRIVATE-DECIDING-REASON';
const HANDLE = 'HANDLE-OF-THE-APPEALER';

const id22 = (): string => randomBytes(16).toString('base64url');
const sid = (): string => `s_${id22()}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`;

interface FakeAppeal {
  sanction: { groupId: string; kind: string; startsAt: number; endsAt: number | null };
  statement: string | null;
}

/** A kit with only what the feed uses, and the staff read of an appeal (which holds a statement the feed must never post). */
function fakeKit() {
  const listeners = new Set<{ type: string; fn: (e: KitEvent) => unknown }>();
  const threads = new Map<string, DiscordThreadRow>();
  const appeals = new Map<string, FakeAppeal>();
  const state = { severeRules: undefined as number[] | undefined, failGet: false, gets: [] as string[] };
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      const entry = { type, fn };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    reports: { get: () => null },
    profile: {
      get severeRules() {
        return state.severeRules;
      },
    },
    rules: { all: () => [{ number: 1, title: 'No hate' }, { number: 2, title: 'Respect others' }] },
    limits: { strikes: { firstMs: H, repeatMs: DAY } },
    people: { canonical: (id: string) => id, aliases: (id: string) => [id] },
    appeals: {
      get: (id: string) => {
        state.gets.push(id);
        if (state.failGet) throw new RangeError('store down');
        return (appeals.get(id) as never) ?? null;
      },
    },
    discordThreads: {
      get: (subject: string) => threads.get(subject) ?? null,
      put: (row: DiscordThreadRow) => void threads.set(row.subject, { ...row }),
    },
  };
  const emit = async (e: KitEvent): Promise<void> => {
    await Promise.all([...listeners].filter((l) => l.type === '*' || l.type === e.type).map((l) => l.fn(e)));
  };
  return { kit: kit as unknown as FeedKit, listeners, appeals, state, emit };
}
type Kit = ReturnType<typeof fakeKit>;

function start(k: Kit, options: Partial<DiscordFeedOptions> = {}) {
  const d = fakeDiscord();
  const logged: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
  const logger: Logger = { warn: (e, detail) => void logged.push([e, detail]) };
  const feed = discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, logger, random: () => 0.5, clock: { now: () => Date.now() }, ...options });
  return { feed, d, logged };
}

const created = (target: string, over: Partial<Extract<KitEvent, { type: 'appeal.created' }>> = {}): KitEvent => ({
  type: 'appeal.created',
  appealId: 'ap-' + id22().slice(0, 8),
  createdAt: NOW,
  target,
  kind: 'chat',
  rule: 2,
  ...over,
});
const decided = (target: string, outcome: 'uphold' | 'reduce' | 'revoke', over: Partial<Extract<KitEvent, { type: 'appeal.decided' }>> = {}): KitEvent => ({
  type: 'appeal.decided',
  appealId: 'ap-' + id22().slice(0, 8),
  at: NOW,
  target,
  outcome,
  rule: 2,
  ...over,
});
const rename = (target: string): KitEvent => ({ type: 'rename.required', at: NOW, target, rule: 1 });

/** Stock the fake kit with the appeal a `created` event names. */
function withAppeal(k: Kit, e: KitEvent, sanction: Partial<FakeAppeal['sanction']> = {}): void {
  if (e.type !== 'appeal.created') throw new Error('not a created event');
  k.appeals.set(e.appealId, { sanction: { groupId: id22(), kind: e.kind, startsAt: NOW, endsAt: NOW + DAY, ...sanction }, statement: STATEMENT });
}

const contents = (calls: Array<{ body: Record<string, unknown> }>): string[] => calls.map((c) => String(c.body.content));

describe('Discord posts "Appeal filed against a 24-hour chat restriction, Rule 2. Open in the hub." and "Appeal decided: lighter." style messages with no statement, handle or reason; severeOnly filters; the message fits the post limit; rename.required is ignored', () => {
  it('appeal.created: the sanction and the rule in words, then a link into the hub on the person', async () => {
    const k = fakeKit();
    const subject = sid();
    const e = created(subject);
    withAppeal(k, e);
    const { d } = start(k);
    await k.emit(e);
    await settle();
    expect(d.creates()).toHaveLength(1);
    const text = String(d.calls[0]?.body.content);
    expect(text).toContain('Appeal filed against a 24-hour chat restriction, Rule 2.');
    expect(text).toContain(`[Open in the hub](<${hubLink('person', subject)}>)`);
    expect(text.split('\n')[0]).toBe('Appeal filed against a 24-hour chat restriction, Rule 2.');
    // The post goes to the person's thread: the second post of a person lands in the thread the first opened.
    const e2 = decided(subject, 'reduce');
    await k.emit(e2);
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(1);
  });

  it('appeal.decided: the outcome in a word (lighter for a reduction), a link into the hub, in the same thread', async () => {
    const k = fakeKit();
    const subject = sid();
    const { d } = start(k);
    await k.emit(decided(subject, 'reduce'));
    await k.emit(decided(subject, 'uphold'));
    await k.emit(decided(subject, 'revoke'));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(2);
    const texts = contents(d.calls);
    expect(texts[0]).toContain('Appeal decided: lighter.');
    expect(texts[1]).toContain('Appeal decided: upheld.');
    expect(texts[2]).toContain('Appeal decided: revoked.');
    for (const t of texts) expect(t).toContain(`[Open in the hub](<${hubLink('person', subject)}>)`);
  });

  it('describes each kind and length in plain words, with the right article', async () => {
    const cases: Array<[string, Partial<FakeAppeal['sanction']>, string]> = [
      ['chat', { endsAt: NOW + DAY }, 'against a 24-hour chat restriction'],
      ['chat', { endsAt: NOW + 6 * H }, 'against a 6-hour chat restriction'],
      ['chat', { endsAt: NOW + 18 * H }, 'against an 18-hour chat restriction'],
      ['ban', { endsAt: NOW + 7 * DAY }, 'against a 7-day ban'],
      ['ban', { endsAt: null }, 'against a permanent ban'],
      ['area', { endsAt: NOW + 3 * DAY }, 'against a 3-day area ban'],
      ['chat', { endsAt: NOW + 90 * 60_000 }, 'against a chat restriction of 1 hour 30 minutes'],
      ['warning', { endsAt: null }, 'against a warning'],
    ];
    for (const [kind, sanction, phrase] of cases) {
      const k = fakeKit();
      const e = created(sid(), { kind: kind as never });
      withAppeal(k, e, sanction);
      const { d } = start(k);
      await k.emit(e);
      await settle();
      expect(String(d.calls[0]?.body.content), `${kind} ${JSON.stringify(sanction)}`).toContain(`Appeal filed ${phrase}, Rule 2.`);
    }
  });

  it('a kit with no appeal read, a read that fails, or one that finds nothing still posts, without a length, and logs the class only', async () => {
    const k = fakeKit();
    const subject = sid();
    const e = created(subject);
    // not stocked: the read answers null
    const { d, logged } = start(k);
    await k.emit(e);
    k.state.failGet = true;
    await k.emit(created(subject));
    delete (k.kit as { appeals?: unknown }).appeals;
    await k.emit(created(subject));
    await settle();
    for (const t of contents(d.calls)) expect(t).toContain('Appeal filed against a chat restriction, Rule 2.');
    expect(d.calls).toHaveLength(3);
    expect(logged.filter(([ev]) => ev === 'chatwarden.discord_failed')).toEqual([['chatwarden.discord_failed', { op: 'appeal.created', error: 'RangeError' }]]);
    expect(JSON.stringify(logged)).not.toContain('store down');
  });

  it('the rule is left out when the appeal has none or it is not covered', async () => {
    for (const rule of [null, 'uncovered'] as const) {
      const k = fakeKit();
      const e = created(sid(), { rule });
      withAppeal(k, e);
      const { d } = start(k);
      await k.emit(e);
      await settle();
      expect(contents(d.calls)[0]).toContain('Appeal filed against a 24-hour chat restriction.');
      expect(contents(d.calls)[0]).not.toContain('Rule');
    }
  });

  it('never posts a statement, a handle, a reason or an id: only the fixed words and the hub link carry the person', async () => {
    const k = fakeKit();
    const subject = sid();
    const e = created(subject);
    withAppeal(k, e);
    const { d } = start(k, { mentionRoleId: ROLE });
    await k.emit(e);
    await k.emit(decided(subject, 'reduce', { appealId: (e as { appealId: string }).appealId }));
    await settle();
    expect(d.calls).toHaveLength(2);
    for (const call of d.calls) {
      for (const text of visibleTexts(call.body)) {
        expect(leaks(text, [STATEMENT, REASON, HANDLE, subject, (e as { appealId: string }).appealId]), text).toEqual([]);
      }
    }
    // The kit read the appeal (for the length) and never put what it holds into a post.
    expect(k.state.gets).toEqual([(e as { appealId: string }).appealId]);
  });

  it('a post pings no one: appeals are not severe pings, and allowed_mentions parses nothing', async () => {
    const k = fakeKit();
    const subject = sid();
    const e = created(subject, { rule: 1 });
    withAppeal(k, e);
    const { d } = start(k, { mentionRoleId: ROLE });
    await k.emit(e);
    await k.emit(decided(subject, 'revoke', { rule: 1 }));
    await settle();
    for (const call of d.calls) {
      expect(String(call.body.content)).not.toContain('<@&');
      expect(call.body.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it('severeOnly keeps only appeals on severe rules (rule 1 by default), created and decided; other rules, none and uncovered are skipped', async () => {
    const k = fakeKit();
    const subject = sid();
    const { d } = start(k, { severeOnly: true });
    for (const rule of [2, 4, null, 'uncovered'] as const) {
      const e = created(subject, { rule });
      withAppeal(k, e);
      await k.emit(e);
      await k.emit(decided(subject, 'uphold', { rule }));
    }
    await settle();
    expect(d.calls).toHaveLength(0);
    const severe = created(subject, { rule: 1 });
    withAppeal(k, severe);
    await k.emit(severe);
    await k.emit(decided(subject, 'revoke', { rule: 1 }));
    await settle();
    expect(d.calls).toHaveLength(2);
    expect(contents(d.calls)[0]).toContain('Rule 1.');
  });

  it('severeOnly follows profile.severeRules', async () => {
    const k = fakeKit();
    k.state.severeRules = [2];
    const subject = sid();
    const { d } = start(k, { severeOnly: true });
    await k.emit(decided(subject, 'uphold', { rule: 1 }));
    await k.emit(decided(subject, 'uphold', { rule: 2 }));
    await settle();
    expect(d.calls).toHaveLength(1);
  });

  it('without severeOnly every appeal posts, whatever the rule', async () => {
    const k = fakeKit();
    const subject = sid();
    const { d } = start(k);
    for (const rule of [1, 2, 4, null, 'uncovered'] as const) await k.emit(decided(subject, 'uphold', { rule }));
    await settle();
    expect(d.calls).toHaveLength(5);
  });

  it('the message fits the post limit (2000 characters), with the head and the link intact', async () => {
    const k = fakeKit();
    const subject = sid();
    const e = created(subject, { rule: 2 });
    withAppeal(k, e);
    const long = (path: string) => `https://hub.example.test/${path}/${'x'.repeat(400)}`;
    const { d } = start(k, { hubLink: (kind, id) => long(`${kind}/${encodeURIComponent(id)}`).slice(0, 480) });
    await k.emit(e);
    await settle();
    const text = String(d.calls[0]?.body.content);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('Appeal filed against a 24-hour chat restriction, Rule 2.');
    expect(text).toContain('[Open in the hub](<https://hub.example.test/');
  });

  it('a hub link that cannot be used drops the link and keeps the post', async () => {
    const k = fakeKit();
    const e = created(sid());
    withAppeal(k, e);
    const { d, logged } = start(k, { hubLink: () => 'javascript:alert(1)' });
    await k.emit(e);
    await settle();
    expect(String(d.calls[0]?.body.content)).toBe('Appeal filed against a 24-hour chat restriction, Rule 2.');
    expect(logged.map(([ev]) => ev)).toContain('chatwarden.discord_link_dropped');
  });

  it('an appeal for a person the kit cannot name goes to the shared thread', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit({ type: 'appeal.decided', appealId: 'a1', at: NOW, target: '', outcome: 'uphold', rule: 2 } as KitEvent);
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(String(d.calls[0]?.body.thread_name)).toBe('Unattributed reports');
  });

  it('rename.required is ignored: nothing is posted, nothing is logged, and the feed does not even listen for it', async () => {
    const k = fakeKit();
    const { d, logged } = start(k);
    expect([...k.listeners].map((l) => l.type)).not.toContain('rename.required');
    expect([...k.listeners].map((l) => l.type)).toEqual(expect.arrayContaining(['appeal.created', 'appeal.decided']));
    await k.emit(rename(sid()));
    await settle();
    expect(d.calls).toHaveLength(0);
    expect(logged).toEqual([]);
  });

  it('a throwing kit never reaches the caller: the listener is fenced', async () => {
    const k = fakeKit();
    (k.kit as unknown as { people: { canonical: () => never } }).people.canonical = () => {
      throw new TypeError('people down');
    };
    const { d, logged } = start(k);
    await expect(k.emit(created(sid()))).resolves.toBeUndefined();
    await settle();
    expect(d.calls).toHaveLength(0);
    expect(logged).toContainEqual(['chatwarden.discord_failed', { op: 'appeal.created', error: 'TypeError' }]);
  });

  it('after dispose nothing posts', async () => {
    const k = fakeKit();
    const { d, feed } = start(k);
    feed.dispose();
    await k.emit(created(sid()));
    await settle();
    expect(d.calls).toHaveLength(0);
    expect(k.listeners.size).toBe(0);
  });
});

describe('a moot closure posts nothing', () => {
  const alice: RawWho = { clientKey: 'key-alice-appeal', ip: '198.51.100.1' };
  const bob: RawWho = { clientKey: 'key-bob-appeal', ip: '198.51.100.2' };
  const idle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
  };

  async function realKit() {
    const store = withMemoryAppeals(new MemoryStore());
    const clock = { now: () => Date.now() };
    const cw = await createChatwarden({
      store,
      secret: 'appeal-feed-secret',
      platform: { identify: (ctx: unknown) => ctx as RawWho },
      clock,
      logger: { warn: () => undefined },
      retention: false,
      overrides: { appeals: { enabled: true } },
    } as never);
    cw.rooms.seat('room-f', 'a', alice, HANDLE);
    cw.rooms.seat('room-f', 'b', bob, 'Bob');
    cw.chat.accept('room-f', 'a', 'a line');
    const sub = await cw.reports.submit({ roomId: 'room-f', reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    if (!sub.ok) throw new Error('report refused');
    const target = cw.rooms.subjectAt('room-f', 'a') as string;
    const res = await cw.decide({ reportId: sub.reportId, verdict: 'upheld', actor: 'mod_ann', reason: REASON, actions: [{ subject: target, kind: 'chat', durationMs: DAY, rule: 2, lineIds: [] }] } as never);
    if (!res.ok) throw new Error('decide refused');
    const g = res.groups[0];
    const d = fakeDiscord();
    discordFeed(cw, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, clock, logger: { warn: () => undefined } });
    return { cw, d, target, group: g as NonNullable<typeof g>, store };
  }

  it('the real kit: filing posts, deciding posts, and the real events carry no statement, reason or handle', async () => {
    const { cw, d, target, group } = await realKit();
    const filed = cw.appeals.file(alice, { noticeId: group.noticeId as string, statement: STATEMENT });
    if (!filed.ok) throw new Error('filing refused');
    await idle();
    expect(d.calls).toHaveLength(1);
    expect(contents(d.calls)[0]).toContain('Appeal filed against a 24-hour chat restriction, Rule 2.');
    const done = await cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'reduce', actor: 'senior_bea', reason: REASON, to: { kind: 'chat', durationMs: H } });
    expect(done.ok).toBe(true);
    await idle();
    expect(d.calls).toHaveLength(2);
    expect(contents(d.calls)[1]).toContain('Appeal decided: lighter.');
    expect(d.creates()).toHaveLength(1);
    for (const call of d.calls) {
      for (const text of visibleTexts(call.body)) expect(leaks(text, [STATEMENT, REASON, HANDLE, target, filed.appeal.id, 'mod_ann', 'senior_bea']), text).toEqual([]);
    }
  });

  it('an appeal made moot by someone else revoking the sanction announces no decision', async () => {
    const { cw, d, group } = await realKit();
    const filed = cw.appeals.file(alice, { noticeId: group.noticeId as string, statement: STATEMENT });
    if (!filed.ok) throw new Error('filing refused');
    await idle();
    expect(d.calls).toHaveLength(1);
    expect(await cw.sanctions.revoke(group.groupId, 'senior_cy', REASON)).toBe(true);
    await idle();
    expect(cw.appeals.list({ status: 'all' }).items).toEqual([]);
    expect(d.calls.map((c) => String(c.body.content)).filter((t) => t.includes('Appeal decided'))).toEqual([]);
    // Still only the filing's post, plus the lift (a sanction revoke is its own event).
    expect(contents(d.calls).filter((t) => t.includes('Appeal'))).toHaveLength(1);
  });

  it('a decision that finds the sanction gone (moot) announces nothing either', async () => {
    const { cw, d, group, store } = await realKit();
    const filed = cw.appeals.file(alice, { noticeId: group.noticeId as string, statement: STATEMENT });
    if (!filed.ok) throw new Error('filing refused');
    await idle();
    // A revoke outside the kit: the appeal is still open until someone decides it, and then it is moot.
    store.revokeSanctionGroup(group.groupId, 'someone', Date.now(), 'direct');
    expect(await cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'uphold', actor: 'senior_bea', reason: REASON })).toEqual({ ok: false, error: 'gone' });
    await idle();
    expect(contents(d.calls).filter((t) => t.includes('Appeal decided'))).toEqual([]);
  });

  it('a refusal (not the decider, already decided) announces nothing', async () => {
    const { cw, d, group } = await realKit();
    const filed = cw.appeals.file(alice, { noticeId: group.noticeId as string, statement: STATEMENT });
    if (!filed.ok) throw new Error('filing refused');
    await idle();
    expect(await cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'uphold', actor: 'mod_ann', reason: REASON })).toEqual({ ok: false, error: 'same_decider' });
    expect(await cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'bogus' as never, actor: 'senior_bea', reason: REASON })).toEqual({ ok: false, error: 'invalid' });
    await idle();
    expect(contents(d.calls).filter((t) => t.includes('Appeal decided'))).toEqual([]);
  });
});

describe('the feed never holds statement text: it reads the sanction of an appeal and nothing else', () => {
  it('FeedKit.appeals.get is typed to answer the sanction only, so a kit has no statement to hand the feed', () => {
    type Read = NonNullable<ReturnType<NonNullable<FeedKit['appeals']>['get']>>;
    expectTypeOf<keyof Read>().toEqualTypeOf<'sanction'>();
    expectTypeOf<keyof Read['sanction']>().toEqualTypeOf<'kind' | 'startsAt' | 'endsAt'>();
    // a kit that answers only the sanction satisfies the type; a real Chatwarden (which answers more) still does
    const narrow: NonNullable<FeedKit['appeals']> = { get: () => ({ sanction: { kind: 'chat', startsAt: 1, endsAt: 2 } }) };
    expect(narrow.get('x')).toEqual({ sanction: { kind: 'chat', startsAt: 1, endsAt: 2 } });
    expectTypeOf<Awaited<ReturnType<typeof createChatwarden>>['appeals']>().toMatchTypeOf<NonNullable<FeedKit['appeals']>>();
  });

  it('at run time the feed reads only sanction.kind, startsAt and endsAt: the statement, the decision and the ids are never touched', async () => {
    const k = fakeKit();
    const e = created(sid());
    const touched: string[] = [];
    const watch = <T extends object>(label: string, target: T): T =>
      new Proxy(target, {
        get: (t, key, r) => {
          touched.push(`${label}.${String(key)}`);
          if (key === 'statement' || key === 'decided') throw new Error('the feed read what it must never read');
          return Reflect.get(t, key, r);
        },
      });
    k.kit.appeals = {
      get: () =>
        watch('appeal', {
          sanction: watch('sanction', { groupId: id22(), kind: 'chat', startsAt: NOW, endsAt: NOW + DAY, decidedBy: 'mod_ann' }),
          statement: STATEMENT,
          decided: { by: 'senior_bea', reason: REASON },
        }) as never,
    };
    const { d, logged } = start(k);
    await k.emit(e);
    await k.emit(decided(sid(), 'reduce'));
    await settle();
    expect(contents(d.calls)[0]).toContain('Appeal filed against a 24-hour chat restriction, Rule 2.');
    expect(new Set(touched)).toEqual(new Set(['appeal.sanction', 'sanction.endsAt', 'sanction.startsAt']));
    expect(logged).toEqual([]);
    expect(leaks(JSON.stringify(d.calls), [STATEMENT, REASON, 'mod_ann', 'senior_bea']), 'no post').toEqual([]);
  });
});
