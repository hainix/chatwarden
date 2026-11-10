# @chatwarden/hub-react

The moderator hub for Chatwarden, the open-source chat moderation kit for games: a React UI over the kit's staff HTTP API, built
as a workbench for a team of moderators. The queue of open cases is always at the left, the case or screen in the middle; a
moderator takes the next case, sees who else is on what, reads a report and decides it, and (as the later screens land) sanctions
people, edits blocked terms and reads the audit trail. It talks to the API through a small injected transport, so the
same hub runs against a real server (`fetch`) or against the real staff routes running in the page (a demo).

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/hub-react @chatwarden/core @chatwarden/http react react-dom
```

`react` and `react-dom` (18.3 or 19) are peer dependencies, so your app has one copy of React. The hub uses only APIs that exist in
18.3 (`useSyncExternalStore`, `useId`), but it is tested only on React 19 so far. `@chatwarden/core` and
`@chatwarden/http` are peers too: the hub imports types from both and one value from core (`LADDER_TABLE`, so the decision menu
and the suggestion cannot drift apart), and its own type declarations name them. Node 22.13 or newer
for the tooling; the hub itself runs in a browser and imports no `node:` module.

## Quick start

On the server you already mount the kit's staff routes (see `@chatwarden/http`). In the page, create a client once and render the hub.

```ts
import { createHubClient, fetchTransport } from '@chatwarden/hub-react';

// The staff routes are mounted at /admin on this origin. Cookies go along with each call.
export const client = createHubClient(fetchTransport({ baseUrl: '/admin', credentials: 'same-origin' }));

const me = await client.me(); // who is signed in, and what their role may do
console.log(me.role, me.can['reports.read']);
```

```tsx
import '@chatwarden/hub-react/styles.css';
import { Hub } from '@chatwarden/hub-react';
import { client } from './client';

export function ModeratorPage() {
  return <Hub client={client} />;
}
```

The hub asks `GET /me` first and shows only what the signed-in role can use. A signed-out visitor (401) or a signed-in account
with no access (403) gets a plain full-page message instead.

### Run the real routes in the page

For a demo, or a tool that talks to the kit directly, `routerTransport` calls the staff routes in the same process, with no
network. The hub cannot tell the difference.

```ts
import { createChatwarden, type RawWho } from '@chatwarden/core';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';
import { createHubClient, routerTransport } from '@chatwarden/hub-react';
import { createMemoryStore } from '@chatwarden/store-memory';

const cw = await createChatwarden({
  store: createMemoryStore(),
  secret: 'demo-secret-0000-not-for-production',
  platform: { identify: (ctx) => ctx as RawWho },
});
const handle = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'owner' }) }));

export const client = createHubClient(routerTransport(handle));
```

## Options

### `<Hub>` props

| Prop | Type | What it does |
| --- | --- | --- |
| `client` | `HubClient` | Required. Create it once, outside render. A new client reloads `GET /me`. |
| `t` | `HubT` | The words. Default: the English catalog in `locale`. See "Words and languages". |
| `locale` | `string` | BCP 47 tag for dates, numbers and plural rules. Default `en`. |
| `router` | `HubRouter` | Where the hub is and how it moves. Default: the URL hash (`#/reports`). See "Routing". |
| `theme` | `'light' \| 'dark' \| 'auto'` | Forces a colour scheme. `auto` (default) follows `prefers-color-scheme`. |
| `onNavigate` | `(route, path) => void` | Called when the hub first shows and each time the route changes. |
| `now` | `() => number` | The clock for "5 minutes ago". Default `Date.now`. Tests pass their own. |
| `className` | `string` | Extra class names for the root element, handy for theming. |
| `gameName` | `string` | Your game's name, shown beside the product name in the top bar. Default: none. |
| `shortcuts` | `boolean` | Set `false` to turn every keyboard shortcut off (J, K, N, ?, Ctrl or Cmd+K, Escape), for a page that has its own. Default `true`. |

