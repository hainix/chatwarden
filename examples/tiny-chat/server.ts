// Tiny chat: one room, Express + ws, wired to Chatwarden.
//
// Wire protocol (JSON text frames)
//   in:  { type: 'chat', text }                     { type: 'mute', seatId, on }
//        { type: 'ack', id }                        the player has seen that notice
//   out: { type: 'welcome', seatId, summary }  `summary` is the profile's one-line standard, to show above the chat
//        { type: 'chat', seatId, text, lineId }     a delivered line (the sender gets their own back)
//        { type: 'refused', reason, until?, rule?, noticeId? }
//                                                   reason: blocked | rate | length | restricted | gate | banned | profanity
//                                                   (profanity only when the profile refuses swearing; the default stars it).
//                                                   `rule` is the Community Rule number to show as "Community Rule N";
//                                                   `noticeId` is the player's own notice that explains it (look it up in
//                                                   the `notices` frames or "My record"). Both are left out when unknown,
//                                                   and for a bystander refused through someone else's shared address.
//        { type: 'notices', items }                 the player's pending notices (PlayerNotice[]): on connect when
//                                                   any are waiting, and whenever a decision adds one
//        { type: 'acked', id, ok }                  the answer to an 'ack'
// HTTP, by the kit's own routes (`@chatwarden/http`, mounted through its Express adapter):
//   /admin/*   the staff API (`adminRoutes`). DEMO ONLY auth: the `x-admin-token` header, role owner, actor `demo-admin`.
//              A real app authenticates its moderators with its own session. Off (404) without a token.
//              GET  /admin/reports, GET /admin/reports/:id   the queue and one report (names the people by subject id)
//              POST /admin/reports/:id/decide  { verdict, reason, actions: [{ subject, kind, durationMs, rule, lineIds?, gapNote? }] }
//                                              `subject` comes from the report detail; the answer carries ref codes only
//              Also the gap, sanction, term, policy and audit routes (the live term list is passed as `terms`).
//   /mod       the moderator hub: one page with `<chatwarden-hub base-url="/admin">` and one script tag (/mod/hub-element.js,
//              the file `@chatwarden/hub-element` ships). Behind the same authorize as /admin: the `x-admin-token` header, or the
//              session cookie that POST /mod/login sets from a sign-in form (a browser cannot send a header on a page load).
//              Off (404) without an admin token, like /admin.
//   /api/*     the player API (`playerRoutes`): GET /api/notices, POST /api/notices/:id/ack, GET /api/record,
//              GET /api/rules, GET /api/code-of-conduct?format=html|markdown|text, POST /api/names/check.
//              DEMO ONLY identity: the `x-chatwarden-key` header, or `?key=` (a key in a URL is unsafe, see the README).
//   /healthz, /readyz   the probes (`healthRoutes`)
// Optional Discord feed (`@chatwarden/discord`): set DISCORD_WEBHOOK_URL (and DISCORD_MENTION_ROLE_ID) to post reports and
//   outcomes into a forum channel. Off otherwise. The links in the posts open the /admin routes above.
//   /chat/*    the HTTP chat (`chatRoutes` over `createRoomBroadcaster`, the room broadcaster in `@chatwarden/http`): the same chat as the
//              WebSocket protocol above, for a browser: Server-Sent Events down, POST up.
//              GET  /chat/rooms/:room/stream           the stream (hello, line, hide, state, notices, bye frames)
//              POST /chat/rooms/:room/lines { text }   -> { ok: true, line } | { ok: false, refused: { reason, until?, rule?, noticeId?, ... } }
//              POST /chat/rooms/:room/mute { lineId | ref, on }       -> { ok, hiddenIds }
//              POST /chat/rooms/:room/report { lineId, reason?, note? } -> { ok: true, remaining } | { ok: false, refused }
//              DEMO ONLY identity, as for /api: the `x-chatwarden-key` header, or `?key=`. The name other players see is `Player N`, N a
//              counter this server assigns per key (never any part of the key). Rooms are per process: route a room's players to one process.
//   /          the page that uses it (`@chatwarden/player-react/chat`'s ChatBox, built into dist/web by `npm start`), with /chat.js and
//              /chat.css. A strict CSP: scripts, styles and connections from this origin only.
// Tiny chat's own HTTP: POST /report { key, targetSeat, category, note?, lineId? } -> 200 { ok, remaining } | 4xx { ok: false, refused }
//
// "key" stands in for whatever credential your game already has (a session token, a device id). It is sent as a
// query parameter on the socket and in the report body to keep this demo short; no frame or response ever
// carries it, a subject id or a hash back to a player.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createChatwarden,
  type Chatwarden,
  type ChatwardenOptions,
  type ProfileOverrides,
  type RawWho,
} from '@chatwarden/core';
import { discordFeed, type DiscordFeed } from '@chatwarden/discord';
import { adminRoutes, chatRoutes, createRoomBroadcaster, healthRoutes, playerRoutes, type KitRequest } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import { LiveTerms, type TermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { createProfanityFilter } from '@chatwarden/profanity';
import { openStore } from '@chatwarden/store-sqlite';

const ROOM = 'lobby';
const GAME_NAME = 'tiny-chat';
const CATEGORIES = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

export interface TinyChatOptions {
  /** 0 picks a free port. Default 3000. */
  port?: number;
  /** Term pack. Default: the synthetic demo pack. Real adopters install a pack (see the README). */
  pack?: TermPack;
  onReport?: ChatwardenOptions['onReport'];
  /**
   * Secret keying the client-key and IP hashes. Default: the `CHATWARDEN_SECRET` environment variable. With
   * neither, a random one is generated (and a warning printed): hashes then change on every restart, which
   * is fine for a demo and wrong for production, where startup throws instead.
   */
  secret?: string;
  /**
   * DEMO ONLY: the token the `/admin` API wants in the `x-admin-token` header. Default: the `TINY_CHAT_ADMIN_TOKEN`
   * environment variable. With neither, the whole admin API is switched off (404). A real app authenticates its moderators
   * with its own session, never a shared token.
   */
  adminToken?: string;
  /**
   * Changes to the `relaxed` profile, deep-merged onto it. For example `{ profanity: { mode: 'allow' } }` stops starring,
   * `{ profanity: { remove: ['damn', 'hell'] } }` takes words off the list and `{ profanity: { add: ['word'] } }` adds
   * one. An invalid value throws at startup.
   */
  overrides?: ProfileOverrides;
  /**
   * Post the review queue into a Discord forum (the `@chatwarden/discord` package): the forum channel's webhook URL.
   * Default: the `DISCORD_WEBHOOK_URL` environment variable. With neither (or an empty one) the feed is off and nothing is
   * sent anywhere. An empty string passed here forces it off even when the environment has a URL. A URL that is not a Discord webhook URL throws at startup.
   */
  discordWebhookUrl?: string;
  /** A Discord role id to ping on a severe report or sanction. Default: the `DISCORD_MENTION_ROLE_ID` environment variable. Optional. */
  discordMentionRoleId?: string;
  /** The `fetch` the Discord feed posts with. Default: the global one. For tests. */
  discordFetch?: typeof fetch;
}

/** The secret to run with, or a throw in production when none was configured. */
function resolveSecret(explicit: string | undefined): string {
  const configured = explicit ?? process.env.CHATWARDEN_SECRET;
  if (configured !== undefined && configured !== '') return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CHATWARDEN_SECRET is not set: refusing to start in production without a configured secret');
  }
  console.warn(
    'tiny-chat: CHATWARDEN_SECRET is not set; using a random secret that changes on restart (unfit for production)',
  );
  return randomBytes(32).toString('hex');
}

