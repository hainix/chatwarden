// `socketio.ts` and `socketTransport.ts` (design 9.4, chat box design 5.3): the chat box over the game's own Socket.IO server. The server file attaches a
// namespace under the prefix and calls the room broadcaster from its handlers (every line still goes through the kit); the client file is a
// `ChatTransport` over a socket.io-client socket, so the same <ChatBox> works. Only for `--chat box --chat-transport socketio`.
import type { FileSpec } from '../types.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

function serverFile(ctx: Ctx): string {
  const imports =
    impType(ctx, 'IncomingHttpHeaders', 'node:http') +
    impType(ctx, 'RawWho', '@chatwarden/core') +
    impType(ctx, 'KitRequest', '@chatwarden/http') +
    impType(ctx, ['Server', 'Socket'], 'socket.io') +
    impType(ctx, 'Kit', './kit');
  return `${header(ctx, 'The chat box over your Socket.IO server: attachChat(io, kit).')}${imports}
// The same limits the HTTP chat routes use.
const TEXT_MAX = 2000;
const NOTE_MAX = 500;
const REASON_MAX = 64;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (value${t(ctx, ': unknown')})${t(ctx, ': value is Record<string, unknown>')} => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value${t(ctx, ': unknown')})${t(ctx, ': value is string')} => typeof value === 'string' && ID.test(value);

/**
 * The handshake in the kit's request shape, so the same identify and join hooks serve the sockets and the HTTP routes. A browser cannot set a header on
 * a socket, so the player's key rides in the auth payload ({ key }); a header, when there is one, wins. The address is the socket's.
 */
function handshakeRequest(socket${t(ctx, ': Socket')})${t(ctx, ': KitRequest')} {
  const headers${t(ctx, ': Record<string, string>')} = {};
  for (const [name, value] of Object.entries(socket.handshake.headers${t(ctx, ' as IncomingHttpHeaders')})) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  const key = socket.handshake.auth.key;
  if (headers['x-chatwarden-key'] === undefined && typeof key === 'string' && key !== '') headers['x-chatwarden-key'] = key;
  return { method: 'GET', path: socket.nsp.name, query: {}, headers, body: undefined, remoteAddress: socket.handshake.address };
}

/** Tell the client why, then drop it. The client reads chat:refused and does not retry. */
function refuse(socket${t(ctx, ': Socket')}, refused${t(ctx, ': unknown')})${t(ctx, ': void')} {
  socket.emit('chat:refused', refused);
  socket.disconnect(true);
}

const answer = (ack${t(ctx, ': unknown')}, value${t(ctx, ': unknown')})${t(ctx, ': void')} => {
  if (typeof ack === 'function') ack(value);
};

async function serve(socket${t(ctx, ': Socket')}, kit${t(ctx, ': Kit')})${t(ctx, ': Promise<void>')} {
  const who = socket.data.who${t(ctx, ' as RawWho')};
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

  socket.on('chat:send', (input${t(ctx, ': unknown')}, ack${t(ctx, ': unknown')}) => {
    const text = isObject(input) && typeof input.text === 'string' ? input.text : '';
    answer(ack, text.length > TEXT_MAX ? { ok: false, refused: { reason: 'length' } } : session.send({ text }));
  });
  socket.on('chat:mute', (input${t(ctx, ': unknown')}, ack${t(ctx, ': unknown')}) => {
    const byLine = isObject(input) && idOf(input.lineId);
    const byRef = isObject(input) && idOf(input.ref);
    if (!isObject(input) || typeof input.on !== 'boolean' || byLine === byRef) return answer(ack, { ok: false, hiddenIds: [] });
    const target = byLine ? { lineId: input.lineId${t(ctx, ' as string')} } : { ref: input.ref${t(ctx, ' as string')} };
    answer(ack, session.muteResult({ ...target, on: input.on }));
  });
  socket.on('chat:report', async (input${t(ctx, ': unknown')}, ack${t(ctx, ': unknown')}) => {
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
export function attachChat(io${t(ctx, ': Server')}, kit${t(ctx, ': Kit')})${t(ctx, ': void')} {
  io.of(\`\${kit.base}/chat\`)
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
      void serve(socket, kit);
    });
}
`;
}

