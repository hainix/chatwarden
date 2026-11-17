import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { verifyBundle } from '@chatwarden/core';
import type { EvidenceBundle } from '@chatwarden/core';
import { demoBundleSecret, startServer } from './server.js';
import type { TinyChat } from './server.js';

// CW_DEMO_PRIVACY=1 (or the `demoPrivacy` option) signs evidence bundles with a demo secret derived from the server secret, so the whole privacy and legal-hold flow can be
// seen over the owner's staff routes with no setup: a person is exported, a report is held past a forced retention pass, its bundle verifies, and the person is erased with the
// safety remainder (a ban in force stays) and a receipt. Without it bundles are produced unsigned and the signing secret does not exist. The staff routes are the owner's
// either way (the demo token is an owner); only the signing is the demo's.

const AMBIENT = ['CW_DEMO_PRIVACY', 'DISCORD_WEBHOOK_URL', 'DISCORD_MENTION_ROLE_ID'] as const;
const ambient = Object.fromEntries(AMBIENT.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of AMBIENT) delete process.env[k];
});
afterEach(() => {
  delete process.env.CW_DEMO_PRIVACY;
});
afterAll(() => {
  for (const k of AMBIENT) {
    if (ambient[k] === undefined) delete process.env[k];
    else process.env[k] = ambient[k];
  }
});

const servers: TinyChat[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const ws of sockets) ws.close();
  for (const s of servers) await s.close();
});

const TOKEN = 'tiny-chat-privacy-admin-token';
const SECRET = 'privacy-test-secret-not-for-production';
async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({ port: 0, secret: SECRET, discordWebhookUrl: '', adminToken: TOKEN, ...opts });
  servers.push(server);
  return server;
}

type Frame = Record<string, unknown>;
const keyOf = (name: string): string => `demo-key-${name}-0001-secret`;

