import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, ChatResult, PaceSettings, ProfanityFilter, RawWho, SubjectId } from '@chatwarden/core';
import { MemoryStore } from '@chatwarden/store-memory';
import { createRoomBroadcaster } from '@chatwarden/http';
import type { ChatMember, ChatSession, RoomBroadcaster, RoomBroadcasterOptions } from '@chatwarden/http';
import type { ChatConnection, ChatTransport, ChatTransportEvents } from '../src/chat/transport.js';
import type { ChatFrame, MuteTarget, SendResult } from '../src/chat/wire.js';

// A test world for the chat box: the real core over the memory store, the real room broadcaster, and `localChatTransport`, a
// `ChatTransport` over a broadcaster `ChatSession` with no network. Only what the kit cannot produce (a pacing refusal, a dropped
// connection) is scripted.

export const T0 = 1_800_000_000_000;
/** A synthetic blocked term: a line with it is refused as `blocked`. */
export const BLOCKED = 'zorbak';

const filter: ProfanityFilter = {
  apply: (t) => ({ hit: /\bglarn\b/i.test(t), text: t.replace(/\bglarn\b/gi, '*****') }),
};

/** A facade over the kit whose chat answers come from `script` (undefined passes through to the real kit). */
export function scripted(script: (roomId: string, seatId: string, text: string) => ChatResult | undefined): (cw: Chatwarden) => Chatwarden {
  return (cw) => {
    const facade = Object.create(cw) as Chatwarden;
    facade.chat = {
      ...cw.chat,
      accept: (roomId, seatId, text, opts) => script(roomId, seatId, text) ?? cw.chat.accept(roomId, seatId, text, opts),
    };
    return facade;
  };
}

export interface ChatWorldOptions {
  profanity?: 'refuse' | 'star';
  /** The kit's pace in force from the start (slow mode, burst, repeats): real pacing through the real core. */
  pace?: PaceSettings;
  wrap?: (cw: Chatwarden) => Chatwarden;
  broadcaster?: RoomBroadcasterOptions;
}

export async function chatWorld(over: ChatWorldOptions = {}) {
  const clock = { t: T0, now: () => clock.t };
  const gate = { open: true };
  const real = await createChatwarden({
    store: new MemoryStore(),
    secret: 'player-react-chat-test-secret-0000-not-real',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    matcher: {
      match: (t) => (t.toLowerCase().includes(BLOCKED) ? { termId: `syn:${BLOCKED}` } : null),
      spans: (t) => {
        const i = t.toLowerCase().indexOf(BLOCKED);
        return i < 0 ? [] : [{ start: i, end: i + BLOCKED.length, termId: `syn:${BLOCKED}` }];
      },
    },
    profanity: filter,
    gate: () => gate.open,
    ...(over.profanity === 'refuse' || over.pace !== undefined
      ? { overrides: { ...(over.profanity === 'refuse' ? { profanity: { mode: 'refuse' as const } } : {}), ...(over.pace === undefined ? {} : { pace: over.pace }) } }
      : {}),
    retention: false,
  });
  const cw = over.wrap === undefined ? real : over.wrap(real);
  const chat: RoomBroadcaster = createRoomBroadcaster(cw, { now: clock.now, ...over.broadcaster });

  const who = (name: string): RawWho => ({ clientKey: `raw-client-key-${name}-0001` });
  const member = (name: string): ChatMember => ({ name });

  /** A transport for player `name`. */
  const transportFor = (name: string, options: LocalOptions = {}) => localChatTransport(chat, who(name), member(name), options);

  /** `name` says something in `room` without a box (a bot at the other end). `as` is the identity behind the name: two players may share a name. */
  const say = (room: string, name: string, text: string, as: string = name): SendResult => {
    const s = chat.session(room, who(as), member(name));
    if ('refused' in s) throw new Error(`session refused: ${s.refused.reason}`);
    return s.send({ text });
  };

  /** The subject id of a player, found through a probe seat of the same identity. */
  const subjectOf = (room: string, name: string): SubjectId => {
    const probe = `probe-${room}-${name}`;
    real.rooms.seat(room, probe, who(name), name);
    const subject = real.rooms.subjectAt(room, probe);
    real.rooms.unseat(room, probe);
    if (subject === null) throw new Error('no subject');
    return subject;
  };

  /** Apply a stored sanction to a player and tell their open boxes. */
  const sanction = async (kind: 'chat' | 'ban', room: string, name: string, durationMs: number | null = 3_600_000) => {
    const subject = subjectOf(room, name);
    await real.sanctions.apply({
      kind,
      subject,
      includeIp: false,
      durationMs,
      reason: 'private moderator reason',
      actor: 'mod@example.test',
      source: 'moderator',
      automated: false,
      rule: 2,
      roomId: room,
    });
    chat.noticePending(subject);
  };

  return { cw, real, chat, clock, gate, who, member, transportFor, say, sanction, subjectOf, close: () => chat.close() };
}

