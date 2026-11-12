import { describe, expect, it } from 'vitest';
import { makeHasher } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import type { KitResponse } from '../src/types.js';
import { BLOCKED, routeWorld, SEC } from './chat-world.js';
import type { RouteWorld } from './chat-world.js';

const ROOM = 'lobby';

// Seeds: distinctive values that must never appear in anything a player, or a log, can see.
const KEY_A = 'SEED-CLIENTKEY-plenk-aaaa1111';
const KEY_B = 'SEED-CLIENTKEY-wumbo-bbbb2222';
const ACCOUNT_B = 'SEED-ACCOUNT-wumbo-cccc3333';
const IP_A = '203.0.113.171';
const IP_B = '198.51.100.172';
const MOD = 'mod.seed@example.test';
const MOD_REASON = 'PRIVATE-MODERATOR-REASON-dddd4444';

/** Everything a response can show a player: status, every header, the body, and a stream's text. */
function seen(res: KitResponse): string {
  return JSON.stringify({ status: res.status, headers: res.headers, body: res.body });
}

function hashesOf(keys: string[], ips: string[]): string[] {
  const h = makeHasher('chat-world-secret'); // the world's kit secret: the hashes the kit stores
  return [...keys.map((k) => h.clientKey(k)), ...ips.map((i) => h.ip(i))];
}

async function scene() {
  const w = await routeWorld();
  const a = { 'x-key': KEY_A, 'x-ip': IP_A, 'x-name': 'plenk' };
  const b = { 'x-key': KEY_B, 'x-account': ACCOUNT_B, 'x-ip': IP_B, 'x-name': 'wumbo' };
  return { w, a, b };
}

