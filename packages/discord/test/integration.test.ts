import { describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Platform, RawWho } from '@chatwarden/core';
import { discordFeed } from '../src/index.js';
import { MemoryStore } from '../../core/test/memoryStore.js';
import { ROLE, WEBHOOK, fakeDiscord, leaks, visibleTexts } from './support.js';

// The feed on the real kit: real events, real staff reports, real subject ids and report ids.

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const R = 'room-int';
const alice: RawWho = { clientKey: 'key-alice-int', ip: '198.51.100.1' };
const bob: RawWho = { clientKey: 'key-bob-int', ip: '198.51.100.2' };
const CHAT = 'INTEGRATION-CHAT-LINE hello from alice';
const NOTE = 'INTEGRATION-REPORTER-NOTE';
const REASON = 'INTEGRATION-PRIVATE-REASON';

const hubLink = (kind: 'report' | 'person', id: string): string => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`;
const idle = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
};

async function world() {
  const store = new MemoryStore();
  const clock = { now: () => NOW };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store, secret: 'int-secret', platform, clock, logger: { warn: () => undefined }, retention: false });
  cw.rooms.seat(R, 'a', alice, 'Alice');
  cw.rooms.seat(R, 'b', bob, 'Bob');
  cw.chat.accept(R, 'a', CHAT);
  const d = fakeDiscord();
  const feed = discordFeed(cw, { webhookUrl: WEBHOOK, hubLink, fetch: d.fetch, mentionRoleId: ROLE, clock, logger: { warn: () => undefined } });
  const a = cw.rooms.subjectAt(R, 'a') as string;
  return { cw, store, d, feed, a };
}

describe('discordFeed on the real kit', () => {
  it('a hate report opens a thread, pings the role, and the decision and its lift post into it', async () => {
    const { cw, d, a } = await world();
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'hate', note: NOTE });
    if (!res.ok) throw new Error('expected a stored report');
    await idle();
    expect(d.creates()).toHaveLength(1);
    expect(d.calls[0]!.body.thread_name).toMatch(/^Case [0-9A-HJKMNP-TV-Z]{5}$/);
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
    expect(String(d.calls[0]!.body.content)).toContain(`https://hub.example.test/report/${res.reportId}`);
    expect(String(d.calls[0]!.body.content)).toContain(`https://hub.example.test/person/${a}`);

    const decided = await cw.decide({
      reportId: res.reportId,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: REASON,
      actions: [{ subject: a, kind: 'chat', durationMs: 7 * 24 * H, rule: 1 }] as never,
    });
    expect(decided.ok).toBe(true);
    await idle();
    const groupId = decided.ok ? (decided.groups[0]?.groupId as string) : '';
    expect(await cw.sanctions.revoke(groupId, 'mod@example.test', REASON)).toBe(true);
    await idle();

    expect(d.creates()).toHaveLength(1);
    const texts = d.posts().map((c) => String(c.body.content));
    expect(texts.some((t) => t.includes('**Report closed** · Upheld'))).toBe(true);
    expect(texts.some((t) => t.includes('Chat restriction · 7 days'))).toBe(true);
    expect(texts.some((t) => t.includes('**Lifted**'))).toBe(true);
    for (const p of d.posts()) expect(p.url.searchParams.get('thread_id')).toBe('T1');
  });

  it('no visible text holds an id, a hash, chat text, the note or the reason', async () => {
    const { cw, d, a } = await world();
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'hate', note: NOTE });
    if (!res.ok) throw new Error('expected a stored report');
    const decided = await cw.decide({
      reportId: res.reportId,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: REASON,
      actions: [{ subject: a, kind: 'ban', durationMs: null, rule: 1 }] as never,
    });
    if (!decided.ok) throw new Error('expected a decision');
    await cw.sanctions.revoke(decided.groups[0]?.groupId as string, 'mod@example.test', REASON);
    await idle();
    expect(d.calls.length).toBeGreaterThanOrEqual(4);
    const groupIds = decided.groups.map((g) => g.groupId);
    const forbidden = [a, res.reportId, ...groupIds, CHAT, NOTE, REASON, 'Alice', 'Bob', 'key-alice-int', 'mod@example.test'];
    for (const c of d.calls) for (const text of visibleTexts(c.body)) expect(leaks(text, forbidden)).toEqual([]);
    const wire = d.calls.map((c) => JSON.stringify(c.body)).join('\n');
    for (const secret of [CHAT, NOTE, REASON, 'mod@example.test']) expect(wire).not.toContain(secret);
  });

  it('a second report about the same person reuses the thread, also after the feed restarts', async () => {
    const w = await world();
    const first = await w.cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    expect(first.ok).toBe(true);
    await idle();
    w.feed.dispose();
    const d2 = fakeDiscord();
    const feed2 = discordFeed(w.cw, { webhookUrl: WEBHOOK, hubLink, fetch: d2.fetch, logger: { warn: () => undefined } });
    w.cw.rooms.seat('room-int-2', 'b', bob, 'Bob');
    w.cw.rooms.seat('room-int-2', 'a', alice, 'Alice');
    w.cw.chat.accept('room-int-2', 'a', 'a second line');
    const second = await w.cw.reports.submit({ roomId: 'room-int-2', reporterSeat: 'b', targetSeat: 'a', category: 'spam' });
    expect(second.ok).toBe(true);
    await idle();
    expect(d2.creates()).toHaveLength(0);
    expect(d2.posts()).toHaveLength(1);
    expect(d2.posts()[0]!.url.searchParams.get('thread_id')).toBe('T1');
    feed2.dispose();
  });

  it('the kit stays healthy when Discord is down: reports still store', async () => {
    const store = new MemoryStore();
    const platform: Platform = { identify: (ctx) => ctx as RawWho };
    const cw = await createChatwarden({ store, secret: 'int-secret', platform, clock: { now: () => NOW }, logger: { warn: () => undefined }, retention: false });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.chat.accept(R, 'a', CHAT);
    const feed = discordFeed(cw, {
      webhookUrl: WEBHOOK,
      hubLink,
      fetch: (() => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
      logger: { warn: () => undefined },
    });
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'hate' });
    expect(res.ok).toBe(true);
    expect(cw.reports.list().items).toHaveLength(1);
    feed.dispose();
  });
});