### Screens

| Route | Screen | Needs |
| --- | --- | --- |
| `#/` | Overview, the team view: people waiting, open reports, the longest wait, unclaimed cases, who is on and what each is holding, recent actions | any signed-in role (panels follow `reports.read` and `history.read`) |
| `#/reports`, `#/reports?status=actioned` | Reports: every report, grouped by reported person, filtered by status (the queue pane beside it is always the open cases) | `reports.read` |
| `#/reports/:id` | Report: who is in it, their last 90 days, the saved chat (the reported line marked, blocked lines struck through, a filter to one person) and the decision panel | `reports.read`; deciding needs `reports.decide`, actions need `sanctions.apply` |
| `#/people/:ref`, `#/terms`, `#/blocked`, `#/gaps`, `#/audit`, `#/guide` | Routes and tabs exist; the screens arrive in later releases and show a short "not available yet" page until then | the permission of the tab |

The tabs a role cannot use are not shown: Audit appears for a senior and above, and every tab follows the permission table the
server reports in `GET /me` (so a `permissions` override on the server is respected).

### The workbench

Three panes from 1200px wide: the queue (left), the case or screen (middle), and, beside an open case, a panel saying who is
handling it and who else is looking. Two panes from 820px (the panel moves under the case); narrower, everything stacks and the page
scrolls as one, with no horizontal scroll down to 360px. A slim rail of sections sits at the far left, and a top bar holds the
product, your game's name, whether the queue is live, the command bar and who is on. The hub fills `--cw-hub-height` (the viewport
by default; set it to fit under your own header). Everything async is quiet: skeletons while loading (no spinners), a toast for news,
a banner when the connection is lost.

**Claims are soft locks.** Opening a case claims it if nobody holds it (`POST /cases/:ref/claim`), and while it stays open and the
tab is visible the hub renews the claim every 60 seconds and a "viewing" hint every 20. The server releases a claim after 10 minutes
without a renewal. A case someone else holds opens to read, with a notice; the server refuses a decision on it unless a senior
takes it over; a decision sent anyway is refused (409 `claimed`) and the panel says who holds it and keeps what you entered. Each queue row shows who handles it (you in blue, others by name, or Unclaimed) and who is viewing; your own row has
a Release button (the toast offers Undo). "Take next case" (N) claims the oldest unclaimed case that matches the category filter and
opens it. The hub does not yet release a case when you navigate away from it: the claim lapses on its own.

**The queue stays still.** The queue is read once, then the hub asks `GET /changes` every 5 seconds while the tab is visible and every
30 while it is hidden, never while the browser is offline, and reads the queue again only when the token changed. New cases wait behind
an "N new cases" pill; a claim arrives in place; a case that closes while the pointer or keyboard focus is in the list (or while it is
the open case) stays in its place, marked "No longer open", until you move away. After two failed polls in a row a banner says the
connection is lost (and polling slows to every 15 seconds); a toast says "Back online." when it recovers. A 401 or 403 is not a lost connection: the
hub stops asking, says "You are signed out" (or "Your role cannot do this") in the banner, and offers Try again. A 429 waits its
`retry-after`. A minute tick (while visible) redraws waits, the 24-hour overdue flip and lapsed claims, which move no token. Viewing and claim lapses
move no change token, so a row's viewers refresh whenever the queue does and your own open case's viewers refresh every 20 seconds.

**Keyboard.** Shortcuts never fire while you are typing in a field, a select or an editable region, or with Ctrl, Cmd or Alt held
(except Ctrl or Cmd+K), and `shortcuts={false}` turns them all off.

| Key | What it does |
| --- | --- |
| `J` / `K` | Move focus to the next or previous case in the queue. It moves; it does not open or claim. Enter opens the one you are on. |
| `N` | Take the next case. A held key takes one. |
| `Ctrl+K` (`⌘K` on a Mac) | Open the command bar: jump to a person or report in the queue, a term, a screen, or run Take next. |
| `?` | List the shortcuts. |
| `Esc` | Close the window that is open; otherwise go back to the queue. |

