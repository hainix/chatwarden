# chatwarden.dev: design direction

**Arena at night, warden on duty.** A dark game-arena backdrop (faint grid, two colour glows) with chunky arcade controls,
and one calm teal "warden" that does the protecting. It should read as a game studio's site and still be credible to an engineer.

The one memorable thing is the hero chat HUD: lines arrive, and when an invented slur is sent it is struck through and a
**REFUSED!** stamp slams onto it. Everything else stays quiet and disciplined so that moment lands.

## Palette tokens (CSS variables in `src/styles.css`)

| Token | Dark | Light | Job |
| --- | --- | --- | --- |
| `--bg` | `#0a0d1a` | `#f6f4ff` | page |
| `--panel` / `--panel-hi` | `#141a31` / `#1b2342` | `#ffffff` / `#f1eeff` | cards, hover |
| `--edge` | `#2c376a` | `#1d1a42` | chunky 2px borders and hard shadows |
| `--text` / `--muted` | `#eef1ff` / `#aab4dc` | `#17133a` / `#4a4676` | copy |
| `--accent` | `#ff3d8f` hot magenta | `#d10f6c` | the one hot colour: primary button, the stamp, limits |
| `--warden` | `#35e3c5` teal | `#12a58e` (text `#0a6b5d`) | the signature colour: logo, icons, "available", focus-adjacent |
| `--gold` | `#ffc83d` | `#8a5a00` | step numbers, "coming soon" pills |

"Screens" (the hero HUD, code blocks, the install pill and the demo panes) stay dark in both themes, like a terminal on a
desk. Syntax colours: keyword `#ff80b9`, string `#6ff0d6`, comment `#8c97c6`, number `#ffd479`, call `#94b8ff`.
Contrast is AA or better for text on every surface (button text is the dark ink on magenta in dark mode, white on the deeper
magenta in light mode). Dark is the default; `prefers-color-scheme: light` is honoured on a first visit, and the toggle
stores the choice in `localStorage` (guarded, the page works without it).

## Type

- Display: **Bungee** (SIL OFL), self-hosted, Latin subset, 14 KB woff2. Used only for h1, h2, the logo wordmark, step
  numbers, the HUD title and the stamp. It is wide and chunky, so it is kept to short lines.
- Body: **Atkinson Hyperlegible Next** (SIL OFL), self-hosted variable woff2, Latin subset, 34 KB. Chosen for legibility.
- Code: the system monospace stack. No download.

Scale: hero `clamp(2.35rem, 1.1rem + 5.2vw, 4.6rem)`, h2 `clamp(1.7rem, 1.1rem + 2.6vw, 2.7rem)`, h3 `1.1875rem`
(bold body face), body `1.0625rem` / 1.6, small `0.9375rem`. Body lines are capped near 34 to 44em. Headings are
sentence-case content set in a display face, never tracked-out caps labels above a heading.

Licences for both fonts sit in `public/fonts/OFL-*.txt`.

## Shape and structure

- Chunky 2px borders, 6px radius (10px for big "screens"), hard offset shadows instead of soft blur: arcade-panel feel.
- HUD corner ticks on cards (teal L-brackets) that grow on hover.
- Dashed borders mean "not here yet" (coming-soon pills, AI levels 1 to 4, the demo slot). Solid teal means live.
- Numbers appear only where the content is a sequence: the three steps and AI levels 0 to 4.
- Alignment: left-aligned throughout, one 1120px column, alternating plain and tinted bands for rhythm.

## Motion

- One orchestrated moment on load: hero chat lines pop in, the refused line shakes, strikes through and gets the stamp.
  "Replay" restarts it.
- Motion that answers a person: buttons press down (hard shadow collapses), cards lift, copy buttons confirm, FAQ chevrons turn.
- No scroll-triggered entrance effects.
- `prefers-reduced-motion: reduce` turns every animation and transition off. Every animated element's base style is its
  final state, so the page is complete without motion.

## Logo

An SVG wordmark: a teal shield (the warden) holding a dark chat bubble with a magenta tick, then "chatwarden" set in
Bungee (`src/components/Logo.tsx`; the same mark is `public/favicon.svg`). The glyph and wordmark use the theme tokens
so they work on both backgrounds.

## Performance and accessibility rules this design keeps

- No third-party script, font, analytics or tracker; every asset is same-origin. `test/dist.test.ts` scans the build.
- Fonts are bundled from `src/assets/fonts/` so Vite hashes them (`/assets/bungee-<hash>.woff2`) and the `_headers` file can
  cache them as immutable. Both use `font-display: swap`; the display face is preloaded from `index.html`. Initial JS is about
  80 KB gzip, initial CSS about 6 KB, and the lazy demo chunk adds about 15 KB JS and 5 KB CSS.
- The page runs under a strict CSP (`public/_headers`): `default-src 'self'`, no inline script (the theme bootstrap is
  `public/theme-init.js`), no inline style. React sets custom properties through the CSSOM, which the policy allows.
- Semantic landmarks, a skip link, one h1, labelled sections, visible 3px focus rings, 44px touch targets, native
  `<details>` for the FAQ, focusable scrollable code blocks, copy results announced in a polite live region.
- Works at 360px: single column, no horizontal scroll, the stamp moves to the bubble's bottom edge so the line stays readable.

## Polish and delight (Task 4)

