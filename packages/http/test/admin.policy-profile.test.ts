import { describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { PERMISSIONS } from '../src/index.js';
import { DAY, errorOf, HOUR, world } from './world.js';

// The editable profile over HTTP (K4 Task 7f): GET/PUT /policy/profile, POST /policy/profile/preview, DELETE /policy/profile,
// the owner-only `policy.write`, the policy.update / policy.reset audit rows, and `duration_not_offered`.

const PUT = (body: unknown, role: 'owner' | 'senior' | 'moderator' = 'owner', actor = 'owner_ann') => ({ role, actor, body });
const good = { layer: { durations: [HOUR, 6 * HOUR, 12 * HOUR] }, version: 0, reason: 'Lae asked for 1, 6 and 12 hours' };

interface ProfileBody {
  effective: { durations: number[]; customDuration: boolean; repeat: { notes: number } };
  base: { durations: number[] };
  layer: Record<string, unknown>;
  version: number;
  canSave: boolean;
  layerError?: { path: string };
}

describe('permissions', () => {
  it('policy.write is owner only by default; policy.read stays moderator', () => {
    expect(PERMISSIONS['policy.write']).toBe('owner');
    expect(PERMISSIONS['policy.read']).toBe('moderator');
  });

  it('GET /me shows policy.write only for the owner', async () => {
    const { call } = await world();
    for (const [role, expected] of [['moderator', false], ['senior', false], ['owner', true]] as const) {
      const me = (await call('GET', '/me', { role })).body as { can: Record<string, boolean> };
      expect(me.can['policy.write'], role).toBe(expected);
      expect(me.can['policy.read'], role).toBe(true);
    }
  });

  it('an override can hand policy.write to seniors', async () => {
    const { call } = await world({ permissions: { 'policy.write': 'senior' } });
    expect((await call('PUT', '/policy/profile', PUT(good, 'senior'))).status).toBe(200);
    expect((await call('PUT', '/policy/profile', PUT({ ...good, version: 1 }, 'moderator'))).status).toBe(403);
  });
});

describe('GET /policy/profile', () => {
  it('answers effective, base, layer, version and canSave to any staff role, and audits policy.view', async () => {
    const { call, cw, routeAudit } = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const res = await call('GET', '/policy/profile', { role });
      expect(res.status, role).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(['base', 'canSave', 'effective', 'layer', 'version']);
    }
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.version).toBe(0);
    expect(body.layer).toEqual({});
    expect(body.canSave).toBe(true);
    expect(body.effective).toEqual(JSON.parse(JSON.stringify(cw.profile)));
    expect(body.base).toEqual(JSON.parse(JSON.stringify(cw.policy.get().base)));
    expect(routeAudit().every((r) => r.action === 'policy.view' && r.detail === undefined)).toBe(true);
    expect(routeAudit()).toHaveLength(4);
  });

  it('401 with no caller, 403 below an overridden role; no audit row on either', async () => {
    const { call, routeAudit } = await world({ permissions: { 'policy.read': 'senior' } });
    expect((await call('GET', '/policy/profile', { role: null })).status).toBe(401);
    const denied = await call('GET', '/policy/profile', { role: 'moderator' });
    expect([denied.status, errorOf(denied)]).toEqual([403, 'forbidden']);
    expect(routeAudit()).toEqual([]);
  });

  it('reads the store first, so it shows a change another process made at once', async () => {
    const { call, store } = await world();
    store.savePolicyLayer({ customDuration: false }, 0);
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.version).toBe(1);
    expect(body.effective.customDuration).toBe(false);
  });

  it('never caches', async () => {
    const { call } = await world();
    expect((await call('GET', '/policy/profile')).headers?.['cache-control']).toBe('no-store');
  });

  it('reports a stored layer this kit cannot use as layerError, with the base in force', async () => {
    const { call, store } = await world();
    store.savePolicyLayer({ profanity: { mode: 'allow' } } as never, 0);
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.layerError).toEqual({ path: 'layer.profanity' });
    expect(body.effective.durations).toEqual(body.base.durations);
    expect(body.version).toBe(1);
  });

  it('says canSave false for a store that cannot save', async () => {
    const { call } = await world({ wrap: (cw) => unsupported(cw) });
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.canSave).toBe(false);
    expect(body.version).toBe(0);
  });
});