**Toasts and Undo.** Toasts pause while the pointer or focus is on them. `useToasts()` (exported) gives `push`, `dismiss` and `hold`:
`hold({ text, run, onUndo })` waits 5 seconds with an Undo button and a progress bar, then runs `run` once; Undo cancels it, and it
runs at once if the toast is dismissed early or the page is closing. Releasing a claim uses `push` with an action; decisions will
use `hold`.

**Limits.** "On now" lists the people who hold or are viewing a case, and you: the kit has no presence route, so someone signed in and idle is
not shown. Recent actions is read again whenever the queue is read because the change token moved.

### The report page and the decision

The decision panel sends one call, `POST /reports/:id/decide`. It offers the ladder's suggestion (and asks the server again when the
conduct level changes), the verdict (Fair, Not a problem, Bad faith), any number of actions up to 20, each with a person, what
happens (the ladder table's presets, a note, or a kind and length), the Community Rule it is under (or "No rule covers this" with a
note) and up to five of that person's own lines to show them, and a reason. It refuses what the server would refuse before sending:
no action on the reported person unless the report is fair, bad-faith evidence of 1 to 500 characters, a gap note for an uncovered
rule, at most five lines that are the person's own, one action of a kind per person, no permanent length without
`sanctions.apply.ban_permanent`. The role's `can` map decides what is offered, never the role name.

There is no idempotency key to send: the server recognises a repeated decision by its content and answers `replay: true`, which the
panel shows as a success. A `409 already_decided` reloads the report and says someone else decided it. A network failure keeps
everything typed and offers "Try again", which sends the same body. The panel's results are announced in a polite live region.

### `HubClient`

`createHubClient(transport)` returns one method per staff route. Each resolves with the parsed answer or rejects with a `HubError`
(`status`, `code`, `message`, `retryAfter`; for a 409 `claimed`, also `heldBy` and `heldUntil`). Codes are the kit's (`forbidden`, `not_found`, `already_decided`, ...), plus `network`
(no answer), `bad_response` and `unexpected`.

| Method | Route |
| --- | --- |
| `me()` | `GET /me` |
| `listReports({ status?, cursor?, limit? })` | `GET /reports` |
| `getReport(id, { level? })` | `GET /reports/:id` |
| `suggest(id, { level, rule?, person? })` | `POST /reports/:id/suggest` |
| `decide(id, { verdict, reason, actions, evidence?, takeOver? })` | `POST /reports/:id/decide` |
| `personHistory(ref, { limit? })` | `GET /people/:ref/history` |
| `listSanctions({ cursor?, limit?, source? })` | `GET /sanctions` |
| `applySanction({ subject, kind, durationMs, rule, ... })` | `POST /sanctions` |
| `revokeSanction(groupId, reason)` | `POST /sanctions/:groupId/revoke` |
| `listGaps()` | `GET /gaps` |
| `closeGap(groupId, { status, ref? })` | `POST /gaps/:groupId/close` |
| `listTerms()` | `GET /terms` |
| `checkTerm({ term, language })` | `POST /terms/check` |
| `testText(text)` | `POST /terms/test` |
| `addTerm(input)`, `updateTerm(id, patch)`, `setTermActive(id, active)` | `POST /terms`, `PATCH /terms/:id`, `POST /terms/:id/active` |
| `addException(input)`, `updateException(id, patch)`, `setExceptionActive(id, active)` | `POST /exceptions`, `PATCH /exceptions/:id`, `POST /exceptions/:id/active` |
| `listBlocked({ days? })` | `GET /blocked` |
| `policy({ format? })` | `GET /policy` |
| `listAudit({ cursor?, limit?, actor?, action? })` | `GET /audit` |
| `changes(since?)` | `GET /changes` |
| `claimCase(person, { takeOver? })` | `POST /cases/:ref/claim` |
| `releaseCase(person)` | `POST /cases/:ref/release` |
| `takeNext({ category? })` | `POST /cases/next` |
| `viewing(person)` | `POST /cases/:ref/viewing` |
| `listReasons()`, `addReason(input)`, `updateReason(id, patch)`, `setReasonActive(id, active)` | `GET /reasons`, `POST /reasons`, `PATCH /reasons/:id`, `POST /reasons/:id/active` |

