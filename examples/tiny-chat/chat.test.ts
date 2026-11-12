import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';
// @ts-expect-error build.mjs is plain JavaScript (esbuild's API); it exports buildWeb
import { buildWeb } from './web/build.mjs';

// The HTTP chat beside the WebSocket protocol: the kit's room broadcaster and chat routes mounted at /chat, and the page that uses
// the ChatBox. The WebSocket tests are untouched (tiny-chat.test.ts, mod.test.ts).

const ADMIN = 'demo-admin-token';
const ROOM = 'lobby';
const keyOf = (name: string): string => `demo-key-${name}-0001-secret`;

let server: TinyChat;
let base = '';
const open: Array<() => void> = [];

beforeAll(async () => {
  await (buildWeb as () => Promise<void>)();
}, 60_000);

afterEach(() => {
  for (const stop of open.splice(0)) stop();
});
afterAll(async () => {
  await server?.close();
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  await server?.close();
  server = await startServer({ port: 0, secret: 'chat-test-secret-not-for-production', adminToken: ADMIN, discordWebhookUrl: '', ...opts });
  base = `http://127.0.0.1:${server.port}`;
  return server;
}

const as = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'x-chatwarden-key': keyOf(name), ...extra });

/** An open stream: everything it has received, as text, and the frames in order. */
interface Listening {
  text(): string;
  frames(): Array<Record<string, unknown>>;
  until(pred: (frames: Array<Record<string, unknown>>) => boolean, ms?: number): Promise<void>;
  status: number;
  type: string;
  headers: Headers;
}

async function listen(name: string, room = ROOM): Promise<Listening> {
  const ac = new AbortController();
  open.push(() => ac.abort());
  const res = await fetch(`${base}/chat/rooms/${room}/stream`, { headers: as(name, { accept: 'text/event-stream' }), signal: ac.signal });
  let text = '';
  const waiters: Array<() => void> = [];
  void (async () => {
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (const w of waiters.splice(0)) w();
      }
    } catch {
      // aborted
    }
  })();
  const frames = (): Array<Record<string, unknown>> =>
    [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string) as Record<string, unknown>);
  const until = async (pred: (f: Array<Record<string, unknown>>) => boolean, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pred(frames())) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${text.slice(0, 400)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { text: () => text, frames, until, status: res.status, type: res.headers.get('content-type') ?? '', headers: res.headers };
}