export interface TinyChat {
  port: number;
  chatwarden: Chatwarden;
  /** True when the Discord feed is running (a webhook URL was configured). */
  discord: boolean;
  close(): Promise<void>;
}

interface Seat {
  ws: WebSocket;
  seatId: string;
  /** Who is behind the connection, as `identify` read it once. Server-side only. */
  who: RawWho;
}

/** Equal tokens, without leaking where they differ. */
function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The cookie the demo's sign-in form sets. DEMO ONLY: it holds the shared admin token. A real app has its own session cookie. */
const STAFF_COOKIE = 'tiny_chat_staff';

/** The value of cookie `name` in a `Cookie` header, or undefined when it is absent or cannot be decoded. */
function cookieValue(header: unknown, name: string): string | undefined {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A style-src value that allows exactly one inline stylesheet, by its hash: no `'unsafe-inline'`. */
const styleHash = (css: string): string => `'sha256-${createHash('sha256').update(css).digest('base64')}'`;

const HUB_PAGE_CSS = 'body{margin:0}';
const SIGN_IN_CSS =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}';

/** The moderator hub page: the element and one script tag. `base-url` is where the staff routes are mounted. */
const HUB_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tiny-chat moderation</title>
<style>${HUB_PAGE_CSS}</style>
</head>
<body>
<script type="module" src="/mod/hub-element.js"></script>
<chatwarden-hub base-url="/admin"></chatwarden-hub>
</body>
</html>
`;

/** The sign-in form (a plain post to /mod/login). `notice` is fixed text from this file, never anything the visitor sent. */
const signInPage = (notice: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tiny-chat moderation: sign in</title>
<style>${SIGN_IN_CSS}</style>
</head>
<body>
<h1>Moderation</h1>
<p>DEMO ONLY: sign in with the admin token (TINY_CHAT_ADMIN_TOKEN).${notice === '' ? '' : ` ${notice}`}</p>
<form method="post" action="/mod/login">
<label for="token">Admin token</label>
<input id="token" name="token" type="password" autocomplete="off" required>
<button type="submit">Sign in</button>
</form>
</body>
</html>
`;

