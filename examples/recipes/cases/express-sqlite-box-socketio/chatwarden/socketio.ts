// The chat box over your Socket.IO server: attachChat(io, kit).
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import type { IncomingHttpHeaders } from 'node:http';
import type { RawWho } from '@chatwarden/core';
import type { KitRequest } from '@chatwarden/http';
import type { Server, Socket } from 'socket.io';
import type { Kit } from './kit.js';

// The same limits the HTTP chat routes use.
const TEXT_MAX = 2000;
const NOTE_MAX = 500;
const REASON_MAX = 64;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/**
 * The handshake in the kit's request shape, so the same identify and join hooks serve the sockets and the HTTP routes. A browser cannot set a header on
 * a socket, so the player's key rides in the auth payload ({ key }); a header, when there is one, wins. The address is the socket's.
 */
function handshakeRequest(socket: Socket): KitRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(socket.handshake.headers as IncomingHttpHeaders)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  const key = socket.handshake.auth.key;
  if (headers['x-chatwarden-key'] === undefined && typeof key === 'string' && key !== '') headers['x-chatwarden-key'] = key;
  return { method: 'GET', path: socket.nsp.name, query: {}, headers, body: undefined, remoteAddress: socket.handshake.address };
}

/** Tell the client why, then drop it. The client reads chat:refused and does not retry. */
function refuse(socket: Socket, refused: unknown): void {
  socket.emit('chat:refused', refused);
  socket.disconnect(true);
}

const answer = (ack: unknown, value: unknown): void => {
  if (typeof ack === 'function') ack(value);
};

async function serve(socket: Socket, kit: Kit): Promise<void> {
  const who = socket.data.who as RawWho;
  const room = typeof socket.handshake.auth.room === 'string' ? socket.handshake.auth.room : '';
  let member;
  try {
    member = await kit.hooks.join(handshakeRequest(socket), room);
  } catch {
    member = null;
  }
  if (!socket.connected) return; // the client left while the join hook ran
  if (member === null) return refuse(socket, { reason: 'forbidden' });
  const session = kit.chat.session(room, who, member);
  if ('refused' in session) return refuse(socket, session.refused);
  // The hello frame is written inside open(); the handlers below are attached in the same tick, before the client can send anything.
  const stream = session.open({
    write: (frame) => {
      socket.emit('chat:frame', frame);
      return socket.connected;
    },
    end: () => void socket.disconnect(true),
  });
  if ('refused' in stream) return refuse(socket, stream.refused);

  socket.on('chat:send', (input: unknown, ack: unknown) => {
    const text = isObject(input) && typeof input.text === 'string' ? input.text : '';
    answer(ack, text.length > TEXT_MAX ? { ok: false, refused: { reason: 'length' } } : session.send({ text }));
  });
  socket.on('chat:mute', (input: unknown, ack: unknown) => {
    const byLine = isObject(input) && idOf(input.lineId);
    const byRef = isObject(input) && idOf(input.ref);
    if (!isObject(input) || typeof input.on !== 'boolean' || byLine === byRef) return answer(ack, { ok: false, hiddenIds: [] });
    const target = byLine ? { lineId: input.lineId as string } : { ref: input.ref as string };
    answer(ack, session.muteResult({ ...target, on: input.on }));
  });
  socket.on('chat:report', async (input: unknown, ack: unknown) => {
    if (!isObject(input) || !idOf(input.lineId)) return answer(ack, { ok: false, refused: 'not_found' });
    const reason = typeof input.reason === 'string' && input.reason.length <= REASON_MAX ? input.reason : undefined;
    const note = typeof input.note === 'string' && input.note.length <= NOTE_MAX ? input.note : undefined;
    try {
      answer(ack, await session.report({ lineId: input.lineId, ...(reason === undefined ? {} : { reason }), ...(note === undefined ? {} : { note }) }));
    } catch {
      answer(ack, { ok: false, refused: 'not_found' });
    }
  });
  socket.on('disconnect', () => stream.close());
}

/**
 * Attach the chat to your Socket.IO server: attachChat(io, kit). It uses its own namespace (<base>/chat), so your game's events stay apart.
 * A socket with no identity is refused at the handshake (connect_error "unauthorized"); a room the join hook refuses gets chat:refused and is
 * disconnected. Add a per-socket limit of your own if your game needs one: the kit's chat, mute and report limits apply underneath.
 */
export function attachChat(io: Server, kit: Kit): void {
  io.of(`${kit.base}/chat`)
    .use(async (socket, next) => {
      try {
        const who = await kit.hooks.identify(handshakeRequest(socket));
        if (who.clientKey === undefined && who.accountId === undefined) return next(new Error('unauthorized'));
        socket.data.who = who;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    })
    .on('connection', (socket) => {
      // A throw inside serve (a hook of yours, say) must not become an unhandled rejection, which ends a Node process: log the class, drop the socket.
      serve(socket, kit).catch((error: unknown) => {
        console.warn('chatwarden: a chat connection failed:', error instanceof Error ? error.constructor.name : typeof error);
        socket.disconnect(true);
      });
    });
}
