import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordThreadRow, KitEvent, Logger } from '@chatwarden/core';
import { QUEUE_MAX, discordFeed } from '../src/feed.js';
import type { DiscordFeedOptions, FeedKit } from '../src/feed.js';
import { INJECTIONS, NOW, ROLE, TOKEN, WEBHOOK, fakeDiscord, leaks, settle, visibleTexts, withoutLinks } from './support.js';
import type { Step } from './support.js';

const H = 3_600_000;
const DAY = 24 * H;
const LABEL_RE = /^Case [0-9A-HJKMNP-TV-Z]{5}$/;
const ZW = '\u200B';

const CHAT = 'CHAT-LINE-TEXT you are awful';
const HANDLE = 'HANDLE-OF-THE-REPORTED';
const NOTE = 'REPORTER-NOTE-TEXT';

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

interface FakeReport {
  id: string;
  category: string;
  targetPerson: string;
  targetHandle: string;
  note: string;
  excerpt: Array<{ raw: string; handle: string }>;
  conductLevel?: string;
}

const RULES = [
  { number: 1, title: 'No hate', text: 'No hate.' },
  { number: 2, title: 'Respect others', text: 'Be kind.' },
  { number: 4, title: 'No spam', text: 'No spam.' },
];

/** A kit with only what the feed uses: every event can be raised, every dependency broken on demand. */
function fakeKit() {
  const listeners = new Set<{ type: string; fn: (e: KitEvent) => unknown }>();
  const threads = new Map<string, DiscordThreadRow>();
  const merged = new Map<string, string>();
  const staff = new Map<string, FakeReport>();
  const state = {
    severeRules: undefined as number[] | undefined,
    rules: RULES as Array<{ number: number; title: string; text: string }>,
    failGet: false,
    failPut: false,
    failReports: false,
    puts: [] as DiscordThreadRow[],
  };
  const canonical = (id: string): string => {
    let cur = id;
    while (merged.has(cur)) cur = merged.get(cur) as string;
    return cur;
  };
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      const entry = { type, fn };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    reports: {
      get: (id: string) => {
        if (state.failReports) throw new RangeError('reports down');
        return staff.get(id) ?? null;
      },
    },
    profile: {
      get severeRules() {
        return state.severeRules;
      },
    },
    rules: { all: () => state.rules },
    limits: { strikes: { firstMs: H, repeatMs: DAY } },
    people: {
      canonical,
      aliases: (id: string) => {
        const root = canonical(id);
        return [root, ...[...merged.keys()].filter((k) => canonical(k) === root)].sort();
      },
    },
    discordThreads: {
      get: (subject: string) => {
        if (state.failGet) throw new RangeError('db down');
        const row = threads.get(subject);
        return row === undefined ? null : { ...row };
      },
      put: (row: DiscordThreadRow) => {
        if (state.failPut) throw new RangeError('db down');
        threads.set(row.subject, { ...row });
        state.puts.push({ ...row });
      },
    },
  };
  /** Raise an event the way the bus does, but let a throw or a rejection through so a test can see it. */
  const emit = async (e: KitEvent): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const l of [...listeners]) if (l.type === '*' || l.type === e.type) results.push(l.fn(e));
    await Promise.all(results);
    return results;
  };
  const addReport = (over: Partial<FakeReport> & { targetPerson: string }): FakeReport => {
    const r: FakeReport = {
      id: id22(),
      category: 'harassment',
      targetHandle: HANDLE,
      note: NOTE,
      excerpt: [{ raw: CHAT, handle: HANDLE }],
      ...over,
    };
    staff.set(r.id, r);
    return r;
  };
  return { kit: kit as unknown as FeedKit, listeners, threads, merged, staff, state, emit, addReport };
}
type Kit = ReturnType<typeof fakeKit>;

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

function start(k: Kit, plan?: (n: number) => Step | undefined, options: Partial<DiscordFeedOptions> = {}) {
  const d = fakeDiscord(plan);
  const logged: Logged = [];
  const logger: Logger = { warn: (e, detail) => void logged.push([e, detail]) };
  const feed = discordFeed(k.kit, {
    webhookUrl: WEBHOOK,
    hubLink,
    fetch: d.fetch,
    logger,
    random: () => 0.5,
    ...options,
  });
  return { feed, d, logged };
}

const created = (reportId: string, category = 'harassment'): KitEvent =>
  ({ type: 'report.created', reportId, createdAt: NOW, category, roomTags: { mode: 'ranked' } }) as KitEvent;
const closed = (reportId: string, verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith' = 'upheld'): KitEvent => ({
  type: 'report.closed',
  reportId,
  verdict,
  at: NOW,
});
let refN = 0;
const applied = (target: string, over: Partial<Extract<KitEvent, { type: 'sanction.applied' }>> = {}): Extract<KitEvent, { type: 'sanction.applied' }> => ({
  type: 'sanction.applied',
  groupId: id22(),
  refCode: `M-AB${String(10 + ++refN).padStart(3, 'C')}`,
  kind: 'chat',
  until: NOW + 7 * DAY,
  rule: 2,
  source: 'moderator',
  automated: false,
  target,
  ...over,
});

const auto = (subject: string, over: Record<string, unknown> = {}): KitEvent =>
  ({ type: 'auto.restricted', groupId: id22(), refCode: 'M-AUTO1', second: false, subject, ...over }) as KitEvent;
const lifted = (subject: string, over: Record<string, unknown> = {}): KitEvent =>
  ({ type: 'sanction.revoked', groupId: id22(), refCode: 'M-LIFT1', at: NOW, subject, rule: 2, ...over }) as KitEvent;
const gapEv = (subject: string, over: Record<string, unknown> = {}): KitEvent =>
  ({ type: 'gap.created', groupId: id22(), refCode: 'M-GAP01', at: NOW, subject, ...over }) as KitEvent;

const contents = (calls: Array<{ body: Record<string, unknown> }>): string[] => calls.map((c) => String(c.body.content));

describe('construction', () => {
  const build = (over: Record<string, unknown>) => () => discordFeed(fakeKit().kit, { webhookUrl: WEBHOOK, hubLink, fetch: fakeDiscord().fetch, ...over } as never);

  it('accepts the minimal options and a snowflake role', () => {
    expect(build({})).not.toThrow();
    expect(build({ mentionRoleId: ROLE, severeOnly: true })).not.toThrow();
  });

  it.each([
    ['a missing webhookUrl', { webhookUrl: undefined }],
    ['an http webhookUrl', { webhookUrl: WEBHOOK.replace('https', 'http') }],
    ['a non-Discord host', { webhookUrl: WEBHOOK.replace('discord.com', 'example.com') }],
    ['a hubLink that is not a function', { hubLink: 'https://hub.example.test' }],
    ['a role id that is not digits', { mentionRoleId: 'everyone' }],
    ['a role id that is too short', { mentionRoleId: '12345' }],
    ['a role mention string', { mentionRoleId: `<@&${ROLE}>` }],
    ['a numeric role id', { mentionRoleId: Number('987654321098765432') }],
    ['a severeOnly that is not a boolean', { severeOnly: 'yes' }],
  ])('throws RangeError for %s, without echoing the webhook', (_n, over) => {
    let error: unknown;
    try {
      build(over)();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('throws RangeError for options that are not an object', () => {
    expect(() => discordFeed(fakeKit().kit, null as never)).toThrow(RangeError);
    expect(() => discordFeed(fakeKit().kit, undefined as never)).toThrow(RangeError);
  });

  it('a bad option subscribes nothing', () => {
    const k = fakeKit();
    expect(() => discordFeed(k.kit, { webhookUrl: 'nope', hubLink } as never)).toThrow(RangeError);
    expect(k.listeners.size).toBe(0);
  });

  it('subscribes to the eight event types (the six staff ones and the two appeal ones), once each, and not to rename.required', () => {
    const k = fakeKit();
    start(k);
    expect([...k.listeners].map((l) => l.type).sort()).toEqual([
      'appeal.created',
      'appeal.decided',
      'auto.restricted',
      'gap.created',
      'report.closed',
      'report.created',
      'sanction.applied',
      'sanction.revoked',
    ]);
  });
});

describe('threads: one per reported person', () => {
  it('opens a thread on the first report, named with a random neutral label, and stores it', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(d.calls).toHaveLength(1);
    const call = d.calls[0]!;
    expect(call.href).toBe(`${WEBHOOK}?wait=true`);
    const name = String(call.body.thread_name);
    expect(name).toMatch(LABEL_RE);
    expect(k.threads.get(subject)).toEqual({ subject, threadId: 'T1', label: name, createdAt: NOW });
  });

  it('the label is not derived from the subject, the handle or any id', async () => {
    const k = fakeKit();
    const names = new Set<string>();
    const { d } = start(k);
    for (let i = 0; i < 12; i++) {
      const r = k.addReport({ targetPerson: sid() });
      await k.emit(created(r.id));
    }
    await settle();
    for (const c of d.creates()) names.add(String(c.body.thread_name));
    expect(d.creates()).toHaveLength(12);
    for (const n of names) expect(n).toMatch(LABEL_RE);
    // Random: twelve people get (almost surely) more than one distinct label.
    expect(names.size).toBeGreaterThan(8);
  });

  it('the first message of the thread is the report itself', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(d.calls[0]!.body.content).toContain('**New report**');
  });

  it('later reports and outcomes about the same person post into that thread; no second thread', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject, category: 'spam' });
    const { d } = start(k);
    await k.emit(created(a.id));
    await settle();
    await k.emit(created(b.id, 'spam'));
    await k.emit(closed(a.id));
    await k.emit(applied(subject));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(3);
    for (const p of d.posts()) expect(p.url.searchParams.get('thread_id')).toBe('T1');
  });

  it('different people get different threads', async () => {
    const k = fakeKit();
    const a = k.addReport({ targetPerson: sid() });
    const b = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(a.id));
    await k.emit(created(b.id));
    await settle();
    expect(d.creates()).toHaveLength(2);
    expect(d.posts()).toHaveLength(0);
    expect(k.threads.size).toBe(2);
  });

  it('survives a restart: a new feed on the same store posts into the stored thread and creates nothing', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const first = start(k);
    await k.emit(created(a.id));
    await settle();
    first.feed.dispose();
    const second = start(k);
    await k.emit(created(b.id));
    await settle();
    expect(second.d.creates()).toHaveLength(0);
    expect(second.d.posts()).toHaveLength(1);
    expect(second.d.posts()[0]!.url.searchParams.get('thread_id')).toBe('T1');
  });

  it('a stored label is reused when the thread is re-created after Discord lost it', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const { d } = start(k, (n) => (n === 1 ? { status: 404, json: { code: 10003 } } : undefined));
    await k.emit(created(a.id));
    await settle();
    const label = k.threads.get(subject)!.label;
    await k.emit(created(b.id));
    await settle();
    // create, post (gone), create again with the same message and the same label.
    expect(d.calls).toHaveLength(3);
    expect(d.calls[2]!.body.thread_name).toBe(label);
    expect(d.calls[2]!.body.content).toBe(d.calls[1]!.body.content);
    expect(k.threads.get(subject)).toMatchObject({ threadId: 'T2', label });
  });

  it('a gone thread is re-created once only: a failure on the reopen is given up on, not looped', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const { d } = start(k, (n) => (n === 1 ? { status: 404, json: { code: 10003 } } : n === 2 ? 400 : undefined));
    await k.emit(created(a.id));
    await settle();
    await k.emit(created(b.id));
    await settle(120_000);
    expect(d.calls).toHaveLength(3);
    expect(k.threads.get(subject)?.threadId).toBe('T1');
  });

  it('a 404 about the webhook itself (code 10015) is not a gone thread: the map is kept and nothing is re-created', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const { d } = start(k, (n) => (n === 1 ? { status: 404, json: { code: 10015 } } : undefined));
    await k.emit(created(a.id));
    await settle();
    await k.emit(created(b.id));
    await settle(60_000);
    expect(d.creates()).toHaveLength(1);
    expect(k.threads.get(subject)?.threadId).toBe('T1');
  });

  it('a thread that could not be opened is not stored: the next event tries again', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const { d } = start(k, (n) => (n === 0 ? 400 : undefined));
    await k.emit(created(a.id));
    await settle();
    expect(k.threads.size).toBe(0);
    await k.emit(created(b.id));
    await settle();
    expect(d.creates()).toHaveLength(2);
    expect(k.threads.get(subject)?.threadId).toBe('T1');
  });
});

