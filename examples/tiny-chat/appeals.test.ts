import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// CW_DEMO_APPEALS=1 (or the `demoAppeals` option) turns on appeals and required renames, so a player can ask for a second look at a sanction and a
// moderator can decide it with no setup. The demo's one staff login is the actor `demo-admin`, so the sanction is given by another actor
// (`demo-moderator`): the same person may not decide the appeal of their own decision. Without the switch none of it exists.

const ambient = { demo: process.env.CW_DEMO_APPEALS, url: process.env.DISCORD_WEBHOOK_URL, role: process.env.DISCORD_MENTION_ROLE_ID };
beforeAll(() => {
  delete process.env.CW_DEMO_APPEALS;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_MENTION_ROLE_ID;
});
afterEach(() => {
  delete process.env.CW_DEMO_APPEALS;
});
afterAll(() => {
  for (const [key, value] of [['CW_DEMO_APPEALS', ambient.demo], ['DISCORD_WEBHOOK_URL', ambient.url], ['DISCORD_MENTION_ROLE_ID', ambient.role]] as const) {
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

const TOKEN = 'appeals-demo-admin-token';
const HOUR = 3_600_000;

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({ port: 0, secret: 'appeals-test-secret-not-for-production', discordWebhookUrl: '', adminToken: TOKEN, ...opts });
  servers.push(server);
  return server;
}

type Json = Record<string, unknown>;
const keyOf = (name: string): string => `demo-key-${name}-0001-secret`;

/** Seat a player over the WebSocket and answer the seat they hold. */
async function seat(server: TinyChat, name: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${keyOf(name)}`);
  sockets.push(ws);
  const welcome = new Promise<Json>((resolve, reject) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Json;
      if (frame.type === 'welcome') resolve(frame);
    });
    ws.once('error', reject);
  });
  return (await welcome).seatId as string;
}

async function call(server: TinyChat, path: string, init: { method?: string; as?: 'player' | 'staff'; name?: string; body?: unknown } = {}): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = {};
  if (init.as === 'staff') headers['x-admin-token'] = TOKEN;
  else if (init.name !== undefined) headers['x-chatwarden-key'] = keyOf(init.name);
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Json) };
}

/**
 * A 24 hour chat restriction for `target`, decided by `actor` on a report a second player filed (the kit writes a player's notice when a report
 * is decided, or when it times someone out by itself; a bare `sanctions.apply` writes none). Answers the target's subject.
 */
async function restrict(server: TinyChat, reports: Array<{ id: string }>, target: string, reporter: string, actor: string): Promise<string> {
  const targetSeat = await seat(server, target);
  await seat(server, reporter);
  const res = await fetch(`http://127.0.0.1:${server.port}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyOf(reporter), targetSeat, category: 'harassment', note: 'kept at it' }),
  });
  expect(res.status).toBe(200);
  const subject = server.chatwarden.rooms.subjectAt('lobby', targetSeat);
  if (subject === null) throw new Error('expected a subject');
  const done = await server.chatwarden.decide({
    reportId: reports.at(-1)?.id ?? '',
    verdict: 'upheld',
    actor,
    reason: 'repeated insults in the lobby',
    actions: [{ subject, kind: 'chat', durationMs: 24 * HOUR, rule: 2 }],
  });
  expect(done.ok).toBe(true);
  return subject;
}

