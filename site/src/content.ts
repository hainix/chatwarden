// All the words on the page, as data. Honest copy only (the source is docs/design/2026-11-11-site-copy-rewrite.md, section 3):
//   - code snippets and install commands come from the READMEs (test/content.test.ts checks them against the repo);
//   - nothing that is not built is promised (no chat box, no AI, no shared word list);
//   - the only demo words are the invented ones from @chatwarden/matcher/fixtures.

export const REPO_URL = 'https://github.com/hainix/chatwarden';
export const NPM_URL = 'https://www.npmjs.com/package/@chatwarden/core';
const TREE_URL = `${REPO_URL}/tree/main/packages`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const INSTALL_KIT = 'npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher';

export type Verdict = 'delivered' | 'refused';
export interface ChatLine {
  who: string;
  text: string;
  /** 'refused' is the kit's word for a blocked line; the page says "blocked". */
  verdict: Verdict;
  /** What only the sender sees, for a blocked line. */
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
    notice: 'Blocked. Only Bo sees this.',
  },
  { who: 'Ada', text: 'rematch?', verdict: 'delivered' },
];

export const HERO = {
  title: ['Chat moderation for your game.', 'Moderator hub included.'],
  lead: "Chatwarden blocks slurs from your word list before they're posted, lets players report a message right from the chat, and gives your team a moderator hub: each player with open reports is a case, with every report about them and one click to act. Add it to the chat you already have with a short setup on your Node server.",
  primary: 'Try the live demo',
  secondary: 'Add it to your game',
  proof: 'Free · Open source (Apache-2.0) · Runs on your server, no account',
  tag: 'standard rules',
  stamp: 'Blocked',
} as const;

export const DEMO_SECTION = {
  title: "Try it: you're the player and the moderator",
  lead: 'On the left, a game lobby. On the right, the moderator hub your team would use. Report a message, then deal with it. It takes a few clicks, and it all runs in your browser.',
} as const;

export interface Panel {
  id: 'chat' | 'game' | 'hub';
  title: string;
  body: string;
  /** A smaller second paragraph under the body. */
  aside?: string;
}

export const HOW = {
  title: 'How it works',
  lead: 'Your game keeps its own chat. Chatwarden checks each message, collects reports, and gives your team one place to act on them.',
} as const;

export const HOW_PANELS: Panel[] = [
  {
    id: 'chat',
    title: 'In the chat',
    body: 'Every message goes through one check before your server sends it. Slurs on your word list are blocked, even written with numbers for letters (z0rbak), look-alike letters, accents or repeated letters. Ordinary swearing is your call: allow it, star it out, or block it. Insults and trash talk are not blocked; players can report them. The sender sees why their message was blocked, and nobody else sees it.',
  },
  {
    id: 'game',
    title: 'In your game',
    body: "Players report a message right from the chat. The report carries the chat around it, so your moderators see what happened, not just a complaint. When a moderator acts, the player gets a plain notice: what they did, which rule, and for how long. Ready-made React components cover the report dialog, notices, the player's record and your rules.",
  },
  {
    id: 'hub',
    title: 'In your moderator hub',
    body: "The moderator hub is a web page where your team handles reports. Each case is one card: what the player said, their history, and the action your rules suggest. One click to act, five seconds to undo. Repeat offenders go from a warning to timeouts to a ban.",
    aside: "Bigger team? The hub's Detailed view adds a full queue with filters, and lets a moderator claim a case so two never take the same one. Prefer Discord? Each reported player can get a thread in a Discord forum.",
  },
];

export const RULES_STRIP = {
  title: 'Your rules',
  body: 'Start with relaxed, standard or strict rules. They set what counts as over the line, what the hub suggests, and the code of conduct your players read. Change any of it later in the hub.',
} as const;

export const PLAYER_REACT_URL = `${TREE_URL}/player-react`;
const MATCHER_README_URL = `${TREE_URL}/matcher#readme`;
const PROFANITY_URL = `${TREE_URL}/profanity`;

export const ADD_IT = {
  title: 'Add it to your game',
  lead: "Chatwarden needs three things from your server: who's talking, each message before it's sent, and a page for your moderators. It runs on Node 22.13 or newer, with any framework.",
  closing:
    'Every package has a README with the full setup, options and security notes. For a complete chat server wired up end to end, see examples/tiny-chat in the repo.',
} as const;