async function connect(server: TinyChat, name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${keyOf(name)}`);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (data) => void frames.push(JSON.parse(data.toString()) as Frame));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const until = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
    if (!pred()) throw new Error('timed out waiting for the server');
  };
  await until(() => frames.some((f) => f.type === 'welcome'));
  const welcome = frames.find((f) => f.type === 'welcome') as Frame;
  const say = async (text: string): Promise<void> => {
    const from = frames.length;
    ws.send(JSON.stringify({ type: 'chat', text }));
    await until(() => frames.slice(from).some((f) => f.type === 'chat' || f.type === 'refused'));
  };
  return { say, seat: welcome.seatId as string };
}

const base = (server: TinyChat): string => `http://127.0.0.1:${server.port}`;
async function admin(server: TinyChat, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; headers: Headers }> {
  const res = await fetch(`${base(server)}/admin${path}`, {
    method,
    headers: { 'x-admin-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as unknown, headers: res.headers };
}
const report = (server: TinyChat, reporter: string, targetSeat: string): Promise<Response> =>
  fetch(`${base(server)}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: keyOf(reporter), targetSeat, category: 'harassment', note: 'a note' }) });

describe('tiny-chat with CW_DEMO_PRIVACY', () => {
  it('exports a demo person, erases them with the safety remainder and shows the receipt, holds a report past a forced purge and verifies its bundle; without the variable none of it exists', async () => {
    // Without the variable: the owner can still ask for a bundle, but nothing signs it.
    const without = await boot();
    const plenkWithout = await connect(without, 'plenk');
    await plenkWithout.say('a line before the report');
    const quissel0 = await connect(without, 'quissel');
    await quissel0.say('hi');
    expect((await report(without, 'quissel', plenkWithout.seat)).status).toBe(200);
    const q0 = (await admin(without, 'GET', '/reports?status=open')).json as { items: Array<{ id: string }> };
    const unsigned = (await admin(without, 'GET', `/reports/${q0.items[0]!.id}/bundle`)).json as EvidenceBundle;
    expect(unsigned.integrity.hmacSha256).toBeNull();
    expect(verifyBundle(unsigned, demoBundleSecret(SECRET)).hmac).toBe(false);

    process.env.CW_DEMO_PRIVACY = '1';
    const server = await boot();
    const plenk = await connect(server, 'plenk');
    const quissel = await connect(server, 'quissel');
    const tarvo = await connect(server, 'tarvo');
    await plenk.say('hello from plenk');
    await quissel.say('hi');
    await tarvo.say('hi');
    expect((await report(server, 'quissel', plenk.seat)).status).toBe(200);
    const open1 = (await admin(server, 'GET', '/reports?status=open')).json as { items: Array<{ id: string; targetPerson: string }> };
    const held = open1.items[0]!;
    const person = held.targetPerson;
    // a second report about the same person, which is not held
    expect((await report(server, 'tarvo', plenk.seat)).status).toBe(200);
    const open2 = (await admin(server, 'GET', '/reports?status=open')).json as { items: Array<{ id: string }> };
    const other = open2.items.find((r) => r.id !== held.id)!;

    // 1. the export of the demo person: a JSON attachment with their lines and nothing else's
    const exported = await admin(server, 'GET', `/people/${person}/privacy/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toMatch(/^attachment;/);
    const exportText = JSON.stringify(exported.json);
    expect(exportText).toContain('hello from plenk');
    expect(exportText).not.toContain(keyOf('plenk'));

    // 2. a ban in force on the person, so the erase keeps a remainder
    await server.chatwarden.sanctions.apply({ kind: 'ban', subject: person, includeIp: false, durationMs: null, reason: 'demo', actor: 'demo-admin', source: 'moderator', automated: false, rule: 1 });

    // 3. hold one report, force a retention pass that would delete every report: the held one survives, the other does not
    expect((await admin(server, 'PUT', `/reports/${held.id}/hold`, { code: 'legal_proceeding' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    const purged = await server.chatwarden.purge({ reportsMs: 0 });
    expect(purged.reports).toBeGreaterThanOrEqual(1);
    expect((await admin(server, 'GET', `/reports/${held.id}`)).status).toBe(200);
    expect(((await admin(server, 'GET', `/reports/${held.id}`)).json as { report: { hold?: { code: string } } }).report.hold?.code).toBe('legal_proceeding');
    expect((await admin(server, 'GET', `/reports/${other.id}`)).status).toBe(404);

    // 4. its bundle verifies under the demo secret, and fails after one changed byte
    const bundle = (await admin(server, 'GET', `/reports/${held.id}/bundle`)).json as EvidenceBundle;
    expect(bundle.integrity.hmacSha256).not.toBeNull();
    expect(verifyBundle(bundle, demoBundleSecret(SECRET))).toEqual({ sha256: true, hmac: true });
    const edited = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    edited.excerpt[0]!.raw += '!';
    expect(verifyBundle(edited, demoBundleSecret(SECRET))).toEqual({ sha256: false, hmac: false });
    expect(JSON.stringify(bundle)).not.toContain(keyOf('plenk'));

    // 5. the erase with the safety remainder: the ban stays enforceable, the held report stays whole, and the receipt holds counts only
    const dry = await admin(server, 'POST', `/people/${person}/privacy/erase`, { keep: 'safety', confirm: person, dryRun: true });
    expect(dry.json).toMatchObject({ dryRun: true, kept: { identifiers: true, heldReports: 1 } });
    const erased = await admin(server, 'POST', `/people/${person}/privacy/erase`, { keep: 'safety', confirm: person });
    expect(erased.status).toBe(200);
    const receipt = erased.json as { id: string; kept: { identifiers: boolean; sanctions: number; heldReports: number }; removed: Record<string, number> };
    expect(receipt.id).toMatch(/^e_/);
    expect(receipt.kept).toEqual({ identifiers: true, sanctions: 1, heldReports: 1 });
    expect(Object.keys(receipt).sort()).toEqual(['at', 'id', 'kept', 'mode', 'removed']);
    expect(JSON.stringify(receipt)).not.toContain(person);
    // the held report is still readable, and the person is still refused at the door
    expect((await admin(server, 'GET', `/reports/${held.id}`)).status).toBe(200);
    expect(server.chatwarden.chat.restricted({ clientKey: keyOf('plenk') }).restricted).toBe(true);
  });

  it('only exactly 1 turns it on; the option wins over the environment, and false forces it off', async () => {
    process.env.CW_DEMO_PRIVACY = 'yes';
    expect(demoBundleSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/);
    const probe = async (opts: Parameters<typeof startServer>[0]): Promise<boolean> => {
      const server = await boot(opts);
      const plenk = await connect(server, 'plenk');
      await plenk.say('line one');
      const quissel = await connect(server, 'quissel');
      await quissel.say('hi');
      await report(server, 'quissel', plenk.seat);
      const q = (await admin(server, 'GET', '/reports?status=open')).json as { items: Array<{ id: string }> };
      const b = (await admin(server, 'GET', `/reports/${q.items[0]!.id}/bundle`)).json as EvidenceBundle;
      return b.integrity.hmacSha256 !== null;
    };
    expect(await probe({})).toBe(false);
    process.env.CW_DEMO_PRIVACY = '1';
    expect(await probe({})).toBe(true);
    expect(await probe({ demoPrivacy: false })).toBe(false);
    delete process.env.CW_DEMO_PRIVACY;
    expect(await probe({ demoPrivacy: true })).toBe(true);
  });
});
