// The local transport that lets player-react's components talk to the kit in the page: the same four calls as the player routes,
// answered for one seat, with the shapes the routes use. It runs the REAL kit (KitEngine) and the REAL player client.
import { playerClient } from '@chatwarden/player-react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitEngine } from '../src/demo/kitEngine';
import { seatTransport } from '../src/demo/playerTransport';

const engines: KitEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await (await e.kit()).close();
});

/** A kit with Bo's rude line reported by You, and a warning decided for Bo. */
async function withWarning() {
  const engine = new KitEngine();
  engines.push(engine);
  await engine.reset();
  const sent = await engine.chat.accept('bo', 'uninstall the game, you are hopeless');
  const lineId = 'deliver' in sent ? sent.deliver.lineId : '';
  const filed = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId });
  if (!filed.ok) throw new Error('report refused');
  const cw = await engine.kit();
  const report = cw.reports.get(filed.reportId);
  if (report === null) throw new Error('no report');
  const decided = await cw.decide({
    reportId: report.id,
    verdict: 'upheld',
    actor: 'demo-mod',
    reason: 'rude',
    actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 2, lineIds: [lineId] }],
  });
  if (!decided.ok) throw new Error('not decided');
  return { engine, report };
}

describe('seatTransport', () => {
  it('GET /notices answers { notices: [] } for a seat with nothing waiting', async () => {
    const engine = new KitEngine();
    engines.push(engine);
    const res = await seatTransport(engine, 'bo')({ method: 'GET', path: '/notices' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notices: [] });
  });

  it("GET /notices carries the seat's own warning, and only that seat's", async () => {
    const { engine } = await withWarning();
    const bo = await seatTransport(engine, 'bo')({ method: 'GET', path: '/notices' });
    const notices = (bo.body as { notices: Array<{ kind: string }> }).notices;
    expect(notices.map((n) => n.kind)).toEqual(['warning']);
    for (const other of ['ada', 'you']) {
      const res = await seatTransport(engine, other)({ method: 'GET', path: '/notices' });
      expect(res.body, other).toEqual({ notices: [] });
    }
  });

  it('a notice carries no subject id, no IP and nobody else’s chat', async () => {
    const { engine, report } = await withWarning();
    const res = await seatTransport(engine, 'bo')({ method: 'GET', path: '/notices' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(report.targetPerson);
    expect(text).not.toContain('demo-bo');
    expect(text).not.toMatch(/gg, that last clutch/);
  });

  it('POST /notices/:id/ack answers { ok: true } once, clears it, and keeps it on the record', async () => {
    const { engine } = await withWarning();
    const bo = seatTransport(engine, 'bo');
    const id = ((await bo({ method: 'GET', path: '/notices' })).body as { notices: Array<{ id: string }> }).notices[0]?.id as string;
    expect((await bo({ method: 'POST', path: `/notices/${id}/ack` })).body).toEqual({ ok: true });
    expect((await bo({ method: 'GET', path: '/notices' })).body).toEqual({ notices: [] });
    const record = (await bo({ method: 'GET', path: '/record' })).body as { record: Array<{ kind: string }> };
    expect(record.record.map((n) => n.kind)).toEqual(['warning']);
  });

  it("another seat cannot acknowledge Bo's notice, and an unknown id is { ok: false }", async () => {
    const { engine } = await withWarning();
    const id = ((await seatTransport(engine, 'bo')({ method: 'GET', path: '/notices' })).body as { notices: Array<{ id: string }> }).notices[0]?.id as string;
    expect((await seatTransport(engine, 'ada')({ method: 'POST', path: `/notices/${id}/ack` })).body).toEqual({ ok: false });
    expect((await seatTransport(engine, 'bo')({ method: 'POST', path: '/notices/nope/ack' })).body).toEqual({ ok: false });
    expect(((await seatTransport(engine, 'bo')({ method: 'GET', path: '/notices' })).body as { notices: unknown[] }).notices).toHaveLength(1);
  });

  it('an id with odd characters is decoded, not matched as a path', async () => {
    const { engine } = await withWarning();
    const res = await seatTransport(engine, 'bo')({ method: 'POST', path: `/notices/${encodeURIComponent('a/b c')}/ack` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });

  it('any other route is 404 not_found (the kit has no player report route)', async () => {
    const engine = new KitEngine();
    engines.push(engine);
    const t = seatTransport(engine, 'bo');
    for (const [method, path] of [
      ['POST', '/report'],
      ['GET', '/rules'],
      ['GET', '/notices/x'],
      ['DELETE', '/notices/x/ack'],
      ['GET', '/'],
    ] as const) {
      const res = await t({ method, path });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body).toMatchObject({ error: 'not_found' });
    }
  });

  it('the real player client reads it: notices(), ack(), record()', async () => {
    const { engine } = await withWarning();
    const client = playerClient({ transport: seatTransport(engine, 'bo') });
    const pending = await client.notices();
    expect(pending.map((n) => n.kind)).toEqual(['warning']);
    expect(await client.ack(pending[0]?.id as string)).toBe(true);
    expect(await client.notices()).toEqual([]);
    expect((await client.record()).map((n) => n.kind)).toEqual(['warning']);
  });

  it('follows a Reset: the seat reads the new kit, which has no notices', async () => {
    const { engine } = await withWarning();
    const bo = seatTransport(engine, 'bo');
    expect(((await bo({ method: 'GET', path: '/notices' })).body as { notices: unknown[] }).notices).toHaveLength(1);
    await engine.reset();
    expect((await bo({ method: 'GET', path: '/notices' })).body).toEqual({ notices: [] });
  });
});
