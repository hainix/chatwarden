import { describe, expect, it } from 'vitest';
import { APP_ID, answerOf, botWorld, contentOf } from './discord-world.js';
import type { BotWorld, BotWorldOptions } from './discord-world.js';
import { DAY } from './world.js';

// Slow work: a deferred answer, then one follow-up (K5 D6, design 6.5). The timers are injected (`schedule`), so a test decides which one fires and when;
// `fetch` is a recorder, so nothing leaves the process. Every id and token is an obviously fake string.

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
/** `'hang'` never answers until the request is aborted. */
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error | 'hang';

/** A fetch that records every call and answers from a script (the last reply repeats). */
function fakeFetch(...script: Reply[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown> });
    const reply = script[Math.min(calls.length - 1, script.length - 1)] ?? { status: 200, json: {} };
    if (reply === 'hang') {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fn, calls };
}

interface Timer {
  ms: number;
  run: () => void;
  cancelled: boolean;
}

/** The bot's timers. `fire` decides, per timer, whether it fires the moment it is set (so it wins the race against work that has not resolved yet) or is only recorded. */
function fakeTimers(fire: (ms: number, n: number) => boolean) {
  const timers: Timer[] = [];
  const schedule = (run: () => void, ms: number): (() => void) => {
    const t: Timer = { ms, run, cancelled: false };
    timers.push(t);
    if (fire(ms, timers.length)) run();
    return () => {
      t.cancelled = true;
    };
  };
  return { timers, schedule };
}

const TOKEN_RE = /^tok_\d+_fake-interaction-token$/;
const FAILED = 'Something went wrong. Try again in the hub.';