describe('PUT /policy/profile', () => {
  it('saves the layer, answers the version and the sections changed, and the very next GET shows it', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ ...good, layer: { durations: [HOUR, 6 * HOUR], repeat: { notes: 3 } } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 1, changed: ['durations', 'repeat'] });
    const after = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(after.version).toBe(1);
    expect(after.effective.durations).toEqual([HOUR, 6 * HOUR]);
    expect(after.effective.repeat.notes).toBe(3);
    expect(after.layer).toEqual({ durations: [HOUR, 6 * HOUR], repeat: { notes: 3 } });
    expect(cw.profile.durations).toEqual([HOUR, 6 * HOUR]);
  });

  it('only the owner: moderator and senior are 403 forbidden, nothing is saved, no audit row', async () => {
    const { call, cw, routeAudit } = await world();
    for (const role of ['moderator', 'senior'] as const) {
      const res = await call('PUT', '/policy/profile', PUT(good, role));
      expect([res.status, errorOf(res)], role).toEqual([403, 'forbidden']);
    }
    expect((await call('PUT', '/policy/profile', { role: null, body: good })).status).toBe(401);
    expect(cw.policy.get().version).toBe(0);
    expect(routeAudit()).toEqual([]);
  });

  it('authorization comes before validation (a too-low role with a bad body is 403)', async () => {
    const { call } = await world();
    expect((await call('PUT', '/policy/profile', { role: 'senior', raw: '{nope' })).status).toBe(403);
  });

  it('audits policy.update with the sections changed and the reason, by the owner, with no target', async () => {
    const { call, routeAudit, clock } = await world();
    await call('PUT', '/policy/profile', PUT({ ...good, layer: { durations: [HOUR], customDuration: false } }, 'owner', 'owner_zed'));
    expect(routeAudit()).toEqual([
      {
        id: expect.any(String),
        at: clock.t,
        actor: 'owner_zed',
        role: 'owner',
        action: 'policy.update',
        detail: { sections: ['durations', 'customDuration'], reason: 'Lae asked for 1, 6 and 12 hours' },
      },
    ]);
  });

  it('the audit row carries ids and section names and the reason, and no layer values', async () => {
    const { call, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { guidelines: [{ outcome: 'secret-outcome-text-7731' }] }, version: 0, reason: 'r' }));
    const text = JSON.stringify(routeAudit());
    expect(text).not.toContain('secret-outcome-text-7731');
    expect(routeAudit()[0]?.detail).toEqual({ sections: ['guidelines'], reason: 'r' });
  });

  it('a stale version is 409 conflict with a fixed body, nothing is written, no audit row', async () => {
    const { call, routeAudit, cw } = await world();
    await call('PUT', '/policy/profile', PUT(good));
    const before = routeAudit().length;
    const res = await call('PUT', '/policy/profile', PUT({ ...good, layer: { durations: [HOUR] } }));
    expect([res.status, errorOf(res)]).toEqual([409, 'conflict']);
    expect(Object.keys(res.body as object).sort()).toEqual(['error', 'message']);
    expect(routeAudit()).toHaveLength(before);
    expect(cw.profile.durations).toEqual([HOUR, 6 * HOUR, 12 * HOUR]);
  });

  it('an invalid layer is 400 invalid_profile with the layer path, nothing is written, no audit row', async () => {
    const { call, routeAudit, cw } = await world();
    const cases: Array<[unknown, string]> = [
      [{ profanity: { mode: 'allow' } }, 'layer.profanity'],
      [{ name: 'Mine' }, 'layer.name'],
      [{ durations: [DAY, HOUR] }, 'layer.durations'],
      [{ durations: [0] }, 'layer.durations[0]'],
      [{ customDuration: 'yes' }, 'layer.customDuration'],
      [{ repeat: { outcome: 'none' } }, 'layer.repeat.outcome'],
      [{ ladder: [] }, 'layer.ladder'],
    ];
    for (const [layer, path] of cases) {
      const res = await call('PUT', '/policy/profile', PUT({ ...good, layer }));
      expect([res.status, errorOf(res), (res.body as { path: string }).path], path).toEqual([400, 'invalid_profile', path]);
      expect(JSON.stringify(res.body)).not.toContain('allow');
    }
    expect(routeAudit()).toEqual([]);
    expect(cw.policy.get().version).toBe(0);
  });

  const BAD_BODIES: Array<[string, unknown]> = [
    ['no layer', { version: 0, reason: 'r' }],
    ['a layer that is a list', { layer: [], version: 0, reason: 'r' }],
    ['a layer that is a string', { layer: 'x', version: 0, reason: 'r' }],
    ['a null layer', { layer: null, version: 0, reason: 'r' }],
    ['no version', { layer: {}, reason: 'r' }],
    ['a negative version', { layer: {}, version: -1, reason: 'r' }],
    ['a fractional version', { layer: {}, version: 0.5, reason: 'r' }],
    ['a string version', { layer: {}, version: '0', reason: 'r' }],
    ['no reason', { layer: {}, version: 0 }],
    ['a blank reason', { layer: {}, version: 0, reason: '   ' }],
    ['a reason that is not text', { layer: {}, version: 0, reason: 5 }],
    ['a reason over 2000 characters', { layer: {}, version: 0, reason: 'x'.repeat(2001) }],
  ];
  for (const [name, body] of BAD_BODIES) {
    it(`400 invalid_request for ${name}; nothing is saved`, async () => {
      const { call, cw, routeAudit } = await world();
      const res = await call('PUT', '/policy/profile', PUT(body));
      expect([res.status, errorOf(res)]).toEqual([400, 'invalid_request']);
      expect(cw.policy.get().version).toBe(0);
      expect(routeAudit()).toEqual([]);
    });
  }

  it('400 for a body that is not JSON, and for no body', async () => {
    const { call } = await world();
    expect((await call('PUT', '/policy/profile', { role: 'owner', raw: '{nope' })).status).toBe(400);
    expect((await call('PUT', '/policy/profile', { role: 'owner' })).status).toBe(400);
  });

  it('a 2000 character reason is accepted', async () => {
    const { call } = await world();
    expect((await call('PUT', '/policy/profile', PUT({ ...good, reason: 'x'.repeat(2000) }))).status).toBe(200);
  });

  it('answers 501 not_supported for a store that cannot save, and writes no audit row', async () => {
    const { call, routeAudit } = await world({ wrap: (cw) => unsupported(cw) });
    const res = await call('PUT', '/policy/profile', PUT(good));
    expect([res.status, errorOf(res)]).toEqual([501, 'not_supported']);
    expect(routeAudit()).toEqual([]);
  });

  it('the save stands when the audit row cannot be written (logged, never an error)', async () => {
    const { call, cw, logged } = await world({
      wrap: (cw) => Object.create(cw, { audit: { value: { ...cw.audit, record: () => false } } }) as Chatwarden,
    });
    const res = await call('PUT', '/policy/profile', PUT(good));
    expect(res.status).toBe(200);
    expect(cw.policy.get().version).toBe(1);
    expect(logged.map(([e]) => e)).toContain('chatwarden.http_audit_failed');
  });

  it('a layer from the actor in the body cannot name another actor: the audit actor is the authenticated one', async () => {
    const { call, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ ...good, actor: 'someone_else' }, 'owner', 'owner_real'));
    expect(routeAudit()[0]?.actor).toBe('owner_real');
  });

  it('forbidden keys in the body (a __proto__ key) are 400, not a prototype pollution', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', { role: 'owner', raw: '{"layer":{"__proto__":{"x":1}},"version":0,"reason":"r"}' });
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(cw.policy.get().version).toBe(0);
  });
});

