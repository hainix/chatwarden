// The tiny-chat page: the ChatBox over the HTTP chat (`/chat`), the notices dialog and the rules page, from @chatwarden/player-react.
// DEMO ONLY identity: the key is made in the browser and kept in localStorage (or `?as=name`, so two tabs can be two players). A real
// game uses its own session; the server reads whatever credential your game already has.
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPlayerClient, fetchTransport, NoticeQueue, RulesPage } from '@chatwarden/player-react';
import type { PlayerReporting } from '@chatwarden/player-react';
import { ChatBox, sseTransport } from '@chatwarden/player-react/chat';

const STORAGE = 'tiny-chat-key';

function demoKey(): string {
  const as = new URLSearchParams(location.search).get('as');
  if (as !== null && /^[A-Za-z0-9_-]{1,32}$/.test(as)) return `demo-as-${as}`;
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved !== null && saved !== '') return saved;
  } catch {
    // storage is off: a key for this tab only
  }
  const key = `demo-${crypto.randomUUID()}`;
  try {
    localStorage.setItem(STORAGE, key);
  } catch {
    // as above
  }
  return key;
}

function App() {
  const headers = useMemo(() => ({ 'x-chatwarden-key': demoKey() }), []);
  const client = useMemo(() => createPlayerClient({ transport: fetchTransport({ baseUrl: '/api', headers }) }), [headers]);
  const transport = useMemo(() => sseTransport({ baseUrl: '/chat', headers }), [headers]);
  const [reporting, setReporting] = useState<PlayerReporting | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const [rules, setRules] = useState(false);

  useEffect(() => {
    client.rules().then(
      (r) => setReporting(r.reporting),
      () => undefined,
    );
  }, [client]);

  return (
    <main className="page">
      <h1>tiny-chat</h1>
      <p className="demo">DEMO ONLY: this page makes its own key and sends it in a header. A real game uses its own session.</p>
      <ChatBox transport={transport} room="lobby" {...(reporting === undefined ? {} : { reporting })} onNoticePending={() => setRefresh((n) => n + 1)} onOpenRules={() => setRules((open) => !open)} />
      {rules && <RulesPage client={client} />}
      <NoticeQueue client={client} refreshKey={refresh} />
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
