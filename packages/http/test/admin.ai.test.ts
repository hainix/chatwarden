import { describe, expect, it } from 'vitest';
import { AIError, fakeRead } from '@chatwarden/core';
import type { AIReadInput, FakeScript, FakeStep } from '@chatwarden/core';
import type { KitResponse } from '@chatwarden/http';
import { DAY, HOUR, IP_TARGET, KEY_TARGET, MIN, SECRET, errorOf, keysDeep, world } from './world.js';
import type { WorldOptions } from './world.js';

// The AI over HTTP: the queue brief, the read on the case page, read again, the status line, the decision echo and "don't teach".
// Everything runs on the scripted fake adapter; no network, no key.

const ownRef = (input: AIReadInput): string => input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1';
/** A fake that reads every case as `severity`, recommending `verdict` under rule 2 and citing the reported player's first line. */
const reads =
  (verdict: 'upheld' | 'noted' | 'no_action' | 'unclear', severity: 'banter' | 'rude' | 'hostile' | 'severe' = 'rude') =>
  (input: AIReadInput): FakeStep => ({
    output: fakeRead(input, {
      severity,
      rule: 2,
      evidence: [ownRef(input)],
      recommendation: { verdict, severity, rule: 2, evidence: verdict === 'no_action' || verdict === 'unclear' ? [] : [ownRef(input)] },
    }),
  });

type AiWorld = Awaited<ReturnType<typeof aiWorld>>;
async function aiWorld(level: 0 | 1 | 2 = 2, script: FakeScript = reads('upheld'), more: WorldOptions = {}) {
  const w = await world({ ...more, ai: { level, script, ...(more.ai ?? {}) } });
  const idle = () => w.cw.ai.idle();
  return { ...w, idle, adapter: w.adapter as NonNullable<typeof w.adapter> };
}
/** An open report that the AI has read. */
async function readReport(w: AiWorld) {
  const f = await w.file();
  await w.idle();
  w.clock.t += 1000;
  return f;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire shapes are asserted field by field below
const body = (res: KitResponse) => res.body as Record<string, any>;
const decideBody = (f: { target: string }, ai: unknown, over: Record<string, unknown> = {}) => ({
  verdict: 'upheld',
  actions: [{ subject: f.target, kind: 'warning', durationMs: null, rule: 2 }],
  reason: 'rude to a teammate',
  ai,
  ...over,
});

describe('the queue carries a brief and nothing else', () => {
  it('a queue item carries ai brief only and no text', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const res = await w.call('GET', '/reports', { query: { status: 'open' } });
    expect(res.status).toBe(200);
    const item = body(res).items.find((i: { id: string }) => i.id === f.id);
    expect(item.ai).toEqual({ severity: 'rude', confidence: 'medium', rule: 2, stale: false, injectionSuspected: false, hasRecommendation: true });
    // No summary, no line id, no model: a brief and nothing of the evidence.
    const text = JSON.stringify(item);
    expect(text).not.toContain('The reported player was rude');
    const lineIds = (w.cw.reports.get(f.id)?.excerpt ?? []).map((l) => l.lineId);
    for (const id of lineIds.filter((id) => id.length >= 6)) expect(text).not.toContain(id);
    expect(Object.keys(item.ai).sort()).toEqual(['confidence', 'hasRecommendation', 'injectionSuspected', 'rule', 'severity', 'stale']);
  });

  it('an item with no read yet, and a decided item, have ai null', async () => {
    const w = await aiWorld(2, reads('upheld'));
    const unread = await w.file();
    // The read is made off the ack path: right after filing there is none.
    const early = body(await w.call('GET', '/reports', { query: { status: 'open' } })).items;
    expect(early.find((i: { id: string }) => i.id === unread.id).ai).toBeNull();
    const read = await readReport(w);
    await w.call('POST', `/reports/${read.id}/decide`, { body: { verdict: 'no_action', actions: [] } });
    const decided = body(await w.call('GET', '/reports', { query: { status: 'dismissed' } })).items;
    expect(decided.find((i: { id: string }) => i.id === read.id).ai).toBeNull();
  });

  it('at level 1 the brief says there is no recommendation', async () => {
    const w = await aiWorld(1);
    const f = await readReport(w);
    const item = body(await w.call('GET', '/reports', { query: { status: 'open' } })).items.find((i: { id: string }) => i.id === f.id);
    expect(item.ai).toMatchObject({ severity: 'rude', hasRecommendation: false });
  });

  it('a read made from older rules is marked stale in the brief', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    await w.cw.reports.addDetail(f.id, 'p1', { note: 'it kept going' });
    const item = body(await w.call('GET', '/reports', { query: { status: 'open' } })).items.find((i: { id: string }) => i.id === f.id);
    expect(item.ai.stale).toBe(true);
  });

  it('a server with the AI off returns exactly the previous bodies (field ai: null aside)', async () => {
    const off = await world();
    const withoutAdapter = await off.file();
    const on = await aiWorld(0);
    const atLevelZero = await on.file();
    for (const [w, f] of [[off, withoutAdapter], [on, atLevelZero]] as const) {
      const list = body(await w.call('GET', '/reports', { query: { status: 'open' } })).items[0];
      expect(list.ai).toBeNull();
      const rest = { ...list };
      delete rest.ai;
      expect(Object.keys(rest).sort()).toEqual(
        ['actionedAt', 'actionedBy', 'badFaith', 'category', 'claim', 'createdAt', 'id', 'reportedReason', 'reportedReasonLabel', 'reporterAccuracy', 'reporterHandle', 'reporterPerson', 'roomId', 'status', 'tags', 'targetHandle', 'targetPerson', 'viewing'].sort(),
      );
      const page = body(await w.call('GET', `/reports/${f.id}`));
      expect(page.ai).toBeNull();
      expect(Object.keys(page).sort()).toEqual(['ai', 'claim', 'history', 'report', 'rule', 'suggest']);
    }
    expect(on.adapter.callCount).toBe(0);
  });
});

