// Tiny chat: one room, Express + ws, wired to Chatwarden.
//
// Wire protocol (JSON text frames)
//   in:  { type: 'chat', text }                     { type: 'mute', seatId, on }
//   out: { type: 'welcome', seatId }
//        { type: 'chat', seatId, text, lineId }     a delivered line (the sender gets their own back)
//        { type: 'refused', reason, until? }        reason: blocked | rate | length | restricted | gate | banned
// HTTP: POST /report { key, targetSeat, category, note?, lineId? } -> 200 { ok, remaining } | 4xx { ok: false, refused }
//
// "key" stands in for whatever credential your game already has (a session token, a device id). It is sent as a
// query parameter on the socket and in the report body to keep this demo short; no frame or response ever
// carries it, a subject id or a hash back to a player.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { createChatwarden, type Chatwarden, type ChatwardenOptions, type RawWho } from '@chatwarden/core';
import { LiveTerms, type TermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { openStore } from '@chatwarden/store-sqlite';

const ROOM = 'lobby';
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
  key: string;
}

export async function startServer(opts: TinyChatOptions = {}): Promise<TinyChat> {
  const secret = resolveSecret(opts.secret);
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
  const chatwarden = await createChatwarden({
    store,
    secret,
    platform: { identify: (ctx) => identify(ctx as IncomingMessage) },
    matcher: terms,
    clock,
    onReport: opts.onReport,
  });

  const seats = new Map<string, Seat>();
  let nextSeat = 1;
  const send = (ws: WebSocket, frame: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };

  const app = express();
  app.use(express.json());
  app.post('/report', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { key, targetSeat, category, note, lineId } = body;
    if (typeof key !== 'string' || typeof targetSeat !== 'string' || !CATEGORIES.includes(category as Category)) {
      res.status(400).json({ ok: false, refused: 'bad_request' });
      return;
    }
    const reporter = [...seats.values()].find((s) => s.key === key);
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
      send(ws, { type: 'refused', reason: 'banned', until: door.until });
      ws.close();
      return;
    }
    const seatId = `p${nextSeat++}`;
    const seat: Seat = { ws, seatId, key: who.clientKey ?? '' };
    seats.set(seatId, seat);
    chatwarden.rooms.seat(ROOM, seatId, who, `Player ${seatId.slice(1)}`);
    send(ws, { type: 'welcome', seatId });

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
      if (m.type !== 'chat' || typeof m.text !== 'string') return;

      const result = chatwarden.chat.accept(ROOM, seatId, m.text);
      if ('refuse' in result) {
        const { reason, until } = result.refuse;
        if (reason !== 'empty') send(ws, { type: 'refused', reason, ...(until === undefined ? {} : { until }) });
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