const post = async (name: string, route: 'lines' | 'mute' | 'report', body: unknown, room = ROOM): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
  const res = await fetch(`${base}/chat/rooms/${room}/${route}`, { method: 'POST', headers: as(name, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
};

/** The subject id of a player, for staff-side checks, through a probe seat of the same identity. */
function subjectOf(name: string): string {
  const probe = `probe-${name}`;
  server.chatwarden.rooms.seat(ROOM, probe, { clientKey: keyOf(name), ip: '127.0.0.1' }, name);
  const subject = server.chatwarden.rooms.subjectAt(ROOM, probe);
  server.chatwarden.rooms.unseat(ROOM, probe);
  if (subject === null) throw new Error('no subject');
  return subject;
}

describe('the page', () => {
  beforeAll(async () => {
    await boot();
  });

  it('serves the page and the bundle with the CSP and nosniff; GET /chat.js is a module', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(page.headers.get('content-security-policy')).toMatch(/style-src 'self'/);
    expect(page.headers.get('content-security-policy')).toMatch(/connect-src 'self'/);
    expect(page.headers.get('content-security-policy')).not.toMatch(/unsafe-inline|unsafe-eval/);
    const html = await page.text();
    expect(html).toContain('<script type="module" src="/chat.js">');
    expect(html).toContain('href="/chat.css"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\sstyle=/);

    const js = await fetch(`${base}/chat.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    const code = await js.text();
    expect(code.length).toBeGreaterThan(20_000);
    expect(code).not.toMatch(/\beval\(|new Function\(/);

    const css = await fetch(`${base}/chat.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    expect(css.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await css.text()).toContain('.cw-chat');
  });

  it('the bundle holds no demo key (it is made in the browser)', async () => {
    const code = await (await fetch(`${base}/chat.js`)).text();
    expect(code).not.toContain('demo-key-');
  });

  it('the page marks the demo identity as DEMO ONLY', async () => {
    expect(await (await fetch(`${base}/`)).text()).toMatch(/DEMO ONLY/);
  });

  it('the bundle exists on disk where the server reads it', () => {
    expect(existsSync(fileURLToPath(new URL('./dist/web/chat.js', import.meta.url)))).toBe(true);
  });
});

describe('two players over /chat', () => {
  beforeAll(async () => {
    await boot();
  });

  it('a line from one reaches the other; a blocked line is refused with rule 1 and reaches nobody', async () => {
    const a = await listen('alice');
    const b = await listen('bob');
    expect(a.status).toBe(200);
    expect(a.type).toMatch(/text\/event-stream/);
    await a.until((f) => f.some((x) => x.type === 'hello'));
    await b.until((f) => f.some((x) => x.type === 'hello'));
    const hello = a.frames().find((f) => f.type === 'hello') as { you: { name: string } };
    expect(hello.you.name).toMatch(/^Player \d+$/);

    const ok = await post('alice', 'lines', { text: 'hello bob' });
    expect(ok.json).toMatchObject({ ok: true, line: { text: 'hello bob', mine: true } });
    await b.until((f) => f.some((x) => x.type === 'line'));
    const heard = b.frames().find((f) => f.type === 'line') as { line: { text: string; name: string; mine?: boolean } };
    expect(heard.line.text).toBe('hello bob');
    expect(heard.line.mine).toBeUndefined();
    expect(heard.line.name).toBe(hello.you.name);

    const refused = await post('alice', 'lines', { text: 'you zorbak' });
    expect(refused.json).toMatchObject({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.text()).not.toContain('zorbak');
    expect(a.text()).not.toContain('zorbak');
  });

  it('a refused line\'s text is in no other player\'s stream, no later snapshot and no answer but the author\'s reason', async () => {
    await boot();
    const a = await listen('alice');
    await a.until((f) => f.some((x) => x.type === 'hello'));
    const refused = await post('alice', 'lines', { text: 'zorbak is blocked' });
    expect(refused.text).not.toContain('zorbak');
    const late = await listen('cara');
    await late.until((f) => f.some((x) => x.type === 'hello'));
    expect(late.text()).not.toContain('zorbak');
    expect(a.text()).not.toContain('zorbak');
  });

  it('names are Player N, assigned per key, and never any part of the key', async () => {
    await boot();
    const a1 = await listen('alice');
    const a2 = await listen('alice');
    const b = await listen('bob');
    for (const l of [a1, a2, b]) await l.until((f) => f.some((x) => x.type === 'hello'));
    const name = (l: Listening): string => (l.frames().find((f) => f.type === 'hello') as { you: { name: string } }).you.name;
    expect(name(a1)).toBe(name(a2));
    expect(name(a1)).not.toBe(name(b));
    for (const l of [a1, a2, b]) expect(name(l)).not.toMatch(/demo|key|alice|bob/i);
  });

  it('401 without a key, and the stream is not a page for a form post', async () => {
    const none = await fetch(`${base}/chat/rooms/lobby/stream`);
    expect(none.status).toBe(401);
    const form = await fetch(`${base}/chat/rooms/lobby/lines`, { method: 'POST', headers: { ...as('alice'), 'content-type': 'text/plain' }, body: '{"text":"hi"}' });
    expect(form.status).toBe(400);
  });
});

describe('a stored sanction, a report and what leaves the server', () => {
  const reports: StoredReport[] = [];
  beforeAll(async () => {
    reports.length = 0;
    await boot({ onReport: (r) => void reports.push(r) });
  });

  it('a stored chat sanction on a player: their line is refused restricted with until, byModerator and noticeId; the notice is listed by GET /api/notices', async () => {
    const a = await listen('dana');
    const c = await listen('cole');
    await a.until((f) => f.some((x) => x.type === 'hello'));
    await c.until((f) => f.some((x) => x.type === 'hello'));
    const said = await post('dana', 'lines', { text: 'you are so bad at this' });
    const lineId = (said.json.line as { id: string }).id;
    await c.until((f) => f.some((x) => x.type === 'line'));
    expect((await post('cole', 'report', { lineId })).json).toMatchObject({ ok: true });
    const report = reports.at(-1);
    if (report === undefined) throw new Error('no report');
    const decided = await server.chatwarden.decide({
      reportId: report.id,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: 'private moderator reason',
      actions: [{ subject: subjectOf('dana') as never, kind: 'chat', durationMs: 3_600_000, rule: 2, lineIds: report.excerpt.filter((l) => l.delivered === 'you are so bad at this').map((l) => l.lineId) }],
    });
    expect(decided.ok).toBe(true);
    // the open box is told to ask for the notice (no content), and the next line is refused
    await a.until((f) => f.some((x) => x.type === 'notices'));
    const refused = await post('dana', 'lines', { text: 'hello' });
    expect(refused.json).toMatchObject({ ok: false, refused: { reason: 'restricted', byModerator: true } });
    const r = refused.json.refused as { until: number; noticeId?: string };
    expect(typeof r.until).toBe('number');
    expect(typeof r.noticeId).toBe('string');
    expect(refused.text).not.toContain('private moderator reason');
    const notices = (await (await fetch(`${base}/api/notices`, { headers: as('dana') })).json()) as { notices: Array<{ id: string; kind: string }> };
    expect(notices.notices.some((n) => n.id === r.noticeId && n.kind === 'chat')).toBe(true);
  });

  it('a report from the chat box files a report the hub route lists, with the right reporter and target', async () => {
    const a = await listen('erin');
    const b = await listen('finn');
    await a.until((f) => f.some((x) => x.type === 'hello'));
    await b.until((f) => f.some((x) => x.type === 'hello'));
    const said = await post('erin', 'lines', { text: 'you are so bad at this too' });
    const lineId = (said.json.line as { id: string }).id;
    await b.until((f) => f.some((x) => x.type === 'line'));
    const filed = await post('finn', 'report', { lineId });
    expect(filed.json).toMatchObject({ ok: true });
    expect(Object.keys(filed.json).sort()).toEqual(['ok', 'remaining']);
    const report = reports.at(-1);
    if (report === undefined) throw new Error('no report');
    const detail = (await (await fetch(`${base}/admin/reports/${report.id}`, { headers: { 'x-admin-token': ADMIN } })).json()) as { report: { targetSubject: string; reporterSubject: string } };
    expect(detail.report.targetSubject).toBe(subjectOf('erin'));
    expect(detail.report.reporterSubject).toBe(subjectOf('finn'));
    expect(report.excerpt.some((l) => l.delivered === 'you are so bad at this too')).toBe(true);
  });

  it('a mute from a line hides that player from the muter only', async () => {
    const g = await listen('gwen');
    const h = await listen('hugo');
    await g.until((f) => f.some((x) => x.type === 'hello'));
    await h.until((f) => f.some((x) => x.type === 'hello'));
    const said = await post('hugo', 'lines', { text: 'before the mute' });
    const lineId = (said.json.line as { id: string }).id;
    await g.until((f) => f.some((x) => x.type === 'line'));
    const muted = await post('gwen', 'mute', { lineId, on: true });
    expect(muted.json).toMatchObject({ ok: true, hiddenIds: [lineId] });
    await g.until((f) => f.some((x) => x.type === 'hide'));
    await post('hugo', 'lines', { text: 'after the mute' });
    await new Promise((r) => setTimeout(r, 200));
    expect(g.text()).not.toContain('after the mute');
    expect(h.text()).not.toContain('hide');
  });

  it('no key, subject, seat, hash or address appears in any frame or answer', async () => {
    const a = await listen('iris');
    const b = await listen('juno');
    await a.until((f) => f.some((x) => x.type === 'hello'));
    const answers = [(await post('iris', 'lines', { text: 'fine line' })).text, (await post('iris', 'lines', { text: 'zorbak' })).text];
    await b.until((f) => f.some((x) => x.type === 'line'));
    const said = await post('iris', 'lines', { text: 'another' });
    const lineId = (said.json.line as { id: string }).id;
    answers.push((await post('juno', 'report', { lineId })).text, (await post('juno', 'mute', { lineId, on: true })).text);
    const everything = [a.text(), b.text(), ...answers].join('\n');
    for (const secret of [keyOf('iris'), keyOf('juno'), subjectOf('iris'), subjectOf('juno'), '127.0.0.1', 'iris', 'juno']) expect(everything, secret).not.toContain(secret);
  });
});

describe('close', () => {
  it('releases the port and every timer', async () => {
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await server?.close();
    const before = timers();
    const s = await startServer({ port: 0, secret: 'chat-test-secret-not-for-production', discordWebhookUrl: '' });
    const origin = `http://127.0.0.1:${s.port}`;
    const ac = new AbortController();
    const res = await fetch(`${origin}/chat/rooms/lobby/stream`, { headers: { 'x-chatwarden-key': keyOf('zed'), accept: 'text/event-stream' }, signal: ac.signal });
    expect(res.status).toBe(200);
    await s.close();
    ac.abort();
    await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
    // the broadcaster's heartbeat and seat timers are gone with it
    await new Promise((r) => setTimeout(r, 50));
    expect(timers()).toBeLessThanOrEqual(before);
    server = await startServer({ port: 0, secret: 'chat-test-secret-not-for-production', discordWebhookUrl: '' });
  });
});

describe('the demo join', () => {
  beforeAll(async () => {
    await boot();
  });

  it('opens the demo room only: any other room id is 403 for a stream and a line', async () => {
    const stream = await fetch(`${base}/chat/rooms/some-other-room/stream`, { headers: as('rooma') });
    expect(stream.status).toBe(403);
    await stream.body?.cancel();
    const line = await post('rooma', 'lines', { text: 'hello' }, 'some-other-room');
    expect(line.status).toBe(403);
    expect((await post('rooma', 'lines', { text: 'hello' })).status).toBe(200);
  });

  it('does not grow without bound: the table of players it numbers is capped, and past the cap a new key is refused', async () => {
    await boot();
    let refused = 0;
    for (let i = 0; i < 1100; i += 1) {
      const res = await fetch(`${base}/chat/rooms/${ROOM}/stream`, { headers: { 'x-chatwarden-key': `demo-key-cap-${i}-0001-secret` } });
      await res.body?.cancel();
      if (res.status === 403) refused += 1;
    }
    expect(refused).toBe(1100 - 400); // the first 400 keys are numbered and let in, the rest are not
    // a key that was already numbered still gets in
    const again = await fetch(`${base}/chat/rooms/${ROOM}/stream`, { headers: { 'x-chatwarden-key': 'demo-key-cap-0-0001-secret' } });
    expect(again.status).toBe(200);
    await again.body?.cancel();
  }, 60_000);
});

