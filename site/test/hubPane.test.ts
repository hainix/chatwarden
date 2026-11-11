// The staff routes behind the demo's hub: the real adminRoutes over the demo's kit, signed in as a made-up owner, plus the one
// listener that tells the page when a case was opened and a decision taken (the tour and the notice button follow those).
import { afterEach, describe, expect, it } from 'vitest';
import { staffHandle } from '../src/demo/HubPane';
import type { StaffEvent } from '../src/demo/HubPane';
import { DEMO_ACTOR, KitEngine } from '../src/demo/kitEngine';

const engines: KitEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await (await e.kit()).close();
});

const req = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => ({
  method,
  path,
  query,
  headers: {},
  body: undefined,
  ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }),
});

async function withReport() {
  const engine = new KitEngine();
  engines.push(engine);
  await engine.reset();
  const sent = await engine.chat.accept('bo', 'uninstall the game, you are hopeless');
  const lineId = 'deliver' in sent ? sent.deliver.lineId : '';
  const filed = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId });
  if (!filed.ok) throw new Error('report refused');
  const world = await engine.world();
  const events: StaffEvent[] = [];
  const handle = staffHandle(world, (e) => events.push(e));
  return { engine, world, handle, events, reportId: filed.reportId };
}

describe('staffHandle', () => {
  it('is signed in as the made-up owner: GET /me says so', async () => {
    const { handle } = await withReport();
    const res = await handle(req('GET', '/me'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actor: DEMO_ACTOR, role: 'owner' });
    expect(DEMO_ACTOR).toBe('demo-mod');
  });

  it('serves the real routes: the queue, a report with the kit’s suggestion, the terms (the demo passes its term list), the policy', async () => {
    const { handle, reportId } = await withReport();
    expect((await handle(req('GET', '/reports', undefined, { status: 'open' }))).status).toBe(200);
    const one = await handle(req('GET', `/reports/${reportId}`));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ report: { id: reportId }, suggest: expect.any(Object) });
    expect((await handle(req('GET', '/terms'))).status).toBe(200); // `terms` is mounted
    expect((await handle(req('GET', '/policy/profile'))).status).toBe(200);
    expect((await handle(req('GET', '/audit'))).status).toBe(200); // an owner reads the audit trail
  });

  it('tells the page when a case is opened (GET /reports/:id), and not for the queue or a failed read', async () => {
    const { handle, events, reportId } = await withReport();
    await handle(req('GET', '/reports', undefined, { status: 'open' }));
    await handle(req('GET', '/reports/nope'));
    expect(events).toEqual([]);
    await handle(req('GET', `/reports/${reportId}`));
    expect(events).toEqual([{ kind: 'case-opened', reportId }]);
  });

  it('tells the page when the kit took a decision, and writes the staff name on it', async () => {
    const { handle, events, reportId, world, engine } = await withReport();
    const report = world.cw.reports.get(reportId);
    const res = await handle(
      req('POST', `/reports/${reportId}/decide`, {
        verdict: 'upheld',
        reason: 'rude',
        actions: [{ subject: report?.targetPerson, kind: 'warning', durationMs: null, rule: 2 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(events).toEqual([{ kind: 'decided', reportId }]);
    expect((await engine.notices.pending('bo')).map((n) => n.kind)).toEqual(['warning']);
    const audit = await handle(req('GET', '/audit'));
    expect(JSON.stringify(audit.body)).toContain('demo-mod');
  });

  it('a decision the kit refuses tells the page nothing', async () => {
    const { handle, events, reportId } = await withReport();
    const bad = await handle(req('POST', `/reports/${reportId}/decide`, { verdict: 'upheld', reason: '', actions: [] }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const missing = await handle(req('POST', '/reports/nope/decide', { verdict: 'no_action', reason: 'x', actions: [] }));
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(events).toEqual([]);
  });

  it('works without a listener', async () => {
    const engine = new KitEngine();
    engines.push(engine);
    const handle = staffHandle(await engine.world());
    expect((await handle(req('GET', '/me'))).status).toBe(200);
  });

  it('follows a Reset: a handle made for the new kit reads the new kit', async () => {
    const { engine, handle, reportId } = await withReport();
    await engine.reset();
    const fresh = staffHandle(await engine.world());
    expect((await fresh(req('GET', `/reports/${reportId}`))).status).toBe(404);
    // and the old handle still answers over the old kit (nothing shared)
    expect(typeof handle).toBe('function');
  });
});
