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
  const staff = new URLSearchParams(location.search).get('staff');
  // With CW_DEMO_ROOMS the server treats a key that starts `demo-staff-` as staff: `?staff=mod` makes this tab one.
  if (staff !== null && /^[A-Za-z0-9_-]{1,32}$/.test(staff)) return `demo-staff-${staff}`;
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

/** DEMO ONLY staff tools (CW_DEMO_ROOMS=1, and a `?staff=` tab): lock or unlock the lobby, and take a line back for everyone by its id. The staff API does the same for a real hub. */
function StaffTools({ headers }: { headers: Record<string, string> }) {
  const [said, setSaid] = useState('');
  const [line, setLine] = useState('');
  const call = async (path: string, body?: unknown): Promise<void> => {
    try {
      const res = await fetch(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      setSaid(res.ok ? 'Done.' : `Not done (${res.status}).`);
    } catch {
      setSaid('Not done: could not reach the server.');
    }
  };
  return (
    <section className="staff" aria-label="Staff tools (demo)">
      <h2>Staff tools (demo)</h2>
      <p>
        <button type="button" onClick={() => void call('/demo/rooms/lobby/lock', { forMs: 30 * 60_000 })}>
          Lock the lobby for 30 minutes
        </button>{' '}
        <button type="button" onClick={() => void call('/demo/rooms/lobby/unlock')}>
          Unlock
        </button>
      </p>
      <p>
        <label>
          Line id <input value={line} onChange={(e) => setLine(e.target.value)} />
        </label>{' '}
        <button type="button" onClick={() => void call(`/demo/rooms/lobby/lines/${encodeURIComponent(line)}/retract`)}>
          Remove the line
        </button>
      </p>
      <p role="status">{said}</p>
    </section>
  );
}

function App() {
  const headers = useMemo(() => ({ 'x-chatwarden-key': demoKey() }), []);
  const client = useMemo(() => createPlayerClient({ transport: fetchTransport({ baseUrl: '/api', headers }) }), [headers]);
  const transport = useMemo(() => sseTransport({ baseUrl: '/chat', headers }), [headers]);
  const [reporting, setReporting] = useState<PlayerReporting | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const [rules, setRules] = useState(false);
  // Appeals are the server's switch (CW_DEMO_APPEALS=1). It says so in a meta tag, so the page asks no route that would answer 404; without it the
  // notices keep the old link.
  const appeals = document.querySelector('meta[name="tiny-chat-appeals"]')?.getAttribute('content') === 'on';
  // Room control is the server's switch too (CW_DEMO_ROOMS=1, a meta tag): the tools show only in a `?staff=` tab.
  const rooms = document.querySelector('meta[name="tiny-chat-rooms"]')?.getAttribute('content') === 'on' && headers['x-chatwarden-key'].startsWith('demo-staff-');

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
      {rooms && <StaffTools headers={headers} />}
      {rules && <RulesPage client={client} />}
      <NoticeQueue client={client} refreshKey={refresh} appeals={appeals} />
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
