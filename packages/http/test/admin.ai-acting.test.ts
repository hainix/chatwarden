import { describe, expect, it } from 'vitest';
import { DAY, errorOf, world } from './world.js';

// The acting routes (AI levels 3 and 4, design 6.6, release 2): `GET /ai/acting` and `POST /ai/acting/shadow|start|pause|resume|off`. The owner's steps are fixed in code
// (the `permissions` option cannot lower them), a senior may pause, and every transition leaves one `ai.acting` row with the sections [ai] and the reason. Nothing here
// writes a sanction: in this release acting only records.

type W = Awaited<ReturnType<typeof world>>;
const actWorld = (over: Parameters<typeof world>[0] = {}): Promise<W> =>
  world({ ai: { level: 2, options: { maxLevel: 3, act: {} } }, overrides: { appeals: { enabled: true } } as never, ...over });

const ROUTES = [
  { path: '/ai/acting/shadow', body: { confirm: 'ACT', reason: 'we are ready' } },
  { path: '/ai/acting/start', body: { confirm: 'ACT', reason: 'we are ready' } },
  { path: '/ai/acting/resume', body: { reason: 'back on' } },
  { path: '/ai/acting/off', body: { reason: 'stop' } },
] as const;
const PAUSE = { path: '/ai/acting/pause', body: { reason: 'looks odd' } } as const;
const OWNER = { role: 'owner' as const, actor: 'owner_ann' };
const SENIOR = { role: 'senior' as const, actor: 'sen_bo' };

/** Everything lowerable that touches this area, put as low as it goes: the owner-fixed routes must not move. */
const LOWERED = { 'policy.write': 'moderator', 'policy.read': 'moderator', settings: 'moderator', 'ai.pause': 'moderator', 'ai.review': 'moderator', 'automation.write': 'moderator' } as const;

describe('GET /ai/acting', () => {
  it('is policy.read, audited as policy.view, and returns the state with no staff ref', async () => {
    const w = await actWorld();
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    const res = await w.call('GET', '/ai/acting', { role: 'moderator', actor: 'mod_zed' });
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ mode: 'shadow', paused: false, modeSince: w.cw.ai.acting.state().modeSince, shadowDaysDone: 0, shadowWouldHaveActed: 0, maxLevel: 3 });
    const views = w.routeAudit().filter((r) => r.action === 'policy.view');
    expect(views.map((r) => [r.actor, r.role, r.target])).toEqual([['mod_zed', 'moderator', undefined]]);
    const text = JSON.stringify(res.body);
    for (const leak of ['owner_ann', 'mod_zed']) expect(text).not.toContain(leak);
  });

  it('is 401 without authz, and 403 when the permissions option raises policy.read', async () => {
    const w = await actWorld({ permissions: { 'policy.read': 'owner' } });
    expect((await w.call('GET', '/ai/acting', { role: null })).status).toBe(401);
    for (const role of ['moderator', 'senior'] as const) expect((await w.call('GET', '/ai/acting', { role })).status, role).toBe(403);
    expect((await w.call('GET', '/ai/acting', { role: 'owner' })).status).toBe(200);
  });

  it('with no AI configured it answers off, and a step is refused as acting_unavailable', async () => {
    const w = await world();
    const res = await w.call('GET', '/ai/acting');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'off', paused: false, maxLevel: 0 });
    const step = await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect(step.status).toBe(409);
    expect(errorOf(step)).toBe('acting_unavailable');
  });
});

describe('the owner-fixed routes', () => {
  it('a moderator gets 403 on every route, a senior on every route but pause, and nothing is written', async () => {
    const w = await actWorld();
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    const before = w.audit().length;
    for (const r of [...ROUTES, PAUSE]) {
      const res = await w.call('POST', r.path, { role: 'moderator', body: r.body });
      expect(res.status, r.path).toBe(403);
      expect(errorOf(res)).toBe('forbidden');
    }
    for (const r of ROUTES) expect((await w.call('POST', r.path, { ...SENIOR, body: r.body })).status, r.path).toBe(403);
    expect(w.audit()).toHaveLength(before);
    expect(w.cw.ai.acting.state()).toMatchObject({ mode: 'shadow', paused: false });
  });

  it('the owner-fixed routes cannot be lowered by the permissions option: still the owner only', async () => {
    const w = await actWorld({ permissions: LOWERED });
    for (const r of ROUTES) {
      for (const who of [{ role: 'moderator' as const }, SENIOR]) {
        const res = await w.call('POST', r.path, { ...who, body: r.body });
        expect(res.status, `${r.path} ${who.role}`).toBe(403);
      }
    }
    expect(w.cw.ai.acting.state().mode).toBe('off');
    expect((await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body })).status).toBe(200);
  });

  it('authorization comes before the body: 403 and 401 for a body that is not JSON', async () => {
    const w = await actWorld();
    for (const r of [...ROUTES, PAUSE]) {
      expect((await w.call('POST', r.path, { role: 'moderator', raw: '{nope' })).status, r.path).toBe(403);
      expect((await w.call('POST', r.path, { role: null, raw: '{nope' })).status, r.path).toBe(401);
    }
  });
});