export type ChatWorld = Awaited<ReturnType<typeof chatWorld>>;

export interface LocalOptions {
  /** Make `send` reject (a dropped connection). */
  failSend?: boolean;
}

export interface LocalTransport extends ChatTransport {
  /** Every connection opened, in order. */
  readonly opened: Array<{ room: string; closed: boolean; session: ChatSession | null }>;
  /** Text of every send. */
  readonly sent: string[];
  /** Every report call: line id and draft. */
  readonly reports: Array<{ lineId: string; draft: unknown }>;
  /** Every mute call. */
  readonly mutes: Array<{ target: MuteTarget; on: boolean }>;
  options: LocalOptions;
  /** Hand the open connection(s) a frame as if the server wrote it. */
  inject(frame: ChatFrame): void;
  /** Tell the open connection's events the status changed. */
  status(status: Parameters<ChatTransportEvents['status']>[0], why?: Parameters<ChatTransportEvents['status']>[1]): void;
}

/** A `ChatTransport` over a broadcaster session: frames and answers through JSON-like clones, no network. */
export function localChatTransport(chat: RoomBroadcaster, who: RawWho, member: ChatMember, options: LocalOptions = {}): LocalTransport {
  const live = new Set<ChatTransportEvents>();
  const t: LocalTransport = {
    opened: [],
    sent: [],
    reports: [],
    mutes: [],
    options,
    inject: (frame) => {
      for (const e of live) e.frame(structuredClone(frame));
    },
    status: (status, why) => {
      for (const e of live) e.status(status, why);
    },
    open(room, events): ChatConnection {
      const entry: { room: string; closed: boolean; session: ChatSession | null } = { room, closed: false, session: null };
      t.opened.push(entry);
      live.add(events);
      events.status('connecting');
      const found = chat.session(room, who, member);
      let stream: { close(): void } | null = null;
      if ('refused' in found) events.status('closed', found.refused.reason === 'banned' ? 'banned' : 'forbidden');
      else {
        entry.session = found;
        const opened = found.open({
          write: (frame) => {
            if (entry.closed) return false;
            if (frame.type === 'hello') events.status('open');
            events.frame(structuredClone(frame));
            if (frame.type === 'bye') events.status('closed', frame.reason);
            return true;
          },
          ping: () => !entry.closed,
          end: () => undefined,
        });
        if ('refused' in opened) events.status('closed', 'forbidden');
        else stream = opened;
      }
      const session = (): ChatSession => {
        if (entry.session === null) throw new Error('no session');
        return entry.session;
      };
      return {
        send: (text) => {
          t.sent.push(text);
          if (t.options.failSend === true) return Promise.reject(new Error('Failed to fetch'));
          return Promise.resolve(structuredClone(session().send({ text })));
        },
        mute: (target, on) => {
          t.mutes.push({ target, on });
          return Promise.resolve(session().mute({ ...target, on }));
        },
        report: async (lineId, draft) => {
          t.reports.push({ lineId, draft });
          const out = await session().report({ lineId, ...draft });
          return out.ok ? { ok: true, reportId: '', remaining: out.remaining } : { ok: false, refused: out.refused as never, ...(out.remaining === undefined ? {} : { remaining: out.remaining }) };
        },
        close: () => {
          entry.closed = true;
          live.delete(events);
          stream?.close();
        },
      };
    },
  };
  return t;
}
