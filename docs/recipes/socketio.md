# Recipe: Socket.IO

Your game already has a Socket.IO server. This puts the chat box on it, with every line still going through the kit's chat check.

**Init writes:** everything the Express recipe writes, plus `socketio.ts` (the server side: `attachChat(io, kit)`), `socketTransport.ts` (the client side) and a `ChatPanel.tsx` that uses it. Run init with the chat box and the Socket.IO transport:

```sh
npm install @chatwarden/http @chatwarden/core
npx chatwarden init --chat box --chat-transport socketio
```

**You write:** one line on your server, `attachChat(io, kit)`, after you have the kit from `mountChatwarden(app)`. The identity hook in `auth.ts` (marked `TODO(identity)`) decides who a socket is. Replace it before you go live.

Init picks this transport for you when `socket.io` is already one of your dependencies. The `socket.io-client` package goes in the page that shows the box.

## The server side

The chat lives in its own namespace, `/chatwarden/chat`, so your game's own events stay apart. A socket with no identity is refused at the handshake (`connect_error` with the text `unauthorized`). A room the join hook refuses gets a `chat:refused` message and is disconnected, and the client does not retry.

<!-- golden: express-sqlite-box-socketio/chatwarden/socketio.ts -->
```ts
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
```

Add a per-socket limit of your own if your game needs one. The kit's chat, mute and report limits apply underneath. If something in your hooks throws, the socket is dropped and the class of the error is logged.

## The client side

`socketTransport.ts` turns a `socket.io-client` socket into the `ChatTransport` that `<ChatBox>` takes. The panel below builds the socket and hands it over.

<!-- golden: express-sqlite-box-socketio/chatwarden/ChatPanel.tsx -->
```tsx
// The chat box for a player page: <ChatPanel playerKey={...} />.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import '@chatwarden/player-react/styles.css';
import '@chatwarden/player-react/chat.css';
import { createPlayerClient, fetchTransport, NoticeQueue } from '@chatwarden/player-react';
import type { PlayerReporting } from '@chatwarden/player-react';
import { io } from 'socket.io-client';
import { socketTransport } from './socketTransport.js';
import type { ChatTransport } from '@chatwarden/player-react/chat';

// The box is loaded when it is first shown, so a page that never shows chat does not pay for it.
const ChatBox = lazy(() => import('@chatwarden/player-react/chat').then((m) => ({ default: m.ChatBox })));
const BASE = '/chatwarden';

export interface ChatPanelProps {
  /** Who this player is to the server: your game's own session or account id goes here (see identify in auth). */
  playerKey: string;
  /** The room to join. The starter join hook knows one room, lobby. */
  room?: string;
}

export default function ChatPanel({ playerKey, room = 'lobby' }: ChatPanelProps) {
  const headers = useMemo(() => ({ 'x-chatwarden-key': playerKey }), [playerKey]);
  const client = useMemo(() => createPlayerClient({ transport: fetchTransport({ baseUrl: `${BASE}/api`, headers }) }), [headers]);
  // The socket is made when the box opens (in the browser, never on the server) and closed when it unmounts. It rides your Socket.IO server's origin.
  const transport: ChatTransport = useMemo(
    () => ({ open: (roomId, events) => socketTransport(io(`${BASE}/chat`, { autoConnect: false, auth: { key: playerKey } })).open(roomId, events) }),
    [playerKey],
  );
  const [reporting, setReporting] = useState<PlayerReporting | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    client.rules().then(
      (rules) => setReporting(rules.reporting),
      () => undefined,
    );
  }, [client]);

  return (
    <>
      <Suspense fallback={null}>
        <ChatBox transport={transport} room={room} {...(reporting === undefined ? {} : { reporting })} onNoticePending={() => setRefresh((n) => n + 1)} />
      </Suspense>
      <NoticeQueue client={client} refreshKey={refresh} />
    </>
  );
}
```

## Safe by default

- The same hooks decide who may join, over HTTP and over the socket.
- The player's address comes from the socket handshake, never from a header.
- What a player sees holds no identifier: no seat, subject, key, hash or address.
- The staff routes and the hub answer 401 until `CHATWARDEN_ADMIN_TOKEN` is long (at least 24 characters), and production needs `CHATWARDEN_SECRET` (at least 32).

Your server reads these variables from its environment. A `.env` file is not loaded for you: export the names, or start the server with `node --env-file=.env`. Run `npx chatwarden init --check` before you go live. It lists the starter code still in place.

## More

- The same files, as committed goldens: `examples/recipes/cases/express-sqlite-box-socketio/`. A test runs them over a real `socket.io` server and `socket.io-client`.
- The seam is `chat.session(...)` on the server and `ChatTransport` on the client. The `@chatwarden/http` README ("A game's own socket") describes it.