describe('pause', () => {
  it('a senior pauses, it takes effect before anything else, and a moderator cannot', async () => {
    const w = await actWorld();
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect((await w.call('POST', PAUSE.path, { role: 'moderator', body: PAUSE.body })).status).toBe(403);
    const res = await w.call('POST', PAUSE.path, { ...SENIOR, body: PAUSE.body });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'shadow', paused: true });
    expect(w.cw.ai.acting.state().paused).toBe(true);
    // the owner may pause too (the owner is above a senior)
    expect((await w.call('POST', '/ai/acting/resume', { ...OWNER, body: { reason: 'fine' } })).status).toBe(200);
    expect((await w.call('POST', PAUSE.path, { ...OWNER, body: PAUSE.body })).status).toBe(200);
  });

  it('ai.pause is lowerable: a moderator may pause when the owner says so; resume stays the owner\'s', async () => {
    const w = await actWorld({ permissions: { 'ai.pause': 'moderator' } });
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect((await w.call('POST', PAUSE.path, { role: 'moderator', actor: 'mod_cy', body: PAUSE.body })).status).toBe(200);
    expect((await w.call('POST', '/ai/acting/resume', { role: 'moderator', actor: 'mod_cy', body: { reason: 'x' } })).status).toBe(403);
    expect(w.cw.ai.acting.state().paused).toBe(true);
  });

  it('pausing twice is a 409 wrong_state, and pausing when acting is off too', async () => {
    const w = await actWorld();
    const off = await w.call('POST', PAUSE.path, { ...SENIOR, body: PAUSE.body });
    expect([off.status, errorOf(off)]).toEqual([409, 'wrong_state']);
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect((await w.call('POST', PAUSE.path, { ...SENIOR, body: PAUSE.body })).status).toBe(200);
    const again = await w.call('POST', PAUSE.path, { ...SENIOR, body: PAUSE.body });
    expect([again.status, errorOf(again)]).toEqual([409, 'wrong_state']);
  });
});

describe('the steps and their refusals', () => {
  it('walks off, shadow, on (after 14 days), shadow, off with the owner, each 200 with the new state', async () => {
    const w = await actWorld();
    const step = async (r: { path: string; body: unknown }, role = OWNER) => w.call('POST', r.path, { ...role, body: r.body });
    expect((await step(ROUTES[0])).body).toMatchObject({ mode: 'shadow' });
    w.clock.t += 14 * DAY;
    expect((await step(ROUTES[1])).body).toMatchObject({ mode: 'on' });
    expect((await step({ path: '/ai/acting/shadow', body: { reason: 'back' } })).body).toMatchObject({ mode: 'shadow', shadowDaysDone: 0 });
    expect((await step(ROUTES[3])).body).toMatchObject({ mode: 'off' });
  });

  it('maps every refusal to its own fixed code and writes no audit row for it', async () => {
    const w = await actWorld();
    const rows = (): number => w.routeAudit().filter((r) => r.action === 'ai.acting').length;
    const code = async (path: string, body: unknown): Promise<[number, string]> => {
      const res = await w.call('POST', path, { ...OWNER, body });
      return [res.status, errorOf(res) ?? ''];
    };
    expect(await code('/ai/acting/start', ROUTES[1].body)).toEqual([409, 'wrong_state']);
    expect(await code('/ai/acting/shadow', { confirm: 'act', reason: 'x' })).toEqual([400, 'invalid_request']);
    expect(await code('/ai/acting/shadow', { confirm: 'ACT' })).toEqual([400, 'invalid_request']);
    expect(await code('/ai/acting/shadow', { confirm: 'ACT', reason: '   ' })).toEqual([400, 'invalid_request']);
    expect(await code('/ai/acting/shadow', { confirm: 5, reason: 'x' })).toEqual([400, 'invalid_request']);
    expect(await code('/ai/acting/shadow', { confirm: 'ACT', reason: 'x', actor: 'someone_else' })).toEqual([400, 'forbidden_key']);
    expect(await code('/ai/acting/off', { reason: 'x', confirm: 'ACT' })).toEqual([400, 'forbidden_key']);
    expect(await code('/ai/acting/resume', [])).toEqual([400, 'invalid_request']);
    expect(rows()).toBe(0);
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect(rows()).toBe(1);
    expect(await code('/ai/acting/start', ROUTES[1].body)).toEqual([409, 'too_early']);
    expect(await code('/ai/acting/shadow', ROUTES[0].body)).toEqual([409, 'wrong_state']);
    expect(rows()).toBe(1);
  });

  it('refuses a hub level below 2, missing appeals and a code that does not allow acting, each with its own code', async () => {
    const low = await world({ ai: { level: 1, options: { maxLevel: 3, act: {} } }, overrides: { appeals: { enabled: true } } as never });
    const lowRes = await low.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect([lowRes.status, errorOf(lowRes)]).toEqual([409, 'ai_level']);
    const noAppeals = await world({ ai: { level: 2, options: { maxLevel: 3, act: {} } } });
    const naRes = await noAppeals.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect([naRes.status, errorOf(naRes)]).toEqual([409, 'no_appeals']);
    const noCode = await world({ ai: { level: 2 }, overrides: { appeals: { enabled: true } } as never });
    const ncRes = await noCode.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect([ncRes.status, errorOf(ncRes)]).toEqual([409, 'acting_unavailable']);
    for (const w of [low, noAppeals, noCode]) expect(w.routeAudit().filter((r) => r.action === 'ai.acting')).toEqual([]);
  });

  it('the error body is the fixed one: no echo of the reason or the word', async () => {
    const w = await actWorld();
    const res = await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: { confirm: 'zorbak-secret-word', reason: 'vlemmo-private-reason' } });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('zorbak');
    expect(text).not.toContain('vlemmo');
  });
});