const HUB_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  `style-src ${styleHash(HUB_PAGE_CSS)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const SIGN_IN_CSP = ["default-src 'none'", `style-src ${styleHash(SIGN_IN_CSS)}`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

/** Where the `@chatwarden/hub-element` script is, or null when the package has not been built (`npm run build`). */
function hubScriptPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve('@chatwarden/hub-element/standalone');
  } catch {
    return null;
  }
}

const CHAT_PAGE_CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');

/** The page the chat box lives on. Its script and stylesheet are /chat.js and /chat.css. */
const CHAT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tiny-chat</title>
<link rel="stylesheet" href="/chat.css">
</head>
<body>
<!-- DEMO ONLY identity: the page makes its own key and sends it in a header. A real game uses its own session. -->
<div id="root"></div>
<script type="module" src="/chat.js"></script>
</body>
</html>
`;

/** Where the built page is: next to the compiled server (dist/web), or under dist/ when run from source. Null when it is not built. */
function webDir(): URL | null {
  for (const dir of [new URL('./web/', import.meta.url), new URL('./dist/web/', import.meta.url)]) {
    if (existsSync(new URL('chat.js', dir))) return dir;
  }
  return null;
}

export async function startServer(opts: TinyChatOptions = {}): Promise<TinyChat> {
  const secret = resolveSecret(opts.secret);
  // An empty token (option or environment variable) is no token: the route stays off rather than open to an empty header.
  const adminToken = opts.adminToken || process.env.TINY_CHAT_ADMIN_TOKEN || undefined;
  // Declared before the kit: `platform.notify` below looks a seat up here when a notice lands.
  const seats = new Map<string, Seat>();
  const send = (ws: WebSocket, frame: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const clock = { now: () => Date.now() };
  const store = openStore({ path: ':memory:' });
  const terms = new LiveTerms({ store, pack: opts.pack ?? syntheticTermPack(), clock });
  await terms.load();

  // The platform adapter: how to read "who is this?" off a connection. Call it ONCE per connection and reuse
  // the result (the fallback key is random, so a second call would name a different person).
  const identify = (req: IncomingMessage): RawWho => ({
    clientKey: new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? randomUUID(),
    // The IP must be the REAL client address. This demo listens directly, so the socket address is right. Behind
    // a reverse proxy or load balancer it would be the proxy's address, putting every player under one IP: parse
    // X-Forwarded-For (or your platform's equivalent) yourself, trusting only your own proxy's header.
    ip: req.socket.remoteAddress ?? null,
  });
  /** Push a seat its pending notices (the notices themselves, never the subject). */
  const pushNotices = (seat: Seat): void => {
    const items = chatwarden.notices.pending(seat.who);
    if (items.length > 0) send(seat.ws, { type: 'notices', items });
  };
  // `notify` and `pushNotices` read `chatwarden` only when a notice lands, long after it is assigned.
  const chatwarden: Chatwarden = await createChatwarden({
    store,
    secret,
    platform: {
      identify: (ctx) => identify(ctx as IncomingMessage),
      // The kit tells us a SUBJECT has notices. The subject id is an identifier, so it stays on the server: find the
      // seat that person holds in our own map, then send that connection its notices.
      notify: (subject) => {
        for (const seat of seats.values()) {
          if (chatwarden.rooms.subjectAt(ROOM, seat.seatId) === subject) pushNotices(seat);
        }
        // The same news for the browser chat: its open boxes are told a notice is waiting (nothing about it is sent).
        chat.noticePending(subject);
      },
    },
    matcher: terms,
    // The one-line preset. Try 'standard' or 'strict'; `overrides` changes single fields (see the README).
    profile: 'relaxed',
    overrides: opts.overrides,
    // The optional profanity package builds the star filter from the profile. Always pass a slur matcher too (above):
    // starring ordinary swearing is not slur protection.
    profanityPackage: { createProfanityFilter },
    clock,
    onReport: opts.onReport,
  });

  // The room broadcaster for the HTTP chat. `chatwarden` is assigned above; `platform.notify` reads `chat` only when a notice lands.
  const chat = createRoomBroadcaster(chatwarden);

  // The optional Discord feed. Off unless a webhook URL is configured. The hub links point at this demo's own admin routes
  // (open them with the `x-admin-token` header); a real app links to its moderator console. `origin` is known once the
  // server listens, long before any report can make a link.
  let origin = '';
  // An option that was passed wins, an empty string included (it forces the feed off, or the ping off, whatever the shell
  // exports); an option that was left out falls back to the environment. Empty at either place is "not set".
  const discordUrl = (opts.discordWebhookUrl !== undefined ? opts.discordWebhookUrl : process.env.DISCORD_WEBHOOK_URL) || undefined;
  const discordRole = (opts.discordMentionRoleId !== undefined ? opts.discordMentionRoleId : process.env.DISCORD_MENTION_ROLE_ID) || undefined;
  let discord: DiscordFeed | undefined;
  if (discordUrl !== undefined) {
    try {
      discord = discordFeed(chatwarden, {
        webhookUrl: discordUrl,
        hubLink: (kind, id) =>
          kind === 'report'
            ? `${origin}/admin/reports/${encodeURIComponent(id)}`
            : `${origin}/admin/people/${encodeURIComponent(id)}/history`,
        ...(discordRole === undefined ? {} : { mentionRoleId: discordRole }),
        ...(opts.discordFetch === undefined ? {} : { fetch: opts.discordFetch }),
      });
    } catch (err) {
      // A bad URL or role id: stop before anything listens.
      await chatwarden.close();
      throw err;
    }
  }

  let nextSeat = 1;

  const app = express();
  app.disable('x-powered-by');

  // The kit's routes read the raw body themselves: mount them BEFORE any body parser. This app's own `/report` route
  // parses JSON for itself, below, and nothing is mounted globally.

  // DEMO ONLY. A shared token in a header stands in for moderator login; a real app authenticates its moderators with its
  // own session. The role is `owner` and the actor a fixed `demo-admin`. Switched off (404) without a token.
  if (adminToken === undefined) {
    app.use('/admin', (_req, res) => void res.status(404).json({ ok: false, refused: 'off' }));
    app.use('/mod', (_req, res) => void res.status(404).json({ ok: false, refused: 'off' }));
  } else {
    const token = adminToken;
    // The one staff authorize, for /admin and /mod alike. A header, if the caller sent one, is the credential (a wrong header is
    // not rescued by a cookie); otherwise the sign-in cookie is.
    const staffFrom = (headers: Readonly<Record<string, string | string[] | undefined>>): { actor: string; role: 'owner' } | null => {
      const given = headers['x-admin-token'] ?? cookieValue(headers.cookie, STAFF_COOKIE);
      return sameToken(given, token) ? { actor: 'demo-admin', role: 'owner' } : null;
    };

    // The moderator hub. The page and the script are static (they hold no data), but they sit behind the same authorize as the
    // staff API they call, and a visitor who is not signed in gets the sign-in form.
    const html = (res: Response, status: number, csp: string, body: string): void => {
      res.status(status).type('html').set({ 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff' }).send(body);
    };
    app.get('/mod', (req, res) => {
      if (staffFrom(req.headers) === null) html(res, 401, SIGN_IN_CSP, signInPage(''));
      else html(res, 200, HUB_PAGE_CSP, HUB_PAGE);
    });
    app.get('/mod/hub-element.js', async (req, res, next) => {
      if (staffFrom(req.headers) === null) {
        res.status(401).set('cache-control', 'no-store').type('text').send('Sign in at /mod first.');
        return;
      }
      const file = hubScriptPath();
      if (file === null) {
        res.status(503).type('text').send('@chatwarden/hub-element is not built: run npm run build.');
        return;
      }
      try {
        res.status(200).set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).type('text/javascript; charset=utf-8').send(await readFile(file));
      } catch (err) {
        next(err);
      }
    });
    app.post('/mod/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
      const given = (req.body as { token?: unknown } | undefined)?.token;
      if (!sameToken(given, token)) {
        html(res, 401, SIGN_IN_CSP, signInPage('That token was not accepted.'));
        return;
      }
      // HttpOnly: the page's scripts cannot read it. SameSite=Strict: another site cannot make the browser send it, which is what
      // keeps a cookie-signed staff API from being driven cross-site. Secure whenever the request came over TLS.
      res.append('set-cookie', `${STAFF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}`);
      res.set('cache-control', 'no-store').redirect(303, '/mod');
    });
    app.use('/mod', (_req, res) => void res.status(404).json({ error: 'not_found' }));

    app.use(
      '/admin',
      toExpress(
        adminRoutes(chatwarden, {
          authorize: (req: KitRequest) => staffFrom(req.headers),
          gameName: GAME_NAME,
          // The live term list: it adds the staff term and exception routes (`/admin/terms`, `/admin/terms/check`, ...).
          terms,
        }),
        // A prefix mount with nothing after it that wants these paths: the kit's JSON 404 is the answer for an unknown one.
        { fallthrough: false },
      ),
    );
  }

  // The player API. DEMO ONLY identity: the key is read from the `x-chatwarden-key` header, falling back to `?key=`
  // (a key in a URL ends up in logs and history; a real app takes it from its session). The address is the kit's
  // `remoteAddress`: the socket peer, which a client cannot choose.
  app.use(
    '/api',
    toExpress(
      playerRoutes(chatwarden, {
        gameName: GAME_NAME,
        identify: (req: KitRequest): RawWho => {
          const key = req.headers['x-chatwarden-key'] ?? req.query.key;
          return {
            ...(key === undefined || key === '' ? {} : { clientKey: key }),
            // The IP must be the REAL client address. `remoteAddress` is the socket's, right for this demo that listens
            // directly. Behind a reverse proxy it is the proxy's: parse X-Forwarded-For yourself, trusting only your own proxy.
            ip: req.remoteAddress ?? null,
          };
        },
      }),
      { fallthrough: false },
    ),
  );

  // The HTTP chat. DEMO ONLY identity, as for /api. The display name is `Player N`: N is counted per key and the key is never in it.
  const credentialOf = (req: KitRequest): string | undefined => {
    const key = req.headers['x-chatwarden-key'] ?? req.query.key;
    return key === undefined || key === '' ? undefined : key;
  };
  const players = new Map<string, number>();
  app.use(
    '/chat',
    toExpress(
      chatRoutes(chatwarden, chat, {
        identify: (req: KitRequest): RawWho => {
          const key = credentialOf(req);
          return { ...(key === undefined ? {} : { clientKey: key }), ip: req.remoteAddress ?? null };
        },
        join: (req) => {
          const key = credentialOf(req) ?? '';
          let n = players.get(key);
          if (n === undefined) {
            n = players.size + 1;
            players.set(key, n);
          }
          return { name: `Player ${n}` };
        },
      }),
      { fallthrough: false },
    ),
  );

  // The page and its bundle (built into dist/web by `npm start`). Static, no data; a strict CSP.
  const asset = async (res: Response, file: string, type: string, csp?: string): Promise<void> => {
    const dir = webDir();
    if (dir === null) {
      res.status(503).type('text').send('The chat page is not built: run npm start (or node web/build.mjs).');
      return;
    }
    try {
      res.status(200).set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(csp === undefined ? {} : { 'content-security-policy': csp }) }).type(type).send(await readFile(new URL(file, dir)));
    } catch {
      res.status(503).type('text').send('The chat page is not built: run npm start (or node web/build.mjs).');
    }
  };
  app.get('/', (_req, res) => void res.status(200).set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CHAT_PAGE_CSP }).type('html').send(CHAT_PAGE));
  app.get('/chat.js', (_req, res) => void asset(res, 'chat.js', 'text/javascript; charset=utf-8'));
  app.get('/chat.css', (_req, res) => void asset(res, 'chat.css', 'text/css; charset=utf-8'));

  app.post('/report', express.json(), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { key, targetSeat, category, note, lineId } = body;
    if (typeof key !== 'string' || typeof targetSeat !== 'string' || !CATEGORIES.includes(category as Category)) {
      res.status(400).json({ ok: false, refused: 'bad_request' });
      return;
    }
    const reporter = [...seats.values()].find((s) => s.who.clientKey === key);
    if (reporter === undefined) {
      res.status(422).json({ ok: false, refused: 'off' });
      return;
    }
    const result = await chatwarden.reports.submit({
      roomId: ROOM,
      reporterSeat: reporter.seatId,
      targetSeat,
      category: category as Category,
      note: typeof note === 'string' ? note : undefined,
      lineId: typeof lineId === 'string' ? lineId : undefined,
    });
    // Deliberately not returning the report id: nothing the reporter does not need.
    if (result.ok) res.json({ ok: true, remaining: result.remaining });
    else res.status(result.refused === 'rate' ? 429 : 422).json({ ok: false, refused: result.refused });
  });

  // Probes, last, at the root. By default `toExpress` hands a path that is not its own to the next handler, so a root mount
  // would not hide the routes after it; here nothing comes after, so `fallthrough: false` makes an unknown path the kit's 404.
  app.use(toExpress(healthRoutes(chatwarden), { fallthrough: false }));

  // Body-parser failures (malformed JSON, an oversized body) and anything else thrown in a route: always a small
  // JSON answer, never Express's HTML stack page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : 500;
    if (status >= 400 && status < 500) res.status(status).json({ ok: false, refused: 'bad_request' });
    else res.status(500).json({ ok: false, refused: 'error' });
  });

  const http = createServer(app);
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws, req) => {
    const who = identify(req); // once: the door check and the seat must see the same person
    const door = chatwarden.doors.check('join', who);
    if (door !== null) {
      send(ws, { type: 'refused', reason: 'banned', until: door.until, ...(door.noticeId === undefined ? {} : { noticeId: door.noticeId }) });
      ws.close();
      return;
    }
    const seatId = `p${nextSeat++}`;
    const seat: Seat = { ws, seatId, who };
    seats.set(seatId, seat);
    chatwarden.rooms.seat(ROOM, seatId, who, `Player ${seatId.slice(1)}`);
    send(ws, { type: 'welcome', seatId, summary: chatwarden.summary });
    // Anything that landed while they were away (a warning to acknowledge, a report outcome).
    pushNotices(seat);

    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m.type === 'mute' && typeof m.seatId === 'string' && typeof m.on === 'boolean') {
        chatwarden.mutes.set(ROOM, seatId, m.seatId, m.on);
        return;
      }
      if (m.type === 'ack' && typeof m.id === 'string') {
        send(ws, { type: 'acked', id: m.id, ok: chatwarden.notices.ack(who, m.id) });
        return;
      }
      if (m.type !== 'chat' || typeof m.text !== 'string') return;

      const result = chatwarden.chat.accept(ROOM, seatId, m.text);
      if ('refuse' in result) {
        const { reason, until, rule, noticeId } = result.refuse;
        if (reason !== 'empty') {
          send(ws, {
            type: 'refused',
            reason,
            ...(until === undefined ? {} : { until }),
            // Both are the player's own: a rule number and the random handle of their notice, never an identifier.
            ...(rule === undefined ? {} : { rule }),
            ...(noticeId === undefined ? {} : { noticeId }),
          });
        }
        return;
      }
      const { lineId, text } = result.deliver;
      for (const viewer of seats.values()) {
        if (chatwarden.chat.visibleTo(ROOM, viewer.seatId, seatId)) {
          send(viewer.ws, { type: 'chat', seatId, text, lineId });
        }
      }
    });
    ws.on('close', () => {
      seats.delete(seatId);
      chatwarden.rooms.unseat(ROOM, seatId);
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? 3000, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    chatwarden,
    discord: discord !== undefined,
    close: async () => {
      discord?.dispose();
      chat.close();
      for (const { ws } of seats.values()) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await chatwarden.close();
    },
  };
}

// Run directly (`npm start`): listen until interrupted.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await startServer({ port });
  console.log(`tiny-chat listening on ws://127.0.0.1:${server.port}/?key=<anything>`);
  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
}
