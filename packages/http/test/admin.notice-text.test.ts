import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Matcher, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createRouter, playerRoutes } from '@chatwarden/http';
import { world } from './world.js';

// `GET /reports/:id`: each excerpt line that is some person's own gains `noticeText`, the text the player's notice would show for it
// (`cw.notices.lineText`). `GET /policy` carries `notices.reporterFeedback`. Synthetic terms only: zorbak, vlemmo.

const matcher: Matcher = {
  match: (t) => (/zorbak|vlemmo/i.test(t) ? { termId: 'syn:zorbak' } : null),
  spans: (t) => {
    const out: Array<{ start: number; end: number; termId: string }> = [];
    for (const m of t.matchAll(/zorbak|vlemmo/gi)) out.push({ start: m.index, end: m.index + m[0].length, termId: 'syn' });
    return out;
  },
};

type W = Awaited<ReturnType<typeof world>>;
type Line = { lineId: string; raw: string; delivered: string | null; blocked: boolean; p: number | null; noticeText?: string };

/** A report against the target (p2) with lines from both people, a blocked one among them. */
async function filed(w: W) {
  const room = 'notice-text-room';
  w.cw.rooms.seat(room, 'p1', { clientKey: 'raw-reporter-key-0001', ip: '198.51.100.23' }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: 'raw-target-key-0001', ip: '203.0.113.99' }, 'Tgt');
  w.cw.chat.accept(room, 'p2', 'a clean line from the target');
  w.cw.chat.accept(room, 'p2', 'you zorbak and vlemmo');
  w.cw.chat.accept(room, 'p1', 'the reporter says hello');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  return res.reportId;
}

const reportOf = async (w: W, id: string) => {
  const res = await w.call('GET', `/reports/${id}`);
  expect(res.status).toBe(200);
  return (res.body as { report: { excerpt: Line[]; ownLineIds: Record<string, string[]>; targetPerson: string; reporterPerson: string } }).report;
};

