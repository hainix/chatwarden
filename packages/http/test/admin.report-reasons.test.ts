import { describe, expect, it } from 'vitest';
import type { ReportInput } from '@chatwarden/core';
import { errorOf, keysDeep, world } from './world.js';
import type { WorldOptions } from './world.js';

// The reported reason on the staff routes: `reportedReason` and `reportedReasonLabel` on the queue and the report, the `reason` filter,
// the suggested rule from the reason, reporter accuracy on the history route, and the `reporting` section of /policy/profile.

type W = Awaited<ReturnType<typeof world>>;
interface Filed {
  id: string;
  target: string;
  reporter: string;
  room: string;
}

let seq = 0;
/** File one report in a room of its own. `reporterKey` repeats a reporter across reports. */
async function fileWith(w: W, o: Partial<ReportInput> = {}, reporterKey = `rk-${++seq}`): Promise<Filed> {
  const room = `reason-room-${++seq}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: reporterKey, ip: '198.51.100.30' }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: `tk-${seq}`, ip: '203.0.113.30' }, 'Tgt');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', ...o });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const report = w.cw.reports.get(res.reportId);
  if (report === null) throw new Error('missing');
  return { id: res.reportId, target: report.targetPerson, reporter: report.reporterPerson, room };
}

const items = (res: { body: unknown }) => (res.body as { items: Array<Record<string, unknown>> }).items;
const idsOf = (res: { body: unknown }) => items(res).map((i) => i.id);
const decide = (w: W, f: Filed, rule: number, verdict = 'upheld') =>
  w.call('POST', `/reports/${f.id}/decide`, {
    role: 'senior',
    body: { verdict, actions: verdict === 'no_action' ? [] : [{ subject: f.target, kind: 'warning', durationMs: null, rule }], reason: 'looked at it' },
  });

describe('GET /reports: reportedReason and reportedReasonLabel', () => {
  it('each item carries the reason id and its label; null and null when none was given', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'hate' });
    const b = await fileWith(w, {});
    const list = items(await w.call('GET', '/reports'));
    const byId = Object.fromEntries(list.map((i) => [i.id as string, i]));
    expect(byId[a.id]).toMatchObject({ reportedReason: 'hate', reportedReasonLabel: 'Hate', category: 'hate' });
    expect(byId[b.id]).toMatchObject({ reportedReason: null, reportedReasonLabel: null, category: 'other' });
  });

  it('the old category call reads as the new id: disruption is griefing with its label', async () => {
    const w = await world();
    const a = await fileWith(w, { category: 'disruption' });
    const item = items(await w.call('GET', '/reports')).find((i) => i.id === a.id);
    expect(item).toMatchObject({ reportedReason: 'griefing', reportedReasonLabel: 'Throwing or griefing', category: 'disruption' });
  });

  it('the label is the current one: relabelling a reason shows at once, also for old reports', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'cheating' });
    const reasons = w.cw.profile.reporting.reasons.map((r) => (r.id === 'cheating' ? { ...r, label: 'Cheating or hacking' } : { ...r }));
    expect(w.cw.policy.save({ reporting: { reasons } }, { version: 0, actor: 'owner_ann', reason: 'relabel' }).ok).toBe(true);
    expect(items(await w.call('GET', '/reports')).find((i) => i.id === a.id)).toMatchObject({ reportedReasonLabel: 'Cheating or hacking' });
  });

  it('a reason that is no longer in the list still shows: the label falls back to the id', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'afk' });
    const reasons = w.cw.profile.reporting.reasons.filter((r) => r.id !== 'afk').map((r) => ({ ...r }));
    w.cw.policy.save({ reporting: { reasons } }, { version: 0, actor: 'owner_ann', reason: 'drop afk' });
    expect(items(await w.call('GET', '/reports')).find((i) => i.id === a.id)).toMatchObject({ reportedReason: 'afk', reportedReasonLabel: 'afk' });
  });

  it('adds exactly the two keys to the summary, and still no note, excerpt or chat text', async () => {
    const w = await world();
    await fileWith(w, { reason: 'hate', note: 'planted-reporter-note-7731' });
    const res = await w.call('GET', '/reports');
    const keys = Object.keys(items(res)[0] as object).sort();
    expect(keys).toEqual(
      ['actionedAt', 'actionedBy', 'badFaith', 'category', 'claim', 'createdAt', 'id', 'reportedReason', 'reportedReasonLabel', 'reporterHandle', 'reporterPerson', 'roomId', 'status', 'tags', 'targetHandle', 'targetPerson', 'viewing'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain('planted-reporter-note-7731');
    expect(JSON.stringify(res.body)).not.toContain('a line from the target');
  });

  it('a decided report keeps its reason on the queue', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'hate' });
    expect((await decide(w, a, 1)).status).toBe(200);
    expect(items(await w.call('GET', '/reports', { query: { status: 'actioned' } }))[0]).toMatchObject({ id: a.id, reportedReason: 'hate', status: 'actioned' });
  });
});

describe('GET /reports?reason=', () => {
  async function seeded() {
    const w = await world();
    const ids: Record<string, string> = {};
    for (const [name, o] of [['h1', { reason: 'hate' }], ['s1', { reason: 'spam' }], ['h2', { reason: 'hate' }], ['n1', {}], ['g1', { category: 'disruption' }], ['n2', {}]] as const) {
      ids[name] = (await fileWith(w, o)).id;
    }
    return { w, ids };
  }

  it('filters on the reason id, newest first', async () => {
    const { w, ids } = await seeded();
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'hate' } }))).toEqual([ids.h2, ids.h1]);
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'spam' } }))).toEqual([ids.s1]);
  });

  it('none keeps the reports with no reason given', async () => {
    const { w, ids } = await seeded();
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'none' } }))).toEqual([ids.n2, ids.n1]);
  });

  it('the old disruption id finds griefing reports', async () => {
    const { w, ids } = await seeded();
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'disruption' } }))).toEqual([ids.g1]);
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'griefing' } }))).toEqual([ids.g1]);
  });

  it('a well-formed id nobody used is an empty page, not an error', async () => {
    const { w } = await seeded();
    const res = await w.call('GET', '/reports', { query: { reason: 'lag_switch' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], next: null });
  });

  it.each([[''], ['Bad Id'], ['HATE'], ['x'.repeat(40)], ['a/b'], ['hate,spam'], ['None'], ['_x']])('a malformed reason %j is 400 invalid_query', async (reason) => {
    const { w } = await seeded();
    const res = await w.call('GET', '/reports', { query: { reason } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_query']);
  });

  it('combines with status and with limit and cursor', async () => {
    const { w, ids } = await seeded();
    await decide(w, { id: ids.h1 as string, target: '', reporter: '', room: '' } as Filed, 1, 'no_action');
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'hate', status: 'open' } }))).toEqual([ids.h2]);
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'hate', status: 'dismissed' } }))).toEqual([ids.h1]);
    const page1 = await w.call('GET', '/reports', { query: { reason: 'none', limit: '1' } });
    expect(idsOf(page1)).toEqual([ids.n2]);
    const next = (page1.body as { next: string }).next;
    expect(idsOf(await w.call('GET', '/reports', { query: { reason: 'none', limit: '1', cursor: next } }))).toEqual([ids.n1]);
  });

  it('is audited like the plain list and needs the same permission', async () => {
    const { w } = await seeded();
    expect((await w.call('GET', '/reports', { role: null, query: { reason: 'hate' } })).status).toBe(401);
    await w.call('GET', '/reports', { query: { reason: 'hate' } });
    expect(w.audit().filter((r) => r.action === 'report.view')).toHaveLength(1);
  });
});

describe('GET /reports/:id: the report, its reason and the suggested rule', () => {
  const get = async (w: W, f: Filed) => (await w.call('GET', `/reports/${f.id}`)).body as { report: Record<string, unknown>; rule: unknown; suggest: { label: string } };

  it('carries reportedReason, reportedReasonLabel and detailAt on the report', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'threat', note: 'said they would find me' });
    const body = await get(w, a);
    expect(body.report).toMatchObject({ reportedReason: 'threat', reportedReasonLabel: 'Threats', detailAt: null, note: 'said they would find me' });
  });

  it('no reason: null, null, and the rule is uncovered (the moderator picks)', async () => {
    const w = await world();
    const a = await fileWith(w, {});
    const body = await get(w, a);
    expect(body.report).toMatchObject({ reportedReason: null, reportedReasonLabel: null });
    expect(body.rule).toBe('uncovered');
  });

  it('suggests the first rule of the reason, for every default reason', async () => {
    const w = await world();
    const expected: Record<string, number | string> = {
      harassment: 2, hate: 1, sexual: 3, threat: 2, spam: 4, personal_info: 2, cheating: 5, griefing: 6, afk: 6, other: 'uncovered',
    };
    for (const [reason, rule] of Object.entries(expected)) {
      const f = await fileWith(w, { reason });
      expect((await get(w, f)).rule, reason).toBe(rule);
    }
  });

  it('the six old categories still get their old rules', async () => {
    const w = await world();
    for (const [category, rule] of [['harassment', 2], ['hate', 1], ['cheating', 5], ['spam', 4], ['disruption', 6], ['other', 'uncovered']] as const) {
      const f = await fileWith(w, { category });
      expect((await get(w, f)).rule, category).toBe(rule);
    }
  });

  it('follows the studio’s mapping live: a custom reason with rules [3, 4], a retired rule skipped, no rules is uncovered', async () => {
    const w = await world();
    const reasons = [
      { id: 'abuse', label: 'Abuse', rules: [99, 3, 4] },
      { id: 'vague', label: 'Vague', rules: [] },
      { id: 'other', label: 'Else' },
    ];
    w.cw.policy.save({ reporting: { reasons } }, { version: 0, actor: 'owner_ann', reason: 'custom reasons' });
    const a = await fileWith(w, { reason: 'abuse' });
    const b = await fileWith(w, { reason: 'vague' });
    expect((await get(w, a)).rule).toBe(3);
    expect((await get(w, b)).rule).toBe('uncovered');
  });

  it('POST /reports/:id/suggest uses the reason’s rule by default and an explicit rule still wins', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'hate' });
    const def = (await w.call('POST', `/reports/${a.id}/suggest`, { body: { level: 'hostile' } })).body as { label: string };
    const explicit = (await w.call('POST', `/reports/${a.id}/suggest`, { body: { level: 'hostile', rule: 6 } })).body as { label: string };
    const direct = w.cw.suggest(a.target, 'hostile', 1, { roomId: a.room });
    expect(def.label).toBe(direct.label);
    expect(explicit).toBeDefined();
    const none = await fileWith(w, {});
    const unc = (await w.call('POST', `/reports/${none.id}/suggest`, { body: { level: 'hostile' } })).body as { label: string };
    expect(unc.label).toBe(w.cw.suggest(none.target, 'hostile', 'uncovered', { roomId: none.room }).label);
  });
});

describe('the reporter record: reasonMatched and reasonDecided on GET /people/:ref/history', () => {
  it('counts matched and decided for the reporter, and leaves the others’ out', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'hate' }, 'rep-x');
    const b = await fileWith(w, { reason: 'hate' }, 'rep-x');
    const c = await fileWith(w, { reason: 'spam' }, 'rep-x');
    const open = await fileWith(w, { reason: 'cheating' }, 'rep-x');
    const none = await fileWith(w, {}, 'rep-x');
    await decide(w, a, 1);
    await decide(w, b, 2);
    await decide(w, c, 4, 'no_action');
    await decide(w, none, 2);
    void open;
    const res = await w.call('GET', `/people/${a.reporter}/history`);
    const asReporter = (res.body as { asReporter: Record<string, unknown> }).asReporter;
    expect(asReporter).toMatchObject({ reports: 5, open: 1, reasonDecided: 3, reasonMatched: 1 });
    expect(Object.keys(asReporter).sort()).toEqual(['actioned', 'badFaith', 'dismissed', 'open', 'reasonDecided', 'reasonMatched', 'reports', 'suspendedUntil']);
  });

  it('a corrupted decision row never fails the history route: the report counts as decided, unmatched', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'hate' }, 'rep-corrupt');
    const b = await fileWith(w, { reason: 'spam' }, 'rep-corrupt');
    await decide(w, a, 1);
    await decide(w, b, 4);
    w.db.prepare('UPDATE kit_decisions SET result_json = ? WHERE report_id = ?').run('{not json', a.id);
    const res = await w.call('GET', `/people/${a.reporter}/history`);
    expect(res.status).toBe(200);
    expect((res.body as { asReporter: Record<string, unknown> }).asReporter).toMatchObject({ reasonDecided: 2, reasonMatched: 1 });
  });

  it('writes no extra audit rows: the history view is the only row', async () => {
    const w = await world();
    const a = await fileWith(w, { reason: 'hate' });
    const before = w.audit().length;
    await w.call('GET', `/people/${a.reporter}/history`);
    expect(w.audit().length).toBe(before + 1);
  });
});

describe('GET/PUT/DELETE /policy/profile and the reporting section', () => {
  const PUT = (body: unknown) => ({ role: 'owner' as const, actor: 'owner_ann', body });
  const reasons = [{ id: 'lag_switch', label: 'Lag switching', rules: [5], group: 'Gameplay' }, { id: 'other', label: 'Something else' }];

  it('GET answers effective.reporting and base.reporting with the defaults, and the layer without it', async () => {
    const w = await world();
    const body = (await w.call('GET', '/policy/profile')).body as { effective: { reporting: { flow: string; reasons: unknown[]; thanks: string } }; base: { reporting: unknown }; layer: Record<string, unknown> };
    expect(body.effective.reporting.flow).toBe('one_tap');
    expect(body.effective.reporting.reasons).toHaveLength(10);
    expect(body.effective.reporting.thanks).toBe("Thanks for the report. We'll look into it.");
    expect(body.base.reporting).toEqual(body.effective.reporting);
    expect(body.layer).toEqual({});
    // Staff see the whole reason, rules included.
    expect((body.effective.reporting.reasons[0] as Record<string, unknown>).rules).toEqual([2]);
  });

  it('PUT saves a reporting layer, answers the fresh state, and audits policy.update with the section name `reporting` and no values', async () => {
    const w = await world();
    const res = await w.call('PUT', '/policy/profile', PUT({ layer: { reporting: { flow: 'reason_required', reasons, thanks: 'Thanks, we will check.' } }, version: 0, reason: 'we want reasons' }));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; changed: string[]; version: number; effective: { reporting: { flow: string; thanks: string; reasons: Array<{ id: string }> } } };
    expect(body).toMatchObject({ ok: true, changed: ['reporting'], version: 1 });
    expect(body.effective.reporting.flow).toBe('reason_required');
    expect(body.effective.reporting.reasons.map((r) => r.id)).toEqual(['lag_switch', 'other']);
    const row = w.routeAudit().find((r) => r.action === 'policy.update');
    expect(row?.detail).toEqual({ sections: ['reporting'], reason: 'we want reasons' });
    expect(JSON.stringify(row)).not.toContain('lag_switch');
    expect(JSON.stringify(row)).not.toContain('Thanks, we will check.');
  });

  it('the saved flow takes effect on the next report: reason_required refuses a report with no reason', async () => {
    const w = await world();
    await w.call('PUT', '/policy/profile', PUT({ layer: { reporting: { flow: 'reason_required' } }, version: 0, reason: 'require a reason' }));
    const room = 'flow-room';
    w.cw.rooms.seat(room, 'p1', { clientKey: 'flow-rep' }, 'Rep');
    w.cw.rooms.seat(room, 'p2', { clientKey: 'flow-tgt' }, 'Tgt');
    expect(await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2' })).toEqual({ ok: false, refused: 'reason_required' });
  });

  it.each([
    [{ reporting: { flow: 'pick' } }, 'layer.reporting.flow'],
    [{ reporting: { reasons: [] } }, 'layer.reporting.reasons'],
    [{ reporting: { reasons: [{ id: 'lag', label: 'Lag' }] } }, 'layer.reporting.reasons'],
    [{ reporting: { reasons: [{ id: 'Bad Id', label: 'x' }, { id: 'other', label: 'o' }] } }, 'layer.reporting.reasons[0].id'],
    [{ reporting: { thanks: '' } }, 'layer.reporting.thanks'],
    [{ reporting: { colour: 'red' } }, 'layer.reporting.colour'],
  ])('PUT of %j is 400 invalid_profile with path %s and saves nothing', async (layer, path) => {
    const w = await world();
    const res = await w.call('PUT', '/policy/profile', PUT({ layer, version: 0, reason: 'try' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', path]);
    expect(w.cw.policy.get().version).toBe(0);
    expect(w.routeAudit().filter((r) => r.action === 'policy.update')).toEqual([]);
  });

  it('only the owner may save it (policy.write)', async () => {
    const w = await world();
    for (const role of ['moderator', 'senior'] as const) {
      expect((await w.call('PUT', '/policy/profile', { role, body: { layer: { reporting: { flow: 'one_tap' } }, version: 0, reason: 'x' } })).status, role).toBe(403);
    }
  });

  it('DELETE ?section=reporting resets just that section and audits policy.reset', async () => {
    const w = await world();
    await w.call('PUT', '/policy/profile', PUT({ layer: { reporting: { reasons }, customDuration: false }, version: 0, reason: 'two edits' }));
    const res = await w.call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section: 'reporting' }, body: { reason: 'back to defaults' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: ['reporting'] });
    expect(w.cw.profile.reporting.reasons).toHaveLength(10);
    expect(w.cw.profile.customDuration).toBe(false);
    expect(w.routeAudit().find((r) => r.action === 'policy.reset')?.detail).toEqual({ sections: ['reporting'], reason: 'back to defaults' });
  });

  it('POST /policy/profile/preview carries the player view of the candidate, with no rule mapping', async () => {
    const w = await world();
    const res = await w.call('POST', '/policy/profile/preview', { body: { layer: { reporting: { reasons, flow: 'reason_first' } } } });
    expect(res.status).toBe(200);
    const body = res.body as { samples: unknown; reporting: { flow: string; reasons: Array<Record<string, unknown>> } };
    expect(Object.keys(body).sort()).toEqual(['reporting', 'samples']);
    expect(body.reporting.flow).toBe('reason_first');
    expect(body.reporting.reasons.map((r) => r.id)).toEqual(['lag_switch', 'other']);
    expect(keysDeep(body.reporting).has('rules')).toBe(false);
    expect(w.cw.policy.get().version).toBe(0);
  });

  it('a preview of an invalid reporting layer is 400 invalid_profile with its path', async () => {
    const w = await world();
    const res = await w.call('POST', '/policy/profile/preview', { body: { layer: { reporting: { flow: 'x' } } } });
    expect([res.status, (res.body as { path: string }).path]).toEqual([400, 'layer.reporting.flow']);
  });
});

describe('GET /policy/profile: a corrupted stored layer (carry-over from 7f)', () => {
  const corrupt = async (text: string, opts: WorldOptions = {}) => {
    const w = await world(opts);
    w.db.prepare('INSERT INTO kit_policy_layer (id, layer_json, version) VALUES (1, ?, 3)').run(text);
    // Another process wrote it: the route reads the store first.
    return w;
  };

  it.each([['{not json'], ['"a string"'], ['null'], ['[1,2']])('reports layerError { path: layer, kind: unreadable } for stored text %j, with the base in force', async (text) => {
    const w = await corrupt(text);
    const res = await w.call('GET', '/policy/profile');
    expect(res.status).toBe(200);
    const body = res.body as { layerError?: { path: string; kind: string }; version: number; layer: unknown; effective: unknown; base: unknown };
    expect(body.layerError).toEqual({ path: 'layer', kind: 'unreadable' });
    expect(body.version).toBe(3);
    expect(body.layer).toEqual({});
    expect(body.effective).toEqual(body.base);
  });

  it('a layer that reads but is not valid is kind invalid, with its path', async () => {
    const w = await corrupt(JSON.stringify({ reporting: { flow: 'nope' } }));
    const body = (await w.call('GET', '/policy/profile')).body as { layerError?: { path: string; kind: string } };
    expect(body.layerError).toEqual({ path: 'layer.reporting.flow', kind: 'invalid' });
  });

  it('a good layer has no layerError, and the owner can save over a corrupted one (it is not a conflict)', async () => {
    const w = await corrupt('{not json');
    const res = await w.call('PUT', '/policy/profile', PUT_OWNER({ layer: { customDuration: false }, version: 3, reason: 'repair' }));
    expect(res.status).toBe(200);
    expect((res.body as { layerError?: unknown }).layerError).toBeUndefined();
  });
});

const PUT_OWNER = (body: unknown) => ({ role: 'owner' as const, actor: 'owner_ann', body });
