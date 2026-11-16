// `HubPage.tsx` (design 6.1): the moderator hub as a React component (`hub: react`), over the staff routes. It asks for the staff token and keeps it in
// memory for the visit (never in a cookie or in storage); send it with the starter authorize, or replace both with your own sign-in.
import type { FileSpec } from '../types.js';
import { imp } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function hubReactFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.hub !== 'react') return [];
  const client = answers.framework === 'next' ? "'use client';\n\n" : '';
  const imports =
    imp(ctx, ['useMemo', 'useState'], 'react') +
    "import '@chatwarden/hub-react/styles.css';\n" +
    imp(ctx, ['Hub', 'createHubClient', 'fetchTransport'], '@chatwarden/hub-react');
  const content = `${client}${header(ctx, 'The moderator hub for a React page: <HubPage />.')}${imports}
const BASE = '${answers.base}';

// The starter sign-in: the page asks for the staff token and sends it in a header. Replace this with your own session when you replace authorize().
export default function HubPage() {
  const [typed, setTyped] = useState('');
  const [token, setToken] = useState('');
  const client = useMemo(
    () => (token === '' ? undefined : createHubClient(fetchTransport({ baseUrl: \`\${BASE}/admin\`, headers: { 'x-admin-token': token } }))),
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
`;
  return [{ path: `${answers.dir}/HubPage${ctx.jsxExt}`, content }];
}
