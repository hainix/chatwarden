// `ChatPanel.tsx` (design 6.1): the kit's chat box in the player's page, lazy-loaded, with the two stylesheet imports and the notice dialog. The
// server half of the box (the broadcaster and its routes) is in kit.ts and in each framework's mount; this is only the client.
import type { FileSpec } from '../types.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function chatFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.chat !== 'box') return [];
  const client = answers.framework === 'next' ? "'use client';\n\n" : '';
  const imports =
    imp(ctx, ['lazy', 'Suspense', 'useEffect', 'useMemo', 'useState'], 'react') +
    "import '@chatwarden/player-react/styles.css';\nimport '@chatwarden/player-react/chat.css';\n" +
    imp(ctx, ['createPlayerClient', 'fetchTransport', 'NoticeQueue'], '@chatwarden/player-react') +
    impType(ctx, 'PlayerReporting', '@chatwarden/player-react') +
    imp(ctx, 'sseTransport', '@chatwarden/player-react/chat');
  const props = t(
    ctx,
    `export interface ChatPanelProps {
  /** Who this player is to the server: your game's own session or account id goes here (see identify in auth). */
  playerKey: string;
  /** The room to join. The starter join hook knows one room, lobby. */
  room?: string;
}

`,
  );
  const content = `${client}${header(ctx, 'The chat box for a player page: <ChatPanel playerKey={...} />.')}${imports}
// The box is loaded when it is first shown, so a page that never shows chat does not pay for it.
const ChatBox = lazy(() => import('@chatwarden/player-react/chat').then((m) => ({ default: m.ChatBox })));
const BASE = '${answers.base}';

${props}export default function ChatPanel({ playerKey, room = 'lobby' }${t(ctx, ': ChatPanelProps')}) {
  const headers = useMemo(() => ({ 'x-chatwarden-key': playerKey }), [playerKey]);
  const client = useMemo(() => createPlayerClient({ transport: fetchTransport({ baseUrl: \`\${BASE}/api\`, headers }) }), [headers]);
  const transport = useMemo(() => sseTransport({ baseUrl: \`\${BASE}/chat\`, headers }), [headers]);
  const [reporting, setReporting] = useState${t(ctx, '<PlayerReporting | undefined>')}(undefined);
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
`;
  return [{ path: `${answers.dir}/ChatPanel${ctx.jsxExt}`, content }];
}
