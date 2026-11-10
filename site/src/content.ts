// All the words on the page, as data. Honest copy only:
//   - code snippets and install commands come from the READMEs (test/content.test.ts checks them against the repo);
//   - AI levels that are not built are marked "coming";
//   - the only demo words are the invented ones from @chatwarden/matcher/fixtures.

export const REPO_URL = 'https://github.com/hainix/chatwarden';
export const NPM_URL = 'https://www.npmjs.com/package/@chatwarden/core';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const INSTALL_KIT = 'npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher';

export type Verdict = 'delivered' | 'refused';
export interface ChatLine {
  who: string;
  text: string;
  verdict: Verdict;
  /** What only the sender sees, for a refused line. */
  notice?: string;
}

/** The hero's chat snippet. "zorbak" is an invented word from the matcher's test fixtures. */
export const HERO_CHAT: ChatLine[] = [
  { who: 'Ada', text: 'gg, that last clutch was wild', verdict: 'delivered' },
  { who: 'Bo', text: "ez, you're trash lol", verdict: 'delivered' },
  {
    who: 'Bo',
    text: 'you absolute zorbak',
    verdict: 'refused',
    notice: 'Blocked. Only Bo sees this notice.',
  },
  { who: 'Ada', text: 'rematch?', verdict: 'delivered' },
];

export interface Feature {
  id: string;
  title: string;
  body: string;
  tag?: string;
}

export const FEATURES: Feature[] = [
  {
    id: 'match',
    title: 'Catches slurs that dodge filters',
    body: 'Leetspeak, look-alike letters, accents, repeated letters and invisible characters are read through. Whole words only, so innocent words pass.',
  },
  {
    id: 'reports',
    title: 'Reports with evidence',
    body: 'Players report each other from inside your game. The kit keeps the lines as evidence and limits abuse of the report button.',
  },
  {
    id: 'ladder',
    title: 'A fair ladder',
    body: 'Pick relaxed, standard or strict. Trash talk is not punished. Repeat offenders climb from a warning to timeouts to a ban.',
  },
  {
    id: 'notices',
    title: 'Player notices',
    body: 'Every action comes with a plain notice for the player. It never carries anyone else’s chat text, IP or id.',
  },
  {
    id: 'hub',
    title: 'Moderator hub and roles',
    body: 'Moderator, senior and owner roles run on a staff HTTP API today: the queue, decisions, sanctions, terms and the audit trail.',
    tag: 'Hub UI is coming',
  },
  {
    id: 'discord',
    title: 'Discord and webhooks',
    body: 'Post the review queue into a Discord forum, one thread per reported person. Signed webhooks go in and out.',
  },
];

export interface Step {
  id: string;
  title: string;
  body: string;
  lang: 'sh' | 'ts';
  file: string;
  copyLabel: string;
  code: string;
}

const STEP_ENGINE = `import { createChatwarden, type Platform } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { openStore } from '@chatwarden/store-sqlite';

// What one of your connections looks like. Yours may be a socket, a session or a request.
interface Connection {
  playerToken: string; // a stable, secret per-player value (not shown to other players)
  remoteAddress: string; // the REAL client address; behind a proxy, parse X-Forwarded-For yourself
}

// How to find out who is behind a connection. Give raw values: the kit hashes them before it stores anything.
const platform: Platform = {
  identify: (ctx) => {
    const conn = ctx as Connection;
    return { clientKey: conn.playerToken, ip: conn.remoteAddress };
  },
};

const store = openStore({ path: './chatwarden.db' });

// The slur matcher. This demo uses the invented test words; use your own term pack in production.
const matcher = new LiveTerms({ store, pack: syntheticTermPack(), clock: { now: () => Date.now() } });
await matcher.load();

const cw = await createChatwarden({
  store,
  secret: process.env.CHATWARDEN_SECRET!, // 32+ random characters; keep it stable and private
  platform,
  matcher,
  profile: 'standard', // 'relaxed', 'standard' or 'strict'
});`;

const STEP_CHAT = `// A player connects: seat them in a room under a display name.
const connection: Connection = { playerToken: 'token-from-your-login', remoteAddress: '203.0.113.7' };
cw.rooms.seatConnection('lobby', 'seat-1', connection, 'Ada');

// A chat line arrives: ask the kit what to do with it.
const result = cw.chat.accept('lobby', 'seat-1', 'hello everyone');
if ('deliver' in result) {
  console.log('send to the room:', result.deliver.text); // may be starred if you turned profanity starring on
} else {
  console.log('tell this player only:', result.refuse.reason); // 'blocked', 'rate', 'restricted', ...
}`;

