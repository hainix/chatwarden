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
