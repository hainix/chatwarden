// "Show the code": the few lines of real kit code behind each tour step. Every non-blank line is copied verbatim from a
// package README (test/demoCode.test.ts checks that against the repo, so this cannot drift into invention).
import type { Lang } from '../lib/highlight';

export interface CodeStep {
  /** The tour step title. */
  title: string;
  /** What the lines do, in one sentence. */
  blurb: string;
  /** Where the demo differs from a real game, when it does (the demo runs the kit in the page, a game runs it on its server). */
  demoNote?: string;
  file: string;
  lang: Lang;
  code: string;
  /** Where the lines come from. */
  source: string;
}

export const CODE_STEPS: readonly CodeStep[] = [
  {
    title: "Report Bo's message",
    blurb: 'Your server files the report with one call. The room and players come from your session, never from the client.',
    demoNote: "The report dialog is player-react's; this demo calls cw.reports.submit in the page.",
    file: 'report.ts',
    lang: 'ts',
    source: 'packages/player-react/README.md',
    code: `// \`cw\` is your createChatwarden(...) instance. Call this behind your own route, for example POST /report: \`roomId\` and the seats come
// from your session, never from the client. The draft is the kit's own \`reason\` and \`note\`, so it spreads straight in.
export function takeReport(roomId: string, mySeat: string, theirSeat: string, draft: ReportDraft): Promise<ReportResult> {
  return cw.reports.submit({ roomId, reporterSeat: mySeat, targetSeat: theirSeat, ...draft });
}`,
  },
  {
    title: 'Open the report in the hub',
    blurb: 'The whole hub is one component on a page of your admin site.',
    demoNote: 'Here the hub reads the report from the real moderator routes running in this page, with no network. On a server you point it at /admin instead.',
    file: 'ModeratorPage.tsx',
    lang: 'ts',
    source: 'packages/hub-react/README.md',
    code: `import '@chatwarden/hub-react/styles.css';
import { Hub } from '@chatwarden/hub-react';
import { client } from './client';

export const ModeratorPage = () => <Hub client={client} />;`,
  },
  {
    title: 'Take the suggested action',
    blurb: "A decision closes the report, applies the action (here a warning) and writes the player's notice in one step.",
    demoNote: 'The hub sends the decision after its five seconds of Undo. A replay applies nothing twice.',
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
    title: 'See what Bo sees',
    blurb: "Your game reads the player's notices from one route and shows them with the notice dialog.",
    demoNote: 'A real game reads notices over the HTTP player routes (GET /notices). This demo calls cw.notices.pending in process, through a small local transport, and gets the same notices. A notice never carries anyone else’s chat, an IP, or an account or subject id.',
    file: 'client.ts',
    lang: 'ts',
    source: 'packages/player-react/README.md',
    code: `import { fetchTransport, createPlayerClient } from '@chatwarden/player-react';

// The player routes are mounted at /player on this origin. Cookies go along with each call: the server decides who is asking.
export const client = createPlayerClient({ transport: fetchTransport({ baseUrl: '/player', credentials: 'same-origin' }) });

const notices = await client.notices(); // what is waiting for this player, oldest first
console.log(notices.length);`,
  },
];