describe('concurrency: two events for one person in flight', () => {
  it('create exactly one thread and keep the posts in order', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject, category: 'spam' });
    const { d } = start(k);
    void k.emit(created(a.id));
    void k.emit(created(b.id, 'spam'));
    void k.emit(applied(subject));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(2);
    expect(d.calls[0]!.body.content).toContain('Harassment');
    expect(d.calls[1]!.body.content).toContain('Spam');
    expect(d.calls[2]!.body.content).toContain('Sanction applied');
  });

  it('create one thread even when the first create is slow (retried after a 429)', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const { d } = start(k, (n) => (n === 0 ? { status: 429, json: { retry_after: 5 } } : undefined));
    void k.emit(created(a.id));
    await settle(100);
    void k.emit(created(b.id));
    await settle(10_000);
    expect(d.creates()).toHaveLength(2); // the 429 and its retry: the same create
    expect(d.creates()[0]!.body.thread_name).toBe(d.creates()[1]!.body.thread_name);
    expect(d.posts()).toHaveLength(1);
    expect(k.threads.size).toBe(1);
  });

  it('events for an alias and for its canonical person share one thread', async () => {
    const k = fakeKit();
    const root = sid();
    const alias = sid();
    k.merged.set(alias, root);
    const r = k.addReport({ targetPerson: root });
    const { d } = start(k);
    void k.emit(applied(alias));
    void k.emit(created(r.id));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(1);
    expect([...k.threads.keys()]).toEqual([root]);
  });

  it('different people proceed independently (a 429 is the webhook-wide wait, not a deadlock)', async () => {
    const k = fakeKit();
    const a = k.addReport({ targetPerson: sid() });
    const b = k.addReport({ targetPerson: sid() });
    const { d } = start(k, (n) => (n === 0 ? { status: 429, json: { retry_after: 1 } } : undefined));
    void k.emit(created(a.id));
    void k.emit(created(b.id));
    await settle(2000);
    expect(k.threads.size).toBe(2);
    expect(d.creates()).toHaveLength(3);
  });
});

describe('merged people', () => {
  it('an event for an alias looks up the canonical person', async () => {
    const k = fakeKit();
    const root = sid();
    const alias = sid();
    k.merged.set(alias, root);
    k.threads.set(root, { subject: root, threadId: 'TR', label: 'Case AAAAA', createdAt: 1 });
    const { d } = start(k);
    await k.emit(applied(alias));
    await settle();
    expect(d.creates()).toHaveLength(0);
    expect(d.posts()[0]!.url.searchParams.get('thread_id')).toBe('TR');
    expect(d.posts()[0]!.body.content).toContain(`https://hub.example.test/person/${root}`);
  });

  it('a canonical person with no thread reuses the alias thread and the map is repointed', async () => {
    const k = fakeKit();
    const root = sid();
    const alias = sid();
    k.merged.set(alias, root);
    k.threads.set(alias, { subject: alias, threadId: 'TA', label: 'Case BBBBB', createdAt: 5 });
    const r = k.addReport({ targetPerson: root });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(d.creates()).toHaveLength(0);
    expect(d.posts()[0]!.url.searchParams.get('thread_id')).toBe('TA');
    expect(k.threads.get(root)).toMatchObject({ threadId: 'TA', label: 'Case BBBBB' });
  });

  it('when both have threads the canonical one wins and the alias one is left alone', async () => {
    const k = fakeKit();
    const root = sid();
    const alias = sid();
    k.merged.set(alias, root);
    k.threads.set(alias, { subject: alias, threadId: 'TA', label: 'Case BBBBB', createdAt: 5 });
    k.threads.set(root, { subject: root, threadId: 'TR', label: 'Case AAAAA', createdAt: 9 });
    const r = k.addReport({ targetPerson: root });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(d.posts()[0]!.url.searchParams.get('thread_id')).toBe('TR');
    expect(k.threads.get(alias)?.threadId).toBe('TA');
  });

  it('a merge after the thread exists: the next event finds it through the alias, once', async () => {
    const k = fakeKit();
    const a = sid();
    const b = sid();
    const r1 = k.addReport({ targetPerson: a });
    const { d } = start(k);
    await k.emit(created(r1.id));
    await settle();
    k.merged.set(a, b);
    const r2 = k.addReport({ targetPerson: b });
    await k.emit(created(r2.id));
    await k.emit(created(r2.id));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(2);
    expect(k.threads.get(b)?.threadId).toBe('T1');
    expect(k.state.puts.filter((p) => p.subject === b)).toHaveLength(1);
  });
});

describe('shared threads', () => {
  it('a report whose target is unknown goes to one shared "Unattributed reports" thread', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(created('gone-report-1'));
    await k.emit(created('gone-report-2'));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.creates()[0]!.body.thread_name).toBe('Unattributed reports');
    expect(d.posts()).toHaveLength(1);
    expect(d.calls[0]!.body.content).toContain('**New report**');
  });

  it('a report with an empty target does too, and the thread is remembered across a restart', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: '' });
    const a = start(k);
    await k.emit(created(r.id));
    await settle();
    a.feed.dispose();
    const b = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(a.d.creates()[0]!.body.thread_name).toBe('Unattributed reports');
    expect(b.d.creates()).toHaveLength(0);
    expect(b.d.posts()).toHaveLength(1);
  });

  it('a report lookup that throws is treated as an unknown target and logged by class', async () => {
    const k = fakeKit();
    k.state.failReports = true;
    const { d, logged } = start(k);
    await k.emit(created('r-x'));
    await settle();
    expect(d.creates()[0]!.body.thread_name).toBe('Unattributed reports');
    expect(logged).toContainEqual(['chatwarden.discord_failed', { op: 'report.created', error: 'RangeError' }]);
  });

  it('auto timeouts, lifts and gaps with no usable subject go to the shared "Unattributed reports" thread (no "Moderation log")', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(auto(''));
    await k.emit(lifted(undefined as never));
    await k.emit(gapEv(7 as never));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.creates()[0]!.body.thread_name).toBe('Unattributed reports');
    expect(d.posts()).toHaveLength(2);
    for (const c of d.calls) expect(String(c.body.content)).not.toContain('Open person');
  });

  it("auto timeouts, lifts and gaps with a subject go to that person's thread with no memory of the apply (also after a restart)", async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const a = start(k);
    await k.emit(created(r.id));
    await settle();
    a.feed.dispose();
    const b = start(k);
    await k.emit(auto(subject));
    await k.emit(lifted(subject));
    await k.emit(gapEv(subject));
    await settle();
    expect(b.d.creates()).toHaveLength(0);
    expect(b.d.posts()).toHaveLength(3);
    for (const c of b.d.posts()) {
      expect(c.url.searchParams.get('thread_id')).toBe('T1');
      expect(String(c.body.content)).toContain(`[Open person](<https://hub.example.test/person/${subject}>)`);
    }
  });

  it('a person with no thread yet gets one opened by an auto timeout, a lift or a gap', async () => {
    for (const ev of [auto, lifted, gapEv]) {
      const k = fakeKit();
      const subject = sid();
      const { d } = start(k);
      await k.emit(ev(subject));
      await settle();
      expect(d.creates()).toHaveLength(1);
      expect(String(d.creates()[0]!.body.thread_name)).toMatch(LABEL_RE);
      expect(k.threads.has(subject)).toBe(true);
    }
  });

  it('these three events use the canonical person: an alias subject lands in the canonical thread', async () => {
    const k = fakeKit();
    const root = sid();
    const alias = sid();
    k.merged.set(alias, root);
    k.threads.set(root, { subject: root, threadId: 'TR', label: 'Case AAAAA', createdAt: 1 });
    const { d } = start(k);
    await k.emit(auto(alias));
    await k.emit(lifted(alias));
    await k.emit(gapEv(alias));
    await settle();
    expect(d.creates()).toHaveLength(0);
    for (const c of d.posts()) {
      expect(c.url.searchParams.get('thread_id')).toBe('TR');
      expect(String(c.body.content)).toContain(`/person/${root}>`);
    }
  });
});