async function rig(over: BotWorldOptions & { fire?: (ms: number, n: number) => boolean; replies?: Reply[] } = {}) {
  const { fire, replies, ...rest } = over;
  const f = fakeFetch(...(replies ?? [{ status: 200 }]));
  const t = fakeTimers(fire ?? (() => false));
  const b = await botWorld({ ...rest, options: { fetch: f.fn, schedule: t.schedule, actions: { dismiss: true, suggestion: true }, ...rest.options } });
  return { ...b, ...f, ...t };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** Wait until `n` calls were made (or 300 ms), then one more turn so a call that should NOT happen has its chance. */
const settle = async (r: Rig, n: number): Promise<void> => {
  const start = Date.now();
  while (r.calls.length < n && Date.now() - start < 300) await new Promise((res) => setTimeout(res, 2));
  await new Promise((res) => setTimeout(res, 5));
};

async function refCode(b: BotWorld): Promise<string> {
  const res = await b.cw.sanctions.apply({
    kind: 'chat',
    subject: b.w.person(),
    includeIp: false,
    durationMs: DAY,
    reason: 'a reason',
    actor: 'ann-the-moderator',
    source: 'moderator',
    automated: false,
    rule: 2,
  });
  return res.refCode;
}

const throwingLookup = (cw: BotWorld['cw']): BotWorld['cw'] =>
  new Proxy(cw, {
    get(target, prop, receiver) {
      if (prop === 'sanctions') {
        return new Proxy(target.sanctions, {
          get(t, p, r) {
            if (p === 'byRef') return () => { throw new RangeError('store down zorbak'); };
            return Reflect.get(t, p, r) as unknown;
          },
        });
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

const LOOKUP_DATA = { id: '666666666666666601', name: 'chatwarden', type: 1, options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: 'M-ABCDE' }] }] };

describe('deferred answers: the race', () => {
  it('fast work is answered inline; slow work is answered type 5 (command) or 6 (component) within respondWithinMs and finished by one PATCH of @original with the same content the inline answer would have had', async () => {
    let slow = false;
    const r = await rig({ fire: (ms) => slow && ms === 2500 });
    const code = await refCode(r);

    // A command, fast: inline, and no follow-up. The timer is armed at respondWithinMs and cancelled when the work wins.
    const inline = await r.send(r.client.lookup(code));
    expect(answerOf(inline).type).toBe(4);
    expect(r.calls).toHaveLength(0);
    expect(r.timers[0]).toMatchObject({ ms: 2500, cancelled: true });

    // The same command, slow: type 5, ephemeral, and one PATCH after.
    slow = true;
    const deferred = await r.send(r.client.lookup(code));
    expect(deferred.status).toBe(200);
    expect(deferred.body).toEqual({ type: 5, data: { flags: 64 } });
    await settle(r, 1);
    expect(r.calls).toHaveLength(1);
    const want = answerOf(inline).data;
    expect(r.calls[0]?.body).toEqual({ content: want?.content, allowed_mentions: { parse: [] }, components: want?.components });
    expect(contentOf(inline)).toContain(code);

    // A click on a button of the report post (a public message): type 5 as well, so the post itself is never edited.
    const filed = await r.w.file();
    slow = false;
    const quick = await r.send(r.client.click(`cw1:dis:${filed.id}`));
    slow = true;
    const late = await r.send(r.client.click(`cw1:dis:${filed.id}`));
    expect(late.body).toEqual({ type: 5, data: { flags: 64 } });
    await settle(r, 2);
    const preview = answerOf(quick).data;
    expect(r.calls[1]?.body).toEqual({ content: preview?.content, allowed_mentions: { parse: [] }, components: preview?.components });

    // A click on a button of the ephemeral preview (Confirm): type 6, and the PATCH edits that ephemeral message.
    const confirmed = await r.send(r.client.click(`cw1:ok:${filed.id}:n`));
    expect(confirmed.body).toEqual({ type: 6 });
    await settle(r, 3);
    expect(String(r.calls[2]?.body.content)).toMatch(/^Done/);
    expect(r.calls[2]?.body.components).toEqual([]);
  });

  it('a Cancel on the ephemeral preview is deferred as type 6 too; a ping is never raced', async () => {
    const r = await rig({ fire: (ms) => ms === 2500 });
    const cancelled = await r.send(r.client.click('cw1:x'));
    expect(cancelled.body).toEqual({ type: 6 });
    await settle(r, 1);
    expect(r.calls[0]?.body.content).toBe('Cancelled.');
    const before = r.timers.length;
    const ping = await r.send(r.client.ping());
    expect(ping.body).toEqual({ type: 1 });
    expect(r.timers).toHaveLength(before);
  });

  it('work that throws answers the fixed text, inline or by the follow-up, and logs the class', async () => {
    let slow = false;
    const r = await rig({ fire: (ms) => slow && ms === 2500, wrapKit: throwingLookup });
    const inline = await r.send(r.client.lookup('M-ABCDE'));
    expect(contentOf(inline)).toBe(FAILED);
    slow = true;
    const deferred = await r.send(r.client.lookup('M-ABCDE'));
    expect(deferred.body).toEqual({ type: 5, data: { flags: 64 } });
    await settle(r, 1);
    expect(r.calls[0]?.body.content).toBe(FAILED);
    expect(r.logged).toContainEqual(['chatwarden.discord_bot_failed', { op: 'handle', error: 'RangeError' }]);
  });

  it('a redelivery of a slow interaction is answered from memory and the work is not done twice', async () => {
    const r = await rig({ fire: (ms) => ms === 2500 });
    const code = await refCode(r);
    const sent = r.client.interaction(2, { ...LOOKUP_DATA, options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: code }] }] });
    expect((await r.send(r.client.signed(sent))).body).toEqual({ type: 5, data: { flags: 64 } });
    await settle(r, 1);
    expect(r.w.audit().filter((a) => a.action === 'history.view')).toHaveLength(1);
    // The same interaction id again, signed freshly (the replay cache refuses the old signature).
    const again = await r.send(r.client.signed(sent, { timestamp: Math.floor(r.w.clock.now() / 1000) + 1 }));
    expect(again.status).toBe(200);
    await settle(r, 2);
    expect(r.w.audit().filter((a) => a.action === 'history.view')).toHaveLength(1);
  });
});

describe('the direct path (actions.confirm false)', () => {
  it('a slow click on the public report post is deferred as type 5 ephemeral, never type 6, and the follow-up carries the same ephemeral answer', async () => {
    let slow = false;
    const r = await rig({ fire: (ms) => slow && ms === 2500, options: { actions: { dismiss: true, suggestion: true, confirm: false } } });
    const claimed = await r.w.file();
    r.cw.cases.claim(claimed.target, 'someone-else');
    const quick = await r.send(r.client.click(`cw1:dis:${claimed.id}`));
    expect(answerOf(quick)).toMatchObject({ type: 4, data: { flags: 64 } });
    slow = true;
    const late = await r.send(r.client.click(`cw1:dis:${claimed.id}`));
    expect(late.body).toEqual({ type: 5, data: { flags: 64 } });
    await settle(r, 1);
    expect(r.calls[0]?.body.content).toBe(contentOf(quick));
    // A forged confirm id (verb ok) is on an ephemeral message by definition: type 6.
    const ok = await r.send(r.client.click(`cw1:ok:${claimed.id}:n`));
    expect(ok.body).toEqual({ type: 6 });
  });
});