describe('the case page', () => {
  it('a report page without a read has ai null', async () => {
    const w = await aiWorld();
    const f = await w.file();
    const page = body(await w.call('GET', `/reports/${f.id}`));
    expect(page.ai).toBeNull();
  });

  describe('aiExpected says whether a read is on its way (present when the AI is on)', () => {
    const expected = async (w: AiWorld, id: string) => body(await w.call('GET', `/reports/${id}`)).aiExpected;

    it('is a boolean, true while the AI is on and healthy (with or without a read yet)', async () => {
      const w = await aiWorld(1);
      const f = await w.file();
      expect(await expected(w, f.id)).toBe(true);
      await w.idle();
      w.clock.t += 1000;
      const page = body(await w.call('GET', `/reports/${f.id}`));
      expect(page.ai).not.toBeNull();
      expect(page.aiExpected).toBe(true);
    });

    it('is absent at level 0 and with no adapter: the page is exactly as before', async () => {
      const off = await aiWorld(0);
      expect(await expected(off, (await off.file()).id)).toBeUndefined();
      const none = await world({});
      const f = await none.file();
      expect(body(await none.call('GET', `/reports/${f.id}`))).not.toHaveProperty('aiExpected');
    });

    it('is false while the breaker is open', async () => {
      const w = await aiWorld(1, [{ error: new AIError('fatal') }]);
      const a = await w.file();
      await w.idle();
      expect(w.cw.ai.status().state).toBe('unavailable');
      const b = await w.file();
      expect(await expected(w, b.id)).toBe(false);
      expect(await expected(w, a.id)).toBe(false);
    });

    it('is false at the daily money cap and at the daily call ceiling', async () => {
      const money = await aiWorld(1, reads('upheld'), { ai: { options: { dailyBudgetMicros: 0 } } });
      expect(await expected(money, (await money.file()).id)).toBe(false);
      const calls = await aiWorld(1, reads('upheld'), { overrides: { ai: { dailyCalls: 1 } } });
      await calls.file();
      await calls.idle();
      expect(calls.cw.ai.status().state).toBe('paused_budget');
      const later = await calls.file();
      expect(await expected(calls, later.id)).toBe(false);
    });

    it('is false for a read that ended without an answer, and true for the next report', async () => {
      const w = await aiWorld(1, [{ error: new AIError('declined') }]);
      const a = await w.file();
      await w.idle();
      const b = await w.file();
      expect(await expected(w, a.id)).toBe(false);
      expect(await expected(w, b.id)).toBe(true);
    });

    it('opening a case in a degraded mode queues no read and the page is otherwise unchanged', async () => {
      const w = await aiWorld(1, reads('upheld'), { ai: { options: { dailyBudgetMicros: 0 } } });
      const f = await w.file();
      const page = body(await w.call('GET', `/reports/${f.id}`));
      expect(page.ai).toBeNull();
      expect(page.aiExpected).toBe(false);
      await w.idle();
      expect(w.adapter.callCount).toBe(0);
    });
  });

  it('opening a case with no read yet queues one', async () => {
    const w = await aiWorld(0);
    const f = await w.file();
    expect((await w.call('PUT', '/policy/profile', { role: 'owner', body: { layer: { ai: { level: 1 } }, version: 0, reason: 'on' } })).status).toBe(200);
    // Switched on after the report was filed: the first open asks for the read, and a second open asks for nothing more.
    expect(body(await w.call('GET', `/reports/${f.id}`)).ai).toBeNull();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    w.clock.t += 1000;
    expect(body(await w.call('GET', `/reports/${f.id}`)).ai).not.toBeNull();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('at level 1 the page has no recommendation', async () => {
    const w = await aiWorld(1);
    const f = await readReport(w);
    const ai = body(await w.call('GET', `/reports/${f.id}`)).ai;
    expect(ai).toMatchObject({ severity: 'rude', rule: 2, stale: false, injectionSuspected: false, confidence: 'medium', recommendation: null });
    expect(Object.keys(ai).sort()).toEqual(['at', 'confidence', 'evidenceLineIds', 'id', 'injectionSuspected', 'model', 'recommendation', 'rule', 'severity', 'stale', 'summary']);
    expect(ai.summary).toBe('The reported player was rude in chat.');
    expect(ai.model).toBe('fake-1');
    expect(ai.at).toBe(w.clock.t - 1000);
  });

  it('at level 2 it has step and stepWithinCeiling', async () => {
    const w = await aiWorld(2);
    const f = await readReport(w);
    const ai = body(await w.call('GET', `/reports/${f.id}`)).ai;
    expect(ai.recommendation).toMatchObject({ verdict: 'upheld', severity: 'rude', rule: 2 });
    expect(Object.keys(ai.recommendation).sort()).toEqual(['evidenceLineIds', 'rule', 'severity', 'step', 'stepWithinCeiling', 'verdict']);
    // The step is the ladder's, computed now, for the AI's conduct level.
    const suggested = body(await w.call('POST', `/reports/${f.id}/suggest`, { body: { level: 'rude' } }));
    expect(suggested.label).toBe(ai.recommendation.step.label);
    expect(ai.recommendation.stepWithinCeiling).toBe(true);
    // The cited lines are the reported player's, by their real ids.
    const own = new Set((w.cw.reports.get(f.id)?.excerpt ?? []).map((l) => l.lineId));
    expect(ai.recommendation.evidenceLineIds.length).toBeGreaterThan(0);
    for (const id of ai.recommendation.evidenceLineIds) expect(own.has(id)).toBe(true);
  });

  it('a 7 day ban step has stepWithinCeiling false', async () => {
    const w = await aiWorld(2, reads('upheld', 'hostile'), {
      overrides: { firstOffense: { hostile: { kind: 'ban', durationMs: 7 * DAY } } },
    });
    const f = await readReport(w);
    const rec = body(await w.call('GET', `/reports/${f.id}`)).ai.recommendation;
    expect(rec.step).toMatchObject({ kind: 'ban', durationMs: 7 * DAY });
    expect(rec.stepWithinCeiling).toBe(false);
  });

  it('a 24 hour chat restriction has it true, and so do a warning and a note', async () => {
    const chat = await aiWorld(2, reads('upheld', 'rude'), { overrides: { firstOffense: { rude: { kind: 'chat', durationMs: 24 * HOUR } } } });
    const a = await readReport(chat);
    expect(body(await chat.call('GET', `/reports/${a.id}`)).ai.recommendation).toMatchObject({ step: { kind: 'chat', durationMs: 24 * HOUR }, stepWithinCeiling: true });
    const warn = await aiWorld(2, reads('upheld', 'rude'), { overrides: { firstOffense: { rude: 'warning' } } });
    const b = await readReport(warn);
    expect(body(await warn.call('GET', `/reports/${b.id}`)).ai.recommendation).toMatchObject({ step: { kind: 'warning', durationMs: null }, stepWithinCeiling: true });
    const noted = await aiWorld(2, reads('noted', 'rude'));
    const c = await readReport(noted);
    expect(body(await noted.call('GET', `/reports/${c.id}`)).ai.recommendation).toMatchObject({ verdict: 'noted', step: { kind: 'note', durationMs: null }, stepWithinCeiling: true });
  });

  it('an area ban and a restriction over 24 hours are outside the ceiling too', async () => {
    const area = await aiWorld(2, reads('upheld', 'hostile'), { overrides: { firstOffense: { hostile: { kind: 'area', durationMs: 12 * HOUR } } } });
    const a = await readReport(area);
    expect(body(await area.call('GET', `/reports/${a.id}`)).ai.recommendation).toMatchObject({ step: { kind: 'area' }, stepWithinCeiling: false });
    const long = await aiWorld(2, reads('upheld', 'hostile'), { overrides: { firstOffense: { hostile: { kind: 'chat', durationMs: 25 * HOUR } } } });
    const b = await readReport(long);
    expect(body(await long.call('GET', `/reports/${b.id}`)).ai.recommendation).toMatchObject({ step: { kind: 'chat', durationMs: 25 * HOUR }, stepWithinCeiling: false });
  });

  it('a no_action or unclear recommendation names no step', async () => {
    for (const verdict of ['no_action', 'unclear'] as const) {
      const w = await aiWorld(2, reads(verdict, 'banter'));
      const f = await readReport(w);
      expect(body(await w.call('GET', `/reports/${f.id}`)).ai.recommendation).toMatchObject({ verdict, step: null, stepWithinCeiling: true });
    }
  });

  it('is audited as report.view, once, and stays quiet when the AI is broken', async () => {
    const w = await aiWorld(2, () => Promise.reject(new Error('provider down')));
    const f = await w.file();
    await w.idle();
    const views = () => w.routeAudit().filter((r) => r.action === 'report.view').length;
    const before = views();
    const res = await w.call('GET', `/reports/${f.id}`);
    expect(res.status).toBe(200);
    expect(body(res).ai).toBeNull();
    expect(views()).toBe(before + 1);
  });
});

describe('read again', () => {
  it('read-again returns ready without calling the adapter when the hash is unchanged', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const calls = w.adapter.callCount;
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(200);
    expect(body(res).status).toBe('ready');
    expect(body(res).ai).toEqual(body(await w.call('GET', `/reports/${f.id}`)).ai);
    await w.idle();
    expect(w.adapter.callCount).toBe(calls);
  });

  it('pending when a call is made', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    w.clock.t += 1000;
    await w.cw.reports.addDetail(f.id, 'p1', { note: 'more' });
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'pending' });
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
  });

  it('ai_off at level 0, with no call and no audit row', async () => {
    const w = await aiWorld(0);
    const f = await w.file();
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('ai_off');
    expect(w.adapter.callCount).toBe(0);
    expect(w.routeAudit().filter((r) => r.action === 'ai.rerun')).toHaveLength(0);
  });

  it('ai_off when no adapter is configured', async () => {
    const w = await world();
    const f = await w.file();
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('ai_off');
  });

  it('ai_budget at the cap', async () => {
    const w = await aiWorld(1, reads('upheld'), { ai: { options: { dailyBudgetMicros: 0 } } });
    const f = await w.file();
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(429);
    expect(errorOf(res)).toBe('ai_budget');
    expect(w.adapter.callCount).toBe(0);
  });

  it('read-again is audited as ai.rerun by the caller', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    await w.call('POST', `/reports/${f.id}/ai/read`, { role: 'senior', actor: 'sam' });
    const rows = w.cw.audit.list({ limit: 20, action: 'ai.rerun' }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'sam', role: 'senior', action: 'ai.rerun', target: { type: 'report', ref: f.id } });
    expect(rows[0]?.detail).toBeUndefined();
  });

  it('a viewer-only role cannot read again', async () => {
    // The adopter raises "decide" above moderators: a moderator who may only read cases cannot ask for another call.
    const w = await aiWorld(2, reads('upheld'), { permissions: { 'reports.decide': 'senior' } });
    const f = await readReport(w);
    const res = await w.call('POST', `/reports/${f.id}/ai/read`, { role: 'moderator' });
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe('forbidden');
    expect(w.routeAudit().filter((r) => r.action === 'ai.rerun')).toHaveLength(0);
    expect((await w.call('POST', `/reports/${f.id}/ai/read`, { role: 'senior' })).status).toBe(200);
  });

  it('rate limit per actor', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    for (let i = 0; i < 10; i += 1) expect((await w.call('POST', `/reports/${f.id}/ai/read`, { actor: 'ann' })).status).toBe(200);
    const limited = await w.call('POST', `/reports/${f.id}/ai/read`, { actor: 'ann' });
    expect(limited.status).toBe(429);
    expect(errorOf(limited)).toBe('rate_limited');
    expect((await w.call('POST', `/reports/${f.id}/ai/read`, { actor: 'bea' })).status).toBe(200);
    w.clock.t += 60_000;
    expect((await w.call('POST', `/reports/${f.id}/ai/read`, { actor: 'ann' })).status).toBe(200);
  });

  it('an unknown report is 404 and a decided one is ai_off', async () => {
    const w = await aiWorld();
    expect((await w.call('POST', '/reports/no-such-report/ai/read')).status).toBe(404);
    const f = await readReport(w);
    await w.call('POST', `/reports/${f.id}/decide`, { body: { verdict: 'no_action', actions: [] } });
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('ai_off');
  });
});

