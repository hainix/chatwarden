import type { DiscordCommand } from './types.js';

// `registerCommands` (K5 design 6.1 and 6.4): the one-shot call an adopter runs once, from a script or a terminal, that puts the bot's command list on
// one server. It is the only place a bot token is used, and the running server never holds one. The token goes in one header and nowhere else: not in
// the result, an error message or a log line (this function logs nothing).

const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
/** A bot token is three base64url parts joined by dots; this is the loosest shape that cannot break out of a header. */
const BOT_TOKEN = /^[A-Za-z0-9._-]{1,200}$/;
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_FLOOR_MS = 1000;
const RETRY_CAP_MS = 60_000;

/** What `registerCommands` takes. @experimental */
export interface RegisterCommandsOptions {
  /** The Discord application id (a snowflake: 17 to 20 digits). */
  applicationId: string;
  /** The bot token from the Developer Portal. Keep it out of the server: use it here, once, and offline. */
  botToken: string;
  /** The server to put the commands on (a snowflake). */
  guildId: string;
  /** `bot.commands()`. The list replaces every command of the application in that server. */
  commands: readonly DiscordCommand[];
  /** The `fetch` to use. Default the global one. */
  fetch?: typeof fetch;
}

/** `{ ok: true, count }` when Discord took the list (`count` is how many commands it now holds); else `{ ok: false, status }`, with status 0 for no answer at all. */
export type RegisterCommandsResult = { ok: true; count: number } | { ok: false; status: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Seconds a 429 asks for, from the JSON body, clamped to 1 to 60 s. A missing or odd value is the floor. */
function waitMs(text: string): number {
  try {
    const v: unknown = JSON.parse(text);
    const secs = isObject(v) ? v.retry_after : undefined;
    if (typeof secs === 'number' && Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, RETRY_FLOOR_MS), RETRY_CAP_MS);
  } catch {
    // fall through
  }
  return RETRY_FLOOR_MS;
}

/**
 * Put the bot's command list on one server (`PUT /applications/{id}/guilds/{id}/commands`, which replaces the whole list). A 429 is waited out
 * once (its `retry_after`, clamped to 1 to 60 s). A bad id or token shape is a `RangeError` that never holds the value. Any answer other than 200 is
 * `{ ok: false, status }`; a request that fails or times out is `{ ok: false, status: 0 }`.
 *
 * @experimental
 */
export async function registerCommands(options: RegisterCommandsOptions): Promise<RegisterCommandsResult> {
  if (!isObject(options)) throw new RangeError('registerCommands: options are required');
  const { applicationId, botToken, guildId, commands, fetch: fetchOption } = options as unknown as Partial<RegisterCommandsOptions>;
  if (typeof applicationId !== 'string' || !SNOWFLAKE.test(applicationId)) throw new RangeError('registerCommands: applicationId must be a Discord id (17 to 20 digits)');
  if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw new RangeError('registerCommands: guildId must be a Discord id (17 to 20 digits)');
  if (typeof botToken !== 'string' || !BOT_TOKEN.test(botToken)) throw new RangeError('registerCommands: botToken must be the bot token (letters, digits, dot, dash, underscore)');
  if (!Array.isArray(commands)) throw new RangeError('registerCommands: commands must be a list (bot.commands())');
  if (fetchOption !== undefined && typeof fetchOption !== 'function') throw new RangeError('registerCommands: fetch must be a function');
  const send = fetchOption ?? globalThis.fetch;

  const url = `${API}/applications/${applicationId}/guilds/${guildId}/commands`;
  const body = JSON.stringify(commands);
  const attempt = async (): Promise<{ status: number; text: string } | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await send(url, {
        method: 'PUT',
        headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      return { status: res.status, text: await res.text() };
    } catch {
      // Not even the class: a fetch error can quote the request, and the request holds the token.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  let res = await attempt();
  if (res !== null && res.status === 429) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs(res?.text ?? '')));
    res = await attempt();
  }
  if (res === null) return { ok: false, status: 0 };
  if (res.status !== 200) return { ok: false, status: res.status };
  try {
    const list: unknown = JSON.parse(res.text);
    return Array.isArray(list) ? { ok: true, count: list.length } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: res.status };
  }
}