function clientFile(ctx: Ctx): string {
  const imports =
    impType(ctx, ['ChatClosedWhy', 'ChatFrame', 'ChatStatus', 'ChatTransport', 'MuteResult', 'SendResult'], '@chatwarden/player-react/chat') +
    imp(ctx, 'PlayerError', '@chatwarden/player-react') +
    impType(ctx, ['ReportDraft', 'ReportResult'], '@chatwarden/player-react') +
    impType(ctx, 'Socket', 'socket.io-client');
  return `${header(ctx, 'The chat box transport over a socket.io-client socket: <ChatBox transport={socketTransport(socket)} />.')}${imports}
const ACK_MS = 10_000;
${t(ctx, `
/** What the server answers a report with (no id of the report is ever sent). */
type ReportAnswer = { ok: true; remaining: number } | { ok: false; refused: unknown; remaining?: number };
`)}
const noAnswer = ()${t(ctx, ': PlayerError')} => new PlayerError({ status: 0, code: 'no_answer', message: 'The server did not answer.' });

/**
 * A ChatTransport over a socket for the namespace attachChat serves: socketTransport(io('/chatwarden/chat', { autoConnect: false, auth: { key } })).
 * The room is sent in the auth payload when the box opens, and the socket is connected then. close() disconnects this socket only, never the
 * manager your game's own namespaces share.
 */
export function socketTransport(socket${t(ctx, ': Socket')})${t(ctx, ': ChatTransport')} {
  return {
    open(room, events) {
      let closed = false;
      let status${t(ctx, ': ChatStatus | undefined')};
      const set = (next${t(ctx, ': ChatStatus')}, why${t(ctx, '?: ChatClosedWhy')})${t(ctx, ': void')} => {
        if (closed || status === 'closed' || (next === status && why === undefined)) return;
        status = next;
        events.status(next, why);
      };
      const onFrame = (frame${t(ctx, ': ChatFrame')})${t(ctx, ': void')} => {
        if (closed) return;
        if (frame.type === 'hello') set('open');
        events.frame(frame);
        if (frame.type === 'bye') set('closed', frame.reason);
      };
      const onRefused = (refused${t(ctx, ': { reason?: unknown }')})${t(ctx, ': void')} => {
        set('closed', refused?.reason === 'banned' ? 'banned' : refused?.reason === 'unauthorized' ? 'unauthorized' : 'forbidden');
      };
      const onConnectError = (error${t(ctx, ': Error')})${t(ctx, ': void')} => {
        if (error.message === 'unauthorized' || error.message === 'forbidden') set('closed', error.message);
        else set('reconnecting');
      };
      const onDisconnect = (reason${t(ctx, ': string')})${t(ctx, ': void')} => {
        if (reason === 'io client disconnect') return;
        if (reason === 'io server disconnect') set('closed', 'shutdown');
        else set('reconnecting');
      };
      const onConnect = ()${t(ctx, ': void')} => set('connecting');

      socket.on('chat:frame', onFrame);
      socket.on('chat:refused', onRefused);
      socket.on('connect_error', onConnectError);
      socket.on('disconnect', onDisconnect);
      socket.on('connect', onConnect);
      socket.auth = { ...(typeof socket.auth === 'object' ? socket.auth : {}), room };
      set('connecting');
      socket.connect();

      function ask${t(ctx, '<T>')}(event${t(ctx, ': string')}, input${t(ctx, ': unknown')})${t(ctx, ': Promise<T>')} {
        return new Promise((resolve, reject) => {
          if (closed || !socket.connected) return reject(noAnswer());
          socket.timeout(ACK_MS).emit(event, input, (error${t(ctx, ': Error | null')}, answer${t(ctx, ': T')}) => (error ? reject(noAnswer()) : resolve(answer)));
        });
      }

      return {
        send: (text) => ask${t(ctx, '<SendResult>')}('chat:send', { text }),
        mute: (target, on) => ask${t(ctx, '<MuteResult>')}('chat:mute', { ...target, on }),
        report: async (lineId${t(ctx, ': string')}, draft${t(ctx, ': ReportDraft')})${t(ctx, ': Promise<ReportResult>')} => {
          const out = await ask${t(ctx, '<ReportAnswer>')}('chat:report', { lineId, ...draft });
          if (out.ok) return { ok: true, reportId: '', remaining: out.remaining };
          return { ok: false, refused: out.refused${t(ctx, " as Extract<ReportResult, { ok: false }>['refused']")}, ...(out.remaining === undefined ? {} : { remaining: out.remaining }) };
        },
        close() {
          closed = true;
          socket.off('chat:frame', onFrame);
          socket.off('chat:refused', onRefused);
          socket.off('connect_error', onConnectError);
          socket.off('disconnect', onDisconnect);
          socket.off('connect', onConnect);
          socket.disconnect();
        },
      };
    },
  };
}
`;
}

export function socketioFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.chat !== 'box' || answers.chatTransport !== 'socketio' || answers.framework === 'none') return [];
  return [
    { path: `${answers.dir}/socketio${ctx.scriptExt}`, content: serverFile(ctx) },
    { path: `${answers.dir}/socketTransport${ctx.scriptExt}`, content: clientFile(ctx) },
  ];
}