describe('GET /ai/status', () => {
  it('GET /ai/status needs policy.read', async () => {
    const w = await aiWorld(1, reads('upheld'), { permissions: { 'policy.read': 'owner' } });
    expect((await w.call('GET', '/ai/status', { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/ai/status', { role: 'senior' })).status).toBe(403);
    expect((await w.call('GET', '/ai/status', { role: 'owner' })).status).toBe(200);
    expect((await w.call('GET', '/ai/status', { role: null })).status).toBe(401);
  });

  it('answers the status, the learn setting and the casebook stats, and is audited as policy.view', async () => {
    const w = await aiWorld(2);
    const f = await readReport(w);
    const page = body(await w.call('GET', `/reports/${f.id}`)).ai;
    const step = page.recommendation.step;
    await w.call('POST', `/reports/${f.id}/decide`, {
      body: decideBody(f, { readId: page.id, accepted: true }, { actions: [{ subject: f.target, kind: step.kind, durationMs: step.durationMs, rule: 2 }] }),
    });
    const before = w.routeAudit().filter((r) => r.action === 'policy.view').length;
    const res = await w.call('GET', '/ai/status');
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const s = body(res);
    expect(Object.keys(s).sort()).toEqual(['available', 'cacheHitRate', 'capCalls', 'capMicros', 'day', 'invalid', 'learn', 'level', 'maxLevel', 'reads', 'spentMicros', 'state', 'stats']);
    expect(s).toMatchObject({ available: true, level: 2, maxLevel: 2, state: 'ok', spentMicros: 1000, capMicros: 1_000_000, capCalls: 5000, reads: 1, learn: true, invalid: {} });
    expect(s.day).toBe(new Date(w.clock.t).toISOString().slice(0, 10));
    expect(s.stats).toMatchObject({ decided: 1, agree: 1, override: 0, none: 0, falsePositives: 0, oneClick: 1, agreementRate: 1, oneClickRate: 1 });
    expect(s.stats.rules).toEqual([{ rule: 2, decided: 1, agree: 1, override: 0, none: 0, falsePositives: 0, oneClick: 1 }]);
    expect(w.routeAudit().filter((r) => r.action === 'policy.view')).toHaveLength(before + 1);
  });

  it('when no adapter is configured, available is false and level is 0', async () => {
    const w = await world();
    const s = body(await w.call('GET', '/ai/status'));
    expect(s).toMatchObject({ available: false, level: 0, maxLevel: 0, state: 'off', spentMicros: 0, capMicros: 0, capCalls: 0, reads: 0, cacheHitRate: null, learn: true });
    expect(s.stats).toMatchObject({ decided: 0, rules: [] });
  });

  it('shows the paused state at the cap and counts refused answers by code', async () => {
    const w = await aiWorld(1, [{ output: { nonsense: true }, usage: { costMicros: 1000 } }], { ai: { options: { dailyBudgetMicros: 1000 } } });
    await w.file();
    await w.idle();
    const s = body(await w.call('GET', '/ai/status'));
    expect(s).toMatchObject({ state: 'paused_budget', spentMicros: 1000, invalid: { extra_key: 1 } });
  });

  it('is a view: a failing audit write is a 500, like the other views', async () => {
    const w = await aiWorld(1, reads('upheld'), { wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    expect((await w.call('GET', '/ai/status')).status).toBe(500);
  });

  it('the level moves through the existing policy route, within maxLevel', async () => {
    const w = await aiWorld(0);
    const put = await w.call('PUT', '/policy/profile', { role: 'owner', body: { layer: { ai: { level: 2 } }, version: 0, reason: 'turn the AI on' } });
    expect(put.status).toBe(200);
    expect(body(await w.call('GET', '/ai/status')).level).toBe(2);
    const capped = await aiWorld(0, reads('upheld'), { ai: { options: { maxLevel: 1 } } });
    await capped.call('PUT', '/policy/profile', { role: 'owner', body: { layer: { ai: { level: 2 } }, version: 0, reason: 'turn the AI on' } });
    expect(body(await capped.call('GET', '/ai/status'))).toMatchObject({ level: 1, maxLevel: 1 });
    const three = await w.call('PUT', '/policy/profile', { role: 'owner', body: { layer: { ai: { level: 3 } }, version: 1, reason: 'too far' } });
    expect(three.status).toBe(400);
  });
});

describe('the decision echo', () => {
  it('decide with a valid ai echo writes an outcome and returns the same body as without', async () => {
    const w = await aiWorld();
    const a = await readReport(w);
    const b = await readReport(w);
    const readId = body(await w.call('GET', `/reports/${a.id}`)).ai.id;
    const withEcho = await w.call('POST', `/reports/${a.id}/decide`, { body: decideBody(a, { readId, accepted: false }) });
    const without = await w.call('POST', `/reports/${b.id}/decide`, { body: decideBody(b, undefined) });
    expect(withEcho.status).toBe(200);
    const shape = (res: KitResponse) => ({ ...body(res), groups: body(res).groups.map((g: { kind: string }) => g.kind) });
    expect(shape(withEcho)).toEqual(shape(without));
    expect(Object.keys(withEcho.body as object).sort()).toEqual(['groups', 'ok', 'replay']);
    // Both decisions are recorded against their reads, with or without the echo, and both leave the moderator's audit row.
    expect(w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items).toHaveLength(2);
    expect(w.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 2, agree: 2 });
  });

  it('writes the ai.outcome audit row as the caller, with their role', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const readId = body(await w.call('GET', `/reports/${f.id}`)).ai.id;
    await w.call('POST', `/reports/${f.id}/decide`, { role: 'senior', actor: 'sam', body: decideBody(f, { readId, accepted: true }) });
    const rows = w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'sam', role: 'senior', action: 'ai.outcome', target: { type: 'report', ref: f.id } });
  });

  it('a replay writes no second row', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const readId = body(await w.call('GET', `/reports/${f.id}`)).ai.id;
    const first = await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId, accepted: false }) });
    const again = await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId, accepted: false }) });
    expect(body(first).replay).toBe(false);
    expect(body(again).replay).toBe(true);
    expect(w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items).toHaveLength(1);
  });

  it('a malformed ai is 400', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    for (const ai of [
      'x',
      5,
      null,
      [],
      {},
      { readId: 5, accepted: true },
      { readId: '', accepted: true },
      { readId: 'a', accepted: 'yes' },
      { readId: 'a' },
      { accepted: true },
      { readId: 'a b', accepted: true },
      { readId: 'x'.repeat(200), accepted: true },
      { readId: 'a', accepted: true, extra: 1 },
      { readId: 'a', accepted: true, severity: 'extreme' },
      { readId: 'a', accepted: true, role: 'owner' },
    ]) {
      const res = await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, ai) });
      expect(res.status, JSON.stringify(ai)).toBe(400);
      expect(errorOf(res)).toBe('invalid_request');
    }
    // Nothing was decided by any of them.
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
  });

  it('an unknown readId is ignored: the decision lands and the newest read is used', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const res = await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId: 'no-such-read', accepted: false }) });
    expect(res.status).toBe(200);
    const row = (w.store as unknown as { loadAiOutcome(id: string): { readId: string | null } | null }).loadAiOutcome(f.id);
    expect(row?.readId).toBe(body(await w.call('GET', `/reports/${f.id}`)).ai?.id ?? row?.readId);
    expect(row?.readId).not.toBeNull();
  });

  it('the severity of the moderator form is carried when it is a conduct level', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const readId = body(await w.call('GET', `/reports/${f.id}`)).ai.id;
    await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId, accepted: false, severity: 'hostile' }) });
    expect((w.store as unknown as { loadAiOutcome(id: string): { severity: string } | null }).loadAiOutcome(f.id)?.severity).toBe('hostile');
  });

  it('a decision with no ai at all is recorded too, with the caller role in the audit row, no click and no example', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const res = await w.call('POST', `/reports/${f.id}/decide`, { role: 'senior', actor: 'sam', body: decideBody(f, undefined) });
    expect(res.status).toBe(200);
    const row = (w.store as unknown as { loadAiOutcome(id: string): { agreement: string; example: unknown; detail: { oneClick: boolean } } | null }).loadAiOutcome(f.id);
    expect(row).toMatchObject({ agreement: 'agree', example: null, detail: { oneClick: false } });
    expect(w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items[0]).toMatchObject({ actor: 'sam', role: 'senior' });
  });

  it('a forged accepted flag is not a one-click unless the decision is the pre-fill', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const page = body(await w.call('GET', `/reports/${f.id}`)).ai;
    const step = page.recommendation.step;
    const other = step.kind === 'note' ? 'warning' : 'note';
    await w.call('POST', `/reports/${f.id}/decide`, {
      body: decideBody(f, { readId: page.id, accepted: true }, { verdict: other === 'note' ? 'noted' : 'upheld', actions: [{ subject: f.target, kind: other, durationMs: null, rule: 2 }] }),
    });
    expect((w.store as unknown as { loadAiOutcome(id: string): { detail: { oneClick: boolean } } | null }).loadAiOutcome(f.id)?.detail.oneClick).toBe(false);
    expect(body(await w.call('GET', '/ai/status')).stats).toMatchObject({ oneClick: 0, oneClickRate: 0 });
  });

  it('a forged severity is dropped: a dismissal with severe is filed as banter, an upheld action at banter teaches nothing', async () => {
    const w = await aiWorld(2, reads('upheld', 'hostile'));
    const a = await readReport(w);
    const readId = body(await w.call('GET', `/reports/${a.id}`)).ai.id;
    await w.call('POST', `/reports/${a.id}/decide`, { body: { verdict: 'no_action', actions: [], ai: { readId, accepted: false, severity: 'severe' } } });
    const store = w.store as unknown as { loadAiOutcome(id: string): { severity: string | null; example: unknown } | null };
    expect(store.loadAiOutcome(a.id)?.severity).toBe('banter');
    const b = await readReport(w);
    const bRead = body(await w.call('GET', `/reports/${b.id}`)).ai.id;
    await w.call('POST', `/reports/${b.id}/decide`, { body: decideBody(b, { readId: bRead, accepted: false, severity: 'banter' }) });
    expect(store.loadAiOutcome(b.id)?.severity).toBe('hostile');
  });

  it('with the AI off, an echo is accepted and records nothing', async () => {
    const w = await world();
    const f = await w.file();
    const res = await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId: 'x', accepted: true }) });
    expect(res.status).toBe(200);
    expect(w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items).toHaveLength(0);
  });
});

