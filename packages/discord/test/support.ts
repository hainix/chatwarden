import { vi } from 'vitest';

export const NOW = 1_800_000_000_000;
export const TOKEN = 'tok_ABC-def_123XYZ';
export const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
export const ROLE = '987654321098765432';

export interface Call {
  url: URL;
  href: string;
  init: RequestInit & { headers: Record<string, string>; body: string; signal: AbortSignal };
  body: Record<string, unknown>;
}

export type Step =
  | number
  | Error
  | 'hang'
  | 'throw-sync'
  | { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

/**
 * A fake Discord forum webhook. By default `POST ?wait=true` (no thread_id) opens thread `T<n>` and answers
 * `{ id, channel_id }`; `POST ?wait=true&thread_id=..` answers `{ id }`. `plan(n, call)` may override call n (0-based).
 */
export function fakeDiscord(plan: (n: number, call: Call) => Step | undefined = () => undefined) {
  const calls: Call[] = [];
  let threads = 0;
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const i = init as Call['init'];
    const call: Call = { url: new URL(href), href, init: i, body: JSON.parse(i.body) as Record<string, unknown> };
    const n = calls.length;
    calls.push(call);
    const step = plan(n, call);
    if (step === 'throw-sync') throw new TypeError('sync boom');
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        i.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === 'number') return Promise.resolve(new Response('{}', { status: step }));
    if (step !== undefined) {
      const text = step.text ?? JSON.stringify(step.json ?? {});
      return Promise.resolve(new Response(text, { status: step.status, ...(step.headers === undefined ? {} : { headers: step.headers }) }));
    }
    if (call.url.searchParams.has('thread_id')) {
      return Promise.resolve(new Response(JSON.stringify({ id: `m${n}` }), { status: 200 }));
    }
    threads++;
    return Promise.resolve(new Response(JSON.stringify({ id: `m${n}`, channel_id: `T${threads}` }), { status: 200 }));
  };
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    creates: () => calls.filter((c) => !c.url.searchParams.has('thread_id')),
    posts: () => calls.filter((c) => c.url.searchParams.has('thread_id')),
  };
}

/** Let promise chains and zero-delay timers run. */
export async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Everything a person could read in one request body. */
export function visibleTexts(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
  };
  add(body.content);
  add(body.thread_name);
  add(body.username);
  const embeds = Array.isArray(body.embeds) ? (body.embeds as Array<Record<string, unknown>>) : [];
  for (const e of embeds) {
    add(e.title);
    add(e.description);
    add((e.footer as Record<string, unknown> | undefined)?.text);
    add((e.author as Record<string, unknown> | undefined)?.name);
    for (const f of Array.isArray(e.fields) ? (e.fields as Array<Record<string, unknown>>) : []) {
      add(f.name);
      add(f.value);
    }
  }
  return out;
}

/** Links are the one place an id may appear: markdown links with <url> targets and bare URLs are cut out before a scan. */
export function withoutLinks(text: string): string {
  return text.replace(/\]\(<[^>]*>\)/g, '](link)').replace(/<https?:\/\/[^>\s]*>/g, '<link>').replace(/https?:\/\/\S+/g, 'link');
}

const SUBJECT_ID = /s_[A-Za-z0-9_-]{6,}/;
const LONG_HEX = /[0-9a-f]{32,}/i;
const OPAQUE_ID = /[A-Za-z0-9_-]{20,}/;

/**
 * What a visible-text scan finds: a subject id (`s_...`), a 32+ character hex hash, any 20+ character opaque token (a
 * report or group id), and each of `forbidden` (known ids, handles and chat text). Empty means clean.
 */
export function leaks(text: string, forbidden: readonly string[] = []): string[] {
  const visible = withoutLinks(text);
  const found: string[] = [];
  if (SUBJECT_ID.test(visible)) found.push('subject-id');
  if (LONG_HEX.test(visible)) found.push('hex-hash');
  if (OPAQUE_ID.test(visible)) found.push('opaque-id');
  for (const f of forbidden) if (visible.includes(f)) found.push(`forbidden:${f}`);
  return found;
}

const ZW = String.fromCharCode(0x200b);

/** Every injection shape a rule title, a category string or a tag could carry, with the exact text it must become. */
export const INJECTIONS: Array<[string, string, string]> = [
  ['a user mention', '<@123>', `\\<@${ZW}123\\>`],
  ['a nickname mention', '<@!123>', `\\<@${ZW}!123\\>`],
  ['a role mention', '<@&123>', `\\<@${ZW}&123\\>`],
  ['a channel mention', '<#123>', '\\<\\#123\\>'],
  ['a custom emoji', '<:wave:123>', '\\<\\:wave\\:123\\>'],
  ['a timestamp', '<t:1700000000:R>', '\\<t\\:1700000000\\:R\\>'],
  ['a fullwidth at sign (not a mention in Discord, so shown as typed)', '＠everyone', '＠everyone'],
  ['a zero-width space planted before the name', `@${ZW}everyone`, `@${ZW}everyone`],
  ['a zero-width space planted before the at sign', `${ZW}@everyone`, `@${ZW}everyone`],
  ['@everyone', '@everyone', `@${ZW}everyone`],
  ['a standalone @here', '@here', `@${ZW}here`],
  ['a bare @', '@', `@${ZW}`],
  ['a code fence', '```js\nalert(1)\n```', '\\`\\`\\`js alert\\(1\\) \\`\\`\\`'],
  ['inline code', '`x`', '\\`x\\`'],
  ['a multi-line header and quote', '# Header\n> quote\n- item', '\\# Header \\> quote - item'],
  ['a masked link to https', '[click here](https://evil.example/x)', '\\[click here\\]\\(https\\://evil.example/x\\)'],
  ['an image link', '![x](https://evil.example/a.png)', '!\\[x\\]\\(https\\://evil.example/a.png\\)'],
  ['a bare url', 'https://evil.example', 'https\\://evil.example'],
  ['a trailing backslash', 'ends with\\', 'ends with\\\\'],
  ['a backslash before an at sign', '\\@everyone', `\\\\@${ZW}everyone`],
  ['a spoiler', '||secret||', '\\|\\|secret\\|\\|'],
  ['bold, italic, strike', '**b** _i_ ~~s~~', '\\*\\*b\\*\\* \\_i\\_ \\~\\~s\\~\\~'],
  ['a right-to-left override', 'a‮b', 'ab'],
  ['control characters and tabs', 'a\u0007\tb\r\nc', 'a b c'],
];