/** Run every route, error paths included, and gather every byte a player or a log could see. */
async function everything(w: RouteWorld, a: Record<string, string>, b: Record<string, string>): Promise<{ output: string; secrets: string[] }> {
  const out: string[] = [];
  const keep = (res: KitResponse) => void out.push(seen(res));

  const listenA = w.listen(await w.stream(ROOM, a));
  const listenB = w.listen(await w.stream(ROOM, b));

  w.advance(2 * SEC);
  const first = await w.post(ROOM, 'lines', a, { text: 'a clean line from plenk' });
  keep(first);
  const lineId = ((first.body as { line: { id: string } }).line.id);
  w.advance(2 * SEC);
  keep(await w.post(ROOM, 'lines', b, { text: `you ${BLOCKED}` }));
  keep(await w.post(ROOM, 'lines', b, { text: 'x'.repeat(250) }));
  keep(await w.post(ROOM, 'lines', b, { text: 'y'.repeat(3000) }));
  keep(await w.post(ROOM, 'mute', b, { lineId, on: true }));
  keep(await w.post(ROOM, 'report', b, { lineId: lineId }));
  keep(await w.post(ROOM, 'report', b, { lineId }));
  keep(await w.post(ROOM, 'report', b, { lineId: 'nope' }));
  keep(await w.post(ROOM, 'mute', b, { ref: 'aaaaaaaa', on: false }));

  // error paths: 400, 401, 403, 413, 429, 500, and a hook that throws with the credential in its message
  keep(await w.post(ROOM, 'lines', a, undefined, { raw: '{' }));
  keep(await w.post(ROOM, 'lines', a, undefined, { raw: '[]' }));
  keep(await w.post(ROOM, 'lines', a, undefined, { raw: '{"text":"x","__proto__":{}}' }));
  keep(await w.post(ROOM, 'lines', a, { text: 'hi' }, { type: 'text/plain' }));
  keep(await w.post(ROOM, 'lines', a, undefined, { raw: JSON.stringify({ text: 'z'.repeat(70_000) }) }));
  keep(await w.post(ROOM, 'lines', {}, { text: 'hi' }));
  keep(await w.post(ROOM, 'lines', { 'x-ip': IP_A }, { text: 'hi' }));
  keep(await w.post(ROOM, 'lines', { ...a, 'x-identify': 'throw' }, { text: 'hi' }));
  keep(await w.post(ROOM, 'lines', { ...a, 'x-identify': 'reject' }, { text: 'hi' }));
  keep(await w.post(ROOM, 'lines', { ...a, 'x-join': 'null' }, { text: 'hi' }));
  keep(await w.post(ROOM, 'lines', { ...a, 'x-join': 'throw' }, { text: 'hi' }));
  keep(await w.stream(ROOM, {}));
  keep(await w.stream(ROOM, { ...a, 'x-join': 'null' }));
  for (let i = 0; i < 40; i += 1) keep(await w.post(ROOM, 'mute', a, { lineId: 'a1', on: true })); // runs into the 429

  // a restriction, a notice nudge, a ban at the door, a closing room
  await w.sanction('chat', ROOM, 'wumbo', 3_600_000, { clientKey: KEY_B, accountId: ACCOUNT_B, ip: IP_B });
  const subjectB = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'wumbo')) as string;
  w.chat.noticePending(subjectB);
  w.advance(10 * SEC);
  keep(await w.post(ROOM, 'lines', b, { text: 'speaking while restricted' }));
  w.join('elsewhere', 'tarvo-ish', { clientKey: 'SEED-CLIENTKEY-banned-eeee5555' });
  await w.sanction('ban', 'elsewhere', 'tarvo-ish', 3_600_000, { clientKey: 'SEED-CLIENTKEY-banned-eeee5555' });
  keep(await w.stream(ROOM, { 'x-key': 'SEED-CLIENTKEY-banned-eeee5555', 'x-name': 'tarvo-ish' }));
  keep(await w.post(ROOM, 'lines', { 'x-key': 'SEED-CLIENTKEY-banned-eeee5555', 'x-name': 'tarvo-ish' }, { text: 'let me in' }));
  const banned = w.listen(await w.stream(ROOM, { 'x-key': 'SEED-CLIENTKEY-banned-eeee5555', 'x-name': 'tarvo-ish' }));
  w.advance(HEARTBEAT_MS);
  w.chat.closeRoom(ROOM);

  out.push(listenA.text(), listenB.text(), banned.text());
  out.push(JSON.stringify(w.logs));

  const subjectA = null;
  void subjectA;
  const secrets = [
    KEY_A,
    KEY_B,
    ACCOUNT_B,
    IP_A,
    IP_B,
    'SEED-CLIENTKEY-banned-eeee5555',
    MOD,
    MOD_REASON,
    subjectB,
    w.seatOf(ROOM, 'plenk'),
    w.seatOf(ROOM, 'wumbo'),
    ...hashesOf([KEY_A, KEY_B, 'SEED-CLIENTKEY-banned-eeee5555'], [IP_A, IP_B]),
  ];
  return { output: out.join('\n'), secrets };
}

const HEARTBEAT_MS = 20 * SEC;