describe('read again on a read that ended without an answer', () => {
  it('a refusal is retaken once by an explicit ask (202), charged and audited; the second ask is 409 ai_final', async () => {
    const w = await aiWorld(2, [{ error: new AIError('declined') }, { error: new AIError('declined') }]);
    const f = await w.file();
    await w.idle();
    expect(body(await w.call('GET', `/reports/${f.id}`)).ai).toBeNull();
    const first = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ status: 'pending' });
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    const second = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(second.status).toBe(409);
    expect(errorOf(second)).toBe('ai_final');
    expect(second.body).toEqual({ error: 'ai_final', message: 'The AI has no more to try for this report.' });
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    // Both asks are on the trail.
    expect(w.cw.audit.list({ limit: 20, action: 'ai.rerun' }).items).toHaveLength(2);
  });

  it('a retake that gets an answer makes the read ready', async () => {
    const w = await aiWorld(2, [{ error: new AIError('declined') }]);
    const f = await w.file();
    await w.idle();
    expect((await w.call('POST', `/reports/${f.id}/ai/read`)).status).toBe(202);
    await w.idle();
    const ready = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(ready.status).toBe(200);
    expect(body(ready)).toMatchObject({ status: 'ready', ai: { summary: 'The reported player was rude in chat.' } });
  });

  it('an open breaker is 503 ai_unavailable with retryAfterMs in the body and retry-after in the header', async () => {
    const w = await aiWorld(2, [{ error: new AIError('fatal') }]);
    const f = await w.file();
    await w.idle();
    w.clock.t += 2 * MIN;
    const res = await w.call('POST', `/reports/${f.id}/ai/read`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'ai_unavailable', message: 'The AI cannot be called right now.', retryAfterMs: 3 * MIN });
    expect(res.headers?.['retry-after']).toBe('180');
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(w.adapter.callCount).toBe(1);
    // After the wait a probe may go.
    w.clock.t += 3 * MIN;
    expect((await w.call('POST', `/reports/${f.id}/ai/read`)).status).toBe(202);
  });

  it('a full call window is 503 ai_unavailable until the first call leaves the minute', async () => {
    const w = await aiWorld(2, reads('upheld'), { ai: { options: { perMinuteCalls: 1 } } });
    await readReport(w);
    const second = await w.file();
    await w.idle();
    const res = await w.call('POST', `/reports/${second.id}/ai/read`);
    expect(res.status).toBe(503);
    expect(body(res).retryAfterMs).toBeGreaterThan(0);
    expect(body(res).retryAfterMs).toBeLessThanOrEqual(MIN);
  });

  it('the daily call ceiling answers 429 ai_budget like the money cap', async () => {
    const w = await aiWorld(2, reads('upheld'), { overrides: { ai: { dailyCalls: 1 } } });
    await readReport(w);
    const second = await w.file();
    await w.idle();
    const res = await w.call('POST', `/reports/${second.id}/ai/read`);
    expect(res.status).toBe(429);
    expect(errorOf(res)).toBe('ai_budget');
  });
});

