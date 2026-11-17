import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordThreadRow, KitEvent } from '@chatwarden/core';
import { discordFeed } from '../src/feed.js';
import type { FeedKit } from '../src/feed.js';
import { NOW, WEBHOOK, fakeDiscord, leaks, settle } from './support.js';

// F6: a report a chat filter filed posts as "Filter: Links" (or the phrase rule's label), with no reporter line: there is no reporter.

const id22 = (): string => randomBytes(16).toString('base64url');
const sid = (): string => `s_${id22()}`;
const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Report {
  category: string;
  targetPerson: string;
  origin?: string;
  originKey?: string;
  reporterPerson?: string | null;
}

function fakeKit(phrases: Array<{ id: string; label: string }> = []) {
  const listeners = new Set<{ type: string; fn: (e: KitEvent) => unknown }>();
  const threads = new Map<string, DiscordThreadRow>();
  const reports = new Map<string, Report>();
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      const entry = { type, fn };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    reports: { get: (id: string) => reports.get(id) ?? null },
    profile: { severeRules: undefined, filters: { phrases } },
    rules: { all: () => [{ number: 2, title: 'Respect others' }, { number: 4, title: 'No spam' }] },
    limits: { strikes: { firstMs: 3_600_000, repeatMs: 86_400_000 } },
    people: { canonical: (id: string) => id, aliases: (id: string) => [id] },
    discordThreads: {
      get: (subject: string) => threads.get(subject) ?? null,
      put: (row: DiscordThreadRow) => void threads.set(row.subject, { ...row }),
    },
  };
  const emit = async (e: KitEvent): Promise<void> => {
    await Promise.all([...listeners].filter((l) => l.type === '*' || l.type === e.type).map((l) => l.fn(e)));
  };
  return { kit: kit as unknown as FeedKit, reports, emit };
}

const created = (reportId: string, over: Record<string, unknown> = {}): KitEvent =>
  ({ type: 'report.created', reportId, createdAt: NOW, category: 'spam', reportedReason: 'spam', roomTags: {}, ...over }) as KitEvent;

async function post(report: Report | null, event: Record<string, unknown> = {}, phrases: Array<{ id: string; label: string }> = []) {
  const k = fakeKit(phrases);
  const reportId = 'rep-' + id22().slice(0, 8);
  if (report !== null) k.reports.set(reportId, report);
  const d = fakeDiscord();
  discordFeed(k.kit, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, random: () => 0.5, clock: { now: () => Date.now() } });
  await k.emit(created(reportId, event));
  await settle();
  return { d, text: d.calls.length === 0 ? '' : String(d.calls[0]!.body.content), reportId };
}

describe('the report.created post of a filter report', () => {
  it('Filter: Links, no reporter line, the hub links, the category and the rule', async () => {
    const target = sid();
    const { text, reportId, d } = await post({ category: 'spam', targetPerson: target, origin: 'filter', originKey: 'link.unlisted', reporterPerson: null }, { origin: 'filter' });
    expect(d.calls).toHaveLength(1);
    expect(text).toContain('Filter: Links');
    expect(text).toContain('Category:');
    expect(text).toContain(`[Open report](<${hubLink('report', reportId)}>)`);
    expect(text).not.toMatch(/reporter/i);
    expect(text).not.toContain('link.unlisted');
  });

  it('personal info and ratio keys read as Personal info and Shouting and repeats; any link kind reads as Links', async () => {
    for (const [key, label] of [
      ['personal_info.phone', 'Personal info'],
      ['personal_info.email', 'Personal info'],
      ['ratio.caps', 'Shouting and repeats'],
      ['ratio.emoji', 'Shouting and repeats'],
      ['link.invite', 'Links'],
      ['link.new_account', 'Links'],
    ] as const) {
      const { text } = await post({ category: 'spam', targetPerson: sid(), origin: 'filter', originKey: key }, { origin: 'filter' });
      expect(text, key).toContain(`Filter: ${label}`);
    }
  });

  it('a phrase key reads as the rule\'s label (escaped, cut), or as Phrase when the rule is gone', async () => {
    const withLabel = await post({ category: 'spam', targetPerson: sid(), origin: 'filter', originKey: 'phrase.ads' }, { origin: 'filter' }, [{ id: 'ads', label: 'Gold ads' }]);
    expect(withLabel.text).toContain('Filter: Gold ads');
    const gone = await post({ category: 'spam', targetPerson: sid(), origin: 'filter', originKey: 'phrase.ads' }, { origin: 'filter' }, []);
    expect(gone.text).toContain('Filter: Phrase');
    const hostile = await post({ category: 'spam', targetPerson: sid(), origin: 'filter', originKey: 'phrase.x' }, { origin: 'filter' }, [{ id: 'x', label: '@everyone [x](<http://e.test>) '.repeat(10) }]);
    expect(hostile.text).not.toContain('@everyone');
    expect(hostile.text).not.toContain('http://e.test');
    expect(hostile.text.length).toBeLessThan(2000);
  });

  it('a key that is none of the known families reads as the plain word Filter, never the raw key', async () => {
    const { text } = await post({ category: 'spam', targetPerson: sid(), origin: 'filter', originKey: 'weird.thing' }, { origin: 'filter' });
    expect(text).toContain('Filter');
    expect(text).not.toContain('weird.thing');
  });

  it('an ordinary report has no Filter line and posts as before', async () => {
    const { text } = await post({ category: 'harassment', targetPerson: sid() });
    expect(text).not.toContain('Filter');
    expect(text).toContain('Category:');
  });

  it('an event with an origin but a report the kit can no longer read still posts, as Filter', async () => {
    const { text, d } = await post(null, { origin: 'filter' });
    expect(d.calls).toHaveLength(1);
    expect(text).not.toMatch(/reporter/i);
  });

  it('no subject id, hash or opaque id is in the visible text', async () => {
    const target = sid();
    const { text } = await post({ category: 'spam', targetPerson: target, origin: 'filter', originKey: 'link.unlisted' }, { origin: 'filter' });
    expect(leaks(text, [target])).toEqual([]);
  });
});
