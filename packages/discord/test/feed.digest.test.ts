import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordThreadRow, InsightsDigest, KitEvent, Logger } from '@chatwarden/core';
import { discordFeed } from '../src/feed.js';
import type { DiscordFeedOptions, FeedKit } from '../src/feed.js';
import { NOW, WEBHOOK, fakeDiscord, settle } from './support.js';

// U7: feed.postDigest(days = 7) posts the compact Insights numbers to the staff channel: counts and times, no names, one message under Discord's limit. A failing post is logged by class.

const H = 3_600_000;
const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const digestOf = (over: Partial<InsightsDigest> = {}): InsightsDigest => ({
  days: 7,
  from: NOW - 7 * 24 * H,
  to: NOW,
  filed: 14,
  decided: 11,
  open: 3,
  urgentFiled: 2,
  urgentOpen: 1,
  medianMs: 2 * H + 10 * 60_000,
  p90Ms: 27 * H,
  longestOpenMs: 5 * H,
  ...over,
});

function fakeKit(digest: (days: number) => InsightsDigest | null = (days) => digestOf({ days })) {
  const threads = new Map<string, DiscordThreadRow>();
  const asked: number[] = [];
  const kit = {
    on: () => () => undefined,
    reports: { get: () => null },
    profile: { get severeRules() { return undefined; } },
    rules: { all: () => [] },
    limits: { strikes: { firstMs: 3_600_000, repeatMs: 86_400_000 } },
    people: { canonical: (id: string) => id, aliases: (id: string) => [id] },
    discordThreads: {
      get: (subject: string) => threads.get(subject) ?? null,
      put: (row: DiscordThreadRow) => void threads.set(row.subject, { ...row }),
    },
    insights: {
      digest: (days: number) => {
        asked.push(days);
        return digest(days);
      },
    },
  };
  return { kit: kit as unknown as FeedKit, asked };
}

function start(k: ReturnType<typeof fakeKit>, options: Partial<DiscordFeedOptions> = {}, plan?: Parameters<typeof fakeDiscord>[0]) {
  const d = fakeDiscord(plan);
  const logged: Array<[string, unknown]> = [];
  const logger: Logger = { warn: (e, detail) => void logged.push([e, detail]) };
  const feed = discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, logger, random: () => 0.5, ...options });
  return { feed, d, logged };
}

describe('postDigest', () => {
  it('posts one message with the counts and times, 7 days by default, and pings nobody', async () => {
    const k = fakeKit();
    const { feed, d } = start(k, { mentionRoleId: '987654321098765432', urgentMention: '135792468013579246' });
    expect(feed.postDigest()).toBe(true);
    await settle();
    expect(k.asked).toEqual([7]);
    expect(d.calls).toHaveLength(1);
    const content = String(d.calls[0]!.body.content);
    expect(content).toContain('Insights');
    expect(content).toContain('14 filed');
    expect(content).toContain('11 decided');
    expect(content).toContain('3 open');
    expect(content).toContain('2 hours 10 minutes');
    expect(content).toContain('27 hours');
    expect(content).toContain('5 hours');
    expect(content).not.toContain('<@');
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('days 30 and 90 are asked for as given', async () => {
    const k = fakeKit();
    const { feed } = start(k);
    feed.postDigest(30);
    feed.postDigest(90);
    expect(k.asked).toEqual([30, 90]);
  });

  it('too few reports for a figure says so in words, never null or NaN', async () => {
    const k = fakeKit((days) => digestOf({ days, medianMs: null, p90Ms: null, filed: 0, decided: 0, open: 0, urgentFiled: 0, urgentOpen: 0, longestOpenMs: 0 }));
    const { feed, d } = start(k);
    feed.postDigest();
    await settle();
    const content = String(d.calls[0]!.body.content);
    expect(content).not.toMatch(/null|NaN|undefined/);
    expect(content).toMatch(/not enough|too few/i);
  });

  it('carries no names: nothing but numbers, labels and the window', async () => {
    const k = fakeKit();
    const { feed, d } = start(k);
    feed.postDigest();
    await settle();
    const all = JSON.stringify(d.calls.map((c) => c.body));
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toMatch(/s_[A-Za-z0-9]|handle|actor|moderator/i);
  });

  it('stays under the 2 000 character limit even with absurd numbers', async () => {
    const k = fakeKit(() => digestOf({ filed: 1e15, decided: 1e15, open: 1e15, urgentFiled: 1e15, urgentOpen: 1e15, medianMs: 9e15, p90Ms: 9e15, longestOpenMs: 9e15 }));
    const { feed, d } = start(k);
    feed.postDigest();
    await settle();
    expect(String(d.calls[0]!.body.content).length).toBeLessThanOrEqual(2000);
  });

  it('with Insights off (digest null) or a kit that has none, nothing is posted and the answer is false', async () => {
    const off = fakeKit(() => null);
    const a = start(off);
    expect(a.feed.postDigest()).toBe(false);
    const none = fakeKit();
    delete (none.kit as unknown as { insights?: unknown }).insights;
    const b = start(none);
    expect(b.feed.postDigest()).toBe(false);
    await settle();
    expect(a.d.calls).toEqual([]);
    expect(b.d.calls).toEqual([]);
  });

  it('a digest that throws is logged by class and does not throw', async () => {
    const k = fakeKit(() => {
      throw new RangeError('SENTINEL-secret');
    });
    const { feed, d, logged } = start(k);
    expect(() => feed.postDigest()).not.toThrow();
    expect(feed.postDigest()).toBe(false);
    await settle();
    expect(d.calls).toEqual([]);
    expect(logged[0]).toEqual(['chatwarden.discord_failed', { op: 'insights.digest', error: 'RangeError' }]);
    expect(JSON.stringify(logged)).not.toContain('SENTINEL');
  });

  it('a failing post is logged by class and does not throw or retry for ever', async () => {
    const k = fakeKit();
    const { feed, logged } = start(k, {}, () => 400);
    expect(() => feed.postDigest()).not.toThrow();
    await settle();
    await settle(5000);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toMatch(/tok_ABC|14 filed/);
  });

  it('after dispose it posts nothing', async () => {
    const k = fakeKit();
    const { feed, d } = start(k);
    feed.dispose();
    feed.postDigest();
    await settle();
    expect(d.calls).toEqual([]);
  });

  it('an invalid days value is refused with RangeError before anything is asked', () => {
    const k = fakeKit();
    const { feed } = start(k);
    for (const bad of [0, 8, 14, NaN, '7', null]) expect(() => feed.postDigest(bad as never), String(bad)).toThrow(RangeError);
    expect(k.asked).toEqual([]);
  });
});

describe('the feed still posts what it did, and the webhook kit event is known', () => {
  it('KIT_EVENT_TYPES lists insights.digest so a webhook endpoint may subscribe to it', async () => {
    const { KIT_EVENT_TYPES } = await import('@chatwarden/core');
    expect(KIT_EVENT_TYPES).toContain('insights.digest');
    const _event: KitEvent['type'] = 'insights.digest';
    expect(_event).toBe('insights.digest');
  });
});
