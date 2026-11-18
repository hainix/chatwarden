import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordThreadRow, KitEvent, Logger } from '@chatwarden/core';
import { discordFeed } from '../src/feed.js';
import type { DiscordFeedOptions, FeedKit } from '../src/feed.js';
import { NOW, WEBHOOK, fakeDiscord, leaks, settle, visibleTexts } from './support.js';
import type { Step } from './support.js';

// `sanction.overturned` (0.2.1) in the Discord feed: one plain line in the shared thread, because the event names no person. The line says where the decision came from in a few words and
// never the term, the term id, the filter key beyond its family, the group id or any person.

const H = 3_600_000;
const id22 = (): string => randomBytes(16).toString('base64url');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`;

/** A kit with only what the feed uses. */
function fakeKit() {
  const listeners = new Set<{ type: string; fn: (e: KitEvent) => unknown }>();
  const threads = new Map<string, DiscordThreadRow>();
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      const entry = { type, fn };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    reports: { get: () => null },
    profile: { severeRules: undefined as number[] | undefined },
    rules: { all: () => [{ number: 1, title: 'No hate' }, { number: 2, title: 'Respect others' }] },
    limits: { strikes: { firstMs: H, repeatMs: 24 * H } },
    people: { canonical: (id: string) => id, aliases: (id: string) => [id] },
    discordThreads: {
      get: (subject: string) => threads.get(subject) ?? null,
      put: (row: DiscordThreadRow) => void threads.set(row.subject, { ...row }),
    },
  };
  const emit = async (e: KitEvent): Promise<void> => {
    await Promise.all([...listeners].filter((l) => l.type === '*' || l.type === e.type).map((l) => l.fn(e)));
  };
  return { kit: kit as unknown as FeedKit, listeners, emit };
}

function start(k: ReturnType<typeof fakeKit>, options: Partial<DiscordFeedOptions> = {}, plan?: (n: number) => Step | undefined) {
  const d = fakeDiscord(plan);
  const logged: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
  const logger: Logger = { warn: (e, detail) => void logged.push([e, detail]) };
  const feed = discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, logger, random: () => 0.5, clock: { now: () => Date.now() }, ...options });
  return { feed, d, logged };
}

const overturned = (over: Partial<Extract<KitEvent, { type: 'sanction.overturned' }>> = {}): KitEvent => ({ type: 'sanction.overturned', groupId: id22(), at: NOW, source: 'moderator', ...over });
const contents = (calls: Array<{ body: Record<string, unknown> }>): string[] => calls.map((c) => String(c.body.content));

describe('a term overturn', () => {
  it('posts "Overturned on appeal: an automatic restriction from the slur list." once, to the feed channel, with no link and no person', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(overturned({ source: 'auto_filter', termId: 'syn:zorbak' }));
    await settle();
    expect(d.calls).toHaveLength(1);
    expect(d.creates()).toHaveLength(1);
    expect(d.calls[0]?.body.content).toBe('Overturned on appeal: an automatic restriction from the slur list.');
    expect(JSON.stringify(d.calls[0]?.body)).not.toContain('hub.example.test');
    // the shared thread, not a person's
    expect(visibleTexts(d.calls[0]?.body ?? {}).join('\n')).toContain('Unattributed reports');
  });

  it('a term id alone, or source auto_filter alone, gives the same line', async () => {
    for (const e of [overturned({ source: 'moderator', termId: 'syn:vlemmo' }), overturned({ source: 'auto_filter' })]) {
      const k = fakeKit();
      const { d } = start(k);
      await k.emit(e);
      await settle();
      expect(contents(d.calls)).toEqual(['Overturned on appeal: an automatic restriction from the slur list.']);
    }
  });
});

describe('a filter overturn', () => {
  it('names the family: links, personal information, caps and repeats; a phrase key says "a phrase rule"; an unknown family says "a chat filter"', async () => {
    const cases: Array<[string, string]> = [
      ['link.url', 'Overturned on appeal: a decision that came from the links filter.'],
      ['link', 'Overturned on appeal: a decision that came from the links filter.'],
      ['personal_info.email', 'Overturned on appeal: a decision that came from the personal information filter.'],
      ['ratio.caps', 'Overturned on appeal: a decision that came from the caps and repeats filter.'],
      ['phrase.zorbak-rule', 'Overturned on appeal: a decision that came from a phrase rule.'],
      ['mystery.thing', 'Overturned on appeal: a decision that came from a chat filter.'],
      ['', 'Overturned on appeal: a decision that came from a chat filter.'],
    ];
    for (const [filterKey, expected] of cases) {
      const k = fakeKit();
      const { d } = start(k);
      await k.emit(overturned({ source: 'auto_filter', filterKey }));
      await settle();
      expect(contents(d.calls), filterKey).toEqual([expected]);
    }
  });

  it('a filter key wins over a term id on the same event', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(overturned({ source: 'auto_filter', filterKey: 'link.url', termId: 'syn:zorbak' }));
    await settle();
    expect(contents(d.calls)).toEqual(['Overturned on appeal: a decision that came from the links filter.']);
  });

  it('a key of the wrong type is ignored, never a throw', async () => {
    const k = fakeKit();
    const { d, logged } = start(k);
    await k.emit(overturned({ source: 'auto_filter', filterKey: 7 as never }));
    await settle();
    expect(contents(d.calls)).toEqual(['Overturned on appeal: an automatic restriction from the slur list.']);
    expect(logged).toEqual([]);
  });
});

describe('an AI and a moderator overturn', () => {
  it('each post their own line', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(overturned({ source: 'ai' }));
    await k.emit(overturned({ source: 'moderator' }));
    await k.emit(overturned({ source: 'api' }));
    await k.emit(overturned({ source: 'coop' }));
    await settle();
    expect(contents(d.calls)).toEqual([
      'Overturned on appeal: a decision made by the AI.',
      'Overturned on appeal: a moderator decision.',
      'Overturned on appeal: a moderator decision.',
      'Overturned on appeal: a moderator decision.',
    ]);
  });
});

describe('what a post never holds', () => {
  it('the post never contains the term id, the filter key, the group id or any subject id', async () => {
    const k = fakeKit();
    const { d } = start(k);
    const groupId = `GROUP-${id22()}`;
    const termId = 'syn:zorbak-TERM-SEED-9f3a';
    const filterKey = 'phrase.FILTER-KEY-SEED-77c1';
    await k.emit(overturned({ groupId, source: 'auto_filter', termId }));
    await k.emit(overturned({ groupId, source: 'auto_filter', filterKey }));
    await k.emit(overturned({ groupId, source: 'ai' }));
    await settle();
    expect(d.calls).toHaveLength(3);
    const everything = d.calls.flatMap((c) => visibleTexts(c.body)).join('\n');
    for (const v of [groupId, termId, filterKey, 'zorbak', 'FILTER-KEY-SEED', 'TERM-SEED']) expect(everything, v).not.toContain(v);
    expect(leaks(everything, [groupId, termId, filterKey])).toEqual([]);
    expect(JSON.stringify(d.calls.map((c) => c.body))).not.toContain(groupId);
  });

  it('it pings no one, even with a mention role set, and allows no mention', async () => {
    const k = fakeKit();
    const { d } = start(k, { mentionRoleId: '987654321098765432', urgentMention: '987654321098765433' });
    await k.emit(overturned({ source: 'auto_filter', termId: 'syn:zorbak' }));
    await settle();
    expect(String(d.calls[0]?.body.content)).not.toContain('<@');
    expect(d.calls[0]?.body.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('severeOnly and the queue', () => {
  it('severeOnly does not suppress it (the event carries no rule)', async () => {
    const k = fakeKit();
    const { d } = start(k, { severeOnly: true });
    await k.emit(overturned({ source: 'auto_filter', termId: 'syn:zorbak' }));
    await settle();
    expect(contents(d.calls)).toEqual(['Overturned on appeal: an automatic restriction from the slur list.']);
  });

  it('exactly one post per event, even with two overturns of the same term', async () => {
    const k = fakeKit();
    const { d } = start(k);
    await k.emit(overturned({ source: 'auto_filter', termId: 'syn:zorbak' }));
    await k.emit(overturned({ source: 'auto_filter', termId: 'syn:zorbak' }));
    await settle();
    expect(d.calls).toHaveLength(2);
    expect(d.creates()).toHaveLength(1);
    expect(d.posts()).toHaveLength(1);
    expect(new Set(contents(d.calls)).size).toBe(1);
  });
});

describe('a failing channel and dispose', () => {
  it('a throwing channel never reaches the kit, is logged by class only, and nothing of the event is in the log', async () => {
    const k = fakeKit();
    const { d, logged } = start(k, {}, () => new TypeError('boom GROUP-SECRET-SEED'));
    await expect(k.emit(overturned({ groupId: 'GROUP-SECRET-SEED', source: 'auto_filter', termId: 'syn:zorbak' }))).resolves.toBeUndefined();
    await settle(120_000);
    expect(d.calls.length).toBeGreaterThan(0);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toMatch(/GROUP-SECRET-SEED|zorbak|tok_ABC/);
  });

  it('a handler that throws is fenced: the listener does not throw and the log names the class only', async () => {
    const k = fakeKit();
    const { logged } = start(k);
    const hostile = { type: 'sanction.overturned', at: NOW, get source(): never { throw new RangeError('getter boom GROUP-SECRET-SEED'); } } as unknown as KitEvent;
    await expect(k.emit(hostile)).resolves.toBeUndefined();
    await settle();
    expect(logged).toEqual([['chatwarden.discord_failed', { op: 'sanction.overturned', error: 'RangeError' }]]);
  });

  it('after dispose nothing is posted and nothing is subscribed', async () => {
    const k = fakeKit();
    const { feed, d } = start(k);
    expect([...k.listeners].some((l) => l.type === 'sanction.overturned')).toBe(true);
    feed.dispose();
    expect([...k.listeners].filter((l) => l.type === 'sanction.overturned')).toHaveLength(0);
    await k.emit(overturned({ source: 'auto_filter', termId: 'syn:zorbak' }));
    await settle();
    expect(d.calls).toEqual([]);
  });
});
