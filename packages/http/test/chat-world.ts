import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, ChatResult, Logger, ProfanityFilter, RawWho, SubjectId } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore, syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { MemoryStore } from '@chatwarden/store-memory';
import { createRouter } from '../src/router.js';
import { createRoomBroadcaster } from '../src/chat/broadcaster.js';
import { chatRoutes } from '../src/chat/routes.js';
import type { ChatRoutesOptions } from '../src/chat/routes.js';
import type { KitRequest, KitResponse } from '../src/types.js';
import type { ChatMember, ChatSession, ChatSink, ChatStream, RoomBroadcaster, RoomBroadcasterOptions } from '../src/chat/broadcaster.js';
import type { ChatFrame, WireLine } from '../src/chat/wire.js';

// A test world for the chat box: the real core over the memory store with the synthetic term pack, a fake clock and a fake scheduler
// (one object drives both, so `advance` moves the kit's time and fires the broadcaster's timers together).

export const NOW = 1_800_000_000_000;
export const SEC = 1000;
export const MIN = 60 * SEC;
/** A distinctive blocked term of the synthetic pack, for scans. */
export const BLOCKED = 'zorbak';

export type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

export interface Spoken {
  frames: ChatFrame[];
  /** Pings received. */
  pings: number;
  /** Times the broadcaster told the sink it was done. */
  ended: number;
  /** Return false from the sink (backed up) while true. */
  backedUp: boolean;
  /** Throw from the sink while true. */
  broken: boolean;
  sink: ChatSink;
  /** The text of every `line` frame, in order. */
  texts(): string[];
  /** The ids of every `line` frame, in order. */
  ids(): string[];
  /** Frames of one type. */
  of<T extends ChatFrame['type']>(type: T): Array<Extract<ChatFrame, { type: T }>>;
}

/** A sink that records everything it is given. */
export function spoken(): Spoken {
  const s: Spoken = {
    frames: [],
    pings: 0,
    ended: 0,
    backedUp: false,
    broken: false,
    sink: {
      write: (frame) => {
        if (s.broken) throw new Error('socket is gone: zorbak');
        s.frames.push(structuredClone(frame));
        return s.backedUp ? false : true;
      },
      end: () => {
        s.ended += 1;
      },
      ping: () => {
        if (s.broken) throw new Error('socket is gone');
        s.pings += 1;
        return s.backedUp ? false : true;
      },
    },
    texts: () => s.frames.filter((f) => f.type === 'line').map((f) => (f as { line: WireLine }).line.text),
    ids: () => s.frames.filter((f) => f.type === 'line').map((f) => (f as { line: WireLine }).line.id),
    of: <T extends ChatFrame['type']>(type: T) => s.frames.filter((f) => f.type === type) as Array<Extract<ChatFrame, { type: T }>>,
  };
  return s;
}

export interface WorldOptions {
  options?: RoomBroadcasterOptions;
  profanity?: 'refuse' | 'star';
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
  /** Wrap the kit the broadcaster is given (a scripted facade). */
  wrap?: (cw: Chatwarden) => Chatwarden;
  /** Do not build the broadcaster (a test builds its own). */
  noBroadcaster?: boolean;
}

const filter: ProfanityFilter = {
  apply: (t) => ({ hit: /\bglarn\b/i.test(t), text: t.replace(/\bglarn\b/gi, '*****') }),
};

