import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KitEvent } from '@chatwarden/core';
import { discordFeed } from '../src/feed.js';
import type { FeedKit } from '../src/feed.js';
import { NOW, WEBHOOK, fakeDiscord, settle } from './support.js';

// The staff feed names the report's reason when there is one (0.2.2, audit C3): "Leaving or AFK", not the 0.1.1 category "Disruption" it is kept under. A report
// with no reason, or a reason this kit does not list, reads as it always did.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const SUBJECT = 's_aaaaaaaaaaaaaaaaaaaaaa';
const REASONS = [
  { id: 'afk', label: 'Leaving or AFK' },
  { id: 'name', label: 'Inappropriate name' },
  { id: 'other', label: 'Something else' },
];

function kitWith(reportedReason: string | null, category: string, reasons: unknown = REASONS) {
  const listeners: Array<{ type: string; fn: (e: KitEvent) => unknown }> = [];
  const report = { id: 'rep_aaaaaaaaaaaaaaaaaaaaaa', category, reportedReason, targetPerson: SUBJECT, targetHandle: 'h', note: '', excerpt: [] };
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      listeners.push({ type, fn });
      return () => undefined;
    },
    reports: { get: () => report },
    profile: { severeRules: undefined, ...(reasons === null ? {} : { reporting: { reasons } }) },
    rules: { all: () => [{ number: 6, title: 'No throwing', text: 'x' }] },
    limits: { strikes: { firstMs: 3_600_000, repeatMs: 86_400_000 } },
    people: { canonical: (id: string) => id, aliases: (id: string) => [id] },
    discordThreads: { get: () => null, put: () => undefined },
  } as unknown as FeedKit;
  const d = fakeDiscord();
  discordFeed(kit, { webhookUrl: WEBHOOK, hubLink: (k, id) => `https://hub.example.test/${k}/${id}`, fetch: d.fetch, random: () => 0.5 });
  const emit = async (e: KitEvent): Promise<void> => {
    await Promise.all(listeners.filter((l) => l.type === e.type || l.type === '*').map((l) => l.fn(e)));
    await settle();
  };
  const text = (): string => String(d.calls[0]?.body.content);
  return { emit, text, d, report };
}
const created = (category: string, reportedReason: string | null): KitEvent =>
  ({ type: 'report.created', reportId: 'rep_aaaaaaaaaaaaaaaaaaaaaa', createdAt: NOW, category, reportedReason, urgent: false, roomTags: {} }) as KitEvent;

describe('report.created', () => {
  it('names the reason: Leaving or AFK, not Disruption', async () => {
    const k = kitWith('afk', 'disruption');
    await k.emit(created('disruption', 'afk'));
    expect(k.text()).toContain('Category: Leaving or AFK');
    expect(k.text()).not.toContain('Disruption');
  });
  it('a name report is named, not "Other"', async () => {
    const k = kitWith('name', 'other');
    await k.emit(created('other', 'name'));
    expect(k.text()).toContain('Category: Inappropriate name');
  });
  it('no reason: the category, as before', async () => {
    const k = kitWith(null, 'harassment');
    await k.emit(created('harassment', null));
    expect(k.text()).toContain('Category: Harassment');
  });
  it('a reason this kit does not list, and a kit that has no reporting settings: the category, as before', async () => {
    const a = kitWith('zorbak', 'disruption');
    await a.emit(created('disruption', 'zorbak'));
    expect(a.text()).toContain('Category: Disruption');
    const b = kitWith('afk', 'disruption', null);
    await b.emit(created('disruption', 'afk'));
    expect(b.text()).toContain('Category: Disruption');
  });
  it('the label is plain staff text: nothing from the report is added', async () => {
    const k = kitWith('afk', 'disruption', [{ id: 'afk', label: 'Leaving **or** <@123> AFK' }]);
    await k.emit(created('disruption', 'afk'));
    expect(k.text()).not.toContain('<@123>');
  });
});

describe('report.closed', () => {
  it('names the reason too', async () => {
    const k = kitWith('afk', 'disruption');
    await k.emit({ type: 'report.closed', reportId: 'rep_aaaaaaaaaaaaaaaaaaaaaa', verdict: 'upheld', at: NOW } as KitEvent);
    expect(k.text()).toContain('Category: Leaving or AFK');
  });
});