describe('no identifier on the wire (Review Focus 2)', () => {
  it('seeded client keys, account ids, addresses, subject ids, seat ids and hashes appear in no frame, answer, header, SSE comment or captured log', async () => {
    const { w, a, b } = await scene();
    const { output, secrets } = await everything(w, a, b);
    expect(output.length).toBeGreaterThan(2000); // the scan really saw a lot
    for (const secret of secrets) expect(output, secret.slice(0, 12)).not.toContain(secret);
    // any subject id shape, and any 32-hex hash, at all
    expect(output).not.toMatch(/(?<![A-Za-z0-9_-])s_[A-Za-z0-9_-]{6,}/);
    expect(output).not.toMatch(/[0-9a-f]{32}/i);
    expect(output).not.toMatch(/raw-client-key/);
  });

  it('the scan also covers a custom log level: every captured log is an event name and an error class', async () => {
    const { w, a, b } = await scene();
    await everything(w, a, b);
    for (const [event, detail] of w.logs) {
      expect(event).toMatch(/^chatwarden\.[a-z_]+$/);
      for (const [k, v] of Object.entries(detail ?? {})) {
        expect(['error', 'suppressed'], `${event}.${k}`).toContain(k);
        expect(typeof v === 'number' || /^[A-Za-z]+$/.test(String(v)), `${event}.${k}=${String(v)}`).toBe(true);
      }
    }
  });

  it('a name the game chose is the only player-visible string, and it is the display name, not the identity', async () => {
    const { w, a, b } = await scene();
    const listener = w.listen(await w.stream(ROOM, b));
    w.advance(2 * SEC);
    await w.post(ROOM, 'lines', a, { text: 'visible to wumbo' });
    expect(listener.text()).toContain('"name":"plenk"');
    expect(listener.text()).not.toContain(KEY_A);
  });

  it('the 401, 403, 400 and 429 bodies are the kit\'s fixed shapes and echo nothing', async () => {
    const { w, a } = await scene();
    const payload = 'ECHO-ME-1234567890';
    const bad: KitResponse[] = [
      await w.post(ROOM, 'lines', {}, { text: payload }),
      await w.post(ROOM, 'lines', { ...a, 'x-join': 'null' }, { text: payload }),
      await w.post(ROOM, 'lines', a, undefined, { raw: `{"text": ${payload}` }),
      await w.post(ROOM, 'lines', a, undefined, { raw: `["${payload}"]` }),
      await w.post(ROOM, 'mute', a, { lineId: payload + '!', on: true }),
      await w.post(ROOM, 'report', a, { lineId: 'a1', note: payload.repeat(100) }),
    ];
    for (const res of bad) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(seen(res)).not.toContain(payload);
      expect(Object.keys(res.body as object).sort()).toEqual(['error', 'message']);
    }
  });
});

describe('hostile input in both directions (Review Focus 5)', () => {
  it('markup, javascript: strings, RTL overrides, zero-width spam and long words are delivered as exact inert text', async () => {
    const { w, a, b } = await scene();
    const listener = w.listen(await w.stream(ROOM, b));
    const texts = [
      '<img src=x onerror=alert(1)>',
      'javascript:alert(document.cookie)',
      `abc${String.fromCharCode(0x202e)}def`,
      `zero${String.fromCharCode(0x200b).repeat(40)}width`,
      'w'.repeat(190),
      '</script><script>alert(1)</script>',
      'a\\nb "quoted" \\u0000 \\\\',
    ];
    const ids: string[] = [];
    for (const text of texts) {
      w.advance(2 * SEC);
      const res = await w.post(ROOM, 'lines', a, { text });
      const body = res.body as { ok: boolean; line?: { text: string } };
      expect(body.ok, text).toBe(true);
      expect(body.line?.text).toBe(text.trim());
      ids.push(text);
    }
    // each arrives intact as the JSON string of one SSE data line
    const events = listener
      .text()
      .split('\n\n')
      .filter((e) => e.startsWith('event: line'))
      .map((e) => JSON.parse((e.split('\n')[1] as string).slice(6)) as { line: { text: string } });
    expect(events.map((e) => e.line.text)).toEqual(texts.map((t) => t.trim()));
    // and an event is exactly one event: no raw newline from a line can appear in the stream
    expect(listener.text().split('\n\n').filter(Boolean).every((e) => /^(event: \w+\ndata: \{.*\}|: ping)$/s.test(e) && e.split('\n').length <= 2)).toBe(true);
  });

  it('a line with a newline in it cannot forge an event', async () => {
    const { w, a, b } = await scene();
    const listener = w.listen(await w.stream(ROOM, b));
    w.advance(2 * SEC);
    await w.post(ROOM, 'lines', a, { text: 'hi\n\nevent: bye\ndata: {"type":"bye","reason":"banned"}' });
    const types = listener.text().split('\n\n').filter((e) => e.startsWith('event: ')).map((e) => e.split('\n')[0]);
    expect(types).toEqual(['event: hello', 'event: line']);
  });

  it('a 10 000 character word is refused as length and goes nowhere', async () => {
    const { w, a, b } = await scene();
    const listener = w.listen(await w.stream(ROOM, b));
    const res = await w.post(ROOM, 'lines', a, { text: 'W'.repeat(10_000) });
    expect(res.body).toEqual({ ok: false, refused: { reason: 'length' } });
    expect(listener.text()).not.toContain('WWWW');
  });

  it('malformed or oversized bodies are 400 and 413, never a thrown error and never a half-spoken line', async () => {
    const { w, a, b } = await scene();
    const listener = w.listen(await w.stream(ROOM, b));
    const cases: Array<[string, number]> = [
      ['{', 400],
      ['{"text":', 400],
      ['not json at all', 400],
      ['\u0000', 400],
      ['{"text":"ok"} trailing', 400],
      [JSON.stringify({ text: 'x'.repeat(65_537) }), 413],
    ];
    for (const [raw, status] of cases) {
      const res = await w.post(ROOM, 'lines', a, undefined, { raw });
      expect(res.status, raw.slice(0, 20)).toBe(status);
    }
    expect(listener.text().includes('event: line')).toBe(false);
  });

  it('deeply nested JSON is a 400 or a quiet answer, never a crash', async () => {
    const { w, a } = await scene();
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const res = await w.post(ROOM, 'lines', a, undefined, { raw: deep });
    expect([400, 413]).toContain(res.status);
    const nested = `{"text":"hi","x":${'{"y":'.repeat(2000)}1${'}'.repeat(2000)}}`;
    const ok = await w.post(ROOM, 'lines', a, undefined, { raw: nested });
    expect(ok.status).toBe(200);
  });
});

