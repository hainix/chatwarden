import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { StoredReport } from '@chatwarden/core';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// CW_DEMO_AI=1 (or the `demoAi` option) wires the scripted fake ModerationAI into tiny-chat, so the whole AI flow can be seen in a browser with
// no key and no network: a new report gets a read, the hub shows it, and at level 2 the decision is pre-filled. Without it nothing changes.

const ADMIN = 'test-admin-token';
const IDENTIFIER_RE = /s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}/;

// The tests must not depend on the developer's shell.
const ambient = { demo: process.env.CW_DEMO_AI, url: process.env.DISCORD_WEBHOOK_URL, role: process.env.DISCORD_MENTION_ROLE_ID };
beforeAll(() => {
  delete process.env.CW_DEMO_AI;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_MENTION_ROLE_ID;
});
afterEach(() => {
  delete process.env.CW_DEMO_AI;
});
afterAll(() => {
  for (const [key, value] of [['CW_DEMO_AI', ambient.demo], ['DISCORD_WEBHOOK_URL', ambient.url], ['DISCORD_MENTION_ROLE_ID', ambient.role]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const servers: TinyChat[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const ws of sockets) ws.close();
  for (const s of servers) await s.close();
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<{ server: TinyChat; reports: StoredReport[] }> {
  const reports: StoredReport[] = [];
  const server = await startServer({ port: 0, secret: 'test-secret-not-for-production', adminToken: ADMIN, discordWebhookUrl: '', onReport: (r) => void reports.push(r), ...opts });
  servers.push(server);
  return { server, reports };
}

/** A player: a socket that has been welcomed and has said its lines. Resolves once the server has taken the lines in. */
async function player(server: TinyChat, key: string, lines: string[]): Promise<{ seat: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${key}`);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => void frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const until = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
    if (!pred()) throw new Error('timed out waiting for the server');
  };
  await until(() => frames.some((f) => f.type === 'welcome'));
  const seat = String(frames.find((f) => f.type === 'welcome')?.seatId);
  for (const text of lines) {
    ws.send(JSON.stringify({ type: 'chat', text }));
    await until(() => frames.filter((f) => f.type === 'chat' && f.seatId === seat).length >= lines.indexOf(text) + 1);
  }
  return { seat };
}

/** One report: `key-bad` says two rude lines, `key-reporter` reports them. */
async function fileReport(server: TinyChat, reports: StoredReport[]): Promise<string> {
  const bad = await player(server, 'key-bad', ['you are all so slow', 'uninstall the game']);
  await player(server, 'key-reporter', ['hello']);
  const res = await fetch(`http://127.0.0.1:${server.port}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'key-reporter', targetSeat: bad.seat, category: 'harassment', note: 'rude' }),
  });
  expect(res.status).toBe(200);
  const report = reports[0];
  if (report === undefined) throw new Error('no report was stored');
  return report.id;
}

const staff = async (server: TinyChat, path: string, init: RequestInit = {}): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
  const res = await fetch(`http://127.0.0.1:${server.port}/admin${path}`, { ...init, headers: { 'x-admin-token': ADMIN, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json };
};

describe('tiny-chat with CW_DEMO_AI', () => {
  it('tiny-chat with CW_DEMO_AI shows a read on a new report and no read without it', async () => {
    const on = await boot({ demoAi: true });
    const off = await boot({ demoAi: false });
    const idOn = await fileReport(on.server, on.reports);
    const idOff = await fileReport(off.server, off.reports);
    await on.server.chatwarden.ai.idle();
    await off.server.chatwarden.ai.idle();

    const withAi = await staff(on.server, `/reports/${idOn}`);
    expect(withAi.status).toBe(200);
    const read = withAi.json.ai as { id: string; summary: string; stale: boolean; recommendation: { verdict: string; step: unknown; stepWithinCeiling: boolean } | null } | null;
    expect(read).not.toBeNull();
    expect(read?.stale).toBe(false);
    expect(typeof read?.summary).toBe('string');
    expect(read?.summary).not.toBe('');
    // Level 2 in the demo: the recommendation is shown with its pre-fill step, so the hub offers Accept.
    expect(read?.recommendation?.verdict).toBe('upheld');
    expect(read?.recommendation?.step).not.toBeNull();
    expect(read?.recommendation?.stepWithinCeiling).toBe(true);

    const without = await staff(off.server, `/reports/${idOff}`);
    expect(without.status).toBe(200);
    expect(without.json.ai ?? null).toBeNull();
    expect(off.server.chatwarden.ai.status()).toMatchObject({ available: false, level: 0 });
  });

  it('shows in the queue as a brief, and the status page says the demo adapter is there and at level 2', async () => {
    const { server, reports } = await boot({ demoAi: true });
    const id = await fileReport(server, reports);
    await server.chatwarden.ai.idle();
    const queue = await staff(server, '/reports?status=open');
    const item = (queue.json.items as Array<{ id: string; ai: { severity: string } | null }>).find((i) => i.id === id);
    expect(item?.ai).not.toBeNull();
    const status = await staff(server, '/ai/status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ available: true, level: 2, maxLevel: 2, state: 'ok' });
  });

  it('the environment variable CW_DEMO_AI=1 turns it on; any other value, or none, leaves it off', async () => {
    process.env.CW_DEMO_AI = '1';
    expect((await boot()).server.chatwarden.ai.status().available).toBe(true);
    for (const value of ['0', '', 'true', 'yes', '2']) {
      process.env.CW_DEMO_AI = value;
      expect((await boot()).server.chatwarden.ai.status().available, `CW_DEMO_AI=${value}`).toBe(false);
    }
    delete process.env.CW_DEMO_AI;
    expect((await boot()).server.chatwarden.ai.status().available).toBe(false);
  });

  it('the option wins over the environment, both ways', async () => {
    process.env.CW_DEMO_AI = '1';
    expect((await boot({ demoAi: false })).server.chatwarden.ai.status().available).toBe(false);
    delete process.env.CW_DEMO_AI;
    expect((await boot({ demoAi: true })).server.chatwarden.ai.status().available).toBe(true);
  });

  it('a read again asks the fake once more, and nothing leaves the process (no fetch is made)', async () => {
    const realFetch = globalThis.fetch;
    const { server, reports } = await boot({ demoAi: true });
    const id = await fileReport(server, reports);
    await server.chatwarden.ai.idle();
    // From here on every call that goes out of the process would be a fetch: the AI makes none (the demo adapter is local).
    const outbound: string[] = [];
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (!target.startsWith(`http://127.0.0.1:${server.port}/`)) outbound.push(target);
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const again = await staff(server, `/reports/${id}/ai/read`, { method: 'POST' });
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ status: 'ready' });
      await server.chatwarden.ai.idle();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(outbound).toEqual([]);
  });

  it('the read and the status carry no subject id, key or hash', async () => {
    const { server, reports } = await boot({ demoAi: true });
    const id = await fileReport(server, reports);
    await server.chatwarden.ai.idle();
    const read = JSON.stringify((await staff(server, `/reports/${id}`)).json.ai);
    const status = (await staff(server, '/ai/status')).text;
    for (const text of [read, status]) {
      expect(text).not.toMatch(IDENTIFIER_RE);
      expect(text).not.toContain('key-bad');
      expect(text).not.toContain('key-reporter');
    }
  });

  it('the owner can still turn it off in the hub: level 0 gives no read on the next report', async () => {
    const { server, reports } = await boot({ demoAi: true });
    expect(server.chatwarden.policy.save({ ai: { level: 0 } }, { version: server.chatwarden.policy.get().version, actor: 'demo-admin', reason: 'test' })).toMatchObject({ ok: true });
    const id = await fileReport(server, reports);
    await server.chatwarden.ai.idle();
    expect((await staff(server, `/reports/${id}`)).json.ai ?? null).toBeNull();
  });
});