export async function chatWorld(over: WorldOptions = {}) {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logs.push([event, detail]) };
  const live = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock, logger });
  await live.load();
  logs.length = 0;
  const gateState = { open: true };
  const real = await createChatwarden({
    store,
    secret: 'chat-world-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    matcher: live,
    retention: false,
    // A filter is always installed (the kit logs once when there is none); the profile decides what it does.
    profanity: filter,
    ...(over.profanity === 'refuse' ? { overrides: { profanity: { mode: 'refuse' as const } } } : {}),
    gate: over.gate ?? (() => gateState.open),
  });
  const inner = over.wrap === undefined ? real : over.wrap(real);
  // A spy on `rooms.seat` so a test can learn the (secret) seat id of a player, by the display name they were seated under.
  const seats = new Map<string, string>();
  const seatCalls: Array<{ roomId: string; seatId: string; handle: string }> = [];
  const cw = Object.create(inner) as Chatwarden;
  cw.rooms = {
    ...inner.rooms,
    seat: (roomId, seatId, w, handle, tags) => {
      seats.set(`${roomId}|${handle}`, seatId);
      seatCalls.push({ roomId, seatId, handle });
      inner.rooms.seat(roomId, seatId, w, handle, tags);
    },
  };
  /** The seat id a player was seated under in a room (by the name they joined with). */
  const seatOf = (room: string, name: string): string => {
    const found = seats.get(`${room}|${name}`);
    if (found === undefined) throw new Error('that player was never seated');
    return found;
  };

  // Fake scheduler.
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const id = nextTimer++;
    timers.set(id, { at: clock.t + ms, fn });
    return () => void timers.delete(id);
  };
  /** Move time forward, firing every timer that falls due on the way, in order. */
  const advance = (ms: number): void => {
    const target = clock.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      timers.delete(due[0]);
      clock.t = Math.max(clock.t, due[1].at);
      due[1].fn();
    }
    clock.t = target;
  };

  const chat: RoomBroadcaster = over.noBroadcaster
    ? (undefined as unknown as RoomBroadcaster)
    : createRoomBroadcaster(cw, { now: clock.now, schedule, logger, ...over.options });

  /** A player: a stable raw identity per name. */
  const who = (name: string, extra: RawWho = {}): RawWho => ({ clientKey: `raw-client-key-${name}-0001`, ip: '203.0.113.7', ...extra });

  /** Join a room; throws when refused. */
  const join = (room: string, name: string, extra: RawWho = {}, member: Partial<ChatMember> = {}): ChatSession => {
    const s = chat.session(room, who(name, extra), { name, ...member });
    if ('refused' in s) throw new Error(`join refused: ${s.refused.reason}`);
    return s;
  };

  /** Join and open one stream; the frames land in `heard`. */
  const attend = (room: string, name: string, extra: RawWho = {}) => {
    const session = join(room, name, extra);
    const heard = spoken();
    const stream = session.open(heard.sink);
    if ('refused' in stream) throw new Error(`open refused: ${stream.refused.reason}`);
    return { session, heard, stream: stream as ChatStream };
  };

  /** The subject id of a player's seat, for staff-side calls. */
  const subjectOf = (room: string, name: string, extra: RawWho = {}): SubjectId => {
    // The seat id is the broadcaster's secret; ask the kit through a probe seat of the same identity.
    const probe = `probe-${room}-${name}`;
    real.rooms.seat(room, probe, who(name, extra), name);
    const subject = real.rooms.subjectAt(room, probe);
    real.rooms.unseat(room, probe);
    if (subject === null) throw new Error('no subject');
    return subject;
  };

  /** Apply a stored sanction of `kind` to a player. */
  const sanction = async (kind: 'chat' | 'ban', room: string, name: string, durationMs: number | null = 3_600_000, extra: RawWho = {}) =>
    real.sanctions.apply({
      kind,
      subject: subjectOf(room, name, extra),
      includeIp: false,
      durationMs,
      reason: 'private moderator reason',
      actor: 'mod@example.test',
      source: 'moderator',
      automated: false,
      rule: 2,
      roomId: room,
    });

  return { cw, real, chat, seatOf, seatCalls, store, clock, now: clock.now, advance, schedule, timers, pending: () => timers.size, logs, who, join, attend, subjectOf, sanction, gateState };
}

export type ChatWorld = Awaited<ReturnType<typeof chatWorld>>;