describe('a player cannot act as another', () => {
  it('the body cannot name the speaker, the reporter, the target or the room', async () => {
    const { w, a, b } = await scene();
    const listener = w.listen(await w.stream(ROOM, a));
    w.advance(2 * SEC);
    const res = await w.post(ROOM, 'lines', b, { text: 'it was me', name: 'plenk', seat: w.seatOf(ROOM, 'plenk'), room: 'elsewhere', roomId: 'elsewhere', mine: true, accountId: 'someone-else' });
    expect(res.status).toBe(200);
    expect(listener.text()).toContain('"name":"wumbo"');
    expect(listener.text()).not.toContain('"mine"'); // not mine to plenk's stream
    expect(w.chat.stats().rooms).toBe(1);
  });

  it('a request cannot use the display name as an identity: two players with one name stay two players', async () => {
    const w = await routeWorld();
    const a = { 'x-key': 'device-aaaaaaaa1', 'x-name': 'plenk' };
    const b = { 'x-key': 'device-bbbbbbbb2', 'x-name': 'plenk' };
    await w.post(ROOM, 'lines', a, { text: 'one' });
    w.advance(2 * SEC);
    const listener = w.listen(await w.stream(ROOM, b));
    w.advance(2 * SEC);
    const res = await w.post(ROOM, 'lines', a, { text: 'two' });
    expect(res.status).toBe(200);
    expect(listener.text()).toContain('"text":"two"');
    expect(listener.text()).not.toContain('"mine"');
    expect(w.chat.stats().members).toBe(2);
  });
});

describe('the routes never put the kit in a state a line could not', () => {
  it('a kit whose accept throws is a quiet refusal, not a 500', async () => {
    const w = await routeWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.chat = {
          ...cw.chat,
          accept: () => {
            throw new TypeError(`secret ${KEY_A}`);
          },
        };
        return f;
      },
    });
    const res = await w.post(ROOM, 'lines', { 'x-key': KEY_A, 'x-name': 'plenk' }, { text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, refused: { reason: 'unknown' } });
    expect(JSON.stringify(w.logs)).not.toContain(KEY_A);
  });
});