describe('a save changes what the rest of the staff API does, at once', () => {
  it('GET /policy shows the new profile and a regenerated guide', async () => {
    const { call } = await world();
    const before = (await call('GET', '/policy')).body as { documents: { moderatorGuide: string }; profile: { durations: number[] } };
    expect(before.documents.moderatorGuide).not.toContain('Restrict chat 6 hours');
    await call('PUT', '/policy/profile', PUT({ layer: { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } } }, version: 0, reason: 'r' }));
    const after = (await call('GET', '/policy')).body as { documents: { moderatorGuide: string; agentBrief: string } };
    expect(after.documents.moderatorGuide).toContain('Restrict chat 6 hours');
    expect(after.documents.agentBrief).toContain('Restrict chat 6 hours');
  });

  it('POST /reports/:id/suggest returns the new suggestion', async () => {
    const { call, file } = await world();
    const r = await file();
    const ask = async () => ((await call('POST', `/reports/${r.id}/suggest`, { body: { level: 'rude' } })).body as { label: string }).label;
    expect(await ask()).toBe('Warning');
    await call('PUT', '/policy/profile', PUT({ layer: { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } } }, version: 0, reason: 'r' }));
    expect(await ask()).toBe('Restrict chat 6 hours');
  });
});

describe('POST /policy/profile/preview', () => {
  it('answers the sample suggestions without saving, for any staff role, and writes no audit row', async () => {
    const { call, cw, routeAudit } = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const res = await call('POST', '/policy/profile/preview', { role, body: { layer: { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } } } } });
      expect(res.status, role).toBe(200);
      const body = res.body as { samples: Record<string, Record<string, { label: string; kind: string; durationMs: number | null }>> };
      expect(Object.keys(body)).toEqual(['samples']);
      expect(Object.keys(body.samples)).toEqual(['clean', 'oneWarning', 'chat24h', 'ban7d']);
      expect(body.samples.clean?.rude).toEqual({ label: 'Restrict chat 6 hours', kind: 'chat', durationMs: 6 * HOUR });
    }
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.firstOffense.rude).toEqual(cw.policy.get().base.firstOffense.rude);
    expect(routeAudit()).toEqual([]);
  });

  it('an empty layer previews the base; a rule makes the area swap show', async () => {
    const { call } = await world();
    const base = (await call('POST', '/policy/profile/preview', { body: { layer: {} } })).body as { samples: { clean: { rude: { label: string } } } };
    expect(base.samples.clean.rude.label).toBe('Warning');
    const withRule = (await call('POST', '/policy/profile/preview', { body: { layer: { areaRules: [7] }, rule: 7 } })).body as {
      samples: { clean: { hostile: { kind: string } } };
    };
    expect(withRule.samples.clean.hostile.kind).toBe('area');
  });

  it('an invalid layer is 400 invalid_profile with the path', async () => {
    const { call } = await world();
    const res = await call('POST', '/policy/profile/preview', { body: { layer: { profanity: {} } } });
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', 'layer.profanity']);
  });

  it('a bad body or rule is 400 invalid_request', async () => {
    const { call } = await world();
    for (const body of [{}, { layer: [] }, { layer: 'x' }, { layer: {}, rule: 0 }, { layer: {}, rule: 'nope' }, { layer: {}, rule: 1.5 }]) {
      const res = await call('POST', '/policy/profile/preview', { body });
      expect([res.status, errorOf(res)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
    expect((await call('POST', '/policy/profile/preview', { raw: '{nope' })).status).toBe(400);
  });

  it('is gated by policy.read: 401 without a caller, 403 below an overridden role', async () => {
    const { call } = await world({ permissions: { 'policy.read': 'senior' } });
    expect((await call('POST', '/policy/profile/preview', { role: null, body: { layer: {} } })).status).toBe(401);
    expect((await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: {} } })).status).toBe(403);
  });

  it('works for a store that cannot save', async () => {
    const { call } = await world({ wrap: (cw) => unsupported(cw) });
    expect((await call('POST', '/policy/profile/preview', { body: { layer: {} } })).status).toBe(200);
  });
});