describe('a failing AI over HTTP', () => {
  const scrubbed = (v: unknown): unknown =>
    JSON.parse(
      JSON.stringify(v, (k, val) => (['id', 'createdAt', 'actionedAt', 'detailAt', 'ts', 'lineId', 'at'].includes(k) ? '#' : (val as unknown)))
        .replace(/s_[A-Za-z0-9_-]{22}/g, '#subject'),
    );
  const without = (o: Record<string, unknown>, key: string): Record<string, unknown> => {
    const { [key]: _drop, ...rest } = o;
    void _drop;
    return rest;
  };

  for (const [name, script] of [
    ['throws', () => Promise.reject(new Error('provider down'))],
    ['refuses', [{ error: new AIError('declined') }]],
    ['returns garbage', [{ output: 12 }]],
  ] as Array<[string, FakeScript]>) {
    it(`with an adapter that ${name}, the queue, the case page and the decision answer exactly as with the AI off (ai: null aside)`, async () => {
      const off = await world();
      const bad = await aiWorld(2, script);
      const run = async (w: typeof off | typeof bad) => {
        const f = await w.file();
        if ('idle' in w) await w.idle();
        const list = body(await w.call('GET', '/reports', { query: { status: 'open' } })).items[0];
        const page = body(await w.call('GET', `/reports/${f.id}`));
        const decide = await w.call('POST', `/reports/${f.id}/decide`, { body: { verdict: 'no_action', actions: [], ai: { readId: 'a', accepted: false } } });
        return { list, page, status: decide.status, decide: decide.body };
      };
      const a = await run(off);
      const b = await run(bad);
      expect(b.list.ai).toBeNull();
      expect(b.page.ai).toBeNull();
      // The one addition: with the AI on the page says whether a read is expected (a boolean; false once the read has ended without an answer).
      expect(typeof b.page.aiExpected).toBe('boolean');
      expect(scrubbed({ ...b, list: without(b.list, 'ai'), page: without(without(b.page, 'ai'), 'aiExpected') })).toEqual(scrubbed({ ...a, list: without(a.list, 'ai'), page: without(a.page, 'ai') }));
    });
  }
});