describe('content', () => {
  it('report.created states the category, rule, and hub links, and nothing else', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text).toContain('**New report**');
    expect(text).toContain('Category: Harassment');
    expect(text).toContain('Rule: Community Rule 2 (Respect others)');
    expect(text).toContain(`[Open report](<https://hub.example.test/report/${r.id}>)`);
    expect(text).toContain(`[Open person](<https://hub.example.test/person/${subject}>)`);
    expect(text).not.toContain('Conduct level');
    expect(text).not.toContain('<@&');
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it.each([
    ['harassment', 'Harassment', 'Community Rule 2'],
    ['hate', 'Hate speech', 'Community Rule 1'],
    ['spam', 'Spam', 'Community Rule 4'],
    ['cheating', 'Cheating', 'Community Rule 5'],
    ['disruption', 'Disruption', 'Community Rule 6'],
  ])('labels the %s category', async (category, label, rule) => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category });
    const { d } = start(k);
    await k.emit(created(r.id, category));
    await settle();
    expect(d.calls[0]!.body.content).toContain(`Category: ${label}`);
    expect(d.calls[0]!.body.content).toContain(`Rule: ${rule}`);
  });

  it('the "other" category has no rule yet, so no rule line', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'other' });
    const { d } = start(k);
    await k.emit(created(r.id, 'other'));
    await settle();
    expect(d.calls[0]!.body.content).toContain('Category: Other');
    expect(d.calls[0]!.body.content).not.toContain('Rule:');
  });

  it('a rule number the registry does not list is shown by number alone', async () => {
    const k = fakeKit();
    k.state.rules = [];
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(d.calls[0]!.body.content).toContain('Rule: Community Rule 2\n');
  });

  it('shows the conduct level when the staff report carries a known one, and ignores an unknown one', async () => {
    const k = fakeKit();
    const a = k.addReport({ targetPerson: sid(), conductLevel: 'hostile' });
    const b = k.addReport({ targetPerson: sid(), conductLevel: 'EVIL **x**' });
    const { d } = start(k);
    await k.emit(created(a.id));
    await k.emit(created(b.id));
    await settle();
    expect(d.calls[0]!.body.content).toContain('Conduct level: hostile');
    expect(d.calls[1]!.body.content).not.toContain('Conduct level');
    expect(d.calls[1]!.body.content).not.toContain('EVIL');
  });

  it.each([
    ['upheld', 'Upheld'],
    ['noted', 'Noted'],
    ['no_action', 'No action'],
    ['bad_faith', 'Dismissed as bad faith'],
  ] as const)('report.closed %s reads "%s"', async (verdict, label) => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(r.id));
    await k.emit(closed(r.id, verdict));
    await settle();
    const text = String(d.posts()[0]!.body.content);
    expect(text).toContain(`**Report closed** · ${label}`);
    expect(text).toContain('Category: Harassment');
    expect(text).toContain(`<https://hub.example.test/report/${r.id}>`);
  });

  it('report.closed for a report that cannot be read posts to the unattributed thread', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(closed('missing-report'));
    await settle();
    expect(d.creates()[0]!.body.thread_name).toBe('Unattributed reports');
    expect(d.calls[0]!.body.content).toContain('**Report closed** · Upheld');
  });

  it.each([
    ['chat', 'Chat restriction'],
    ['area', 'Area ban'],
    ['ban', 'Ban'],
    ['warning', 'Warning'],
    ['note', 'Note'],
  ] as const)('sanction.applied names a %s as "%s", with the ref code and the rule', async (kind, label) => {
    const k = fakeKit();
    const subject = sid();
    const { d } = start(k);
    await k.emit(applied(subject, { kind, refCode: 'M-QX7K2', until: kind === 'warning' || kind === 'note' ? null : NOW + 7 * DAY }));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text).toContain(`**Sanction applied** · ${label}`);
    expect(text).toContain('Ref: M-QX7K2');
    expect(text).toContain('Rule: Community Rule 2 (Respect others)');
    expect(text).toContain(`[Open person](<https://hub.example.test/person/${subject}>)`);
  });

  it.each([
    [7 * DAY, '7 days'],
    [30 * DAY, '30 days'],
    [DAY, '24 hours'],
    [H, '1 hour'],
    [90 * 60_000, '1 hour 30 minutes'],
    [15 * 60_000, '15 minutes'],
    [2 * DAY + H, '2 days 1 hour'],
    [7 * DAY - 40, '7 days'],
    [10_000, 'under a minute'],
  ])('writes a duration of %i ms as "%s"', async (ms, label) => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(applied(sid(), { until: NOW + ms }));
    await settle();
    expect(d.calls[0]!.body.content).toContain(`Chat restriction · ${label}`);
  });

  it('a permanent ban says so; a warning or a note never shows a duration', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(applied(sid(), { kind: 'ban', until: null }));
    await k.emit(applied(sid(), { kind: 'warning', until: null }));
    await k.emit(applied(sid(), { kind: 'note', until: null }));
    await settle();
    expect(d.calls[0]!.body.content).toContain('Ban · permanent');
    expect(d.calls[1]!.body.content).not.toMatch(/permanent|day|hour|minute/);
    expect(d.calls[2]!.body.content).not.toMatch(/permanent|day|hour|minute/);
  });

  it('an automated sanction says so, and a rule that is not covered says that', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(applied(sid(), { automated: true, source: 'ai', rule: 'uncovered' }));
    await settle();
    expect(d.calls[0]!.body.content).toContain('Applied automatically.');
    expect(d.calls[0]!.body.content).toContain('Rule: No Community Rule yet');
  });

  it('auto.restricted posts "Automatic timeout" with the duration and the ref code', async () => {
    const k = fakeKit();
    const { d } = start(k);
    const subject = sid();
    await k.emit(auto(subject, { refCode: 'M-AUT01' }));
    await k.emit(auto(subject, { refCode: 'M-AUT02', second: true }));
    await settle();
    expect(d.calls[0]!.body.content).toContain(`[Open person](<https://hub.example.test/person/${subject}>)`);
    expect(d.calls[0]!.body.content).toContain('**Automatic timeout** · 1 hour');
    expect(d.calls[0]!.body.content).toContain('Ref: M-AUT01');
    expect(d.calls[1]!.body.content).toContain('**Automatic timeout** (repeat) · 24 hours');
    expect(d.calls[1]!.body.content).toContain('Ref: M-AUT02');
  });

  it('sanction.revoked says "Lifted" with the ref code, in the person\'s thread', async () => {
    const k = fakeKit();
    const subject = sid();
    const ev = applied(subject, { refCode: 'M-LIFT1' });
    const { d } = start(k);
    await k.emit(ev);
    await settle();
    await k.emit(lifted(subject, { groupId: ev.groupId }));
    await settle();
    expect(d.creates()).toHaveLength(1);
    const text = String(d.posts()[0]!.body.content);
    expect(text).toContain('**Lifted**');
    expect(text).toContain('Ref: M-LIFT1');
    expect(text).toContain(`<https://hub.example.test/person/${subject}>`);
  });

  it('gap.created is a short note with a hub link to the person', async () => {
    const k = fakeKit();
    const subject = sid();
    const ev = applied(subject, { rule: 'uncovered', refCode: 'M-GAP01' });
    const { d } = start(k);
    await k.emit(ev);
    await k.emit(gapEv(subject, { groupId: ev.groupId }));
    await settle();
    const text = String(d.posts()[0]!.body.content);
    expect(text).toContain('**Rule gap filed** for review');
    expect(text).toContain('Ref: M-GAP01');
    expect(text).toContain(`<https://hub.example.test/person/${subject}>`);
  });

  it('keeps the whole message under 2000 characters, shortening the facts and never the links', async () => {
    const k = fakeKit();
    k.state.rules = [{ number: 2, title: 'T'.repeat(5000), text: 'x' }];
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain(`[Open report](<https://hub.example.test/report/${r.id}>)`);
    expect(text).toContain(`[Open person](<https://hub.example.test/person/${subject}>)`);
  });
});

describe('escaping adopter text', () => {
  const TITLE = '**Hi** @everyone <@&1> [x](y) `c` ~s~ |p| >q _u_ #h';

  it('escapes Discord markdown and mention syntax in a rule title', async () => {
    const k = fakeKit();
    k.state.rules = [{ number: 2, title: TITLE, text: 'x' }];
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    const text = String(d.calls[0]!.body.content);
    const expected = `\\*\\*Hi\\*\\* @${ZW}everyone \\<@${ZW}&1\\> \\[x\\]\\(y\\) \\\`c\\\` \\~s\\~ \\|p\\| \\>q \\_u\\_ \\#h`;
    expect(text).toContain(`Community Rule 2 (${expected})`);
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('<@&1>');
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('strips control and invisible characters and collapses whitespace in adopter text', async () => {
    const k = fakeKit();
    k.state.rules = [{ number: 2, title: `A\u202Eb\u200Bc\u0007  \t d`, text: 'x' }];
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(d.calls[0]!.body.content).toContain('Community Rule 2 (Abc d)');
  });

  it('a title with a role mention cannot ping, even when a role is configured', async () => {
    const k = fakeKit();
    k.state.rules = [{ number: 2, title: `<@&${ROLE}> @here`, text: 'x' }];
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id));
    await settle();
    expect(String(d.calls[0]!.body.content)).not.toContain(`<@&${ROLE}>`);
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('a hubLink that returns something that is not an http(s) URL, or throws, loses the link and not the post', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const bad = start(k, undefined, { hubLink: () => 'javascript:alert(1)' });
    await k.emit(created(r.id));
    await settle();
    expect(bad.d.calls).toHaveLength(1);
    expect(bad.d.calls[0]!.body.content).not.toContain('javascript');
    expect(bad.d.calls[0]!.body.content).not.toContain('Open report');
    bad.feed.dispose();

    const throwing = start(k, undefined, {
      hubLink: () => {
        throw new Error('hub down');
      },
    });
    await k.emit(created(r.id));
    await settle();
    expect(throwing.d.calls).toHaveLength(1);
    expect(throwing.d.calls[0]!.body.content).toContain('**New report**');
  });

  it('a hubLink value is normalised so it cannot break out of its angle brackets', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { hubLink: (kind, id) => `https://h.test/${kind}/a b>c ${id.length}` });
    await k.emit(created(r.id));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text).toContain('(<https://h.test/report/a%20b%3Ec%2022>)');
  });
});