describe('DELETE /policy/profile', () => {
  const seeded = async () => {
    const w = await world();
    await w.call('PUT', '/policy/profile', PUT({ layer: { durations: [HOUR], customDuration: false, repeat: { notes: 3 } }, version: 0, reason: 'seed' }));
    w.clock.t += 1000; // the audit list is newest first by time: later rows must be later
    return w;
  };

  it('?section= resets that section only, audits policy.reset with it and the reason', async () => {
    const { call, cw, routeAudit, clock } = await seeded();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section: 'durations' }, body: { reason: 'back to default' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 2, changed: ['durations'] });
    expect(cw.policy.get().layer).toEqual({ customDuration: false, repeat: { notes: 3 } });
    expect(routeAudit().at(0)).toEqual({
      id: expect.any(String),
      at: clock.t,
      actor: 'owner_ann',
      role: 'owner',
      action: 'policy.reset',
      detail: { sections: ['durations'], reason: 'back to default' },
    });
  });

  it('with no section it resets everything, and the reason is optional', async () => {
    const { call, cw, routeAudit } = await seeded();
    const res = await call('DELETE', '/policy/profile', { role: 'owner' });
    expect(res.body).toEqual({ ok: true, version: 2, changed: ['durations', 'customDuration', 'repeat'] });
    expect(cw.policy.get().layer).toEqual({});
    expect(routeAudit().at(0)?.detail).toEqual({ sections: ['durations', 'customDuration', 'repeat'] });
  });

  it('a section that is not in the layer is a harmless no-op, still audited with no sections', async () => {
    const { call, routeAudit } = await seeded();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', query: { section: 'ladder' } });
    expect(res.body).toEqual({ ok: true, version: 1, changed: [] });
    expect(routeAudit().at(0)).toMatchObject({ action: 'policy.reset', detail: { sections: [] } });
  });

  it('only the owner: 403 for moderator and senior, 401 without a caller; nothing changes', async () => {
    const { call, cw } = await seeded();
    for (const role of ['moderator', 'senior'] as const) {
      const res = await call('DELETE', '/policy/profile', { role });
      expect([res.status, errorOf(res)], role).toEqual([403, 'forbidden']);
    }
    expect((await call('DELETE', '/policy/profile', { role: null })).status).toBe(401);
    expect(cw.policy.get().version).toBe(1);
  });

  it('an unknown or empty section is 400 invalid_query, and writes nothing', async () => {
    const { call, cw, routeAudit } = await seeded();
    const before = routeAudit().length;
    for (const section of ['profanity', 'nope', '', 'Ladder', 'ladder,durations']) {
      const res = await call('DELETE', '/policy/profile', { role: 'owner', query: { section } });
      expect([res.status, errorOf(res)], section).toEqual([400, 'invalid_query']);
    }
    expect(cw.policy.get().version).toBe(1);
    expect(routeAudit()).toHaveLength(before);
  });

  it('a bad body is 400: not JSON, a reason that is not text or is over 2000 characters', async () => {
    const { call } = await seeded();
    expect((await call('DELETE', '/policy/profile', { role: 'owner', raw: '{nope' })).status).toBe(400);
    expect((await call('DELETE', '/policy/profile', { role: 'owner', body: { reason: 4 } })).status).toBe(400);
    expect((await call('DELETE', '/policy/profile', { role: 'owner', body: { reason: 'x'.repeat(2001) } })).status).toBe(400);
  });

  it('a version in the body must still be current (409 conflict), and the stored layer is unchanged', async () => {
    const { call, cw } = await seeded();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', body: { version: 0 } });
    expect([res.status, errorOf(res)]).toEqual([409, 'conflict']);
    expect(cw.policy.get().layer).not.toEqual({});
    expect((await call('DELETE', '/policy/profile', { role: 'owner', body: { version: 1 } })).status).toBe(200);
    expect((await call('DELETE', '/policy/profile', { role: 'owner', body: { version: 'x' } })).status).toBe(400);
  });

  it('answers 501 not_supported for a store that cannot save', async () => {
    const { call } = await world({ wrap: (cw) => unsupported(cw) });
    const res = await call('DELETE', '/policy/profile', { role: 'owner' });
    expect([res.status, errorOf(res)]).toEqual([501, 'not_supported']);
  });
});

