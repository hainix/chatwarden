'use client';

// The moderator hub for a React page: <HubPage />.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { useMemo, useState } from 'react';
import '@chatwarden/hub-react/styles.css';
import { Hub, createHubClient, fetchTransport } from '@chatwarden/hub-react';

const BASE = '/chatwarden';

// The starter sign-in: the page asks for the staff token and sends it in a header. Replace this with your own session when you replace authorize().
export default function HubPage() {
  const [typed, setTyped] = useState('');
  const [token, setToken] = useState('');
  const client = useMemo(
    () => (token === '' ? undefined : createHubClient(fetchTransport({ baseUrl: `${BASE}/admin`, headers: { 'x-admin-token': token } }))),
    [token],
  );

  if (client === undefined) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setToken(typed);
        }}
      >
        <label>
          Staff token <input type="password" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        </label>
        <button type="submit">Open the hub</button>
      </form>
    );
  }
  return <Hub client={client} />;
}
