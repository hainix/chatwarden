import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordThreadRow, KitEvent, Logger } from '@chatwarden/core';
import { discordFeed } from '../src/feed.js';
import type { DiscordFeedOptions, FeedKit } from '../src/feed.js';
import { NOW, ROLE, WEBHOOK, fakeDiscord, settle } from './support.js';

// U5: an urgent report posts "Urgent report. Open in the hub." with the role mention of `urgentMention`, and nothing else: never the reason (a welfare report's most of all), a
// category, a rule, a handle or a note. A non-urgent post is as before. `report.handoff` posts nothing.

const URGENT_ROLE = '135792468013579246';
const HANDLE = 'HANDLE-OF-THE-REPORTED';
const NOTE = 'REPORTER-NOTE-TEXT';
const id22 = (): string => randomBytes(16).toString('base64url');
const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeKit() {
  const listeners = new Set<{ type: string; fn: (e: KitEvent) => unknown }>();
  const threads = new Map<string, DiscordThreadRow>();
  const staff = new Map<string, { id: string; category: string; targetPerson: string; targetHandle: string; note: string }>();
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      const entry = { type, fn };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    reports: { get: (id: string) => staff.get(id) ?? null },
    profile: { get severeRules() { return undefined; } },
    rules: { all: () => [{ number: 1, title: 'No hate' }, { number: 2, title: 'Respect others' }] },
    limits: { strikes: { firstMs: 3_600_000, repeatMs: 86_400_000 } },
    people: { canonical: (id: string) => id, aliases: (id: string) => [id] },
    discordThreads: {
      get: (subject: string) => {
        const row = threads.get(subject);
        return row === undefined ? null : { ...row };
      },
      put: (row: DiscordThreadRow) => void threads.set(row.subject, { ...row }),
    },
  };
  const emit = async (e: KitEvent): Promise<void> => {
    await Promise.all([...listeners].filter((l) => l.type === e.type).map((l) => l.fn(e)));
  };
  const addReport = (category = 'harassment') => {
    const r = { id: id22(), category, targetPerson: `s_${id22()}`, targetHandle: HANDLE, note: NOTE };
    staff.set(r.id, r);
    return r;
  };
  return { kit: kit as unknown as FeedKit, emit, addReport, listeners };
}

function start(k: ReturnType<typeof fakeKit>, options: Partial<DiscordFeedOptions> = {}) {
  const d = fakeDiscord();
  const logged: Array<[string, unknown]> = [];
  const logger: Logger = { warn: (e, detail) => void logged.push([e, detail]) };
  const feed = discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, logger, random: () => 0.5, ...options });
  return { feed, d, logged };
}

const created = (reportId: string, over: Record<string, unknown> = {}): KitEvent =>
  ({ type: 'report.created', reportId, createdAt: NOW, category: 'harassment', reportedReason: 'harassment', urgent: false, roomTags: {}, ...over }) as KitEvent;
const text = (d: ReturnType<typeof fakeDiscord>, i: number): string => String(d.calls[i]?.body.content);