`fetchAll(loadPage, { maxPages? })` follows `next` for you and joins the pages.

### Transports

A transport is `(request) => Promise<{ status, headers, body }>`. It resolves for any HTTP status and rejects only when no answer
arrived.

- `fetchTransport({ baseUrl, headers?, credentials?, fetch? })`: `fetch` against the routes your server mounts.
- `routerTransport(handle, { headers? })`: calls `createRouter(adminRoutes(...))` in the same process.

### Routing

The default router uses the URL hash, so the hub drops into any page without touching your routes. To use your own router, pass
`{ path, navigate, href? }`: `path` is the current hub path (`/reports/abc`, no `#`), `navigate` moves there, and `href` gives a link its
address (default `#` plus the path). Render the hub again when the path changes, or add `subscribe(listener)` and the hub follows
by itself. `memoryRouter(initial)` keeps the path in memory, for tests and demos. `parseRoute` and `buildPath` convert between a
path and a route.

### Words and languages

Every word the hub shows is a key in the English catalog (`en`), named `hub.<area>.<thing>`. Plural forms add the plural category
last (`hub.reports.row.reports.one`, `.other`) and are chosen by `Intl.PluralRules` for the `locale`. To translate, spread English
under your text so a gap falls back to English instead of showing a key:

```ts
import { createT, en } from '@chatwarden/hub-react';

const de = { 'hub.nav.reports': 'Meldungen', 'hub.nav.overview': 'Übersicht' };
export const t = createT({ ...en, ...de }, 'de');
```

Pass it as `<Hub t={t} locale="de" />`. Times and numbers use `Intl` with the same locale.

## Theming

The hub ships one stylesheet, `@chatwarden/hub-react/styles.css`. Import it once (a bundler, or a `<link>`). Every colour, size,
radius, font and space is a `--cw-*` custom property, with a light and a dark value, and every rule is scoped under `.cw-hub`.

- **Light and dark.** By default the hub follows the visitor's `prefers-color-scheme`. The `theme` prop (or `data-cw-theme="light"`
  or `"dark"` on `.cw-hub` or any ancestor) forces one.
- **Re-theme it.** Set tokens on `.cw-hub`, or on the `className` you pass. The defaults sit at zero specificity (`:where(.cw-hub)`),
  so any rule of yours wins whatever its order.
- **Strict CSP.** The stylesheet is a file. The hub injects no `<style>`, sets no inline `style` and uses no
  `dangerouslySetInnerHTML`.
- **Browsers.** The colours use `light-dark()` (Chrome 123, Firefox 120, Safari 17.5, all 2024), and the line-height unit `lh`.
  Older browsers that lack `light-dark()` get the light colours from a fallback block in the stylesheet, so the hub keeps its
  colours; they follow neither the visitor's dark setting nor the `theme` prop.

```css
.cw-hub.acme {
  --cw-accent: light-dark(#7a2e8a, #d9a3e6);
  --cw-accent-ink: light-dark(#ffffff, #2a0f31);
  --cw-radius-m: 2px;
  --cw-font: 'Acme Sans', system-ui, sans-serif;
}
```

The look is a calm, dense workbench in the style of a professional triage tool. Neutrals carry the screen, and the chrome and
navigation recede. **Colour only where it means something:**

