# @chatwarden/hub-react

The moderator hub for Chatwarden, the open-source chat moderation kit for games: a React UI over the kit's staff HTTP API. A
moderator sees the report queue grouped by person, what was done lately, and (as the later screens land) decides reports,
sanctions people, edits blocked terms and reads the audit trail. It talks to the API through a small injected transport, so the
same hub runs against a real server (`fetch`) or against the real staff routes running in the page (a demo).

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/hub-react @chatwarden/core @chatwarden/http react react-dom
```

`react` and `react-dom` (18.3 or 19) are peer dependencies, so your app has one copy of React. The hub uses only APIs that exist in
18.3 (`useSyncExternalStore`, `useId`), but it is tested only on React 19 so far. `@chatwarden/core` and
`@chatwarden/http` are peers too: the hub imports only their types, but its own type declarations name them. Node 22.13 or newer
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

### Screens

| Route | Screen | Needs |
| --- | --- | --- |
| `#/` | Overview: people waiting, open reports, longest wait, the people who need review, recent actions | any signed-in role (panels follow `reports.read` and `history.read`) |
| `#/reports`, `#/reports?status=actioned` | Reports: the queue grouped by reported person, filtered by status | `reports.read` |
| `#/reports/:id`, `#/people/:ref`, `#/terms`, `#/blocked`, `#/gaps`, `#/audit`, `#/guide` | Routes and tabs exist; the screens arrive in later releases and show a short "not available yet" page until then | the permission of the tab |

The tabs a role cannot use are not shown: Audit appears for a senior and above, and every tab follows the permission table the
server reports in `GET /me` (so a `permissions` override on the server is respected).

### `HubClient`

`createHubClient(transport)` returns one method per staff route. Each resolves with the parsed answer or rejects with a `HubError`
(`status`, `code`, `message`, `retryAfter`). Codes are the kit's (`forbidden`, `not_found`, `already_decided`, ...), plus `network`
(no answer), `bad_response` and `unexpected`.

| Method | Route |
| --- | --- |
| `me()` | `GET /me` |
| `listReports({ status?, cursor?, limit? })` | `GET /reports` |
| `getReport(id, { level? })` | `GET /reports/:id` |
| `suggest(id, { level, rule?, person? })` | `POST /reports/:id/suggest` |
| `decide(id, { verdict, reason, actions, evidence? })` | `POST /reports/:id/decide` |
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

The look is a calm, dense console: cool neutrals, one accent, and the signal colours kept for what needs a decision. A queue row
carries a coloured rail on its left edge that follows how long the oldest open report has waited (green under an hour, amber under
a day, red after), and the words beside it say the same, so colour is never the only signal.

The tokens:

| Token | Default (light, dark) | Used for |
| --- | --- | --- |
| `--cw-bg` | `#eef1f4`, `#10161b` | Page background behind everything. |
| `--cw-surface` | `#ffffff`, `#182028` | Panels, rows, buttons. |
| `--cw-surface-sunken` | `#f4f6f8`, `#1e2832` | Hover fill, code and tag chips. |
| `--cw-border` | `#d5dce3`, `#2b3743` | Hairlines between rows and around panels. |
| `--cw-border-strong` | `#a9b6c2`, `#435464` | Control borders and the default queue rail. |
| `--cw-ink` | `#17212b`, `#e7edf2` | Body text. |
| `--cw-ink-muted` | `#4a5866`, `#a6b4c1` | Secondary text, labels. |
| `--cw-accent` | `#115e67`, `#6cc3cc` | Primary buttons, links, the current tab. |
| `--cw-accent-ink` | `#ffffff`, `#07262a` | Text on an accent background. |
| `--cw-accent-soft` | `#dbeced`, `#183840` | Selected filter, accent tags. |
| `--cw-focus` | `#1a5fd1`, `#8ab4ff` | The focus ring. |
| `--cw-ok` | `#1c7a45`, `#5ec98a` | Solid green: a fresh wait rail. |
| `--cw-ok-soft` | `#dcf1e3`, `#173826` | Green tag background. |
| `--cw-ok-ink` | `#14502c`, `#a6e8c0` | Text on the green background. |
| `--cw-warn` | `#b86e00`, `#e8a93a` | Solid amber: an aging wait rail. |
| `--cw-warn-soft` | `#fbeccc`, `#3a2c10` | Amber tag background. |
| `--cw-warn-ink` | `#6b4300`, `#f2cd85` | Text on the amber background. |
| `--cw-bad` | `#b3261e`, `#f0766d` | Solid red: a stale wait rail, danger borders. |
| `--cw-bad-soft` | `#fbe0dd`, `#40201d` | Red tag and error background. |
| `--cw-bad-ink` | `#8c1b15`, `#ffbab4` | Text on the red background. |
| `--cw-idle-soft` | `#e6eaee`, `#26313c` | Neutral tag background. |
| `--cw-idle-ink` | `#3b4753`, `#c6d1db` | Text on the neutral background. |
| `--cw-font` | `ui-sans-serif, system-ui, -apple-system, 'Segoe UI Variab...` | Text font stack. |
| `--cw-font-mono` | `ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, 'Libe...` | Person tags. |
| `--cw-text-s` | `0.8125rem` | Small text: labels, facts, tags. |
| `--cw-text-m` | `0.9375rem` | Body text. |
| `--cw-text-l` | `1.125rem` | Screen titles. |
| `--cw-text-xl` | `1.5rem` | The hub title. |
| `--cw-text-stat` | `2.25rem` | The big numbers on the Overview. |
| `--cw-weight-medium` | `500` | Buttons, tabs, labels. |
| `--cw-weight-strong` | `650` | Headings, names, the current tab. |
| `--cw-leading` | `1.5` | Body line height. |
| `--cw-leading-tight` | `1.2` | Heading line height. |
| `--cw-radius-s` | `4px` | Buttons, tags, inputs. |
| `--cw-radius-m` | `8px` | Panels and cards. |
| `--cw-border-width` | `1px` | Every border. |
| `--cw-rail-width` | `5px` | Width of the wait rail on a queue row. |
| `--cw-space-1` | `0.25rem` | Smallest gap. |
| `--cw-space-2` | `0.5rem` | Small gap. |
| `--cw-space-3` | `0.75rem` | Medium gap. |
| `--cw-space-4` | `1rem` | Standard padding. |
| `--cw-space-5` | `1.5rem` | Large gap. |
| `--cw-space-6` | `2.5rem` | Largest gap (page bottom, gate screens). |
| `--cw-max-width` | `72rem` | Widest the content grows. |
| `--cw-control-height` | `2.25rem` | Minimum height of buttons and filters. |

The signal colours come in three: the solid one for rails and borders, the soft one for backgrounds, and the ink for text on that
background. Keep the ink and soft pair at a readable contrast when you change them.

## Security notes

- **No identifiers reach the page beyond the staff API's own.** The hub shows a person as the first 8 characters of their opaque
  ref and never the full ref. It shows a reported person's handle (staff only, from the queue) and nothing of a reporter.
- **The full person ref is in the link.** The page shows only the 8 character tag, but a link to a person (`#/people/:ref`) has to
  carry the whole ref, because the server route needs it. It is staff-only, like the queue, but the address bar, the history and the
  paths `onNavigate` receives all hold it, so do not forward those to analytics.
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