- Every delight is cheap, optional and reduced-motion safe (the base style is always the finished look):
  - the hero grid lights up teal under a mouse (`--mx` / `--my` on `.hero`, set only for mouse and pen, never under
    reduced motion, eased by a registered `@property`);
  - feature cards: the icon tile pops on hover ("level up");
  - the AI-levels HUD meter (four unlit pips for levels 1 to 4) runs one pip scan when it scrolls into view (`useSeen`); it states only what is true,
    "AI levels shipped: 0 of 4";
  - the konami code (up up down down left right left right B A) turns the warden gold and says so in a polite live region;
    typing it again turns it back (`GoldWarden`, `data-gold` on `<html>`). It ignores form fields.
- Nothing fakes data: no counters, no activity feeds.
- Steps layout: under 1280px the words sit above each code block so the block gets the whole column; from 1280px they sit beside
  it and the code column is pulled out to the right by up to 72px (a clamp() that shrinks on narrower screens) (the left edge stays on the page grid), and the code is 12.5px, so
  the README lines (kept verbatim) are not clipped. `test/browser.test.ts` measures this at 1024 to 1920.
- Never reuse a bare class name across the two stylesheets: the demo's lazy CSS styles `.badge` as a count chip, which once
  restyled the open-source pills (they are `.open-badge` now).
- Gold on a dark screen or under dark ink is `--gold-bright` in both themes; `--gold` is the darker text gold in light.

## Meta, SEO and deploy

- `index.html` carries title, description, canonical, Open Graph and Twitter tags. The OG image (`public/og.png`, 1200x630) is
  rendered from `scripts/og.svg` by `scripts/assets.mjs` with `@resvg/resvg-js`, using the two self-hosted fonts (unpacked from
  woff2 with `wawoff2`, since resvg reads TTF only). The same script makes `favicon-32.png` and `apple-touch-icon.png` from
  `public/favicon.svg`. `npm run build` runs it first; the outputs are committed.
- `robots.txt`, `sitemap.xml`, `llms.txt` (README and npm links, one line each; `test/meta.test.ts` checks every GitHub path
  exists in this repo). No `security.txt`: there is no real contact to put in it.
- See `README.md` for the deploy steps.

## Honesty rules the copy keeps

No customer logos (only the true "Built for Moxgate, now being adopted"; flip it to "Used by Moxgate" once Moxgate is deployed on the kit), no invented numbers, install commands and code come from the READMEs
(`test/content.test.ts`), AI levels 1 to 4 are marked coming soon, the moderator hub card says what ships (the team workbench, Simple
mode, editable steps and reporting, four ways to adopt and `<chatwarden-hub>`), and "free forever, no SLA" is stated plainly. Demo words are the invented
terms from `@chatwarden/matcher/fixtures` only.

## The interactive demo (`src/demo/`, its own chunk)

Two "screens" side by side: the game (a lobby with You, Ada and Bo, a composer, a report button on every other player's line, and a
button per player who has a notice waiting) and the moderator pane, which is the REAL hub (`@chatwarden/hub-react`, Simple mode),
drawn in the page theme. The REFUSED! stamp is the hero's, reused. The tour tooltip is a gold quest bubble with progress pips, so it
never reads as part of a screen; it points at the control with a static gold ring (a soft ripple only when motion is allowed).

- The game side talks to the kit through `DemoEngine` (`engine.ts`), shaped like `@chatwarden/core` (`chat.accept`,
  `reports.submit`, `reports.addDetail`, `notices.*`). `kitEngine.ts` binds the REAL kit behind it (core, the in-memory store, the
  matcher with its synthetic pack), one fixed room `lobby` and three seats. Every verdict is the kit's: the matcher refuses, the
  limits are its defaults (3 lines per 5 s, 3 blocked lines an hour earn an automatic 30 minute timeout). There is no demo-side
  judgement any more: the suggestion is the ladder the hub asks the kit for. The kit is in the lazy demo chunk only. `vite.config.ts`
  cuts obscenity's unused English word list out of the bundle (the site ships invented words only).
- The moderator side (`HubPane.tsx`): `<Hub>` over `adminRoutes(cw, ...)` through `routerTransport` and a `memoryRouter`, signed in
  as a made-up owner; hub-react's own stylesheet (not its font file). Its keys answer only while the visitor works in the demo.
- The player side: player-react's `ReportDialog` (the kit's own reporting settings, one tap by default) and `NoticeQueue`, through
  `playerTransport.ts`, a small local transport that answers `GET /notices`, `POST /notices/:id/ack` and `GET /record` from the kit
  for one seat (the kit has no player report route, and the player routes do not run in a browser). The notice opens only when the
  visitor presses "See what Bo sees": it never interrupts the hub.
- The tour has seven steps (report, the case in the queue, open it in Simple, apply the suggestion, the player's notice, then two
  optional: the Detailed switch and Steps and ladder). It points at hub controls by role and accessible name (`hubTarget.ts`).
- "Show me the code" shows lines copied verbatim from the READMEs (`test/demoCode.test.ts` checks every line).
- Layout: side by side from 1152px (the game is the narrow column, the hub gets about 720px); below that one pane at a time, a
  sticky Game / Moderator switcher below the site header, and the tour moves to the pane a step is about. The hub stacks itself under
  820px; from 1200px `demo.css` keeps its case and record stacked inside the pane instead of three panes.
- Scripted players say a line every 4 to 6 seconds; they wait while the tab is hidden, while you type, while the report
  dialog is open and while paused. Nothing is stored: a reload is a fresh lobby.
- Lazy: `DemoSlot` loads the chunk when the section is within 200px of the viewport (or on pointer or focus). It is the heavy chunk now
  (the hub and the player components: about 178 KB JS and 15 KB CSS gzip), so a phone's first screen does not fetch it.