describe('tiny-chat with CW_DEMO_APPEALS', () => {
  it('files an appeal against a demo sanction, a second moderator reduces it, and the player sees the outcome notice', async () => {
    const reports: Array<{ id: string }> = [];
    const server = await boot({ demoAppeals: true, onReport: (r) => void reports.push(r) });
    await restrict(server, reports, 'quissel', 'reporter-one', 'demo-moderator');

    // The player's notice is the sanction they can appeal.
    const notices = await call(server, '/api/notices', { name: 'quissel' });
    const sanction = (notices.json.notices as Array<{ id: string; kind: string }>).find((n) => n.kind === 'chat');
    expect(sanction).toBeDefined();
    expect((await call(server, '/api/appeals', { name: 'quissel' })).json).toEqual({ appeals: [] });

    const filed = await call(server, '/api/appeals', { method: 'POST', name: 'quissel', body: { noticeId: sanction?.id, statement: 'It was a joke between friends, and we had stopped.' } });
    expect(filed.status).toBe(200);
    expect(filed.json.appeal).toMatchObject({ noticeId: sanction?.id, status: 'open', decidedAt: null });
    // Once only: a second appeal against the same sanction is refused.
    const again = await call(server, '/api/appeals', { method: 'POST', name: 'quissel', body: { noticeId: sanction?.id, statement: 'Please look again.' } });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('already_appealed');

    // The moderators see it in the inbox and are told by /me and /changes.
    const me = await call(server, '/admin/me', { as: 'staff' });
    expect(me.json.features).toMatchObject({ appeals: true, renames: true });
    const inbox = await call(server, '/admin/appeals', { as: 'staff' });
    const items = inbox.json.items as Array<{ id: string; sanction: { decidedBy: string; kind: string } }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.sanction).toMatchObject({ kind: 'chat', decidedBy: 'demo-moderator' });
    const id = items[0]?.id as string;
    expect(((await call(server, `/admin/appeals/${id}`, { as: 'staff' })).json.appeal as Json).statement).toBe('It was a joke between friends, and we had stopped.');

    // The demo's staff login (demo-admin) did not give the sanction, so it may decide: reduce it to a warning.
    const decided = await call(server, `/admin/appeals/${id}/decide`, {
      method: 'POST',
      as: 'staff',
      body: { outcome: 'reduce', reason: 'Fair to warn, but a day of silence is too much.', to: { kind: 'warning', durationMs: null } },
    });
    expect(decided.status).toBe(200);
    expect(decided.json).toMatchObject({ status: 'reduced' });
    expect(typeof decided.json.replacementGroupId).toBe('string');

    // The player sees the outcome as a plain message, and the appeal as reduced. The outcome notice carries no reason and no staff name.
    const after = await call(server, '/api/notices', { name: 'quissel' });
    const outcome = (after.json.notices as Array<Json>).find((n) => n.kind === 'appeal_reduced');
    expect(outcome).toBeDefined();
    expect(JSON.stringify(outcome)).not.toMatch(/demo-admin|demo-moderator|too much/);
    const mine = await call(server, '/api/appeals', { name: 'quissel' });
    expect(mine.json.appeals).toMatchObject([{ status: 'reduced' }]);
  });

  it('the same moderator may not decide the appeal of their own decision, and the demo asks for a rename through the staff routes', async () => {
    const reports: Array<{ id: string }> = [];
    const server = await boot({ demoAppeals: true, onReport: (r) => void reports.push(r) });
    // The staff login's own decision (the actor is demo-admin).
    const subject = await restrict(server, reports, 'merl', 'reporter-two', 'demo-admin');
    const sanction = ((await call(server, '/api/notices', { name: 'merl' })).json.notices as Array<{ id: string; kind: string }>).find((n) => n.kind === 'chat');
    await call(server, '/api/appeals', { method: 'POST', name: 'merl', body: { noticeId: sanction?.id, statement: 'Please look again.' } });
    const id = ((await call(server, '/admin/appeals', { as: 'staff' })).json.items as Array<{ id: string }>)[0]?.id;
    const refused = await call(server, `/admin/appeals/${id}/decide`, { method: 'POST', as: 'staff', body: { outcome: 'uphold', reason: 'Still right.' } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('same_decider');

    // A rename request: a notice that names no name, and the game's hold until it calls `renamed`.
    const asked = await call(server, `/admin/people/${encodeURIComponent(subject)}/rename`, { method: 'POST', as: 'staff', body: { reason: 'The name breaks Rule 1.' } });
    expect(asked.status).toBe(200);
    expect(server.chatwarden.names.pendingRename({ clientKey: keyOf('merl') })).toBe(true);
    const asked2 = await call(server, `/admin/people/${encodeURIComponent(subject)}/rename`, { method: 'POST', as: 'staff', body: { reason: 'Again.' } });
    expect(asked2.json.error).toBe('pending_rename');
    expect(server.chatwarden.names.renamed({ clientKey: keyOf('merl') })).toBe(true);
    expect(server.chatwarden.names.pendingRename({ clientKey: keyOf('merl') })).toBe(false);
  });

  it('the README path works: three blocked lines earn an automatic timeout, and the demo staff login decides its appeal', async () => {
    const server = await boot({ demoAppeals: true });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${keyOf('zed')}`);
    sockets.push(ws);
    const frames: Json[] = [];
    ws.on('message', (data) => void frames.push(JSON.parse(data.toString()) as Json));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    for (let i = 0; i < 3; i += 1) ws.send(JSON.stringify({ type: 'chat', text: 'zorbak' }));
    for (let i = 0; i < 300 && !frames.some((f) => f.type === 'notices'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const notice = ((await call(server, '/api/notices', { name: 'zed' })).json.notices as Array<{ id: string; kind: string }>).find((n) => n.kind === 'chat');
    expect(notice).toBeDefined();
    const filed = await call(server, '/api/appeals', { method: 'POST', name: 'zed', body: { noticeId: notice?.id, statement: 'I was quoting a game.' } });
    expect(filed.status).toBe(200);
    const id = ((await call(server, '/admin/appeals', { as: 'staff' })).json.items as Array<{ id: string; sanction: { automated: boolean } }>)[0];
    expect(id?.sanction.automated).toBe(true);
    const decided = await call(server, `/admin/appeals/${id?.id}/decide`, { method: 'POST', as: 'staff', body: { outcome: 'revoke', reason: 'Quoted, not aimed at anyone.' } });
    expect(decided.json).toEqual({ status: 'revoked' });
  });

  it('without the variable none of it exists', async () => {
    const reports: Array<{ id: string }> = [];
    const server = await boot({ onReport: (r) => void reports.push(r) });
    await restrict(server, reports, 'quissel', 'reporter-three', 'demo-moderator');
    expect(server.chatwarden.appeals.enabled()).toBe(false);
    expect(server.chatwarden.names.renamesEnabled()).toBe(false);
    expect((await call(server, '/api/appeals', { name: 'quissel' })).status).toBe(404);
    expect((await call(server, '/api/appeals', { method: 'POST', name: 'quissel', body: { noticeId: 'x', statement: 'y' } })).status).toBe(404);
    expect((await call(server, '/admin/appeals', { as: 'staff' })).status).toBe(404);
    expect((await call(server, '/admin/appeals/stats', { as: 'staff' })).status).toBe(404);
    expect((await call(server, '/admin/people/s_none/rename', { method: 'POST', as: 'staff', body: { reason: 'x' } })).status).toBe(404);
    // 0.1.8's bodies: no features in /me, and no outcome notice kinds appear.
    expect((await call(server, '/admin/me', { as: 'staff' })).json).not.toHaveProperty('features');
  });

  it('the option wins over the environment, only the exact value 1 turns it on, and a profile override wins field by field', async () => {
    process.env.CW_DEMO_APPEALS = '1';
    const onByEnv = await boot();
    expect(onByEnv.chatwarden.appeals.enabled()).toBe(true);
    const forcedOff = await boot({ demoAppeals: false });
    expect(forcedOff.chatwarden.appeals.enabled()).toBe(false);
    expect(forcedOff.chatwarden.names.renamesEnabled()).toBe(false);
    process.env.CW_DEMO_APPEALS = 'true';
    expect((await boot()).chatwarden.appeals.enabled()).toBe(false);
    delete process.env.CW_DEMO_APPEALS;
    const lowered = await boot({ demoAppeals: true, overrides: { appeals: { perPlayerPerWeek: 1 }, names: { renames: false } } });
    expect(lowered.chatwarden.appeals.enabled()).toBe(true);
    expect(lowered.chatwarden.profile.appeals.perPlayerPerWeek).toBe(1);
    expect(lowered.chatwarden.names.renamesEnabled()).toBe(false);
  });

  it('the page offers the appeal button only when the server has appeals on', () => {
    const page = readFileSync(new URL('./web/chat-page.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/client\.appeals\(\)/);
    expect(page).toMatch(/<NoticeQueue[^>]*\bappeals\b/);
  });
});