describe('GET /reports/:id: noticeText on each own line', () => {
  it('every own line of the target carries noticeText, equal to cw.notices.lineText of the stored line', async () => {
    const w = await world({ matcher });
    const id = await filed(w);
    const r = await reportOf(w, id);
    const own = new Set(r.ownLineIds[r.targetPerson]);
    expect(own.size).toBeGreaterThanOrEqual(2);
    const stored = w.cw.reports.get(id)?.excerpt ?? [];
    for (const l of r.excerpt.filter((x) => own.has(x.lineId))) {
      expect(typeof l.noticeText, l.lineId).toBe('string');
      expect(l.noticeText).toBe(w.cw.notices.lineText(stored.find((s) => s.lineId === l.lineId)!));
    }
  });

  it('the text is never raw for a blocked line: only the matched terms are starred', async () => {
    const w = await world({ matcher });
    const r = await reportOf(w, await filed(w));
    const blocked = r.excerpt.filter((l) => l.blocked);
    expect(blocked.length).toBeGreaterThan(0);
    for (const l of blocked) {
      expect(l.noticeText).toBe('you ****** and ******');
      expect(l.noticeText).not.toMatch(/zorbak|vlemmo/i);
    }
  });

  it('a delivered line reads as delivered; a blocked line with a matcher that cannot say where is all stars', async () => {
    const w = await world({ matcher: { match: matcher.match } });
    const r = await reportOf(w, await filed(w));
    expect(r.excerpt.find((l) => l.raw === 'a clean line from the target')?.noticeText).toBe('a clean line from the target');
    expect(r.excerpt.find((l) => l.blocked)?.noticeText).toBe('*'.repeat('you zorbak and vlemmo'.length));
  });

  it('only a line somebody wrote carries noticeText: the key is there exactly for the lines in ownLineIds', async () => {
    const w = await world({ matcher });
    const r = await reportOf(w, await filed(w));
    const own = new Set(Object.values(r.ownLineIds).flat());
    expect(own.size).toBeGreaterThan(0);
    for (const l of r.excerpt) expect(Object.hasOwn(l, 'noticeText'), l.lineId).toBe(own.has(l.lineId));
  });

  it('a line with no writer carries no noticeText', async () => {
    const w = await world({
      matcher,
      wrap: (cw) => ({
        ...cw,
        reports: {
          ...cw.reports,
          get: (rid: string) => {
            const rep = cw.reports.get(rid);
            if (rep === null) return null;
            // The excerpt as a store could hold it: the last line has no writer.
            const excerpt = rep.excerpt.map((l, i, all) => (i === all.length - 1 ? { ...l, p: null } : l));
            return { ...rep, excerpt, ownLineIds: Object.fromEntries(Object.entries(rep.ownLineIds).map(([k, v]) => [k, v.filter((x) => x !== excerpt.at(-1)?.lineId)])) };
          },
        },
      }),
    });
    const id = await filed(w);
    const r = await reportOf(w, id);
    const last = r.excerpt.at(-1) as Line;
    expect(last.p).toBeNull();
    expect(Object.hasOwn(last, 'noticeText')).toBe(false);
    expect(r.excerpt.slice(0, -1).every((l) => typeof l.noticeText === 'string')).toBe(true);
  });

  it('a line that cannot be worded does not turn the whole report into a 500: it has no noticeText, the others keep theirs, and a warning is logged by class', async () => {
    const w = await world({
      matcher,
      wrap: (cw) => ({
        ...cw,
        reports: {
          ...cw.reports,
          get: (rid: string) => {
            const rep = cw.reports.get(rid);
            if (rep === null) return null;
            // A stored line with no raw text (a damaged row): `lineText` throws for it.
            const excerpt = rep.excerpt.map((l, i) => (i === 0 ? ({ ...l, raw: undefined } as never) : l));
            return { ...rep, excerpt };
          },
        },
      }),
    });
    const id = await filed(w);
    const r = await reportOf(w, id);
    const own = new Set(Object.values(r.ownLineIds).flat());
    const first = r.excerpt[0] as Line;
    expect(own.has(first.lineId)).toBe(true);
    expect(Object.hasOwn(first, 'noticeText')).toBe(false);
    for (const l of r.excerpt.slice(1)) expect(Object.hasOwn(l, 'noticeText'), l.lineId).toBe(own.has(l.lineId));
    expect(r.excerpt.slice(1).some((l) => typeof l.noticeText === 'string')).toBe(true);
    const warned = w.logged.filter(([event]) => event === 'chatwarden.http_notice_text_failed');
    expect(warned).toHaveLength(1);
    // By class only: no line, no text.
    expect(JSON.stringify(warned)).not.toMatch(/zorbak|vlemmo|clean line/);
  });

  it('adds one key to a line and changes nothing else on it', async () => {
    const w = await world({ matcher });
    const id = await filed(w);
    const r = await reportOf(w, id);
    const stored = JSON.parse(JSON.stringify(w.cw.reports.get(id))) as { excerpt: Array<Record<string, unknown>> };
    for (const [i, l] of r.excerpt.entries()) {
      // 0.2.0 adds `retracted` and `removable` to every excerpt line of the case read: staff's view of the room's evidence, not part of the stored line.
      const { noticeText, retracted, removable, ...rest } = l as Record<string, unknown>;
      expect(typeof noticeText).toBe('string');
      expect([typeof retracted, typeof removable]).toEqual(['boolean', 'boolean']);
      expect(rest).toEqual({ ...stored.excerpt[i] });
    }
  });

  it('a decided report keeps its noticeText', async () => {
    const w = await world({ matcher });
    const id = await filed(w);
    const r0 = await reportOf(w, id);
    const res = await w.call('POST', `/reports/${id}/decide`, { role: 'senior', body: { verdict: 'no_action', actions: [], reason: 'looked at it' } });
    expect(res.status).toBe(200);
    const r1 = await reportOf(w, id);
    expect(r1.excerpt.map((l) => l.noticeText)).toEqual(r0.excerpt.map((l) => l.noticeText));
  });
});

describe('GET /policy carries notices.reporterFeedback', () => {
  it('true by default', async () => {
    const w = await world();
    const res = await w.call('GET', '/policy');
    expect((res.body as { notices: unknown }).notices).toEqual({ reporterFeedback: true });
  });

  it('false when limits say so, and the other keys are as before', async () => {
    const w = await world({ limits: { reporterFeedback: false } });
    const res = await w.call('GET', '/policy');
    const body = res.body as Record<string, unknown>;
    expect(body.notices).toEqual({ reporterFeedback: false });
    expect(Object.keys(body).sort()).toEqual(['documents', 'notices', 'profile', 'rules', 'summary']);
  });
});

describe('no-leak: nothing player-visible changes; staff-only fields stay staff-only', () => {
  it('the public rules answer carries neither noticeText nor the policy field', async () => {
    const cw = await createChatwarden({
      store: openStore({ db: new DatabaseSync(':memory:') }),
      secret: 'notice-text-player',
      platform: { identify: (ctx) => ctx as RawWho },
      retention: false,
    });
    const router = createRouter(playerRoutes(cw, { identify: () => ({}) }));
    const res = await router({ method: 'GET', path: '/rules', query: {}, headers: {}, body: undefined });
    expect(Object.keys(res.body as object).sort()).toEqual(['reporting', 'rules', 'summary']);
    expect(JSON.stringify(res.body)).not.toMatch(/noticeText|reporterFeedback/);
  });

  it('the staff queue (GET /reports) carries no excerpt and so no noticeText', async () => {
    const w = await world({ matcher });
    await filed(w);
    const res = await w.call('GET', '/reports');
    expect(JSON.stringify(res.body)).not.toContain('noticeText');
  });
});
