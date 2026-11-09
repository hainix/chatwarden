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
// HTTP: POST /report { key, targetSeat, category, note?, lineId? } -> 200 { ok, remaining } | 4xx { ok: false, refused }
//       GET  /code-of-conduct   the players' code of conduct (generated from the profile and rules) as HTML
//       GET  /record?key=...   DEMO ONLY: the key's "My record" -> { ok, items }. A real app authenticates the player.
//       POST /decide           DEMO ONLY, guarded by the `x-admin-token` header. A real app authenticates its moderators.
//                              { reportId, verdict, reason, actions: [{ seat, kind, durationMs, rule, lineIds?, gapNote? }] }
//
// "key" stands in for whatever credential your game already has (a session token, a device id). It is sent as a
// query parameter on the socket and in the report body to keep this demo short; no frame or response ever
// carries it, a subject id or a hash back to a player.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createChatwarden,
  type Chatwarden,
  type ChatwardenOptions,
  type DecisionAction,
  type DecisionInput,
  type ProfileOverrides,
  type RawWho,
} from '@chatwarden/core';
import { LiveTerms, type TermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { createProfanityFilter } from '@chatwarden/profanity';
import { openStore } from '@chatwarden/store-sqlite';

const ROOM = 'lobby';
const GAME_NAME = 'tiny-chat';
/** The code of conduct page may load nothing and run nothing; its one inline style block is the only thing allowed. */
const CONDUCT_CSP = "default-src 'none'; style-src 'unsafe-inline'";
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
   * DEMO ONLY: the token `POST /decide` wants in the `x-admin-token` header. Default: the `TINY_CHAT_ADMIN_TOKEN`
   * environment variable. With neither, the route is switched off (404). A real app authenticates its moderators
   * with its own session, never a shared token.
   */
  adminToken?: string;
  /**
   * Changes to the `relaxed` profile, deep-merged onto it. For example `{ profanity: { mode: 'allow' } }` stops starring,
   * `{ profanity: { remove: ['damn', 'hell'] } }` takes words off the list and `{ profanity: { add: ['word'] } }` adds
   * one. An invalid value throws at startup.
   */
  overrides?: ProfileOverrides;
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

const VERDICTS = ['upheld', 'noted', 'no_action', 'bad_faith'] as const;

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

  let nextSeat = 1;

  const app = express();
  app.use(express.json());

  // The players' code of conduct, generated from the profile and the rules in force. Plain HTML with no script and no
  // external reference; the CSP says so to the browser as well. Public by design: it is the rules, not a record.
  app.get('/code-of-conduct', (_req, res) => {
    const body = chatwarden.documents.codeOfConduct({ format: 'html', gameName: GAME_NAME });
    res
      .status(200)
      .set({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CONDUCT_CSP,
        'x-content-type-options': 'nosniff',
      })
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<title>Code of conduct</title>' +
          '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem}' +
          'table{border-collapse:collapse}th,td{border:1px solid #888;padding:.25rem .5rem;text-align:left}</style>' +
          `</head><body>${body}</body></html>`,
      );
  });
  app.post('/report', async (req, res) => {
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

  // DEMO ONLY. "My record" for whoever holds `key`. Anyone who knows (or guesses) a key can read that player's
  // record, which is exactly why a real app authenticates the player first and never takes the key from a URL.
  app.get('/record', (req, res) => {
    const key = req.query.key;
    if (typeof key !== 'string' || key === '') {
      res.status(400).json({ ok: false, refused: 'bad_request' });
      return;
    }
    res.json({ ok: true, items: chatwarden.notices.record({ clientKey: key, ip: req.socket.remoteAddress ?? null }) });
  });

  // DEMO ONLY. A moderator decides a report. A shared token in a header stands in for moderator login; a real app
  // authenticates its moderators with its own session and writes an audit trail. Switched off without a token.
  // Actions name SEATS (the demo has no moderator console); the server turns a seat into a subject, which never
  // leaves it. The answer carries reference codes only.
  app.post('/decide', async (req, res) => {
    if (adminToken === undefined) {
      res.status(404).json({ ok: false, refused: 'off' });
      return;
    }
    if (!sameToken(req.get('x-admin-token'), adminToken)) {
      res.status(401).json({ ok: false, refused: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { reportId, verdict, reason, actions, evidence } = body;
    if (
      typeof reportId !== 'string' ||
      typeof reason !== 'string' ||
      !VERDICTS.includes(verdict as (typeof VERDICTS)[number]) ||
      !Array.isArray(actions) ||
      (evidence !== undefined && typeof evidence !== 'string')
    ) {
      res.status(400).json({ ok: false, refused: 'bad_request' });
      return;
    }
    const mapped: DecisionAction[] = [];
    for (const raw of actions as unknown[]) {
      const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const { seat, ...rest } = a;
      const subject = typeof seat === 'string' ? chatwarden.rooms.subjectAt(ROOM, seat) : null;
      if (subject === null) {
        res.status(422).json({ ok: false, refused: 'no_such_seat' });
        return;
      }
      mapped.push({ ...rest, subject } as unknown as DecisionAction);
    }
    const input: DecisionInput = {
      reportId,
      verdict: verdict as DecisionInput['verdict'],
      actions: mapped,
      actor: 'demo-admin',
      reason,
      // Required by the kit for `bad_faith` and refused for any other verdict; the kit answers `invalid` (422).
      ...(evidence === undefined ? {} : { evidence }),
    };
    try {
      const result = await chatwarden.decide(input);
      if (!result.ok) {
        res.status(result.error === 'not_found' ? 404 : 422).json({ ok: false, refused: result.error });
        return;
      }
      res.json({ ok: true, replay: result.replay, refCodes: result.groups.map((g) => g.refCode) });
    } catch {
      // `decide` rejects with the store's own error and writes nothing. Say so, and say nothing more.
      res.status(500).json({ ok: false, refused: 'error' });
    }
  });

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

  return {
    port,
    chatwarden,
    close: async () => {
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