describe('severe: the role mention', () => {
  it('pings the role on a hate report, and only that role', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'hate' });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id, 'hate'));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text.startsWith(`<@&${ROLE}> **Severe report**`)).toBe(true);
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
  });

  it('does not ping on a non-severe report', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id));
    await settle();
    expect(String(d.calls[0]!.body.content)).not.toContain('<@&');
    expect(String(d.calls[0]!.body.content)).toContain('**New report**');
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('a severe report with no role configured is marked severe but pings nobody', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'hate' });
    const { d } = start(k);
    await k.emit(created(r.id, 'hate'));
    await settle();
    expect(String(d.calls[0]!.body.content)).toContain('**Severe report**');
    expect(String(d.calls[0]!.body.content)).not.toContain('<@&');
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('a report whose rule is in profile.severeRules is severe; the default is Community Rule 1', async () => {
    const k = fakeKit();
    k.state.severeRules = [2];
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id));
    await settle();
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
  });

  it('hate is severe even when severeRules is empty; harassment then is not', async () => {
    const k = fakeKit();
    k.state.severeRules = [];
    const h = k.addReport({ targetPerson: sid(), category: 'hate' });
    const a = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(h.id, 'hate'));
    await k.emit(created(a.id));
    await settle();
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
    expect(d.calls[1]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('a sanction under a severe rule pings; under another rule it does not', async () => {
    const k = fakeKit();
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(applied(sid(), { rule: 1 }));
    await k.emit(applied(sid(), { rule: 2 }));
    await k.emit(applied(sid(), { rule: 'uncovered' }));
    await settle();
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
    expect(String(d.calls[0]!.body.content)).toContain(`<@&${ROLE}>`);
    expect(d.calls[1]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(d.calls[2]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('closing, lifting, auto timeouts and gaps never ping', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'hate' });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id, 'hate'));
    await k.emit(closed(r.id));
    const hated = r.targetPerson;
    await k.emit(lifted(hated, { refCode: 'M-AAAAA', rule: 1 }));
    await k.emit(auto(hated, { refCode: 'M-BBBBB' }));
    await k.emit(gapEv(hated, { refCode: 'M-CCCCC' }));
    await settle();
    const pinged = d.calls.filter((c) => String(c.body.content).includes('<@&'));
    expect(pinged).toHaveLength(1);
    expect(d.calls.every((c, i) => (i === 0 ? true : (c.body.allowed_mentions as { roles?: unknown }).roles === undefined))).toBe(true);
  });
});

describe('severeOnly', () => {
  it('posts severe reports and their outcomes only', async () => {
    const k = fakeKit();
    const subject = sid();
    const mild = k.addReport({ targetPerson: subject });
    const hate = k.addReport({ targetPerson: subject, category: 'hate' });
    const { d } = start(k, undefined, { severeOnly: true });
    await k.emit(created(mild.id));
    await k.emit(closed(mild.id));
    await k.emit(applied(subject, { rule: 2 }));
    await settle();
    expect(d.calls).toHaveLength(0);
    await k.emit(created(hate.id, 'hate'));
    await k.emit(closed(hate.id));
    await k.emit(applied(subject, { rule: 1 }));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(2);
    expect(contents(d.calls).join('\n')).not.toContain('Respect others');
  });

  it('skips auto timeouts and gaps, and a closing it cannot read', async () => {
    const k = fakeKit();
    const subject = sid();
    const { d } = start(k, undefined, { severeOnly: true });
    await k.emit(auto(subject));
    await k.emit(gapEv(subject));
    await k.emit(closed('unreadable'));
    await settle();
    expect(d.calls).toHaveLength(0);
  });

  it("lifts a sanction under a severe rule and not one under another rule or none, by the event's own rule (so also after a restart)", async () => {
    const k = fakeKit();
    const subject = sid();
    const { d } = start(k, undefined, { severeOnly: true });
    await k.emit(lifted(subject, { rule: 2, refCode: 'M-MILD1' }));
    await k.emit(lifted(subject, { rule: null, refCode: 'M-NONE1' }));
    await k.emit(lifted(subject, { rule: 4, refCode: 'M-MILD2' }));
    await settle();
    expect(d.calls).toHaveLength(0);
    await k.emit(lifted(subject, { rule: 1, refCode: 'M-SEVER' }));
    await settle();
    expect(d.calls).toHaveLength(1);
    expect(String(d.calls[0]!.body.content)).toContain('M-SEVER');
  });

  it('a lift follows profile.severeRules', async () => {
    const k = fakeKit();
    k.state.severeRules = [4];
    const { d } = start(k, undefined, { severeOnly: true });
    await k.emit(lifted(sid(), { rule: 1 }));
    await k.emit(lifted(sid(), { rule: 4 }));
    await settle();
    expect(d.calls).toHaveLength(1);
  });

  it('false (the default) posts everything', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { severeOnly: false });
    await k.emit(created(r.id));
    await settle();
    expect(d.calls).toHaveLength(1);
  });
});

describe('privacy: what the visible text never contains', () => {
  async function everyEvent() {
    const k = fakeKit();
    const subject = sid();
    const other = sid();
    const r = k.addReport({ targetPerson: subject, category: 'hate' });
    const r2 = k.addReport({ targetPerson: other });
    const ev = applied(subject, { rule: 1 });
    const ev2 = applied(other, { rule: 2 });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id, 'hate'));
    await k.emit(created(r2.id));
    await k.emit(closed(r.id));
    await k.emit(closed(r2.id, 'no_action'));
    await k.emit(ev);
    await k.emit(ev2);
    await k.emit(lifted(subject, { groupId: ev.groupId, refCode: ev.refCode, rule: 1 }));
    await k.emit(gapEv(other, { groupId: ev2.groupId, refCode: ev2.refCode }));
    await k.emit(auto(subject, { refCode: 'M-AUTO9', second: true }));
    await k.emit(created('vanished-report'));
    await settle();
    const ids = [subject, other, r.id, r2.id, ev.groupId, ev2.groupId];
    return { d, ids };
  }

  it('no visible text holds a subject id, a hash, a report or group id, a handle, a note or chat text', async () => {
    const { d, ids } = await everyEvent();
    expect(d.calls.length).toBeGreaterThanOrEqual(10);
    const forbidden = [...ids, CHAT, HANDLE, NOTE, 'awful'];
    for (const c of d.calls) {
      for (const text of visibleTexts(c.body)) expect(leaks(text, forbidden)).toEqual([]);
    }
  });

  it('the ids do appear in the links (so the scan above is not vacuous)', async () => {
    const { d, ids } = await everyEvent();
    const all = d.calls.map((c) => String(c.body.content)).join('\n');
    // Subjects and report ids ride in the links; a sanction group id is never sent at all.
    for (const id of ids.slice(0, 4)) expect(all).toContain(id);
    for (const id of ids.slice(4)) expect(all).not.toContain(id);
    expect(all).toMatch(/\[Open person\]\(<https:\/\/hub\.example\.test\/person\/s_/);
  });

  it('positive control: the scan finds each kind of leak when one is planted', () => {
    const subject = sid();
    const report = id22();
    expect(leaks(`about ${subject}`)).toContain('subject-id');
    expect(leaks(`hash ${'a1'.repeat(16)}`)).toContain('hex-hash');
    expect(leaks(`report ${report}`)).toContain('opaque-id');
    expect(leaks(`they said ${CHAT}`, [CHAT])).toContain(`forbidden:${CHAT}`);
    expect(leaks(`handle ${HANDLE}`, [HANDLE])).toEqual(expect.arrayContaining([`forbidden:${HANDLE}`]));
    // ...and ids inside a link are excluded.
    expect(leaks(`[Open person](<https://hub.example.test/person/${subject}>)`, [subject])).toEqual([]);
    expect(withoutLinks(`x <https://h.test/${report}> y`)).not.toContain(report);
    // The planted leak is caught in a body the way the checks above read it.
    expect(visibleTexts({ content: `oops ${subject}`, embeds: [{ title: 't', fields: [{ name: 'n', value: report }], footer: { text: 'f' } }] }).flatMap((t) => leaks(t))).toEqual(
      expect.arrayContaining(['subject-id', 'opaque-id']),
    );
  });

  it('chat text, the handle and the reporter note never reach Discord, for any event', async () => {
    const { d } = await everyEvent();
    const wire = d.calls.map((c) => JSON.stringify(c.body)).join('\n');
    for (const secret of [CHAT, HANDLE, NOTE]) expect(wire).not.toContain(secret);
  });

  it('thread names hold no id: only the random label or a fixed shared name', async () => {
    const { d } = await everyEvent();
    for (const c of d.creates()) expect(String(c.body.thread_name)).toMatch(/^(Case [0-9A-HJKMNP-TV-Z]{5}|Unattributed reports)$/);
  });

  it('every request body is JSON with only the documented fields', async () => {
    const { d } = await everyEvent();
    for (const c of d.calls) {
      expect(Object.keys(c.body).sort()).toEqual(
        c.url.searchParams.has('thread_id') ? ['allowed_mentions', 'content', 'flags'] : ['allowed_mentions', 'content', 'flags', 'thread_name'],
      );
    }
  });
});