export interface Step {
  id: string;
  title: string;
  body: string;
  lang: 'sh' | 'ts';
  file: string;
  copyLabel: string;
  code: string;
  /** A link after the text, for where to read more. */
  link?: { label: string; href: string };
  /** Show this many lines, with a "Show the full file" button for the rest. The whole file stays in the page. */
  collapsedLines?: number;
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

/** Steps 1 to 3: the code that runs on your server before any moderator is involved. */
export const STEPS: Step[] = [
  {
    id: 'install',
    title: 'Install',
    body: 'The engine, its storage (one SQLite file, using the SQLite built into Node) and the word filter.',
    lang: 'sh',
    file: 'terminal',
    copyLabel: 'Copy step 1 install command',
    code: INSTALL_KIT,
  },
  {
    id: 'engine',
    title: 'Set it up once',
    body: 'Tell it how to recognise a player: your login token and their IP address, both hashed before anything is stored. Load your word list and pick relaxed, standard or strict. The code uses made-up test words; see the matcher README for the term pack format.',
    link: { label: 'the matcher README', href: MATCHER_README_URL },
    lang: 'ts',
    file: 'moderation.ts',
    copyLabel: 'Copy step 2 engine setup',
    code: STEP_ENGINE,
    collapsedLines: 22,
  },
  {
    id: 'chat',
    title: 'Check every message',
    body: 'Call it before you broadcast a message. It answers deliver, or block with a reason you show only to the sender.',
    lang: 'ts',
    file: 'chat.ts',
    copyLabel: 'Copy step 3 chat hook',
    code: STEP_CHAT,
  },
];

export interface Snippet {
  lang: 'ts' | 'text' | 'sh';
  file: string;
  copyLabel: string;
  code: string;
}

export interface HubTab {
  id: 'react' | 'page';
  label: string;
  snippets: Snippet[];
}

/**
 * Step 4: the moderator hub, doable from the page alone. First the server (install the routes and Express, import what the mount uses,
 * mount the routes behind your login), which every way of showing the hub needs; then the page: React (install, the client the
 * drop-in imports, the drop-in) or any page (one script tag). Every snippet is a block copied verbatim from a README
 * (test/content.test.ts checks them): the install line and the server example from hub-react, its client and drop-in, and the one
 * script tag from hub-element.
 */
export const HUB_STEP: { title: string; body: string; server: Snippet[]; pageTitle: string; tabs: HubTab[] } = {
  title: 'Add the moderator hub',
  body: "Mount the moderator routes on your server, behind your own login: you write one function that says who's a moderator. Then put the hub on a page. In React it's one component; anywhere else it's one script tag.",
  server: [
    {
      lang: 'sh',
      file: 'terminal',
      copyLabel: 'Copy the moderator routes install command',
      code: 'npm install @chatwarden/http express @types/express',
    },
    {
      lang: 'ts',
      file: 'server.ts',
      copyLabel: 'Copy the moderator routes mount',
      code: `import express from 'express';
import { adminRoutes } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';

// \`cw\` is your createChatwarden(...) instance; \`yourModeratorLogin\` is your own sign-in check (see "Signing moderators in").
const app = express();
// The kit's routes read the raw body themselves: mount them before any body parser.
app.use('/admin', toExpress(adminRoutes(cw, { authorize: yourModeratorLogin }), { fallthrough: false }));
app.use('/mod', express.static('dist/mod')); // the built page: an index.html and the script and stylesheet it loads
app.listen(3000);`,
    },
  ],
  pageTitle: 'Then put the hub on a page',
  tabs: [
    {
      id: 'react',
      label: 'React',
      snippets: [
        {
          lang: 'sh',
          file: 'terminal',
          copyLabel: 'Copy the hub install command',
          code: 'npm install @chatwarden/hub-react @chatwarden/core @chatwarden/http react react-dom',
        },
        {
          lang: 'ts',
          file: 'client.ts',
          copyLabel: 'Copy the hub client',
          code: `import { createHubClient, fetchTransport } from '@chatwarden/hub-react';

// The staff routes are mounted at /admin on this origin. Cookies go along with each call.
export const client = createHubClient(fetchTransport({ baseUrl: '/admin', credentials: 'same-origin' }));

const me = await client.me(); // who is signed in, and what their role may do
console.log(me.role, me.can['reports.read']);`,
        },
        {
          lang: 'ts',
          file: 'ModeratorPage.tsx',
          copyLabel: 'Copy the drop-in hub',
          code: `import '@chatwarden/hub-react/styles.css';
import { Hub } from '@chatwarden/hub-react';
import { client } from './client';

export const ModeratorPage = () => <Hub client={client} />;`,
        },
      ],
    },
    {
      id: 'page',
      label: 'Any page',
      snippets: [
        {
          lang: 'text',
          file: 'moderator.html',
          copyLabel: 'Copy the one-script-tag hub',
          code: `<script type="module" src="https://cdn.jsdelivr.net/npm/@chatwarden/hub-element@0.1/dist/hub-element.js"></script>
<chatwarden-hub base-url="/admin"></chatwarden-hub>`,
        },
      ],
    },
  ],
};

/** Step 5, optional: a link, no code. */
export const PLAYER_STEP = {
  title: 'Show players what happened',
  body: "Add the report dialog, notices and the player's record from @chatwarden/player-react.",
  optional: true,
  link: { label: '@chatwarden/player-react', href: PLAYER_REACT_URL },
} as const;

export const OPEN_SOURCE = {
  title: 'Free and open source',
  body: 'Apache-2.0, with no paid tier and nothing hosted. It runs on your server and keeps its data in your database file. Chatwarden is pre-release (version 0.1): ready to try, with no support promise yet. Issues and pull requests are welcome.',
  small: 'Published to npm with provenance.',
} as const;

export interface FaqItem {
  id: string;
  q: string;
  a: string;
  links?: { label: string; href: string }[];
}

export const FAQ: FaqItem[] = [
  {
    id: 'chat',
    q: 'Does Chatwarden give my game a chat?',
    a: 'No. It moderates the chat you already have. Your server still sends the messages; it asks Chatwarden first.',
  },
  {
    id: 'server',
    q: 'Will it work with my game server?',
    a: "If your server runs Node 22.13 or newer, yes, with any framework: the check is one function call. The moderator routes come with an Express adapter, and any other framework can use createRouter, which turns the routes into one plain request-to-response function. If your server is written in another language, there's no ready-made bridge yet.",
  },
  {
    id: 'words',
    q: 'Which words does it block?',
    links: [{ label: '@chatwarden/profanity', href: PROFANITY_URL }],
    a: "Slurs from a word list you provide. There's no shared list yet, so you bring your own, and moderators can edit it from the hub while the game runs. Ordinary swearing uses the optional @chatwarden/profanity package, with a built-in English list that you can allow, star or block. Words with spaces between the letters are not caught, on purpose, because that would block innocent messages. Players can report those.",
  },
  {
    id: 'signin',
    q: 'How do my moderators sign in?',
    a: 'With the login you already have. You write one function that reads the request and says who the moderator is and their role. Chatwarden never sees a password.',
  },
  {
    id: 'data',
    q: 'Where is player data stored?',
    a: 'In a SQLite file on your server. Player IDs and IP addresses are hashed with a secret only you hold. Chatwarden runs no servers and collects nothing, and this site has no analytics.',
  },
  {
    id: 'cost',
    q: 'What does it cost?',
    a: "Nothing. It's open source under Apache-2.0, with no paid tier.",
  },
  {
    id: 'ai',
    q: 'Does it use AI?',
    a: "No. Optional AI help that reads reports and suggests a decision is planned. It isn't built yet.",
  },
  {
    id: 'discord',
    q: 'Can reports go to Discord?',
    a: 'Yes. Each reported player gets a thread in a Discord forum, with a link back to the hub.',
  },
  {
    id: 'child-safety',
    q: 'Is it a child-safety tool?',
    a: 'No. For detecting and reporting child sexual abuse material, use Coop and HMA.',
    links: [
      { label: 'Coop', href: 'https://github.com/roostorg/coop' },
      {
        label: 'HMA',
        href: 'https://github.com/facebook/ThreatExchange/tree/main/hasher-matcher-actioner',
      },
    ],
  },
];