describe('the follow-up request', () => {
  it('the follow-up uses the fixed host, a token that matches the shape, and no Authorization header', async () => {
    const r = await rig({ fire: (ms) => ms === 2500 });
    await r.send(r.client.lookup('M-ABCDE'));
    await settle(r, 1);
    const [call] = r.calls;
    const url = new URL(call?.url ?? '');
    expect(url.origin).toBe('https://discord.com');
    const parts = url.pathname.split('/');
    expect(parts.slice(0, 5)).toEqual(['', 'api', 'v10', 'webhooks', APP_ID]);
    expect(parts[5]).toMatch(TOKEN_RE);
    expect(parts.slice(6)).toEqual(['messages', '@original']);
    expect(url.search).toBe('');
    expect(call?.init.method).toBe('PATCH');
    const headers = Object.fromEntries(Object.entries((call?.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers).toEqual({ 'content-type': 'application/json' });
    expect(call?.init.redirect).toBe('error');
  });

  it('a token of the wrong shape sends nothing and logs a class; the slow work is then answered inline', async () => {
    const r = await rig({ fire: (ms) => ms === 2500 });
    for (const token of ['', 'a b', 'tok/evil', 'tok?x=1', 'x'.repeat(600), 'toké', 'tok..x']) {
      const body = r.client.interaction(2, LOOKUP_DATA);
      const res = await r.send(r.client.signed({ ...body, token }));
      expect(answerOf(res).type).toBe(4);
    }
    const { token: _gone, ...noToken } = r.client.interaction(2, LOOKUP_DATA);
    void _gone;
    expect(answerOf(await r.send(r.client.signed(noToken))).type).toBe(4);
    await settle(r, 1);
    expect(r.calls).toHaveLength(0);
    expect(r.logged.filter(([e]) => e === 'chatwarden.discord_followup_failed')).toEqual(Array(8).fill(['chatwarden.discord_followup_failed', { reason: 'token' }]));
  });
});

describe('the follow-up when Discord pushes back', () => {
  it('a follow-up 429 retries once after the clamped wait; a 500 is logged and dropped; dispose cancels a pending follow-up', async () => {
    // 429 with retry_after 0.2 s: clamped up to 1 s; the retry works.
    const a = await rig({ fire: (ms) => ms === 2500 || ms === 1000, replies: [{ status: 429, json: { retry_after: 0.2 } }, { status: 200 }] });
    await a.send(a.client.lookup('M-ABCDE'));
    await settle(a, 2);
    expect(a.calls).toHaveLength(2);
    expect(a.calls[1]?.body).toEqual(a.calls[0]?.body);
    expect(a.timers.map((t) => t.ms)).toEqual([2500, 1000]);
    expect(a.logged.filter(([e]) => e === 'chatwarden.discord_followup_failed')).toEqual([]);

    // retry_after 120 s: clamped down to 60 s. A second 429 is not retried again.
    const b = await rig({ fire: (ms) => ms === 2500 || ms === 60_000, replies: [{ status: 429, json: { retry_after: 120 } }] });
    await b.send(b.client.lookup('M-ABCDE'));
    await settle(b, 3);
    expect(b.calls).toHaveLength(2);
    expect(b.timers.map((t) => t.ms)).toEqual([2500, 60_000]);
    expect(b.logged).toContainEqual(['chatwarden.discord_followup_failed', { reason: 'status', status: 429 }]);

    // A 429 with no retry_after in the body falls back to the header, then to 1 s.
    const h = await rig({ fire: (ms) => ms === 2500 || ms === 5000, replies: [{ status: 429, headers: { 'retry-after': '5' } }, { status: 200 }] });
    await h.send(h.client.lookup('M-ABCDE'));
    await settle(h, 2);
    expect(h.timers.map((t) => t.ms)).toEqual([2500, 5000]);
    const n = await rig({ fire: (ms) => ms === 2500 || ms === 1000, replies: [{ status: 429, json: { message: 'slow down' } }, { status: 200 }] });
    await n.send(n.client.lookup('M-ABCDE'));
    await settle(n, 2);
    expect(n.timers.map((t) => t.ms)).toEqual([2500, 1000]);

    // A 500 is logged by status and dropped: one call, no retry. A 404 too.
    const c = await rig({ fire: (ms) => ms === 2500, replies: [{ status: 500 }] });
    await c.send(c.client.lookup('M-ABCDE'));
    await settle(c, 2);
    expect(c.calls).toHaveLength(1);
    expect(c.logged).toContainEqual(['chatwarden.discord_followup_failed', { reason: 'status', status: 500 }]);
    const d = await rig({ fire: (ms) => ms === 2500, replies: [{ status: 404 }] });
    await d.send(d.client.lookup('M-ABCDE'));
    await settle(d, 1);
    expect(d.logged).toContainEqual(['chatwarden.discord_followup_failed', { reason: 'status', status: 404 }]);

    // A thrown fetch is logged by class, never by message (a fetch error can quote the URL, which holds the token).
    const e = await rig({ fire: (ms) => ms === 2500, replies: [new TypeError('connect ECONNREFUSED https://discord.com/api/v10/webhooks/x/SECRET')] });
    await e.send(e.client.lookup('M-ABCDE'));
    await settle(e, 2);
    expect(e.calls).toHaveLength(1);
    expect(e.logged).toContainEqual(['chatwarden.discord_followup_failed', { reason: 'error', error: 'TypeError' }]);
    expect(JSON.stringify(e.logged)).not.toContain('SECRET');

    // dispose while the retry waits: the wait is cancelled and nothing more is sent.
    const p = await rig({ fire: (ms) => ms === 2500, replies: [{ status: 429, json: { retry_after: 2 } }, { status: 200 }] });
    await p.send(p.client.lookup('M-ABCDE'));
    await settle(p, 1);
    expect(p.timers.map((t) => t.ms)).toEqual([2500, 2000]);
    p.bot.dispose();
    expect(p.timers[1]?.cancelled).toBe(true);
    p.timers[1]?.run();
    await settle(p, 3);
    expect(p.calls).toHaveLength(1);
  });

  it('dispose aborts a follow-up in flight without a log line, and a disposed bot answers 401', async () => {
    const r = await rig({ fire: (ms) => ms === 2500, replies: ['hang'] });
    await r.send(r.client.lookup('M-ABCDE'));
    await settle(r, 1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.init.signal?.aborted).toBe(false);
    r.bot.dispose();
    expect(r.calls[0]?.init.signal?.aborted).toBe(true);
    await settle(r, 2);
    expect(r.logged.filter(([e]) => e === 'chatwarden.discord_followup_failed')).toEqual([]);
    expect((await r.send(r.client.ping())).status).toBe(401);
  });
});

describe('secrets', () => {
  it('the interaction token never appears in a log line, an error or a store row', async () => {
    const r = await rig({ fire: (ms) => ms === 2500, replies: [{ status: 500 }], wrapKit: throwingLookup });
    const sent = r.client.interaction(2, LOOKUP_DATA);
    const token = String((sent as { token: string }).token);
    expect(token).toMatch(TOKEN_RE);
    const res = await r.send(r.client.signed(sent));
    await settle(r, 1);
    const bad = await r.send(r.client.signed({ ...r.client.interaction(2, LOOKUP_DATA), token: 'x y' }));
    await settle(r, 2);
    const everything = JSON.stringify({ logged: r.logged, res: res.body, bad: bad.body, audit: r.w.audit() });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('x y');
    // The only place the token goes is the request URL.
    expect(r.calls[0]?.url).toContain(token);
    expect(JSON.stringify(r.calls[0]?.body)).not.toContain(token);
  });
});

describe('the options', () => {
  it('schedule must be a function; respondWithinMs arms the timer', async () => {
    await expect(botWorld({ options: { schedule: 5 as never } })).rejects.toThrow(RangeError);
    const r = await rig({ options: { respondWithinMs: 1234 } });
    await r.send(r.client.lookup('M-ABCDE'));
    expect(r.timers[0]?.ms).toBe(1234);
  });
});
