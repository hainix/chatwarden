import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { toExpress } from '../../src/express.js';
import { webhookIn } from '../../src/webhooks/in.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '../../src/webhooks/sign.js';
import { world } from '../world.js';

// The incoming route through the real Express adapter, end to end: the adapter's rawBody is what the signature covers.

const SECRET = 'express-incoming-secret-32-characters-min!';
const ACTOR = 'hook@example.test';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listen(app: Express): Promise<string> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function boot() {
  const w = await world();
  // The default clock (Date.now) is what a real deployment uses, so the requests are signed with the real time.
  const app = express();
  app.use('/hooks', toExpress(webhookIn(w.cw, { secret: SECRET, actor: ACTOR })));
  const base = await listen(app);
  const signed = (raw: string, o: { secret?: string; ts?: number } = {}): Record<string, string> => {
    const ts = o.ts ?? Math.floor(Date.now() / 1000);
    return {
      'content-type': 'application/json',
      [TIMESTAMP_HEADER]: String(ts),
      [SIGNATURE_HEADER]: sign(o.secret ?? SECRET, ts, raw),
    };
  };
  const post = (raw: string, headers: Record<string, string>) =>
    fetch(`${base}/hooks/webhooks/in/action`, { method: 'POST', headers, body: raw });
  return { w, base, signed, post };
}

describe('webhookIn through toExpress', () => {
  it('applies a signed sanction sent over a real socket', async () => {
    const { w, signed, post } = await boot();
    const subject = w.person();
    const raw = JSON.stringify({ action: 'sanction', input: { subject, kind: 'chat', durationMs: 60_000, rule: 1, reason: 'r', idempotencyKey: 'e2e-1' } });
    const res = await post(raw, signed(raw));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groupId: string; refCode: string };
    expect(Object.keys(body).sort()).toEqual(['groupId', 'refCode']);
    expect(w.db.prepare("SELECT actor, source FROM kit_sanctions WHERE target_type = 'subject'").all()).toEqual([{ actor: ACTOR, source: 'moderator' }]);
    expect(w.routeAudit()).toEqual([expect.objectContaining({ actor: ACTOR, role: 'moderator', action: 'sanction.apply' })]);
  });

  it('the same key sent again over the wire returns the first result (a fresh signature each time)', async () => {
    const { w, signed, post } = await boot();
    const subject = w.person();
    const input = { subject, kind: 'chat', durationMs: 60_000, rule: 1, reason: 'r', idempotencyKey: 'e2e-dup' };
    const first = await post(JSON.stringify({ action: 'sanction', input }), signed(JSON.stringify({ action: 'sanction', input })));
    const raw2 = JSON.stringify({ action: 'sanction', input, n: 2 });
    const second = await post(raw2, signed(raw2));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(w.db.prepare("SELECT 1 FROM kit_sanctions WHERE target_type = 'subject'").all()).toHaveLength(1);
  });

  it('is exact over the bytes: odd whitespace and multi-byte text verify', async () => {
    const { w, signed, post } = await boot();
    const subject = w.person();
    const raw = `{\n  "action" :"sanction" ,\t"input":{"subject":"${subject}","kind":"chat","durationMs":60000,"rule":1,"reason":"é日本 \u{1F600}","idempotencyKey":"e2e-bytes"}\n}\n`;
    const res = await post(raw, signed(raw));
    expect(res.status).toBe(200);
  });

  it('refuses a tampered body, a wrong secret, a stale timestamp and a replay with the fixed 401', async () => {
    const { w, signed, post } = await boot();
    const subject = w.person();
    const raw = JSON.stringify({ action: 'sanction', input: { subject, kind: 'chat', durationMs: 60_000, rule: 1, idempotencyKey: 'e2e-bad' } });
    const headers = signed(raw);
    const cases: Array<[string, string, Record<string, string>]> = [
      ['tampered', raw.replace('60000', '60001'), headers],
      ['wrong secret', raw, signed(raw, { secret: `${SECRET}-other` })],
      ['stale', raw, signed(raw, { ts: Math.floor(Date.now() / 1000) - 400 })],
    ];
    for (const [, body, h] of cases) {
      const res = await post(body, h);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    }
    expect(w.db.prepare("SELECT 1 FROM kit_sanctions WHERE target_type = 'subject'").all()).toHaveLength(0);
    expect((await post(raw, headers)).status).toBe(200);
    expect((await post(raw, headers)).status).toBe(401); // replay
    expect(w.db.prepare("SELECT 1 FROM kit_sanctions WHERE target_type = 'subject'").all()).toHaveLength(1);
  });

  it('a body parser mounted before the adapter consumed the bytes: 500, nothing applied', async () => {
    const w = await world();
    const app = express();
    app.use(express.json());
    app.use('/hooks', toExpress(webhookIn(w.cw, { secret: SECRET, actor: ACTOR }), { logger: { warn: () => undefined } }));
    const base = await listen(app);
    const subject = w.person();
    const raw = JSON.stringify({ action: 'sanction', input: { subject, kind: 'chat', durationMs: 60_000, rule: 1, idempotencyKey: 'e2e-parsed' } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/hooks/webhooks/in/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sign(SECRET, ts, raw) },
      body: raw,
    });
    expect(res.status).toBe(500);
    expect(w.db.prepare("SELECT 1 FROM kit_sanctions WHERE target_type = 'subject'").all()).toHaveLength(0);
  });

  it('a decide over the wire: a moderator-role hook cannot permanently ban', async () => {
    const { w, signed, post } = await boot();
    w.cw.rooms.seat('room-x', 'a', { clientKey: 'key-target-aaaaaaaa-x', ip: '198.51.100.7' }, 'Tgt');
    w.cw.rooms.seat('room-x', 'b', { clientKey: 'key-reporter-bbbbbbb-x', ip: '198.51.100.8' }, 'Rep');
    w.cw.chat.accept('room-x', 'a', 'an ordinary line');
    const filed = await w.cw.reports.submit({ roomId: 'room-x', reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    if (!filed.ok) throw new Error('expected a report');
    const target = w.cw.rooms.subjectAt('room-x', 'a') as string;
    const raw = JSON.stringify({
      action: 'decide',
      input: { reportId: filed.reportId, verdict: 'upheld', reason: 'r', actions: [{ subject: target, kind: 'ban', durationMs: null, rule: 1 }] },
    });
    const res = await post(raw, signed(raw));
    expect(res.status).toBe(403);
    expect(w.cw.reports.get(filed.reportId)?.status).toBe('open');
  });
});