describe('dont-teach', () => {
  it('dont-teach needs senior and a decided report', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    // Not decided: there is nothing to mark.
    expect((await w.call('POST', `/reports/${f.id}/ai/dont-teach`, { role: 'senior' })).status).toBe(404);
    const readId = body(await w.call('GET', `/reports/${f.id}`)).ai.id;
    await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId, accepted: false }) });
    // A moderator may not.
    const denied = await w.call('POST', `/reports/${f.id}/ai/dont-teach`, { role: 'moderator' });
    expect(denied.status).toBe(403);
    // A senior may, and it is audited as ai.outcome.
    const ok = await w.call('POST', `/reports/${f.id}/ai/dont-teach`, { role: 'senior', actor: 'sam' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const store = w.store as unknown as { loadAiOutcome(id: string): { dontTeach: boolean; example: unknown } | null };
    expect(store.loadAiOutcome(f.id)).toMatchObject({ dontTeach: true, example: null });
    const rows = w.cw.audit.list({ limit: 20, action: 'ai.outcome' }).items;
    expect(rows.filter((r) => r.actor === 'sam')).toHaveLength(1);
    expect(rows.find((r) => r.actor === 'sam')).toMatchObject({ role: 'senior', target: { type: 'report', ref: f.id } });
  });

  it('an unknown report is 404, and a report that was decided with the AI off has nothing to mark', async () => {
    const w = await aiWorld(0);
    expect((await w.call('POST', '/reports/nope/ai/dont-teach', { role: 'senior' })).status).toBe(404);
    const f = await w.file();
    await w.call('POST', `/reports/${f.id}/decide`, { body: { verdict: 'no_action', actions: [] } });
    expect((await w.call('POST', `/reports/${f.id}/ai/dont-teach`, { role: 'senior' })).status).toBe(404);
  });
});