describe('duration_not_offered', () => {
  const lock = async () => {
    const w = await world();
    const res = await w.call('PUT', '/policy/profile', PUT({ layer: { durations: [HOUR, 6 * HOUR, 12 * HOUR], customDuration: false }, version: 0, reason: 'r' }));
    expect(res.status).toBe(200);
    return w;
  };
  const sanction = (subject: string, over: Record<string, unknown> = {}) => ({ subject, kind: 'chat', durationMs: HOUR, rule: 2, reason: 'r', ...over });

  it('with customDuration off, POST /sanctions refuses a length outside the list: 400 duration_not_offered, nothing applied, no audit row', async () => {
    const { call, person, cw, routeAudit } = await lock();
    const p = person();
    const before = routeAudit().length;
    const res = await call('POST', '/sanctions', { body: sanction(p, { durationMs: 2 * HOUR }) });
    expect([res.status, errorOf(res)]).toEqual([400, 'duration_not_offered']);
    expect(Object.keys(res.body as object).sort()).toEqual(['error', 'message']);
    expect(cw.sanctions.forPerson(p)).toEqual([]);
    expect(routeAudit()).toHaveLength(before);
  });

  it('offers the listed lengths, permanent (for the role that may), notes and warnings', async () => {
    const { call, person } = await lock();
    for (const durationMs of [HOUR, 6 * HOUR, 12 * HOUR]) {
      expect((await call('POST', '/sanctions', { body: sanction(person(), { durationMs }) })).status, String(durationMs)).toBe(200);
    }
    expect((await call('POST', '/sanctions', { role: 'senior', body: sanction(person(), { kind: 'ban', durationMs: null }) })).status).toBe(200);
    expect((await call('POST', '/sanctions', { body: sanction(person(), { kind: 'warning', durationMs: null }) })).status).toBe(200);
    expect((await call('POST', '/sanctions', { body: sanction(person(), { kind: 'note', durationMs: null }) })).status).toBe(200);
  });

  it('also offers the lengths the profile itself suggests: every ladder cell, and the first-offense and repeat outcomes', async () => {
    const { call, person, cw } = await lock();
    const own = new Set<number>();
    for (const row of cw.profile.ladder) for (const c of [row.lowMedium, row.high]) if (c.durationMs !== null) own.add(c.durationMs);
    for (const o of [...Object.values(cw.profile.firstOffense), cw.profile.repeat.outcome]) if (typeof o === 'object') if (o.durationMs !== null) own.add(o.durationMs);
    expect(own.has(DAY)).toBe(true);
    expect(own.has(7 * DAY)).toBe(true);
    expect(own.has(30 * DAY)).toBe(true);
    for (const durationMs of own) {
      expect((await call('POST', '/sanctions', { role: 'senior', body: sanction(person(), { durationMs }) })).status, String(durationMs)).toBe(200);
    }
  });

  it('a length that is in none of them is refused, however close', async () => {
    const { call, person } = await lock();
    for (const durationMs of [1, HOUR - 1, HOUR + 1, 5 * HOUR, 2 * DAY, 3 * DAY, 8 * DAY, 365 * DAY]) {
      const res = await call('POST', '/sanctions', { role: 'owner', body: sanction(person(), { durationMs }) });
      expect([res.status, errorOf(res)], String(durationMs)).toEqual([400, 'duration_not_offered']);
    }
  });

  it('with customDuration on (the default), any valid length is accepted', async () => {
    const { call, person } = await world();
    for (const durationMs of [1, 5 * HOUR, 3 * DAY, 365 * DAY]) {
      expect((await call('POST', '/sanctions', { role: 'owner', body: sanction(person(), { durationMs }) })).status, String(durationMs)).toBe(200);
    }
  });

  it('applies to the next request after a save, and stops applying after a reset', async () => {
    const { call, person } = await world();
    expect((await call('POST', '/sanctions', { body: sanction(person(), { durationMs: 5 * HOUR }) })).status).toBe(200);
    await call('PUT', '/policy/profile', PUT({ layer: { customDuration: false }, version: 0, reason: 'r' }));
    expect(errorOf(await call('POST', '/sanctions', { body: sanction(person(), { durationMs: 5 * HOUR }) }))).toBe('duration_not_offered');
    await call('DELETE', '/policy/profile', { role: 'owner', query: { section: 'customDuration' } });
    expect((await call('POST', '/sanctions', { body: sanction(person(), { durationMs: 5 * HOUR }) })).status).toBe(200);
  });

  it('a duration the editor adds to the list is accepted from then on', async () => {
    const { call, person } = await lock();
    expect(errorOf(await call('POST', '/sanctions', { body: sanction(person(), { durationMs: 2 * HOUR }) }))).toBe('duration_not_offered');
    await call('PUT', '/policy/profile', PUT({ layer: { durations: [HOUR, 2 * HOUR], customDuration: false }, version: 1, reason: 'r' }));
    expect((await call('POST', '/sanctions', { body: sanction(person(), { durationMs: 2 * HOUR }) })).status).toBe(200);
  });

  it('with an empty list only permanent and the profile’s own lengths are left', async () => {
    const w = await world();
    await w.call('PUT', '/policy/profile', PUT({ layer: { durations: [], customDuration: false }, version: 0, reason: 'r' }));
    expect(errorOf(await w.call('POST', '/sanctions', { body: sanction(w.person(), { durationMs: HOUR }) }))).toBe('duration_not_offered');
    expect((await w.call('POST', '/sanctions', { body: sanction(w.person(), { durationMs: DAY }) })).status).toBe(200);
  });

  it('POST /reports/:id/decide refuses it too, and the report stays open for a decision that is allowed', async () => {
    const { call, file, cw } = await lock();
    const r = await file();
    const action = (durationMs: number | null) => ({ subject: r.target, kind: 'chat', durationMs, rule: 2 });
    const body = (a: unknown) => ({ verdict: 'upheld', actions: [a], reason: 'r' });
    const refused = await call('POST', `/reports/${r.id}/decide`, { body: body(action(2 * HOUR)) });
    expect([refused.status, errorOf(refused)]).toEqual([400, 'duration_not_offered']);
    expect(cw.reports.get(r.id)?.status).toBe('open');
    expect(cw.sanctions.forPerson(r.target)).toEqual([]);
    const ok = await call('POST', `/reports/${r.id}/decide`, { body: body(action(6 * HOUR)) });
    expect(ok.status).toBe(200);
    expect(cw.reports.get(r.id)?.status).not.toBe('open');
  });

  it('a decision with several actions is refused whole when any one is outside the list', async () => {
    const { call, file, cw } = await lock();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, {
      body: {
        verdict: 'upheld',
        actions: [
          { subject: r.target, kind: 'chat', durationMs: HOUR, rule: 2 },
          { subject: r.reporter, kind: 'ban', durationMs: 4 * HOUR, rule: 2 },
        ],
        reason: 'r',
      },
    });
    expect([res.status, errorOf(res)]).toEqual([400, 'duration_not_offered']);
    expect(cw.sanctions.forPerson(r.target)).toEqual([]);
    expect(cw.reports.get(r.id)?.status).toBe('open');
  });

  it('a decision with no actions is not affected', async () => {
    const { call, file } = await lock();
    const r = await file();
    const res = await call('POST', `/reports/${r.id}/decide`, { body: { verdict: 'no_action', actions: [], reason: 'r' } });
    expect(res.status).toBe(200);
  });

  it('authorization is checked first: a caller who may not apply is 403, not told about the list', async () => {
    const w = await world({ permissions: { 'sanctions.apply': 'owner' } });
    await w.call('PUT', '/policy/profile', PUT({ layer: { customDuration: false }, version: 0, reason: 'r' }));
    const res = await w.call('POST', '/sanctions', { role: 'moderator', body: sanction(w.person(), { durationMs: 5 * HOUR }) });
    expect([res.status, errorOf(res)]).toEqual([403, 'forbidden']);
  });

  it('a bad duration (not a number) is still 400 invalid_request, as before', async () => {
    const { call, person } = await lock();
    const res = await call('POST', '/sanctions', { body: sanction(person(), { durationMs: '1h' }) });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_request']);
  });
});

/** The kit with a store that cannot save settings: the policy methods answer as the kit does for such a store. */
function unsupported(cw: Chatwarden): Chatwarden {
  const policy = {
    get: () => ({ ...cw.policy.get(), canSave: false }),
    refresh: () => undefined,
    preview: cw.policy.preview.bind(cw.policy),
    save: () => ({ ok: false as const, error: 'unsupported' as const }),
    reset: () => ({ ok: false as const, error: 'unsupported' as const }),
  };
  return Object.create(cw, { policy: { value: policy } }) as Chatwarden;
}