/** A scripted `accept`: a facade over the real kit whose chat answers come from `script`. */
export function scripted(script: (roomId: string, seatId: string, text: string) => ChatResult | undefined): (cw: Chatwarden) => Chatwarden {
  return (cw) => {
    const facade = Object.create(cw) as Chatwarden;
    facade.chat = {
      ...cw.chat,
      accept: (roomId, seatId, text, opts) => {
        const scriptedAnswer = script(roomId, seatId, text);
        return scriptedAnswer === undefined ? cw.chat.accept(roomId, seatId, text, opts) : scriptedAnswer;
      },
    };
    return facade;
  };
}

/** Identity from headers: x-key, x-account, x-ip; x-identify=throw / reject / null / string breaks the hook. */
export const identifyFromHeaders = async (req: KitRequest): Promise<RawWho> => {
  const h = req.headers;
  const mode = h['x-identify'];
  if (mode === 'throw') throw new Error(`boom for ${h['x-key'] ?? ''}`);
  if (mode === 'reject') return Promise.reject(new TypeError(`boom for ${h['x-key'] ?? ''}`));
  if (mode === 'null') return null as unknown as RawWho;
  if (mode === 'string') return 'not an object' as unknown as RawWho;
  const who: Record<string, unknown> = {};
  if (h['x-key'] !== undefined) who.clientKey = h['x-key'];
  if (h['x-account'] !== undefined) who.accountId = h['x-account'];
  if (h['x-ip'] !== undefined) who.ip = h['x-ip'];
  return who as RawWho;
};

export interface RouteWorldOptions extends WorldOptions {
  routes?: Partial<ChatRoutesOptions>;
}

/** The chat world with its routes mounted on a router. Callers are told apart by `x-key` (default: the name given), named by `x-name`. */
export async function routeWorld(over: RouteWorldOptions = {}) {
  const w = await chatWorld(over);
  const routes = chatRoutes(w.cw, w.chat, {
    identify: identifyFromHeaders,
    join: (req) => {
      const mode = req.headers['x-join'];
      if (mode === 'null') return null;
      if (mode === 'throw') throw new TypeError('join exploded');
      return { name: req.headers['x-name'] ?? 'plenk' };
    },
    logger: { warn: (event, detail) => void w.logs.push([event, detail]) },
    now: w.now,
    ...over.routes,
  });
  const router = createRouter(routes);

  /** Headers that identify player `name`. */
  const as = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'x-key': `raw-client-key-${name}-0001`,
    'x-ip': '203.0.113.7',
    'x-name': name,
    ...extra,
  });

  const call = (
    method: string,
    path: string,
    o: { headers?: Record<string, string>; body?: unknown; raw?: string; type?: string | null } = {},
  ): Promise<KitResponse> => {
    const headers: Record<string, string> = { ...o.headers };
    const rawBody = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (rawBody !== undefined && o.type !== null && headers['content-type'] === undefined) headers['content-type'] = o.type ?? 'application/json';
    return router({ method, path, query: {}, headers, body: undefined, ...(rawBody === undefined ? {} : { rawBody }) });
  };
  const post = (room: string, route: 'lines' | 'mute' | 'report', headers: Record<string, string>, body?: unknown, extra: { raw?: string; type?: string | null } = {}) =>
    call('POST', `/rooms/${room}/${route}`, { headers, ...(body === undefined ? {} : { body }), ...extra });
  const stream = (room: string, headers: Record<string, string>) => call('GET', `/rooms/${room}/stream`, { headers });

  /** Start a stream response into a recording sink; the text written is in `chunks`. */
  const listen = (res: KitResponse) => {
    if (res.stream === undefined) throw new Error(`not a stream: ${res.status}`);
    const sink = { chunks: [] as string[], ended: false, backedUp: false };
    const cancel = res.stream.start({
      write: (chunk) => {
        if (!sink.ended) sink.chunks.push(chunk);
        return !sink.backedUp;
      },
      end: () => {
        sink.ended = true;
      },
    });
    return { sink, cancel, text: () => sink.chunks.join('') };
  };

  return { ...w, routes, router, as, call, post, stream, listen };
}

export type RouteWorld = Awaited<ReturnType<typeof routeWorld>>;