describe('fencing: nothing reaches the kit', () => {
  it('handlers return at once (the work is queued), so a slow Discord never delays chat.accept', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    start(k, () => 'hang');
    const results = await k.emit(created(r.id));
    expect(results).toEqual([undefined]);
  });

  it('a fetch that throws synchronously is fenced and logged by class only', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d, logged } = start(k, () => 'throw-sync');
    await expect(k.emit(created(r.id))).resolves.toBeDefined();
    await settle(120_000);
    expect(d.calls.length).toBeGreaterThan(0);
    expect(logged.length).toBeGreaterThan(0);
    const wire = JSON.stringify(logged);
    expect(wire).toContain('TypeError');
    for (const secret of [TOKEN, 'discord.com', 'sync boom', r.id]) expect(wire).not.toContain(secret);
  });

  it('a fetch that rejects is fenced, and the next event still works', async () => {
    const k = fakeKit();
    const a = k.addReport({ targetPerson: sid() });
    const b = k.addReport({ targetPerson: sid() });
    const { d } = start(k, (n) => (n < 6 ? new Error(`boom ${WEBHOOK}`) : undefined));
    await k.emit(created(a.id));
    await settle(120_000);
    await k.emit(created(b.id));
    await settle();
    expect(d.calls).toHaveLength(7);
    expect(k.threads.size).toBe(1);
  });

  it('a store read that throws is fenced: nothing is posted, nothing thrown, the class is logged', async () => {
    const k = fakeKit();
    k.state.failGet = true;
    const r = k.addReport({ targetPerson: sid() });
    const { d, logged } = start(k);
    await expect(k.emit(created(r.id))).resolves.toBeDefined();
    await settle();
    expect(d.calls).toHaveLength(0);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'report.created', error: 'RangeError' }]]);
  });

  it('a store write that throws after the thread was opened is logged, and the same process does not open a second thread', async () => {
    const k = fakeKit();
    k.state.failPut = true;
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    const { d, logged } = start(k);
    await k.emit(created(a.id));
    await settle();
    await k.emit(created(b.id));
    await settle();
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(1);
    expect(logged).toContainEqual(['chatwarden.discord_failed', { op: 'threadMap', error: 'RangeError' }]);
    expect(JSON.stringify(logged)).not.toContain(subject);
  });

  it('a throwing logger is swallowed', async () => {
    const k = fakeKit();
    k.state.failGet = true;
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, {
      logger: {
        warn: () => {
          throw new Error('logger down');
        },
      },
    });
    await expect(k.emit(created(r.id))).resolves.toBeDefined();
    await settle();
    expect(d.calls).toHaveLength(0);
  });

  it('a staff-report lookup that throws on report.closed is fenced', async () => {
    const k = fakeKit();
    k.state.failReports = true;
    const { d } = start(k);
    await expect(k.emit(closed('r-1'))).resolves.toBeDefined();
    await settle();
    expect(d.calls).toHaveLength(1);
  });

  it('an event with nonsense fields does not throw', async () => {
    const k = fakeKit();
    const { d } = start(k);
    for (const bad of [
      { type: 'sanction.applied' },
      { type: 'report.created' },
      { type: 'report.closed', reportId: 7 },
      { type: 'auto.restricted' },
      { type: 'auto.restricted', subject: 5 },
      { type: 'sanction.revoked', groupId: null },
      { type: 'sanction.revoked', rule: 'x', subject: {} },
      { type: 'gap.created' },
    ]) {
      await expect(k.emit(bad as never)).resolves.toBeDefined();
    }
    await settle();
    expect(d.calls.length).toBeLessThanOrEqual(8);
  });
});

describe('queue', () => {
  it('is bounded at 1000 waiting events: the oldest are dropped and the drops are logged as one coalesced count', async () => {
    expect(QUEUE_MAX).toBe(1000);
    const k = fakeKit();
    const { d, logged } = start(k, (n) => (n === 0 ? { status: 429, json: { retry_after: 5 } } : undefined));
    // Delivery starts a microtask after the first event, so a burst raised in one tick all waits: 1005 events, 5 over the bound
    // (the oldest, 0..4, are dropped). The first delivery that remains (event 5) is held up by a 429.
    const total = QUEUE_MAX + 5;
    const subject = sid();
    for (let i = 0; i < total; i++) void k.emit(gapEv(subject, { refCode: `M-N${String(i).padStart(4, '0')}` }));
    await settle();
    expect(logged).toEqual([['chatwarden.discord_dropped', { count: 1 }]]);
    await settle(6000);
    // Everything that was kept is delivered, in order: 5..1004.
    const refs = contents(d.calls).map((t) => /Ref: (M-N\d{4})/.exec(t)?.[1]);
    const delivered = refs.filter((r): r is string => r !== undefined);
    expect(new Set(delivered).size).toBe(QUEUE_MAX);
    expect(delivered[0]).toBe('M-N0005');
    expect(delivered).not.toContain('M-N0000');
    expect(delivered).not.toContain('M-N0004');
    expect(delivered.at(-1)).toBe(`M-N${String(total - 1).padStart(4, '0')}`);
    await settle(60_000);
    expect(logged).toEqual([
      ['chatwarden.discord_dropped', { count: 1 }],
      ['chatwarden.discord_dropped', { count: 4 }],
    ]);
  });
});

describe('the chat hot path: a listener returns before it does any work', () => {
  it('auto.restricted: the listener returns at once, with no thread lookup and no request until a microtask later', async () => {
    const k = fakeKit();
    const get = vi.spyOn(k.kit.discordThreads, 'get');
    const { d } = start(k);
    const subject = sid();
    const listener = [...k.listeners].find((l) => l.type === 'auto.restricted' || l.type === '*');
    expect(listener).toBeDefined();
    const out = (listener as { fn: (e: KitEvent) => unknown }).fn(auto(subject));
    // Back on the caller's stack: nothing was read from the store and nothing was sent.
    expect(get).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
    await out;
    await settle();
    expect(get).toHaveBeenCalled();
    expect(d.calls).toHaveLength(1);
  });

  it.each([
    ['report.created', (s: string) => created(s)],
    ['report.closed', (s: string) => closed(s)],
    ['sanction.applied', (s: string) => applied(s)],
    ['sanction.revoked', (s: string) => lifted(s)],
    ['gap.created', (s: string) => gapEv(s)],
  ])('%s: the same, the listener does no lookup before it returns', async (_n, make) => {
    const k = fakeKit();
    const person = sid();
    const report = k.addReport({ targetPerson: person });
    const get = vi.spyOn(k.kit.discordThreads, 'get');
    const { d } = start(k);
    const e = make(_n === 'report.created' || _n === 'report.closed' ? report.id : person);
    for (const l of [...k.listeners]) if (l.type === '*' || l.type === e.type) l.fn(e);
    expect(get).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
    await settle();
    expect(d.calls).toHaveLength(1);
  });

  it('events raised in one tick are still delivered once each, in order', async () => {
    const k = fakeKit();
    const { d } = start(k);
    const subject = sid();
    for (let i = 0; i < 3; i++) for (const l of [...k.listeners]) if (l.type === '*' || l.type === 'gap.created') l.fn(gapEv(subject, { refCode: `M-ORD0${i}` }));
    await settle();
    expect(contents(d.calls).map((t) => /M-ORD0\d/.exec(t)?.[0]).filter(Boolean)).toEqual(['M-ORD00', 'M-ORD01', 'M-ORD02']);
  });
});