describe('the audit trail', () => {
  it('each transition writes one ai.acting row: the caller as actor and role, the sections [ai] and the reason, no target', async () => {
    const w = await actWorld();
    // the trail lists newest first and breaks a tie by id, so each step happens a second after the last
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: { confirm: 'ACT', reason: '  we start  ' } });
    w.clock.t += 1000;
    await w.call('POST', PAUSE.path, { ...SENIOR, body: { reason: 'looks odd' } });
    w.clock.t += 1000;
    await w.call('POST', '/ai/acting/resume', { ...OWNER, body: { reason: 'it was fine' } });
    w.clock.t += 14 * DAY;
    await w.call('POST', '/ai/acting/start', { ...OWNER, body: ROUTES[1].body });
    w.clock.t += 1000;
    await w.call('POST', '/ai/acting/off', { ...OWNER, body: { reason: 'incident' } });
    const rows = w.routeAudit().filter((r) => r.action === 'ai.acting').reverse();
    expect(rows.map((r) => [r.actor, r.role, r.target, r.detail])).toEqual([
      ['owner_ann', 'owner', undefined, { sections: ['ai'], reason: 'we start' }],
      ['sen_bo', 'senior', undefined, { sections: ['ai'], reason: 'looks odd' }],
      ['owner_ann', 'owner', undefined, { sections: ['ai'], reason: 'it was fine' }],
      ['owner_ann', 'owner', undefined, { sections: ['ai'], reason: 'we are ready' }],
      ['owner_ann', 'owner', undefined, { sections: ['ai'], reason: 'incident' }],
    ]);
  });

  it('the state change stands when the audit row cannot be written (a pause must never fail on the trail)', async () => {
    const w = await actWorld({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) as typeof cw });
    const res = await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    expect(res.status).toBe(200);
    expect(w.cw.ai.acting.state().mode).toBe('shadow');
  });
});

describe('the settings cannot move acting', () => {
  it('a PUT /policy/profile cannot change the acting state, and cannot carry an acting key or level 3 or 4', async () => {
    const w = await actWorld();
    await w.call('POST', '/ai/acting/shadow', { ...OWNER, body: ROUTES[0].body });
    const before = w.cw.ai.acting.state();
    const v = (w.cw.policy.get() as { version: number }).version;
    const ok = await w.call('PUT', '/policy/profile', { ...OWNER, body: { layer: { ai: { level: 2, learn: false } }, version: v, reason: 'tune' } });
    expect(ok.status).toBe(200);
    for (const ai of [{ level: 3 }, { level: 4 }, { mode: 'on' }, { acting: 'on' }, { act: { enabled: true } }]) {
      const res = await w.call('PUT', '/policy/profile', { ...OWNER, body: { layer: { ai }, version: v + 1, reason: 'sneak' } });
      expect(res.status, JSON.stringify(ai)).toBe(400);
      expect(errorOf(res)).toBe('invalid_profile');
    }
    expect(w.cw.ai.acting.state()).toEqual(before);
    const off = await w.call('DELETE', '/policy/profile', { ...OWNER, body: { reason: 'reset' } });
    expect(off.status).toBe(200);
    expect(w.cw.ai.acting.state()).toEqual(before);
  });
});
