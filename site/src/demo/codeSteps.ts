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
    title: 'Say something bad',
    blurb: 'Every chat line goes through the kit first. A refused line is for its sender only.',
    file: 'chat.ts',
    lang: 'ts',
    source: 'packages/core/README.md',
    code: `// A chat line arrives: ask the kit what to do with it.
const result = cw.chat.accept('lobby', 'seat-1', 'hello everyone');
if ('deliver' in result) {
  console.log('send to the room:', result.deliver.text); // may be starred if you turned profanity starring on
} else {
  console.log('tell this player only:', result.refuse.reason); // 'blocked', 'rate', 'restricted', ...
}`,
  },
  {
    title: 'Report a line',
    blurb: 'A report keeps the recent lines as evidence and limits abuse of the report button.',
    file: 'report.ts',
    lang: 'ts',
    source: 'packages/core/README.md',
    code: `// Ada reports Bo from inside your game.
const filed = await cw.reports.submit({
  roomId: 'lobby',
  reporterSeat: 'seat-1',
  targetSeat: 'seat-2',
  category: 'harassment',
  note: 'kept at it after I asked them to stop',
});
console.log(filed.ok ? \`report \${filed.reportId} filed\` : \`not filed: \${filed.refused}\`);`,
  },
  {
    title: 'Decide',
    blurb: 'A decision closes the report and writes the sanction and the player notice in one step. A replay applies nothing twice.',
    file: 'decide.jsonc',
    lang: 'ts',
    source: 'packages/http/README.md',
    code: `// Decide a report, exactly as POST /reports/:id/decide:
{ "action": "decide", "input": { "reportId": "...", "verdict": "upheld", "reason": "...", "actions": [ { "subject": "s_...", "kind": "chat", "durationMs": 3600000, "rule": 1 } ] } }`,
  },
  {
    title: "See the player's view",
    blurb: 'The player reads their notices from the player API. It never carries anyone else’s chat, an IP, or an account or subject id.',
    file: 'terminal',
    lang: 'sh',
    source: 'packages/http/README.md',
    code: 'curl -H "x-player-token: abc" http://localhost:3000/api/notices',
  },
];