describe('dispose', () => {
  it('unsubscribes every listener and is idempotent', () => {
    const k = fakeKit();
    const { feed } = start(k);
    expect(k.listeners.size).toBe(8);
    feed.dispose();
    expect(k.listeners.size).toBe(0);
    expect(() => feed.dispose()).not.toThrow();
  });

  it('an event raised after dispose posts nothing', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { feed, d } = start(k);
    feed.dispose();
    await k.emit(created(r.id));
    await settle(10_000);
    expect(d.calls).toHaveLength(0);
  });

  it('drops the queue, aborts the request in flight and leaves no timer behind', async () => {
    const k = fakeKit();
    const subject = sid();
    const reports = [k.addReport({ targetPerson: subject }), k.addReport({ targetPerson: subject }), k.addReport({ targetPerson: subject })];
    const { feed, d } = start(k, () => 'hang');
    for (const r of reports) void k.emit(created(r.id));
    await settle(100);
    expect(d.calls).toHaveLength(1);
    feed.dispose();
    expect(d.calls[0]!.init.signal.aborted).toBe(true);
    await settle(120_000);
    expect(d.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes the drop count that had not been logged yet', async () => {
    const k = fakeKit();
    const { feed, logged } = start(k, () => 'hang');
    for (let i = 0; i < 1 + QUEUE_MAX + 3; i++) void k.emit(gapEv(sid(), { refCode: 'M-AAAAA' }));
    await settle();
    expect(logged).toEqual([['chatwarden.discord_dropped', { count: 1 }]]);
    feed.dispose();
    expect(logged).toEqual([
      ['chatwarden.discord_dropped', { count: 1 }],
      ['chatwarden.discord_dropped', { count: 3 }],
    ]);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('rendered posts: the injection matrix', () => {
  it.each(INJECTIONS)('%s, as a rule title', async (_name, input, expected) => {
    const k = fakeKit();
    k.state.rules = [{ number: 2, title: input, text: 'x' }];
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id));
    await settle();
    const body = d.calls[0]!.body;
    const text = String(body.content);
    expect(text).toContain(`Rule: Community Rule 2 (${expected})`);
    // header, category, rule, links: the title cannot add a line (a header, a quote, a fence).
    expect(text.split('\n')).toHaveLength(4);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('@here');
    expect(text).not.toMatch(new RegExp('@(?!' + ZW + ')'));
    expect(text).not.toContain('](<https://evil');
    expect(text).not.toContain('```');
    expect(text).not.toContain(`<@&${ROLE}>`);
  });

  it.each(INJECTIONS.filter(([, input]) => input.length <= 30))('%s, as an unknown category string', async (_name, input, expected) => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: input });
    const { d } = start(k, undefined, { mentionRoleId: ROLE });
    await k.emit(created(r.id, input));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text).toContain(`Category: ${expected}`);
    expect(text.split('\n')).toHaveLength(3);
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(text).not.toMatch(new RegExp('@(?!' + ZW + ')'));
  });

  it('a hostile ref code is escaped too', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(applied(sid(), { refCode: '@everyone <@&1>\n# hi' }));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text).toContain(`Ref: @${ZW}everyone \\<@${ZW}&1\\> \\# hi`);
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('hubLink output is bounded', () => {
  const longLink = (n: number) => () => `https://h.test/${'a'.repeat(n)}`;

  it('drops a 3000-character link, keeps the post, the head and the role ping, and logs only the class', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject, category: 'hate' });
    const { d, logged } = start(k, undefined, { mentionRoleId: ROLE, hubLink: longLink(3000) });
    await k.emit(created(r.id, 'hate'));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith(`<@&${ROLE}> **Severe report**`)).toBe(true);
    expect(text).toContain('Category: Hate speech');
    expect(text).not.toContain('Open report');
    expect(text).not.toContain('Open person');
    expect(text).not.toContain('https://h.test');
    expect((d.calls[0]!.body.allowed_mentions as { roles: string[] }).roles).toEqual([ROLE]);
    expect(logged).toEqual([
      ['chatwarden.discord_link_dropped', { kind: 'report', reason: 'too_long', count: 1 }],
      ['chatwarden.discord_link_dropped', { kind: 'person', reason: 'too_long', count: 1 }],
    ]);
    expect(JSON.stringify(logged)).not.toContain('h.test');
    expect(JSON.stringify(logged)).not.toContain(subject);
  });

  it('is never truncated: a link of 512 characters is kept whole, 513 is dropped', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const keep = start(k, undefined, { hubLink: longLink(512 - 'https://h.test/'.length) });
    await k.emit(created(r.id));
    await settle();
    expect(keep.logged).toEqual([]);
    expect(String(keep.d.calls[0]!.body.content)).toContain(`(<https://h.test/${'a'.repeat(497)}>)`);
    keep.feed.dispose();
    const drop = start(k, undefined, { hubLink: longLink(512 - 'https://h.test/'.length + 1) });
    await k.emit(created(r.id));
    await settle();
    expect(drop.logged.length).toBe(2);
    expect(String(drop.d.calls[0]!.body.content)).not.toContain('https://h.test');
  });

  it('one long link does not take the other with it', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const { d, logged } = start(k, undefined, {
      hubLink: (kind, id) => (kind === 'report' ? `https://h.test/${'a'.repeat(900)}` : hubLink(kind, id)),
    });
    await k.emit(created(r.id));
    await settle();
    const text = String(d.calls[0]!.body.content);
    expect(text).not.toContain('Open report');
    expect(text).toContain(`[Open person](<https://hub.example.test/person/${subject}>)`);
    expect(logged).toEqual([['chatwarden.discord_link_dropped', { kind: 'report', reason: 'too_long', count: 1 }]]);
  });

  it('logs an unusable link and a throwing hubLink by class, never the value', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const a = start(k, undefined, { hubLink: () => 'javascript:alert(1)' });
    await k.emit(created(r.id));
    await settle();
    expect(a.logged).toEqual([
      ['chatwarden.discord_link_dropped', { kind: 'report', reason: 'invalid', count: 1 }],
      ['chatwarden.discord_link_dropped', { kind: 'person', reason: 'invalid', count: 1 }],
    ]);
    a.feed.dispose();
    const b = start(k, undefined, {
      hubLink: () => {
        throw new RangeError('secret-token-in-message');
      },
    });
    await k.emit(created(r.id));
    await settle();
    expect(b.logged[0]).toEqual(['chatwarden.discord_link_dropped', { kind: 'report', reason: 'RangeError', count: 1 }]);
    expect(JSON.stringify(b.logged)).not.toContain('secret-token');
  });
});

describe('dropped hub links are logged as a coalesced count', () => {
  const bad = (): string => 'javascript:alert(1)';
  const lines = (logged: Array<[string, unknown]>) => logged.filter(([e]) => e === 'chatwarden.discord_link_dropped');

  it('the first drop of a kind and reason is logged at once; the rest of the minute is one count', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { logged, feed } = start(k, undefined, { hubLink: bad });
    for (let i = 0; i < 6; i++) await k.emit(created(r.id));
    await settle();
    // Each post has two bad links (report and person): the first of each kind is logged now.
    expect(lines(logged)).toEqual([
      ['chatwarden.discord_link_dropped', { kind: 'report', reason: 'invalid', count: 1 }],
      ['chatwarden.discord_link_dropped', { kind: 'person', reason: 'invalid', count: 1 }],
    ]);
    await settle(59_000);
    expect(lines(logged)).toHaveLength(2);
    await settle(2000);
    expect(lines(logged).slice(2)).toEqual([
      ['chatwarden.discord_link_dropped', { kind: 'report', reason: 'invalid', count: 5 }],
      ['chatwarden.discord_link_dropped', { kind: 'person', reason: 'invalid', count: 5 }],
    ]);
    feed.dispose();
    expect(lines(logged)).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new window starts after a flush: the next drop after the minute is logged at once', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { logged } = start(k, undefined, { hubLink: bad });
    await k.emit(created(r.id));
    await settle(61_000);
    await k.emit(created(r.id));
    await settle();
    expect(lines(logged)).toHaveLength(4);
    expect(lines(logged).every(([, d]) => (d as { count: number }).count === 1)).toBe(true);
  });

  it('too_long and invalid are counted apart', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { logged } = start(k, undefined, {
      hubLink: (kind) => (kind === 'report' ? `https://h.test/${'a'.repeat(600)}` : bad()),
    });
    await k.emit(created(r.id));
    await k.emit(created(r.id));
    await settle(61_000);
    const reasons = lines(logged).map(([, d]) => `${(d as { kind: string }).kind}:${(d as { reason: string }).reason}:${(d as { count: number }).count}`);
    expect(reasons).toEqual(['report:too_long:1', 'person:invalid:1', 'report:too_long:1', 'person:invalid:1']);
  });

  it('flushes what is pending when the feed is disposed, with no timer left', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { logged, feed } = start(k, undefined, { hubLink: bad });
    for (let i = 0; i < 4; i++) await k.emit(created(r.id));
    await settle();
    expect(lines(logged)).toHaveLength(2);
    feed.dispose();
    expect(lines(logged).slice(2).map(([, d]) => (d as { count: number }).count)).toEqual([3, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a feed with no dropped link logs nothing and holds no timer; the lines never hold a link or an id', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const good = start(k);
    await k.emit(created(r.id));
    await settle();
    expect(lines(good.logged)).toEqual([]);
    good.feed.dispose();
    const badOne = start(k, undefined, { hubLink: (kind, id) => `javascript:${kind}/${id}` });
    for (let i = 0; i < 3; i++) await k.emit(created(r.id));
    await settle(61_000);
    expect(JSON.stringify(badOne.logged)).not.toContain(subject);
    expect(JSON.stringify(badOne.logged)).not.toContain('javascript');
  });

  it('an unbounded variety of thrown error classes still logs a bounded number of lines', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    let n = 0;
    const { logged } = start(k, undefined, {
      hubLink: () => {
        const e = new Error('x');
        e.name = `Err${n++}`;
        throw e;
      },
    });
    for (let i = 0; i < 100; i++) await k.emit(created(r.id));
    await settle();
    expect(lines(logged).length).toBeLessThanOrEqual(18);
  });
});