| Colour | It means |
| --- | --- |
| Blue (`--cw-accent`) | You, and your next action: the primary button, a selection, your own claims, the focus ring. |
| Red (`--cw-red`) | Overdue (a wait over 24 hours), the reported line, a ban, a failure. |
| Yellow (`--cw-yellow`) | A warning. |
| Green (`--cw-live`) | The small dot that says the queue is live. Nothing else. |
| Everything else | Neutral. No colour per category, per speaker or per person. |

The one signature detail is the referee card, shown wherever a sanction is: a yellow card for a warning, half yellow and half red
for a restriction, red for a ban, and a dashed outline for a note. The words always say the same as the colour, so colour is never
the only signal. Every text token is at least 4.5:1 against every surface it is drawn on, in both themes; a test computes it from the
values below, and another keeps the colour tokens to exactly this list.

The tokens:

| Token | Default (light, dark) | Used for |
| --- | --- | --- |
| `--cw-bg` | `#f4f5f8`, `#0e131c` | The page behind every pane. |
| `--cw-surface` | `#ffffff`, `#151c28` | Panels, the queue, the top bar, buttons. |
| `--cw-surface-sunken` | `#eef0f4`, `#111722` | Hover fill, wells, the filter tray. |
| `--cw-border` | `#e0e3ea`, `#242d3c` | Hairlines between rows and around panels. |
| `--cw-border-strong` | `#7a8397`, `#6b7893` | The border of a field, a select or a checkbox (3:1 against the surface). |
| `--cw-ink` | `#151b27`, `#e8ebf1` | Body text. |
| `--cw-ink-muted` | `#4f5a6e`, `#9ba4b6` | Secondary text, labels. |
| `--cw-ink-faint` | `#5b657a`, `#8f98ad` | Tags, times, the rail labels (still 4.5:1 on every surface). |
| `--cw-accent` | `#2950d3`, `#7d9bff` | You and your next action: the primary button, a selection, your claims, the focus ring. |
| `--cw-accent-ink` | `#ffffff`, `#0e131c` | Text on an accent background. |
| `--cw-accent-soft` | `#e7ecfb`, `#1d2847` | The open case in the queue, a selected card. |
| `--cw-red` | `#c42f3b`, `#ff6b74` | Overdue (a wait over 24 hours), the reported line, a ban, a failure. |
| `--cw-red-soft` | `#fbe4e6`, `#3a1a1f` | The background of a reported line or an error. |
| `--cw-yellow` | `#e5ad00`, `#f2c84b` | A warning: the yellow referee card, the connection banner. |
| `--cw-yellow-soft` | `#fdf3d3`, `#33290d` | The background of a warning. |
| `--cw-yellow-ink` | `#6b4a00`, `#f2d37a` | Text on a warning background. |
| `--cw-live` | `#17804f`, `#4cc38a` | The small dot that says the queue is live. Nothing else is green. |
| `--cw-shadow-ink` | `#151b27`, `#000000` | What every shadow and the dimmed backdrop are made from. |
| `--cw-font` | `'Instrument Sans', ui-sans-serif, system-ui, -apple-syste...` | Text font stack. Instrument Sans first, so it applies once `font.css` is loaded; then the system UI font. |
| `--cw-font-mono` | `ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, 'Libe...` | Times in a transcript. |
| `--cw-text-s` | `0.78125rem` | Small text: labels, facts, tags. |
| `--cw-text-m` | `0.875rem` | Body text. |
| `--cw-text-l` | `1.0625rem` | Screen titles. |
| `--cw-text-xl` | `1.25rem` | The title on a gate screen. |
| `--cw-text-stat` | `2rem` | The big numbers on the Overview. |
| `--cw-weight-medium` | `500` | Labels. |
| `--cw-weight-strong` | `600` | Headings, names, buttons. |
| `--cw-leading` | `1.45` | Body line height. |
| `--cw-leading-tight` | `1.2` | Heading line height. |
| `--cw-radius-s` | `6px` | Buttons, tags, fields. |
| `--cw-radius-m` | `10px` | Panels and windows. |
| `--cw-border-width` | `1px` | Every border. |
| `--cw-wait-width` | `4px` | The left edge of a case, a reported line and a suggestion. |
| `--cw-space-1` | `0.25rem` | Smallest gap. |
| `--cw-space-2` | `0.5rem` | Small gap. |
| `--cw-space-3` | `0.75rem` | Medium gap. |
| `--cw-space-4` | `1rem` | Standard padding. |
| `--cw-space-5` | `1.5rem` | Large gap. |
| `--cw-space-6` | `2.5rem` | Largest gap (page bottom, gate screens). |
| `--cw-nav-width` | `3.5rem` | Width of the section rail. |
| `--cw-queue-width` | `21rem` | Width of the queue pane. |
| `--cw-context-width` | `17rem` | Width of the case panel beside an open case. |
| `--cw-hub-height` | `100dvh` | The height the hub fills (a phone-width page grows past it). Set it to fit below your own header. |
| `--cw-control-height` | `2.25rem` | Minimum height of buttons and filters. |