export const STEPS: Step[] = [
  {
    id: 'install',
    title: 'Install the kit',
    body: 'Three packages: the engine, a SQLite store and the slur matcher. Node 22.13 or newer.',
    lang: 'sh',
    file: 'terminal',
    copyLabel: 'Copy step 1 install command',
    code: INSTALL_KIT,
  },
  {
    id: 'engine',
    title: 'Create the engine',
    body: 'Tell it who is behind a connection and which matcher to use. Pick a preset for your game: relaxed, standard or strict. This runs on the invented test words.',
    lang: 'ts',
    file: 'moderation.ts',
    copyLabel: 'Copy step 2 engine setup',
    code: STEP_ENGINE,
  },
  {
    id: 'chat',
    title: 'Ask it about every line',
    body: 'Each chat line gets a verdict: deliver it, or refuse it with a reason only the sender sees.',
    lang: 'ts',
    file: 'chat.ts',
    copyLabel: 'Copy step 3 chat hook',
    code: STEP_CHAT,
  },
];

export type LevelStatus = 'available' | 'coming';
export interface Level {
  level: 0 | 1 | 2 | 3 | 4;
  name: string;
  body: string;
  status: LevelStatus;
}

// Only level 0 (off) exists today. The AI read (level 1 and up) is not built yet.
export const LEVELS: Level[] = [
  { level: 0, name: 'Off', body: 'Nothing is automated. People do everything.', status: 'available' },
  {
    level: 1,
    name: 'Read',
    body: 'An AI read of each report: how serious, which rule, a one-line summary and the evidence lines. It ranks the queue. People decide.',
    status: 'coming',
  },
  {
    level: 2,
    name: 'Recommend',
    body: 'It proposes the whole decision, pre-filled and marked as an AI suggestion. A moderator confirms or edits it in one click.',
    status: 'coming',
  },
  {
    level: 3,
    name: 'Act on clear cases',
    body: 'For narrow, clear cases it applies a short action itself: a warning or a chat restriction of up to 24 hours. A human can review and reverse it.',
    status: 'coming',
  },
  {
    level: 4,
    name: 'Watch',
    body: 'It reads delivered chat in the background without delaying a message, and files a report when something serious slips by.',
    status: 'coming',
  },
];

export const CEILINGS_TITLE = "Hard limits we're building in";
export const CEILINGS_INTRO = "When the AI levels ship, these will hold at every level, and they won't be settings.";

export const CEILINGS: string[] = [
  'The AI can never ban.',
  'It never acts beyond 24 hours.',
  'It never acts unless the evidence has a line from the person reported.',
  'It never acts on someone a moderator marked “do not automate”.',
  'Other players’ flags never count on their own.',
];

export interface Integration {
  id: string;
  title: string;
  body: string;
}

export const WORKS_WITH: Integration[] = [
  {
    id: 'express',
    title: 'Express',
    body: 'Mount the staff and player routes with the Express adapter. The kit reads the raw body itself.',
  },
  {
    id: 'node',
    title: 'Any Node game server',
    body: 'The engine has no dependencies and no framework. Call it from your ws handler, your lobby code or your own protocol.',
  },
  {
    id: 'discord',
    title: 'Discord',
    body: 'The review queue lands in a Discord forum through a channel webhook, one thread per reported person.',
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    body: 'Signed webhooks in and out connect the kit to the tools you already run.',
  },
];

export interface FaqItem {
  id: string;
  q: string;
  a: string;
  links?: { label: string; href: string }[];
}

export const FAQ: FaqItem[] = [
  {
    id: 'free',
    q: 'Is it really free?',
    a: 'Free forever, under Apache-2.0, with no paid tier. There is no SLA and no support promise: the kit is provided as-is. Pull requests are welcome.',
  },
  {
    id: 'privacy',
    q: 'What happens to player data?',
    a: 'Client keys and IP addresses are hashed on the way in, with a secret only you hold. People are tracked by an opaque subject id that players never see. The kit keeps the lines attached to a report as evidence, in your own SQLite file. Chatwarden runs no servers, and this site has no analytics or trackers.',
  },
  {
    id: 'terms',
    q: 'Where do the blocked words come from?',
    a: 'The packages ship with no term list. Bring your own pack, or try the invented test words that come with the matcher (zorbak and friends). Moderators can edit the list while the game runs, and each edit is checked against known-innocent lines first. A shared community term list is planned. It is not available yet.',
  },
  {
    id: 'ai',
    q: 'Does an AI read my players’ chat?',
    a: 'Not today. The AI levels are coming soon, and every one is opt-in.',
  },
  {
    id: 'agents',
    q: 'Can my coding agent set it up?',
    a: 'Yes. The packages are typed TypeScript, each has a README with a copy-paste start, and the repo has an AGENTS.md. ESM only; a CommonJS app can require() it on Node 22.13 or newer.',
  },
  {
    id: 'child-safety',
    q: 'Is it a child-safety tool?',
    a: 'No. Chatwarden is not a child-safety tool. For CSAM detection and reporting, use Coop and HMA.',
    links: [
      { label: 'Coop', href: 'https://github.com/roostorg/coop' },
      {
        label: 'HMA',
        href: 'https://github.com/facebook/ThreatExchange/tree/main/hasher-matcher-actioner',
      },
    ],
  },
];