describe('a created thread is always remembered', () => {
  it('even when dispose() runs while the create is in flight', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    let answer: (res: Response) => void = () => undefined;
    const fetchFn = (() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch;
    const { feed } = start(k, undefined, { fetch: fetchFn });
    await k.emit(created(r.id));
    await settle();
    feed.dispose();
    answer(new Response(JSON.stringify({ id: 'm1', channel_id: 'T77' }), { status: 200 }));
    await settle();
    expect(k.threads.get(subject)).toMatchObject({ threadId: 'T77' });
    expect(String(k.threads.get(subject)?.label)).toMatch(LABEL_RE);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the known limit: an answer lost after Discord made the thread', () => {
  it('stores nothing, so the next event opens another thread (documented, not fixable without idempotency from Discord)', async () => {
    const k = fakeKit();
    const subject = sid();
    const a = k.addReport({ targetPerson: subject });
    const b = k.addReport({ targetPerson: subject });
    // Discord answers 200 but the body is unreadable: the thread exists there, and we never learn its id.
    const { d, logged } = start(k, (n) => (n === 0 ? { status: 200, text: 'garbled' } : undefined));
    await k.emit(created(a.id));
    await settle();
    expect(k.threads.size).toBe(0);
    expect(logged).toContainEqual(['chatwarden.discord_failed', { op: 'openThread', error: 'bad_response', attempts: 1 }]);
    await k.emit(created(b.id));
    await settle();
    expect(d.creates()).toHaveLength(2);
    expect(k.threads.get(subject)?.threadId).toBe('T1');
  });
});

describe('components on the report post (K5 D1)', () => {
  const ROWS = [{ type: 1 as const, components: [{ type: 2 as const, style: 2 as const, label: 'Nothing wrong here', custom_id: 'cw1:dis:ID' }] }];
  const SECRET_ID = 'cw1:dis:SECRET-CUSTOM-ID';
  const SECRET_LABEL = 'SECRET-LABEL-TEXT';
  const SECRET_URL = 'https://secret.example.test/SECRET-URL-PATH';

  const withComponents = (calls: Array<{ url: URL; body: Record<string, unknown> }>) => calls.filter((c) => c.url.searchParams.has('with_components'));

  it('the report post carries with_components=true and the components; no other post carries either', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const components = vi.fn(() => ROWS);
    const { d } = start(k, undefined, { components });
    await k.emit(created(r.id));
    await settle();
    await k.emit(closed(r.id));
    await k.emit(applied(subject));
    await k.emit(lifted(subject));
    await k.emit(gapEv(subject));
    await k.emit(auto(subject));
    await settle();
    // six posts, and the one edit that takes the buttons off when the report closes (that is D2: it is the only other request that carries them)
    expect(d.calls).toHaveLength(7);
    expect(d.calls[0]!.url.searchParams.get('wait')).toBe('true');
    expect(d.calls[0]!.url.searchParams.get('with_components')).toBe('true');
    expect(d.calls[0]!.body.components).toEqual(ROWS);
    const edits = d.calls.filter((c) => c.init.method === 'PATCH');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.body.components).toEqual([]);
    expect(withComponents(d.calls.filter((c) => c.init.method === 'POST'))).toHaveLength(1);
    for (const c of d.calls.filter((c) => c.init.method === 'POST').slice(1)) {
      expect('components' in c.body).toBe(false);
      expect(c.href).toBe(`${WEBHOOK}?wait=true&thread_id=T1`);
    }
  });

  it('the components function is called with { kind: report, reportId } and nothing else; never for sanction, gap, timeout or closed posts', async () => {
    const k = fakeKit();
    const subject = sid();
    const r = k.addReport({ targetPerson: subject });
    const components = vi.fn<(post: { kind: 'report'; reportId: string }) => typeof ROWS>(() => ROWS);
    start(k, undefined, { components });
    await k.emit(applied(subject));
    await k.emit(lifted(subject));
    await k.emit(gapEv(subject));
    await k.emit(auto(subject));
    await k.emit(closed(r.id));
    await settle();
    expect(components).not.toHaveBeenCalled();
    await k.emit(created(r.id));
    await settle();
    expect(components).toHaveBeenCalledTimes(1);
    expect(components.mock.calls[0]).toEqual([{ kind: 'report', reportId: r.id }]);
    expect(Object.keys(components.mock.calls[0]![0] as object).sort()).toEqual(['kind', 'reportId']);
  });

  it('severeOnly still skips a non-severe report: the components function is not called for it', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'spam' });
    const components = vi.fn(() => ROWS);
    const { d } = start(k, undefined, { components, severeOnly: true });
    await k.emit(created(r.id, 'spam'));
    await settle();
    expect(components).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  const SIX = [{ type: 1, components: Array.from({ length: 6 }, () => ROWS[0]!.components[0]) }];
  const JS_LINK = [{ type: 1, components: [{ type: 2, style: 5, label: 'x', url: 'javascript:alert(1)' }] }];
  it.each([
    [
      'throws',
      () => {
        throw new RangeError('boom');
      },
      'RangeError',
    ],
    ['returns six buttons', () => SIX, 'invalid'],
    ['returns a non-array', () => 'junk', 'invalid'],
    ['returns a promise', () => Promise.resolve(ROWS), 'invalid'],
    ['returns a javascript: link', () => JS_LINK, 'invalid'],
  ])('a components function that %s posts the report without buttons and logs one coalesced line', async (_n, fn, reason) => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d, logged } = start(k, undefined, { components: fn as never });
    await k.emit(created(r.id));
    await settle();
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.href).toBe(`${WEBHOOK}?wait=true`);
    expect('components' in d.calls[0]!.body).toBe(false);
    expect(String(d.calls[0]!.body.content)).toContain('**New report**');
    expect(logged).toEqual([['chatwarden.discord_link_dropped', { op: 'components', reason, count: 1 }]]);
  });

  it('the log line holds no custom_id, label, url or error message', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const bad = (): never => {
      throw new Error(`${SECRET_ID} ${SECRET_LABEL} ${SECRET_URL}`);
    };
    const { logged } = start(k, undefined, { components: bad });
    await k.emit(created(r.id));
    await settle();
    expect(logged).toHaveLength(1);
    const text = JSON.stringify(logged);
    for (const s of [SECRET_ID, SECRET_LABEL, SECRET_URL, 'SECRET']) expect(text).not.toContain(s);
  });

  it('a junk result is coalesced like dropped links: the first at once, then one line a minute with the count', async () => {
    const k = fakeKit();
    const subject = sid();
    const { logged } = start(k, undefined, { components: () => 'junk' as never });
    for (let i = 0; i < 3; i++) {
      await k.emit(created(k.addReport({ targetPerson: subject }).id));
      await settle();
    }
    const lines = () => logged.filter(([e]) => e === 'chatwarden.discord_link_dropped');
    expect(lines()).toEqual([['chatwarden.discord_link_dropped', { op: 'components', reason: 'invalid', count: 1 }]]);
    await settle(60_000);
    expect(lines()).toEqual([
      ['chatwarden.discord_link_dropped', { op: 'components', reason: 'invalid', count: 1 }],
      ['chatwarden.discord_link_dropped', { op: 'components', reason: 'invalid', count: 2 }],
    ]);
  });

  it('an undefined or empty result is not an error: no buttons, no log', async () => {
    const k = fakeKit();
    const first = start(k, undefined, { components: () => undefined });
    await k.emit(created(k.addReport({ targetPerson: sid() }).id));
    await settle();
    first.feed.dispose();
    const second = start(k, undefined, { components: () => [] });
    await k.emit(created(k.addReport({ targetPerson: sid() }).id));
    await settle();
    expect(first.logged).toEqual([]);
    expect(second.logged).toEqual([]);
    expect(first.d.calls).toHaveLength(1);
    expect(second.d.calls).toHaveLength(1);
    expect(withComponents(first.d.calls)).toHaveLength(0);
    expect(withComponents(second.d.calls)).toHaveLength(0);
  });

  it('a components option that is not a function is a RangeError at construction', () => {
    for (const bad of ['yes', 3, {}, null]) {
      expect(() => discordFeed(fakeKit().kit, { webhookUrl: WEBHOOK, hubLink, fetch: fakeDiscord().fetch, components: bad } as never)).toThrow(RangeError);
    }
  });

  it('dispose flushes a pending components drop count like a link drop, and leaves no timer', async () => {
    const k = fakeKit();
    const subject = sid();
    const { feed, logged } = start(k, undefined, { components: () => 'junk' as never });
    await k.emit(created(k.addReport({ targetPerson: subject }).id));
    await k.emit(created(k.addReport({ targetPerson: subject }).id));
    await settle();
    feed.dispose();
    expect(logged.filter(([e]) => e === 'chatwarden.discord_link_dropped').map(([, detail]) => detail)).toEqual([
      { op: 'components', reason: 'invalid', count: 1 },
      { op: 'components', reason: 'invalid', count: 1 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('every existing post kind is byte-identical to before when components is not set (and for non-report posts when it is)', async () => {
    const run = async (options: Partial<DiscordFeedOptions>) => {
      const k = fakeKit();
      const subject = sid();
      const r = k.addReport({ targetPerson: subject });
      const { d } = start(k, undefined, options);
      await k.emit(created(r.id));
      await k.emit(closed(r.id));
      await k.emit(applied(subject, { groupId: 'g1', refCode: 'M-SNAP1', until: NOW + DAY }));
      await k.emit(lifted(subject, { groupId: 'g2', refCode: 'M-SNAP2' }));
      await k.emit(gapEv(subject, { groupId: 'g3', refCode: 'M-SNAP3' }));
      await k.emit(auto(subject, { groupId: 'g4', refCode: 'M-SNAP4' }));
      await settle();
      return { calls: d.calls, id: r.id, subject };
    };
    const plain = await run({});
    expect(plain.calls).toHaveLength(6);
    expect(plain.calls[0]!.href).toBe(`${WEBHOOK}?wait=true`);
    for (const c of plain.calls.slice(1)) expect(c.href).toBe(`${WEBHOOK}?wait=true&thread_id=T1`);
    for (const c of plain.calls) {
      expect(Object.keys(c.body).filter((key) => key !== 'thread_name')).toEqual(['content', 'allowed_mentions', 'flags']);
      expect(c.body.flags).toBe(4);
    }
    const withHook = await run({ components: () => ROWS });
    const strip = (calls: typeof plain.calls, id: string, subject: string) =>
      calls.slice(1).filter((c) => c.init.method === 'POST').map((c) => JSON.stringify(c.body).replaceAll(id, 'R').replaceAll(subject, 'S'));
    expect(strip(withHook.calls, withHook.id, withHook.subject)).toEqual(strip(plain.calls, plain.id, plain.subject));
  });
});

describe('the buttons are stripped when the report closes (K5 D2)', () => {
  const ROWS = [{ type: 1 as const, components: [{ type: 2 as const, style: 2 as const, label: 'Nothing wrong here', custom_id: 'cw1:dis:ID' }] }];
  const withButtons = { components: () => ROWS };
  const patches = <C extends { init: { method?: string } }>(calls: C[]): C[] => calls.filter((c) => c.init.method === 'PATCH');
  const base = (c: { url: URL }): string => c.url.origin + c.url.pathname;
  /** `start`, with the plan seeing the call too (so a test can fail only the PATCH). */
  const begin = (k: Kit, plan: Parameters<typeof fakeDiscord>[0], options: Partial<DiscordFeedOptions>) => {
    const d = fakeDiscord(plan);
    const logged: Logged = [];
    const feed = discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, logger: { warn: (e, detail) => void logged.push([e, detail]) }, random: () => 0.5, ...options });
    return { feed, d, logged };
  };

  it("report.closed edits the report's own post to no components, in the right thread, once", async () => {
    const k = fakeKit();
    const a = k.addReport({ targetPerson: sid() });
    const b = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, withButtons);
    await k.emit(created(a.id));
    await k.emit(created(b.id));
    await settle();
    // call 0 opened T1 (message m0), call 1 opened T2 (message m1)
    await k.emit(closed(b.id));
    await settle();
    expect(patches(d.calls)).toHaveLength(1);
    const edit = patches(d.calls)[0]!;
    expect(base(edit)).toBe(`${WEBHOOK}/messages/m1`);
    expect(edit.url.searchParams.get('thread_id')).toBe('T2');
    expect(edit.url.searchParams.get('with_components')).toBe('true');
    expect(edit.body).toEqual({ components: [], allowed_mentions: { parse: [] } });
    // closing it again edits nothing more; the other report's post is untouched
    await k.emit(closed(b.id));
    await settle();
    expect(patches(d.calls)).toHaveLength(1);
    // and report a is still strippable
    await k.emit(closed(a.id));
    await settle();
    expect(patches(d.calls).map((c) => base(c))).toEqual([`${WEBHOOK}/messages/m1`, `${WEBHOOK}/messages/m0`]);
    expect(patches(d.calls)[1]!.url.searchParams.get('thread_id')).toBe('T1');
  });

  it('a second report of the same person is edited in the shared thread by its own message id', async () => {
    const k = fakeKit();
    const person = sid();
    const a = k.addReport({ targetPerson: person });
    const b = k.addReport({ targetPerson: person });
    const { d } = start(k, undefined, withButtons);
    await k.emit(created(a.id));
    await k.emit(created(b.id));
    await settle();
    await k.emit(closed(b.id));
    await settle();
    expect(base(patches(d.calls)[0]!)).toBe(`${WEBHOOK}/messages/m1`);
    expect(patches(d.calls)[0]!.url.searchParams.get('thread_id')).toBe('T1');
    await k.emit(closed(a.id));
    await settle();
    expect(base(patches(d.calls)[1]!)).toBe(`${WEBHOOK}/messages/m0`);
    expect(patches(d.calls)[1]!.url.searchParams.get('thread_id')).toBe('T1');
  });

  it('the closing post is sent before the edit, and the edit never changes the closing post', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, withButtons);
    await k.emit(created(r.id));
    await settle();
    await k.emit(closed(r.id, 'no_action'));
    await settle();
    expect(d.calls.map((c) => c.init.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(String(d.calls[1]!.body.content)).toContain('**Report closed**');
    expect('components' in d.calls[1]!.body).toBe(false);
  });

  it('the edit body has no content, no embeds, no flags and an allowed_mentions parse that is empty, whatever the report held', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'hate' });
    const { d } = start(k, undefined, { ...withButtons, mentionRoleId: ROLE });
    await k.emit(created(r.id, 'hate'));
    await settle();
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
    await k.emit(closed(r.id));
    await settle();
    const edit = patches(d.calls)[0]!;
    expect(Object.keys(edit.body).sort()).toEqual(['allowed_mentions', 'components']);
    expect(edit.body.components).toEqual([]);
    expect(edit.body.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(edit.body)).not.toMatch(/Case|Report|<@|@everyone|http/);
  });

  it('an edit failure is logged by class and does not block the next post', async () => {
    const k = fakeKit();
    const person = sid();
    const a = k.addReport({ targetPerson: person });
    const b = k.addReport({ targetPerson: person });
    // call 0 opens the thread, call 1 is the closing post, call 2 the edit (a network error, over and over), then the next post
    const { d, logged } = begin(k, (_n, call) => (call.init.method === 'PATCH' ? new TypeError('secret-url-in-message') : undefined), withButtons);
    await k.emit(created(a.id));
    await settle();
    await k.emit(closed(a.id));
    await k.emit(created(b.id));
    await settle(60_000);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'edit', error: 'TypeError', attempts: 6 }]]);
    expect(JSON.stringify(logged)).not.toContain('secret-url');
    const last = d.calls.filter((c) => c.init.method === 'POST').at(-1)!;
    expect(String(last.body.content)).toContain('**New report**');
    expect(last.url.searchParams.get('with_components')).toBe('true');
  });

  it('a 403 on the edit is logged with the status once and not retried', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d, logged } = begin(k, (_n, call) => (call.init.method === 'PATCH' ? 403 : undefined), withButtons);
    await k.emit(created(r.id));
    await settle();
    await k.emit(closed(r.id));
    await settle(60_000);
    expect(patches(d.calls)).toHaveLength(1);
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'edit', status: 403, attempts: 1 }]]);
  });

  it('after a restart (a new feed) a closed report edits nothing and posts nothing wrong', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const first = start(k, undefined, withButtons);
    await k.emit(created(r.id));
    await settle();
    first.feed.dispose();
    const second = start(k, undefined, withButtons);
    await k.emit(closed(r.id));
    await settle();
    expect(patches(second.d.calls)).toHaveLength(0);
    expect(second.d.calls).toHaveLength(1);
    expect(String(second.d.calls[0]!.body.content)).toContain('**Report closed**');
    expect(second.d.calls[0]!.url.searchParams.has('with_components')).toBe(false);
    expect(second.logged).toEqual([]);
  });

  it('without a components option nothing is ever edited and nothing is remembered', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k);
    await k.emit(created(r.id));
    await k.emit(closed(r.id));
    await settle();
    expect(d.calls.map((c) => c.init.method)).toEqual(['POST', 'POST']);
  });

  it('a report whose buttons were dropped (junk) or never posted has no entry, so closing it edits nothing', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d } = start(k, undefined, { components: () => 'junk' as never });
    await k.emit(created(r.id));
    await k.emit(closed(r.id));
    await settle();
    expect(patches(d.calls)).toHaveLength(0);
  });

  it('an answer without a usable message id leaves no entry and logs nothing', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d, logged } = begin(k, (n) => (n === 0 ? { status: 200, json: { channel_id: 'T1' } } : undefined), withButtons);
    await k.emit(created(r.id));
    await settle();
    await k.emit(closed(r.id));
    await settle();
    expect(patches(d.calls)).toHaveLength(0);
    expect(logged).toEqual([]);
  });

  it('a post that Discord sent after the thread was found gone is remembered under the new thread and message', async () => {
    const k = fakeKit();
    const person = sid();
    const first = k.addReport({ targetPerson: person });
    const second = k.addReport({ targetPerson: person });
    // call 0 opens T1; call 1 is the second report's post: 404 Unknown Channel; call 2 reopens (T2, message m2)
    const { d } = begin(k, (n) => (n === 1 ? { status: 404, json: { code: 10003 } } : undefined), withButtons);
    await k.emit(created(first.id));
    await settle();
    await k.emit(created(second.id));
    await settle();
    await k.emit(closed(second.id));
    await settle();
    const edit = patches(d.calls)[0]!;
    expect(base(edit)).toBe(`${WEBHOOK}/messages/m2`);
    expect(edit.url.searchParams.get('thread_id')).toBe('T2');
  });

  it('a thread deleted since is not recreated for an edit (the edit answers gone and nothing else is sent)', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d, logged } = begin(k, (_n, call) => (call.init.method === 'PATCH' ? { status: 404, json: { code: 10003 } } : undefined), withButtons);
    await k.emit(created(r.id));
    await settle();
    await k.emit(closed(r.id));
    await settle(60_000);
    expect(patches(d.calls)).toHaveLength(1);
    // the only thread that was opened is the first one: nothing is recreated for an edit
    expect(d.creates()).toHaveLength(1);
    expect(d.calls.filter((c) => c.init.method === 'POST')).toHaveLength(2);
    expect(logged).toEqual([]);
  });

  it('severeOnly: a non-severe report was never posted, so its closing posts and edits nothing', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'spam' });
    const { d } = start(k, undefined, { ...withButtons, severeOnly: true });
    await k.emit(created(r.id, 'spam'));
    await k.emit(closed(r.id));
    await settle();
    expect(d.calls).toHaveLength(0);
  });

  it('severeOnly: a severe report is edited on close, like any other', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid(), category: 'hate' });
    const { d } = start(k, undefined, { ...withButtons, severeOnly: true });
    await k.emit(created(r.id, 'hate'));
    await settle();
    await k.emit(closed(r.id));
    await settle();
    expect(patches(d.calls)).toHaveLength(1);
  });

  it('the map is bounded at 10000 and forgets the oldest', async () => {
    const k = fakeKit();
    const person = sid();
    const ids: string[] = [];
    const { d } = start(k, undefined, withButtons);
    for (let i = 0; i < 10_001; i++) {
      const r = k.addReport({ targetPerson: person });
      ids.push(r.id);
      await k.emit(created(r.id));
      // the queue itself holds 1000: let it drain, or the oldest would be dropped before it is sent
      if (i % 200 === 199) await settle();
    }
    await settle();
    expect(d.calls).toHaveLength(10_001);
    await k.emit(closed(ids[0]!)); // the oldest was forgotten
    await k.emit(closed(ids[1]!)); // the second oldest is still there
    await k.emit(closed(ids[10_000]!));
    await settle();
    expect(patches(d.calls).map((c) => base(c))).toEqual([`${WEBHOOK}/messages/m1`, `${WEBHOOK}/messages/m10000`]);
  }, 60_000);

  it('dispose drops a pending edit', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    // call 0: the report post; call 1: the closing post hangs, with the edit waiting behind it
    const { d, feed } = begin(k, (n) => (n === 1 ? 'hang' : undefined), withButtons);
    await k.emit(created(r.id));
    await settle();
    await k.emit(closed(r.id));
    await settle();
    expect(d.calls).toHaveLength(2);
    feed.dispose();
    await settle(120_000);
    expect(patches(d.calls)).toHaveLength(0);
    expect(d.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no edit and no post after dispose', async () => {
    const k = fakeKit();
    const r = k.addReport({ targetPerson: sid() });
    const { d, feed } = start(k, undefined, withButtons);
    await k.emit(created(r.id));
    await settle();
    feed.dispose();
    await k.emit(closed(r.id));
    await settle();
    expect(d.calls).toHaveLength(1);
  });

  it('nothing in any post or edit carries chat text, a handle, a note or an id outside the links', async () => {
    const k = fakeKit();
    const person = sid();
    const r = k.addReport({ targetPerson: person });
    const { d } = start(k, undefined, withButtons);
    await k.emit(created(r.id));
    await k.emit(closed(r.id));
    await settle();
    for (const c of d.calls) {
      const text = visibleTexts(c.body).join('\n');
      expect(leaks(text, [CHAT, HANDLE, NOTE, person, r.id])).toEqual([]);
      expect(JSON.stringify(c.body)).not.toContain(CHAT);
    }
  });
});
