// "Show me the code": the few lines of real kit code behind each tour step. Every non-blank line is copied verbatim from a
// package README (test/demoCode.test.ts checks that against the repo, so this cannot drift into invention).
import type { Lang } from '../lib/highlight';

export interface CodeStep {
  /** The tour step title. */
  title: string;
  /** What the lines do, in one sentence. */
  blurb: string;
  file: string;
  lang: Lang;
  code: string;
  /** Where the lines come from. */
  source: string;
}

export const CODE_STEPS: readonly CodeStep[] = [
  {
    title: 'Report a message',
    blurb: 'Your server files the report: one call, with the room and the seats from your session. The report dialog is player-react’s; this demo calls cw.reports.submit in the page.',
    file: 'report.ts',
    lang: 'ts',
    source: 'packages/player-react/README.md',
    code: `// \`roomId\` and the seats come from your session, never from the client.
export function takeReport(roomId: string, mySeat: string, theirSeat: string, draft: ReportDraft): Promise<ReportResult> {
  return cw.reports.submit({ roomId, reporterSeat: mySeat, targetSeat: theirSeat, ...draft });
}`,
  },
  {
    title: 'The case appears in the hub',
    blurb: 'The moderator hub is one component over the staff routes. Simple mode is its default view.',
    file: 'ModeratorPage.tsx',
    lang: 'ts',
    source: 'packages/hub-react/README.md',
    code: `import '@chatwarden/hub-react/styles.css';
import { Hub } from '@chatwarden/hub-react';
import { client } from './client';

export const ModeratorPage = () => <Hub client={client} />;`,
  },
  {
    title: 'Open it in Simple',
    blurb: 'Here the hub reads the case from the real staff routes running in this page, with no network. On a server you point it at /admin instead.',
    file: 'client.ts',
    lang: 'ts',
    source: 'packages/hub-react/README.md',
    code: `const cw = await createChatwarden({
  store: createMemoryStore(),
  secret: 'demo-secret-0000-not-for-production',
  platform: { identify: (ctx) => ctx as RawWho },
});
const handle = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'owner' }) }));

export const client = createHubClient(routerTransport(handle));`,
  },
  {
    title: 'Apply the suggestion',
    blurb: 'A decision closes the report and writes the sanction and the player notice in one step. A replay applies nothing twice. The hub sends it after its five seconds of Undo.',
    file: 'decide.ts',
    lang: 'ts',
    source: 'packages/core/README.md',
    code: `// The moderator decides the open report: a warning that shows the player their latest line.
const report = cw.reports.list({ status: 'open' }).items[0]!;
const decided: DecisionResult = await cw.decide({
  reportId: report.id,
  verdict: 'upheld', // 'noted', 'no_action' and 'bad_faith' are the others
  actor: 'moderator@example.com', // who decided, for the audit trail
  reason: 'kept insulting a teammate', // private: a player never sees it
  actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 2, lineIds: report.ownLineIds[report.targetPerson]?.slice(-1) }],
});
console.log(decided.ok ? \`applied \${decided.groups.length} action\` : \`not applied: \${decided.error}\`);`,
  },
  {
    title: 'The player sees the notice',
    blurb: 'A real game’s client reads notices over the HTTP player API (GET /notices). This demo calls cw.notices.pending in process, through a small local transport, and gets the same notices. A notice never carries anyone else’s chat, an IP, or an account or subject id.',
    file: 'client.ts',
    lang: 'ts',
    source: 'packages/player-react/README.md',
    code: `import { fetchTransport, playerClient } from '@chatwarden/player-react';

// The player routes are mounted at /player on this origin. Cookies go along with each call: the server decides who is asking.
export const client = playerClient({ transport: fetchTransport({ baseUrl: '/player', credentials: 'same-origin' }) });

const notices = await client.notices(); // what is waiting for this player, oldest first
console.log(notices.length);`,
  },
  {
    title: 'The Detailed switch',
    blurb: 'Simple is the hub’s CaseCard, one card per case, and you can also place it in your own dashboard. Detailed is the full workbench, CaseWorkbench.',
    file: 'Moderation.tsx',
    lang: 'ts',
    source: 'packages/hub-react/README.md',
    code: `      <CaseList selected={open} onOpenCase={(_person, reportId) => setOpen(reportId)} />
      {open !== null && <CaseCard reportId={open} onOpenReport={setOpen} />}
      <RecentActions />`,
  },
  {
    title: 'Steps and ladder',
    blurb: 'The lengths a moderator can pick, and the ladder itself, are the studio’s setting. The hub edits them with a preview; in code it is a layer you preview and save.',
    file: 'policy.ts',
    lang: 'ts',
    source: 'packages/core/README.md',
    code: `// What would this suggest for a clean record, a warning, a 24 hour restriction and a 7 day ban? Nothing is saved.
const layer = { durations: [HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR], firstOffense: { rude: { kind: 'chat' as const, durationMs: 6 * HOUR } } };
const preview = cw.policy.preview(layer);`,
  },
];