describe('an urgent report in the feed', () => {
  it('has the role mention, "Urgent report", the hub link and nothing else', async () => {
    const k = fakeKit();
    const r = k.addReport('harassment');
    const { d } = start(k, { urgentMention: URGENT_ROLE, mentionRoleId: ROLE });
    await k.emit(created(r.id, { reportedReason: 'threat', urgent: true }));
    await settle();
    expect(d.calls).toHaveLength(1);
    expect(text(d, 0)).toContain(`<@&${URGENT_ROLE}> **Urgent report.**`);
    expect(text(d, 0)).toContain('Open in the hub');
    expect(text(d, 0)).toContain(encodeURIComponent(r.id));
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [URGENT_ROLE] });
    // no category, rule, level, person link, handle, note or reason id
    for (const leak of ['Category', 'Rule', 'Conduct', 'threat', 'harassment', HANDLE, NOTE, 'Open person', '/person/', ROLE]) expect(text(d, 0), leak).not.toContain(leak);
  });

  it('a welfare report names no reason, and neither does anything else of the post', async () => {
    const k = fakeKit();
    const r = k.addReport('other');
    const { d } = start(k, { urgentMention: URGENT_ROLE });
    await k.emit(created(r.id, { category: 'other', reportedReason: 'welfare', urgent: true }));
    await settle();
    const all = d.calls.map((c) => JSON.stringify(c.body)).join('\n');
    expect(all).not.toMatch(/welfare|trouble|risk|hurt/i);
    expect(all).toContain('Urgent report.');
  });

  it('with no urgentMention the urgent post is still the short urgent one and pings nobody', async () => {
    const k = fakeKit();
    const r = k.addReport();
    const { d } = start(k, { mentionRoleId: ROLE });
    await k.emit(created(r.id, { urgent: true }));
    await settle();
    expect(text(d, 0)).toContain('**Urgent report.**');
    expect(text(d, 0)).not.toContain('<@&');
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('an urgent post is posted even with severeOnly on', async () => {
    const k = fakeKit();
    const r = k.addReport('harassment');
    const { d } = start(k, { severeOnly: true, urgentMention: URGENT_ROLE });
    await k.emit(created(r.id, { urgent: true }));
    await settle();
    expect(d.calls.length).toBeGreaterThan(0);
    expect(d.calls.map((c) => String(c.body.content)).join('\n')).toContain('Urgent report.');
  });

  it('a non-urgent post is as before: the new-report head, the category, no urgent mention', async () => {
    const k = fakeKit();
    const r = k.addReport('harassment');
    const { d } = start(k, { urgentMention: URGENT_ROLE });
    await k.emit(created(r.id, { urgent: false }));
    await settle();
    expect(text(d, 0)).toContain('**New report**');
    expect(text(d, 0)).toContain('Category');
    expect(text(d, 0)).not.toContain('Urgent');
    expect(text(d, 0)).not.toContain(URGENT_ROLE);
  });

  it('the urgent post fits the length limit even with a very long hub link', async () => {
    const k = fakeKit();
    const r = k.addReport();
    const { d } = start(k, { urgentMention: URGENT_ROLE, hubLink: (kind, id) => `https://hub.example.test/${kind}/${id}/${'x'.repeat(400)}` });
    await k.emit(created(r.id, { urgent: true }));
    await settle();
    for (const c of d.calls) expect(String(c.body.content).length).toBeLessThanOrEqual(2000);
    expect(d.calls.map((c) => String(c.body.content)).join('\n')).toContain('Urgent report.');
  });
});

describe('urgentMention is checked at creation', () => {
  it.each([
    ['not digits', 'everyone'],
    ['too short', '12345'],
    ['a role mention string', `<@&${URGENT_ROLE}>`],
    ['a number', Number(URGENT_ROLE)],
    ['an empty string', ''],
  ])('%s is a RangeError that never echoes it, and subscribes nothing', (_name, value) => {
    const k = fakeKit();
    let message = '';
    try {
      discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, urgentMention: value as never });
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      message = (err as Error).message;
    }
    expect(message).toContain('urgentMention');
    if (typeof value === 'string' && value !== '') expect(message).not.toContain(value);
    expect(k.listeners.size).toBe(0);
  });

  it('a good one builds', () => {
    const k = fakeKit();
    expect(() => discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, urgentMention: URGENT_ROLE }).dispose()).not.toThrow();
  });
});

describe('report.handoff', () => {
  it('posts nothing: the feed does not even subscribe to it', async () => {
    const k = fakeKit();
    const r = k.addReport();
    const { d } = start(k, { urgentMention: URGENT_ROLE });
    expect([...k.listeners].map((l) => l.type)).not.toContain('report.handoff');
    await k.emit({ type: 'report.handoff', reportId: r.id, at: NOW } as KitEvent);
    await settle();
    expect(d.calls).toHaveLength(0);
  });
});