describe('every AI route', () => {
  const routes = (f: { id: string }) =>
    [
      ['GET', '/ai/status', undefined],
      ['POST', `/reports/${f.id}/ai/read`, undefined],
      ['POST', `/reports/${f.id}/ai/dont-teach`, undefined],
    ] as const;

  it('401 without authz, and nothing runs', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const calls = w.adapter.callCount;
    const before = w.audit().length;
    for (const [method, path] of routes(f)) {
      const res = await w.call(method, path, { role: null });
      expect(res.status, path).toBe(401);
    }
    expect(w.audit()).toHaveLength(before);
    expect(w.adapter.callCount).toBe(calls);
  });

  it('every route is no-store and every response is JSON', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const responses: KitResponse[] = [];
    for (const [method, path] of routes(f)) {
      responses.push(await w.call(method, path, { role: 'senior' }));
      responses.push(await w.call(method, path, { role: null }));
    }
    responses.push(await w.call('POST', '/reports/nope/ai/read'));
    responses.push(await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, 'x') }));
    responses.push(await w.call('GET', `/reports/${f.id}`));
    responses.push(await w.call('GET', '/reports'));
    for (const res of responses) {
      expect(res.headers?.['cache-control']).toBe('no-store');
      expect(typeof res.body).toBe('object');
      expect(() => JSON.stringify(res.body)).not.toThrow();
    }
  });

  it('the responses carry no ip, hash, raw key or provider detail at any depth', async () => {
    const w = await aiWorld();
    const f = await readReport(w);
    const readId = body(await w.call('GET', `/reports/${f.id}`)).ai.id;
    const responses = [
      await w.call('GET', '/reports'),
      await w.call('GET', `/reports/${f.id}`),
      await w.call('POST', `/reports/${f.id}/ai/read`),
      await w.call('GET', '/ai/status'),
      await w.call('POST', `/reports/${f.id}/decide`, { body: decideBody(f, { readId, accepted: true }) }),
      await w.call('POST', `/reports/${f.id}/ai/dont-teach`, { role: 'senior' }),
    ];
    const forbidden = /^(ip|ips|ipHash|keyHash|clientKey|rawKey|secret|hash|inputHash|prompt|apiKey|adapter)$/i;
    for (const res of responses) {
      for (const k of keysDeep(res.body)) expect(forbidden.test(k), k).toBe(false);
      const text = JSON.stringify(res.body);
      for (const raw of [KEY_TARGET, IP_TARGET, SECRET, 'fake:model']) expect(text).not.toContain(raw);
    }
  });
});