### The font

The hub uses your system UI font and loads nothing. For the intended look, load the optional `font.css` next to the stylesheet:

```ts
import '@chatwarden/hub-react/styles.css';
import '@chatwarden/hub-react/font.css'; // optional: Instrument Sans, self-hosted
```

It is the latin subset of the variable font (weights 400 to 700, about 30 KB), served from your own origin, never from a third
party. Instrument Sans is licensed under the SIL Open Font License 1.1; the licence text ships as `fonts/OFL.txt`. A strict
Content-Security-Policy needs `font-src 'self'` for it.

## Security notes

- **No identifiers reach the page beyond the staff API's own.** The hub shows a person as the first 8 characters of their opaque
  ref and never the full ref. It shows a reported person's handle (staff only, from the queue) and nothing of a reporter.
- **The full person ref is in the link.** The page shows only the 8 character tag, but a link to a person (`#/people/:ref`) has to
  carry the whole ref, because the server route needs it. It is staff-only, like the queue, but the address bar, the history and the
  paths `onNavigate` receives all hold it, so do not forward those to analytics.
- **The report page shows chat as typed.** The excerpt is for staff: it holds the raw lines (blocked ones included, struck through)
  and the reporter's note. What a player sees is only the lines the moderator chose for them, as the server masks them.
- **Polling.** Each open tab asks `GET /changes` every 5 seconds (30 while hidden). It is one cheap read with no audit row; allow for
  it in any rate limit. Claims and the viewing hint write no audit row (a senior's takeover does); viewing is in memory on the
  server process, so behind several processes a moderator sees only the viewers that reached the same one.
- **The queue shows staff names.** Who holds or views a case is a staff actor from your `authorize` hook (an email shows as the part
  before the `@`). It is shown to staff only; players never see it.
- **Opening a report is an audited read.** The Overview and the queue are built from the queue list alone and never open a single
  report, so no `report.view` row names a report just because someone looked at the Overview.
- **Authorization stays on the server.** The hub hides what the role cannot use, but the server still refuses it (403). Mount the
  staff routes behind your own login (`authorize` in `@chatwarden/http`). A 401 or 403 from `GET /me` shows a plain message.
- **No caching of staff answers.** The kit sends `cache-control: no-store` on every staff response; keep that through your proxy.
- **Content-Security-Policy.** Nothing is injected at run time. Allow the stylesheet file and, if the hub calls another origin,
  that origin in `connect-src`.
- **Server text is not echoed.** Error messages come from the hub's own catalog, not from the response body.

## Links

- [Apache-2.0 license](https://github.com/hainix/chatwarden/blob/main/LICENSE)
- [Staff API routes](https://github.com/hainix/chatwarden/tree/main/packages/http#the-routes)
- [Source and other packages](https://github.com/hainix/chatwarden)
- [Issues](https://github.com/hainix/chatwarden/issues)
