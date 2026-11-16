// The chat box transport over a socket.io-client socket: <ChatBox transport={socketTransport(socket)} />.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import type { ChatClosedWhy, ChatFrame, ChatStatus, ChatTransport, MuteResult, SendResult } from '@chatwarden/player-react/chat';
import { PlayerError } from '@chatwarden/player-react';
import type { ReportDraft, ReportResult } from '@chatwarden/player-react';
import type { Socket } from 'socket.io-client';

const ACK_MS = 10_000;

/** What the server answers a report with (no id of the report is ever sent). */
type ReportAnswer = { ok: true; remaining: number } | { ok: false; refused: unknown; remaining?: number };

const noAnswer = (): PlayerError => new PlayerError({ status: 0, code: 'no_answer', message: 'The server did not answer.' });

/**
 * A ChatTransport over a socket for the namespace attachChat serves: socketTransport(io('/chatwarden/chat', { autoConnect: false, auth: { key } })).
 * The room is sent in the auth payload when the box opens, and the socket is connected then. close() disconnects this socket only, never the
 * manager your game's own namespaces share.
 */
export function socketTransport(socket: Socket): ChatTransport {
  return {
    open(room, events) {
      let closed = false;
      let status: ChatStatus | undefined;
      const set = (next: ChatStatus, why?: ChatClosedWhy): void => {
        if (closed || status === 'closed' || (next === status && why === undefined)) return;
        status = next;
        events.status(next, why);
      };
      const onFrame = (frame: ChatFrame): void => {
        if (closed) return;
        if (frame.type === 'hello') set('open');
        events.frame(frame);
        if (frame.type === 'bye') set('closed', frame.reason);
      };
      const onRefused = (refused: { reason?: unknown }): void => {
        set('closed', refused?.reason === 'banned' ? 'banned' : refused?.reason === 'unauthorized' ? 'unauthorized' : 'forbidden');
      };
      const onConnectError = (error: Error): void => {
        if (error.message === 'unauthorized' || error.message === 'forbidden') set('closed', error.message);
        else set('reconnecting');
      };
      const onDisconnect = (reason: string): void => {
        if (reason === 'io client disconnect') return;
        if (reason === 'io server disconnect') set('closed', 'shutdown');
        else set('reconnecting');
      };
      const onConnect = (): void => set('connecting');

      socket.on('chat:frame', onFrame);
      socket.on('chat:refused', onRefused);
      socket.on('connect_error', onConnectError);
      socket.on('disconnect', onDisconnect);
      socket.on('connect', onConnect);
      socket.auth = { ...(typeof socket.auth === 'object' ? socket.auth : {}), room };
      set('connecting');
      socket.connect();

      function ask<T>(event: string, input: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
          if (closed || !socket.connected) return reject(noAnswer());
          socket.timeout(ACK_MS).emit(event, input, (error: Error | null, answer: T) => (error ? reject(noAnswer()) : resolve(answer)));
        });
      }

      return {
        send: (text) => ask<SendResult>('chat:send', { text }),
        mute: (target, on) => ask<MuteResult>('chat:mute', { ...target, on }),
        report: async (lineId: string, draft: ReportDraft): Promise<ReportResult> => {
          const out = await ask<ReportAnswer>('chat:report', { lineId, ...draft });
          if (out.ok) return { ok: true, reportId: '', remaining: out.remaining };
          return { ok: false, refused: out.refused as Extract<ReportResult, { ok: false }>['refused'], ...(out.remaining === undefined ? {} : { remaining: out.remaining }) };
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
