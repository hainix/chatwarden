import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/discord/index.js';
import { APP_ID, GUILD_ID, botWorld } from './discord-world.js';

// registerCommands (K5 D7, design 6.1 and 6.4): the one-shot call that puts the bot's command list on one guild. It needs the bot token, which the
// running server never holds. Nothing here touches the network: `fetch` is a recorder, and the token is an obviously fake string.

const TOKEN = 'FAKE.bot-token_zorbak-0123456789';

interface Call {
  url: string;
  init: RequestInit;
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; text?: string } | Error;

function fakeFetch(...script: Reply[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = script[Math.min(calls.length - 1, script.length - 1)] ?? { status: 200, json: [] };
    if (reply instanceof Error) throw reply;
    return new Response(reply.text ?? JSON.stringify(reply.json ?? []), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const COMMANDS = [{ name: 'chatwarden', description: 'x', type: 1 as const, default_member_permissions: '1', options: [] }];
const base = (fetchFn: typeof fetch, over: Record<string, unknown> = {}) => ({
  applicationId: APP_ID,
  botToken: TOKEN,
  guildId: GUILD_ID,
  commands: COMMANDS,
  fetch: fetchFn,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerCommands', () => {
  it('puts the bulk list to the guild route with the bot authorization; the body is bot.commands(); count is the answers length', async () => {
    const b = await botWorld();
    const f = fakeFetch({ status: 200, json: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    const out = await registerCommands({ ...base(f.fn), commands: b.bot.commands() });
    expect(out).toEqual({ ok: true, count: 3 });
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect(call?.url).toBe(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`);
    expect(call?.init.method).toBe('PUT');
    const headers = Object.fromEntries(Object.entries((call?.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers).toEqual({ authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' });
    expect(JSON.parse(String(call?.init.body))).toEqual(b.bot.commands());
    expect(call?.init.redirect).toBe('error');
  });

  it('an empty list is allowed (it clears the guild); count 0 for an empty answer', async () => {
    const f = fakeFetch({ status: 200, json: [] });
    expect(await registerCommands({ ...base(f.fn), commands: [] })).toEqual({ ok: true, count: 0 });
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual([]);
  });

  it('a bad id or an empty token is a RangeError without the value', async () => {
    const f = fakeFetch();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ applicationId: 'not-a-number-zorbak' }, 'not-a-number-zorbak'],
      [{ applicationId: '123' }, '123'],
      [{ applicationId: 12_345_678 }, '12345678'],
      [{ guildId: '2222222222222222/../x' }, '2222222222222222/../x'],
      [{ guildId: '' }, 'discordBot'],
      [{ botToken: '' }, 'discordBot'],
      [{ botToken: 'a b' }, 'a b'],
      [{ botToken: 'tok\nsecond-line' }, 'second-line'],
      [{ botToken: 5 }, 'discordBot'],
      [{ commands: 'nope' }, 'nope'],
      [{ commands: undefined }, 'discordBot'],
    ];
    for (const [over, leaked] of bad) {
      const err = await registerCommands(base(f.fn, over) as never).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      expect(String((err as Error).message)).toMatch(/^registerCommands: /);
      expect(String((err as Error).message)).not.toContain(leaked);
    }
    await expect(registerCommands(undefined as never)).rejects.toBeInstanceOf(RangeError);
    await expect(registerCommands(base(f.fn, { fetch: 5 }) as never)).rejects.toBeInstanceOf(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it('a 401 and a 400 are { ok: false, status }; a 429 retries once', async () => {
    for (const status of [401, 400, 403, 404, 500]) {
      const f = fakeFetch({ status, json: { message: 'zorbak' } });
      expect(await registerCommands(base(f.fn))).toEqual({ ok: false, status });
      expect(f.calls).toHaveLength(1);
    }
    vi.useFakeTimers();
    // 429 with retry_after 2 s: waits 2 s, then the retry's answer is the result.
    const f = fakeFetch({ status: 429, json: { retry_after: 2 } }, { status: 200, json: [{ id: '1' }] });
    const pending = registerCommands(base(f.fn));
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, count: 1 });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.init.body).toBe(f.calls[0]?.init.body);

    // Two 429s: the second is the answer (no third try). A silly retry_after is clamped to 1 to 60 s.
    const g = fakeFetch({ status: 429, json: { retry_after: 9999 } }, { status: 429, json: { retry_after: 1 } });
    const second = registerCommands(base(g.fn));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(g.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toEqual({ ok: false, status: 429 });
    expect(g.calls).toHaveLength(2);

    // No retry_after at all: the one second floor.
    const h = fakeFetch({ status: 429, json: {} }, { status: 200, json: [] });
    const third = registerCommands(base(h.fn));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await third).toEqual({ ok: true, count: 0 });
  });

  it('an answer that is not a list, a fetch that throws and a request that never answers are { ok: false } with no token anywhere', async () => {
    const odd = fakeFetch({ status: 200, text: 'not json' });
    expect(await registerCommands(base(odd.fn))).toEqual({ ok: false, status: 200 });
    const boom = fakeFetch(new TypeError(`connect failed with Authorization: Bot ${TOKEN}`));
    expect(await registerCommands(base(boom.fn))).toEqual({ ok: false, status: 0 });
    vi.useFakeTimers();
    const hang = (async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
    const pending = registerCommands(base(hang));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, status: 0 });
  });

  it('the token never appears in any output', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(JSON.stringify(a)));
    const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(JSON.stringify(a)));
    try {
      const results = [
        await registerCommands(base(fakeFetch({ status: 200, json: [{ id: '1' }] }).fn)),
        await registerCommands(base(fakeFetch({ status: 401, json: { message: `bad ${TOKEN}` } }).fn)),
        await registerCommands(base(fakeFetch(new Error(TOKEN)).fn)),
      ];
      const thrown = await registerCommands(base(fakeFetch().fn, { applicationId: TOKEN }) as never).catch((e: unknown) => String(e));
      expect(JSON.stringify([results, thrown, lines])).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
