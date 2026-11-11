# @chatwarden/hub-react

The moderator hub for Chatwarden, the open-source chat moderation kit for games: a React UI over the kit's staff HTTP API, built
as a workbench for a team of moderators. The queue of open cases is always at the left, the case or screen in the middle; a
moderator takes the next case, sees who else is on what, reads a report and decides it, sanctions
people, edits the blocked terms, closes rule gaps and reads the audit trail and the guide. It talks to the API through a small injected transport, so the
same hub runs against a real server (`fetch`) or against the real staff routes running in the page (a demo).

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/hub-react @chatwarden/core @chatwarden/http react react-dom
```

`react` and `react-dom` (18.3 or 19) are peer dependencies, so your app has one copy of React (they are optional only if you import just
`@chatwarden/hub-react/headless`; see "Four ways to adopt"). The hub uses only APIs that exist in
18.3 (`useSyncExternalStore`, `useId`). The unit and interaction tests run on React 19; the consumer smoke test installs React 18.3, type-checks against
`@types/react` 18 and renders the hub and the headless entry on the server, but clicks and focus have not been exercised on 18. `@chatwarden/core` and
`@chatwarden/http` are peers too: the hub imports types from both, and these values from core (constants and defaults, so the hub
and the kit cannot drift apart): `LADDER_TABLE`, `DEFAULT_DURATIONS`, `DEFAULT_AREA_RULES`, `DEFAULT_SEVERE_RULES`, `AUDIT_ACTIONS`,
`MAX_REASON_RULES`, `MAX_REPORT_REASONS`, `OTHER_REASON_ID`, `defaultReporting` and `LEGACY_REASON_ALIASES`. Its own type declarations name
both packages. Node 22.13 or newer
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

## Put it on your server

The hub is a page and the kit's staff API. The simplest way to run it is to **serve the built page and the staff API under one
origin**: the page's calls then go to the same host, cookies and sessions work as they do for the rest of your admin pages, and there is
no CORS to set up.

With Express, mount the staff routes with the adapter from `@chatwarden/http`, then the folder your bundler wrote for the page that renders
`<Hub>`:

```ts
import express from 'express';
import { adminRoutes } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';

// `cw` is your createChatwarden(...) instance; `yourModeratorLogin` is your own sign-in check (see "Signing moderators in").
const app = express();
// The kit's routes read the raw body themselves: mount them before any body parser.
app.use('/admin', toExpress(adminRoutes(cw, { authorize: yourModeratorLogin }), { fallthrough: false }));
app.use('/mod', express.static('dist/mod')); // the built page: an index.html and the script and stylesheet it loads
app.listen(3000);
```

The page itself is a few lines (Vite, webpack or any bundler; the stylesheet is imported once):

```ts
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createHubClient, fetchTransport, Hub } from '@chatwarden/hub-react';
// Import '@chatwarden/hub-react/styles.css' once at the top of your entry file (your bundler handles it).

declare const rootElement: Parameters<typeof createRoot>[0]; // document.getElementById('root') in a page

const client = createHubClient(fetchTransport({ baseUrl: '/admin' }));
createRoot(rootElement).render(createElement(Hub, { client }));
```

Any other server works the same way, because the staff API is plain HTTP (`createRouter(adminRoutes(...))` gives you a function from a
request to a response for any framework; see `@chatwarden/http`): answer `/admin/*` from the router and the built files from `/mod`.
If you have no React build at all, `@chatwarden/hub-element` serves the same hub as one script tag (way 4 below), and the `tiny-chat`
example in this repository does exactly that, behind its own sign-in.

**Another origin** needs three more things: the staff API answers CORS for the page's origin, with credentials; the transport sends
cookies (`credentials: 'include'`); and any header you rely on is allowed. Keep the staff API on the same origin where you can.

## Signing moderators in

The hub has no login screen. Who may use it is decided on the server, by the `authorize` function you give `adminRoutes`: it reads the
request and answers `{ actor, role }` for a signed-in moderator or `null` for nobody (a 401), and the kit checks the role's permissions
on every route (a 403). The hub asks `GET /me` first and shows only what that role can do. Two ways to carry the credential:

- **Cookies.** On the same origin the browser sends the page's cookies with every call (`credentials: 'same-origin'` is the default), so
  whatever signs your moderators in to the rest of your admin pages signs them in here. `authorize` reads the session from `req.headers.cookie`.
- **A header.** `fetchTransport({ baseUrl, headers })` adds the headers to every call: a CSRF token, an API key your proxy checks, or a
  bearer token. The headers are fixed when the transport is made. For a token that rotates, make the headers fresh on each call:

```ts
import { createHubClient, fetchTransport } from '@chatwarden/hub-react';
import type { Transport } from '@chatwarden/hub-react';

declare function currentToken(): string;

// A new fetchTransport per call, so the Authorization header is always the current token.
const rotating: Transport = (req) => fetchTransport({ baseUrl: '/admin', headers: { authorization: `Bearer ${currentToken()}` } })(req);

export const client = createHubClient(rotating);
```

Cookie sign-in needs the usual care for a cookie-authenticated API: set the cookie `SameSite=Strict` or `Lax` (or require a CSRF header
from the transport), and keep staff answers out of shared caches (the kit sends `cache-control: no-store`). `authorize` must not trust
the page: the hub hides what a role cannot use, but only the server refuses it.

## Content Security Policy

The hub needs no `'unsafe-inline'` and no `'unsafe-eval'`. It injects no `<style>`, sets no inline `style` attribute, uses no
`dangerouslySetInnerHTML` and loads no third-party resource. Allow:

- `script-src`: where your bundle is served from (`'self'`).
- `style-src`: where `styles.css` is served from (`'self'`, or a hash if you inline it yourself). Add the origin of `font.css` and its font
  files to `style-src` and `font-src` only if you use the optional self-hosted font.
- `connect-src`: the origin of the staff API (`'self'` when it is under the same origin, as above).

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'
```

(Add `img-src 'self' data:` if your own page needs images.) `@chatwarden/hub-element` has its own notes: its CSS is inside the script and adopted as a constructable stylesheet.

## Four ways to adopt

Start with the first. Each later one is optional and builds on the one above it, so nothing you wrote for an earlier way is thrown away. The fourth is for a page with no React build at all.

### 1. Drop in `<Hub>`

The whole moderator hub, in a few lines. Simple mode by default.

```tsx
import '@chatwarden/hub-react/styles.css';
import { Hub } from '@chatwarden/hub-react';
import { client } from './client';

export const ModeratorPage = () => <Hub client={client} />;
```

### 2. Pieces in your own dashboard

Already have an ops page? Put single parts of the hub in it. `HubProvider` is the one thing every piece needs above it. The pieces need
no router, no shell and no nav, and they never navigate by themselves: you say where a case, a person or a report opens with a callback,
and a piece that is not told shows it as plain text.

```tsx
import '@chatwarden/hub-react/styles.css';
import { useState } from 'react';
import { CaseCard, CaseList, HubProvider, RecentActions } from '@chatwarden/hub-react';
import { client } from './client';

export function Moderation() {
  const [open, setOpen] = useState<string | null>(null); // the report your page is showing
  return (
    <HubProvider client={client}>
      <CaseList selected={open} onOpenCase={(_person, reportId) => setOpen(reportId)} />
      {open !== null && <CaseCard reportId={open} onOpenReport={setOpen} />}
      <RecentActions />
    </HubProvider>
  );
}
```

| Piece | What it is | Needs | Tell it where things open |
| --- | --- | --- | --- |
| `CaseList` | The queue: one row per reported person, who is on it, Take next | `reports.read` | `onOpenCase(person, reportId)`; `selected` marks the open row |
| `CaseCard` | One case as the Simple card: what they said, the suggestion, three buttons | `reports.read` (`reports.decide` to answer) | `onOpenReport(reportId)` for the next report of the same person; also `onOpenCase`, `onOpenPerson` |
| `CaseWorkbench` | One case as the Detailed workbench: tabs, transcript, decision bar, the record beside it | `reports.read` | `onOpenPerson(person)`, `onOpenReport(reportId)`, `onOpenCase` |
| `PersonRecord` | One person: in force now, timeline, Revoke, the sanction and note forms | `history.read` | `onOpenReport`, `onOpenPerson` |
| `TermsManager` | Blocked terms and exceptions, with the dry run | `terms.read` | none |
| `BlockedList` | The lines the filter refused, masked until shown | `blocked.read` | `onOpenPerson`; `onOpenTerms()` shows its two Terms buttons |
| `AuditLog` | Who did what | `audit.read` | `onOpenPerson`, `onOpenReport` |
| `RuleGaps` | Cases no rule covered | `gaps.read` | none |
| `Guide` | The guide the kit generates from your rules | `policy.read` | none |
| `RecentActions` | Everything done to anyone, a page at a time | `history.read` | `onOpenPerson` |
| `LadderSettings` | The steps and ladder, editable, with a preview of each change | `policy.read` (changing needs `policy.write`) | none |
| `ReportingSettings` | How players report, the reasons they can give and the thank-you, editable, with a picture of what players see | `policy.read` (changing needs `policy.write`) | none |

Every piece takes `className` for its root element. A role without the permission sees one plain line ("Your role can't open this.")
and nothing is asked of the server.

`HubProvider` takes exactly one of `client` or `controller`, then `mode`, `t`, `locale`, `now`, `theme` and `shortcuts` (the same as on
`<Hub>`), `className`, and `bare`. (`primary` is `<Hub>`'s alone: a piece answers keys only while focus is inside it.)

- **`client`**: the provider makes the controller (the live queue, claims, the Undo hold and the toasts) and disposes it when it unmounts. A
  new client makes a new controller.
- **`controller`**: yours, from `createHubController` (see "Headless" below). The provider uses it and never disposes it. The pieces
  take their own hold on its queue (the queue runs while any hold is unreleased), so a `controller.start()` of yours keeps it running
  after they unmount; `start()` now returns `{ ok, value | error, release }` and `release()` lets go of yours. What the controller
  starts by itself (the "Open the case" toast after a failed decision, Undo of a case you left) goes to the `host` you gave it; what a
  piece does itself (Take next, decide and next) calls the piece's callback, exactly as with a `client`. With a `client`, the toasts
  open through the pieces' callbacks too (never for a case a piece is already showing).
- **`bare`**: by default the provider draws the `.cw-hub` theme root around its children, so the pieces are styled where they sit. With
  `bare` it draws none, and you place an element with the classes `cw-hub cw-hub--embed` (and `data-cw-theme="dark"` to force a theme).
- Until `GET /me` answers, the provider shows a plain message (loading, signed out, no access, or a failed start with Try again), so a
  piece never renders for someone who is not signed in.

Pieces under one provider share one controller. That is one poll of the change token however many pieces show the queue, and one claim
and one heartbeat per case however many pieces show it. The hub holds one case at a time (the one most recently shown or entered by
focus): with cards for different people on one page, the other cards are shown unclaimed, with no heartbeat, so another moderator can
take them; reading and deciding on them still work, and a decision on a card affects only that card's case. In development the hub
warns once when two different people are shown at once. A card with neither `onOpenCase` nor `onOpenReport` has nowhere to show a next
case, so Ctrl or Cmd+Enter only decides. A page
that shows only `TermsManager` asks the server for no cases. The keys of a piece (1, 2 and Ctrl or Cmd+Enter on a `CaseCard`; 1, 2, 3 and
Ctrl or Cmd+Enter on a `CaseWorkbench`) work only while keyboard focus is inside that piece, so several can share a page.
`shortcuts={false}` turns them off.

### 3. Headless hooks, or the controller

Draw it yourself and keep the behaviour: the Undo hold, claims, heartbeat and the live queue are the hub's own. Under a `HubProvider`
(or a `<Hub>`) these hooks work with no markup. Each answers with a value for what it expects (a 409, a 404, a role without the permission,
a dropped connection), never a throw.

```tsx
import { HubProvider, useCases, useDecide } from '@chatwarden/hub-react';
import { client } from './client';

function Queue() {
  const { cases, status, takeNext } = useCases();
  const { decide } = useDecide();
  if (status !== 'ready') return <p>Loading the cases</p>;
  return (
    <>
      <ul>
        {cases.map((c) => (
          <li key={c.person}>
            {c.handle ?? 'Someone'}: {c.open} open
            <button
              type="button"
              onClick={() => decide({ reportId: c.reportIds[0] as string, person: c.person, input: { verdict: 'no_action', reason: 'Banter.', actions: [] } })}
            >
              No action
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => takeNext()}>
        Take next
      </button>
    </>
  );
}

export const Dashboard = () => (
  <HubProvider client={client} bare>
    <Queue />
  </HubProvider>
);
```

| Hook | Gives you |
| --- | --- |
| `useMe()` | `{ me, can(permission) }`: who is signed in and what the role may do |
| `useCases()` | The open cases, kept fresh: `cases`, `status`, `incoming`, `connection`, `filter`, `setFilter`, `showIncoming`, `reload`, `takeNext()` |
| `useCase(reportId, { claim })` | One case: `report`, `detail` (with the suggestion), `holder`, `decision`. It claims the case while in use unless `claim` is `false` |
| `useDecide()` | `decide(command, { hold })`, `undo`, `retry`, `dismiss`, `entry(reportId)`. An outcome is `done`, `failed`, `conflict` or `undone`, never a throw |
| `useClaim(person)` | `holder`, and `claim()`, `takeOver()`, `release()` as `{ ok, value }` or `{ ok: false, error }` |
| `usePolicy()` | The steps and ladder: `{ allowed, canEdit, data, error, loading, busy, reload, preview(layer, rule?), save(layer, reason), reset(sections, reason) }`. `data` is `{ effective, base, layer, version, canSave }`. It reads `GET /policy/profile` (audited on every call) once, and again after a save or a reset, never on a timer |
| `useTerms()`, `useBlocked({ days })`, `usePerson(ref)` | `{ allowed, data, error, loading, reload }`; nothing is asked of a role without the permission |
| `useHubController()` | The provider's controller, for the headless API next to your pieces |

Past the hooks, `@chatwarden/hub-react/headless` is the same controller with no React at all (see "Headless" below), for Vue, Svelte, Solid
or plain code. Below all of it, the HTTP routes and `createHubClient` are the contract for anyone who wants none of the UI.

`react` and `react-dom` are optional peer dependencies of this package for one reason only: the `/headless` entry needs no React. `<Hub>`,
`HubProvider`, the pieces and the hooks do need React at runtime (18.3 or 19), so a project that imports any of them installs both.

### 4. One script tag: the custom element

No React build, no framework: `@chatwarden/hub-element` is the same hub as `<chatwarden-hub>`, in one self-contained script with React inside.
It is the way for a plain HTML page, Vue, Svelte or a server-rendered admin page, and it reads the page's cookies like `<Hub>` does.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@chatwarden/hub-element@0.1/dist/hub-element.js"></script>
<chatwarden-hub base-url="/admin"></chatwarden-hub>
```

Its attributes (`mode`, `theme`, `locale`, `game-name`, `shortcuts`, `primary`, `router`), the `client` and `t` properties, the `cw-navigate`
and `cw-decided` events and its Content Security Policy are in the [hub-element README](https://github.com/hainix/chatwarden/tree/main/packages/hub-element).
`primary` there is the same idea as `<Hub primary>`.

### Experimental until 0.2

The embedding API is new and may change before 0.2. It is marked `@experimental` in its TSDoc, and `test/api.test.ts` locks every export
name of each entry point, so any change shows up as a snapshot diff and the changeset says which way. The experimental names are:

- `HubProvider`, `useHubController`, and the types `HubProviderProps`, `HubProviderOptions` and `HubControllerSource`
- the pieces `CaseList`, `CaseCard`, `CaseWorkbench`, `PersonRecord`, `TermsManager`, `BlockedList`, `AuditLog`, `RuleGaps`, `Guide`,
  `RecentActions`, `LadderSettings` and `ReportingSettings`, their `*Props` types, `PieceProps` and `PieceLinks`
- the hooks `useMe`, `useCases`, `useCase`, `useDecide`, `useClaim`, `useTerms`, `useBlocked`, `usePerson` and `usePolicy`, and the types `HubRead`,
  `UseMe`, `UseCases`, `UseCase`, `UseCaseOptions`, `UseDecide`, `UseClaim` and `UsePolicy`
- every export of `@chatwarden/hub-react/headless`: the controller, the stores and their types, the constants and the pure helpers. That
  includes `HubController.configure` and `HubControllerOptions.host`. The names are the same declarations the main entry re-exports (`createHubClient`,
  `fetchTransport`, `HubError`, the staff types and so on), so they are experimental there too. The kit's own types that `/headless` passes through
  (`Role`, `Me`, `StaffReport` and the other types declared in `@chatwarden/core` and `@chatwarden/http`) follow those packages.
  - functions, values and classes:
    `absoluteTime`, `actorInitial`, `actorName`, `browserPage`, `browserTimers`, `createAction`, `createCaseStore`,
    `createDecisionStore`, `createHubClient`, `createHubController`, `createLiveQueue`, `createPagedList`, `createResource`,
    `createSession`, `createStore`, `createT`, `createToastStore`, `emptyForm`, `en`, `fetchAll`, `fetchTransport`, `filterGroups`,
    `formatDuration`, `groupQueue`, `hasLeft`, `holderOf`, `HubError`, `isWaiting`, `liveClaim`, `nextOpenReport`, `personTag`,
    `queueStats`, `relativeTime`, `routerTransport`, `teamOf`, `toHubError`, `visibleRows`, `waitTone`
  - constants:
    `CLAIM_BEAT_MS`, `QUEUE_MAX_PAGES`, `QUEUE_PAGE`, `SESSION_REPORTERS_MAX`, `SESSION_TTL_MS`, `TAKE_COOLDOWN_MS`,
    `TOAST_ERROR_MS`, `TOAST_MAX`, `TOAST_MS`, `UNDO_MS`, `VIEWING_BEAT_MS`
  - types:
    `ActionResult`, `ActionState`, `ActionStore`, `BlockedDays`, `BlockedLine`, `CaseStore`, `CaseStoreOptions`, `Changes`, `Claim`,
    `ClaimResult`, `CloseGapInput`, `Connection`, `ContinueOutcome`, `DecideCommand`, `DecideInput`, `DecideOptions`, `DecideResult`,
    `DecisionEntry`, `DecisionForm`, `DecisionHost`, `DecisionOutcome`, `DecisionState`, `DecisionStore`, `DecisionStoreOptions`,
    `ExceptionInput`, `ExceptionPatch`, `ExceptionRow`, `FetchTransportOptions`, `Handoff`, `Hold`, `HoldInput`, `Holder`,
    `HubCatalog`, `HubClient`, `HubController`, `HubControllerOptions`, `HubControllerSettings`, `HubHost`, `HubParams`, `HubT`,
    `HubText`, `ListAuditQuery`, `ListReportsQuery`, `ListSanctionsQuery`, `LiveQueueOptions`, `LiveQueueState`, `LiveQueueStore`,
    `NextCase`, `NextReport`, `OpenCase`, `Page`, `PageSource`, `PagedListStore`, `PagedState`, `PersonHistory`, `PolicyDocs`,
    `PolicyFormat`, `PolicySamples`, `PolicySaved`, `QueueFilter`, `QueueGroup`, `QueueHold`, `QueueSort`, `QueueStats`, `Reason`,
    `ReportDetail`, `ReportStatus`, `ResourceState`, `ResourceStore`, `RouterTransportOptions`, `SanctionInput`, `SanctionRow`,
    `SanctionSource`, `Session`, `StartResult`, `Store`, `SubmitDecision`, `SuggestInput`, `TakeOutcome`, `TeamMember`, `TermInput`,
    `TermPatch`, `TermRow`, `TermsList`, `TextVerdict`, `Timers`, `ToastInput`, `ToastRecord`, `ToastStore`, `ToastStoreOptions`,
    `Toasts`, `Transport`, `TransportRequest`, `TransportResponse`, `WritableStore`
- in the main entry, the helpers it keeps for the hub's own screens: `tabOf`, `shortcutFor`, `normalizePath`, `buildPath` and `parseRoute`

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
| `primary` | `boolean` | Which hub answers keys when nothing on the page has focus, as after load. The only hub with shortcuts on always does; with several, only the one marked `primary`; with none marked, none. A hub always answers keys pressed while focus is inside it. Default `false`. |
| `mode` | `'simple' \| 'detailed'` | Fixes the view and hides the Simple/Detailed switch. Left out, each moderator's last choice is kept in their browser (`localStorage`, key `chatwarden.hub.mode`), and a browser that cannot keep it gets `simple`. |

### Simple mode

Simple is the default view: one card per case, for a team of one or two. The card holds the person's name, what they were reported
for and by whom, what they said (only their own lines, the reported one marked, with "Show the whole chat" for the rest; blocked words
stay hidden until shown), their record in one line, and the ladder's suggestion as a referee card with three buttons: the suggested step
("Restrict chat, 24 hours"), "No action needed", and "Something else…", which opens the full decision bar in place. One click sends
Fair, the suggested rule, the rule's title as the reason and the person's own lines (up to five) as what the player is shown; "No action
needed" sends Not a problem with the reason "No rule was broken". Both go through the same five-second Undo as Detailed, the same claims
and the same send, and the keys are `1`, `2` and Ctrl or Cmd+Enter (the suggested step, then the next case). When no rule covers the report, or the role
cannot apply the step, the card says so and offers "Something else…" instead.

**The light tap.** When the suggestion is harsher than a warning, the card also offers "Send a warning" (key `3`): the same one click, the same
Undo, a warning under the same rule with the rule's title as the reason. Key `3` does nothing while "Something else…" is open, while a decision is
waiting, or while you are typing.

What Simple hides stays one click away in Detailed: claims are still taken and released quietly, and only a case someone else holds shows
it ("maya is on it", read-only, with Take over for a role holding `claims.override`). A reporter's record shows only as a warning when they
have three or more reports and fewer than a third were upheld. The menu is Cases, Words, Blocked and More (Recent actions, Audit, Rule gaps, Guide and Steps and
ladder, each by permission); the command bar and every route still work. The switch in the top bar keeps the open case, and a decision waiting
for its Undo survives it.

### Screens

| Route | Screen | Needs |
| --- | --- | --- |
| `#/` | Overview, the team view: people waiting, open reports, the longest wait, unclaimed cases, who is on and what each is holding, recent actions | any signed-in role (panels follow `reports.read` and `history.read`) |
| `#/reports`, `#/reports?status=actioned` | Reports: every report, grouped by reported person, filtered by status (the queue pane beside it is always the open cases) | `reports.read` |
| `#/reports/:id` | The case: header and claim, Evidence (the transcript), Reports and History tabs, the decision bar docked under them, and beside it the person's record, blocked attempts and who reported | `reports.read`; deciding needs `reports.decide`, actions need `sanctions.apply` |
| `#/people/:ref` | The person page, in the middle pane (the queue stays at the left): what is in force now (each with a Revoke that asks for a reason), the timeline of reports about them and every sanction (kind, rule, time left, ref code, who, where it came from, revoked), how the reports they filed have gone, and buttons to Sanction them or add a note. A sanction is a kind, a length, a rule (or "No rule covers this" with a note for the rules review), a reason and "also block their IP address for up to 24 hours"; a permanent ban needs `sanctions.apply.ban_permanent`. Nothing is sent to the player from here. Opening it writes one `history.view`; a write reads the history once more | `history.read`; Sanction and Add a note need `sanctions.apply`, Revoke needs `sanctions.revoke` |
| `#/actions` | All actions: everyone's sanctions, newest first, 25 at a time, with an "Automatic only" filter (the kit's `auto_filter` source). The Overview's Recent actions links here with "See all" | `history.read` |
| `#/terms` | Terms and exceptions by language (named by `Intl.DisplayNames`, the code where it has no name): word, note, last changed by and when, blocks in the last 30 days, and an Active switch. The words are hidden until "Show words" is on. Add or edit a term (a dry run first: `POST /terms/check`), add or edit an exception, and "Test a message" | `terms.read`; Add, Edit and the switches need `terms.write` |
| `#/blocked` | The lines the term filter refused, over 24 hours, 7 or 30 days: time, the person (their handle when a report named them, and the short tag), room, the term and the blocked text, both hidden until shown (per line, with Show beside the text, or "Show blocked words"). "Add exception" opens the exception form on Terms, filled in; "View term" opens Terms at that term. Opening it, and each change of window, writes one `blocked.view`; showing a word reads nothing | `blocked.read`; the term needs `terms.read`; Add exception needs `terms.write` |
| `#/gaps` | Rule gaps: open gaps with their note and ref code, closed ones below. An owner closes one as "Made it rule N" (the rules in force) or "Not a rule" | `gaps.read`; closing needs `gaps.close` |
| `#/audit` | The audit trail, newest first, 50 at a time: time, staff member, role, action and target, filtered by staff member and action | `audit.read` (a senior and up) |
| `#/settings/ladder` | Steps and ladder (under Settings in Detailed, and More in Simple): the lengths moderators can pick, the ladder grid (six steps by a lighter and a harsher column, each a kind and a length), the first offence per conduct level, the repeat rule, the area and severe rules, and the outcome text of the written guidelines. The owner edits a local draft and sees a preview (400 ms after the last edit) of what it would suggest for sample records. Saving asks for a reason; a 409 reads "Someone else changed these settings" with Reload; a 400 puts keyboard focus on the field the kit named. Each section has a Reset, and so has the whole screen, both with an in-page confirm that asks why. Leaving with unsaved edits asks in the page (links, the command bar and buttons) and closing the tab asks the browser to confirm; the browser's Back button and an address typed by hand are not guarded. A role that cannot write (or a store that cannot save settings) sees it read-only with one sentence saying why; `usePolicy().save` and `reset` refuse with `not_allowed` for a role that cannot write, and a reset of several sections that fails part way answers `partial: true` (what did go through is already applied) | `policy.read`; changing needs `policy.write` |
| `#/settings/reporting` | Reporting (beside Steps and ladder): how players report (one tap, pick a reason first, or reason required, each with a plain line), the reasons (add, rename, hint, group, move up and down with buttons, switch on and off, map to Community Rules with a rule multi-picker, ask for a note; "Something else" can be renamed and mapped but never removed or switched off), the thank-you, and a "What players see" picture drawn from the draft. It saves, conflicts, refuses, resets (Reset reporting) and guards leaving exactly as Steps and ladder does; each screen's save keeps what the other saved, and "Reset steps and ladder" leaves reporting alone (it names only its own sections). The reason a reporter gives is only a hint: Detailed shows "Reported as X" or "No reason given" as the chip beside the case name and beside each report, and the queue (and Take next) can be filtered by it; the Simple card asks "Which rule does this break?" when no rule is clear (no reason, "Something else", a reason with no single rule) and suggests once one is picked, and preselects the rule when the reason maps to exactly one. A reporter's page says "Their reasons matched the decision 3 of 4 times" once three reports are decided. A reason's id is what a report stores, and a new reason's id comes from its name: reusing a removed reason's id relabels its old reports (removing "Spam" and adding "Spam" again gives the id `spam` again, so reports filed under the old one read as the new one), so rename a reason rather than remove and re-add it when the meaning is the same | `policy.read`; changing needs `policy.write` |
| `#/guide` | The Community Rules and the escalation ladder (the profile's own, else the kit's `LADDER_TABLE`) from the policy data, then the generated moderator guide (`GET /policy?format=markdown`) through a safe renderer | `policy.read` |

The tabs a role cannot use are not shown: Audit appears for a senior and above, and every tab follows the permission table the
server reports in `GET /me` (so a `permissions` override on the server is respected).

### The workbench

Three panes from 1200px wide: the queue (left), the case or screen (middle), and, beside an open case, the person's record, what they tried to say that was
blocked and how the people who reported have fared. Two panes from 820px (the panel moves under the case); narrower, everything stacks and the page
scrolls as one, with no horizontal scroll down to 360px. A slim rail of sections sits at the far left, and a top bar holds the
product, your game's name, whether the queue is live, the command bar and who is on. The hub fills `--cw-hub-height` (the viewport
by default; set it to fit under your own header). Everything async is quiet: skeletons while loading (no spinners), a toast for news,
a banner when the connection is lost.

**Claims are soft locks.** Opening a case claims it if nobody holds it (`POST /cases/:ref/claim`), and while it stays open and the
tab is visible the hub renews the claim every 60 seconds and a "viewing" hint every 20. The server releases a claim after 10 minutes
without a renewal. A case someone else holds opens to read, with a notice; the server refuses a decision on it unless a senior
takes it over: the decision bar is read-only and names the holder, with "Take over" for a role holding `claims.override`. A decision sent anyway
(someone took the case after you opened it) is refused (409 `claimed`); the bar turns read-only and keeps what you entered. Each queue row shows who handles it (you in blue, others by name, or Unclaimed) and who is viewing; your own row has
a Release button (the toast offers Undo). "Take next case" (N) claims the oldest unclaimed case that matches the "Reported as" filter (the kit gets the same reason, or `none`) and
opens it. Leaving a case (another case, another screen, closing the hub) releases your claim (`POST /cases/:ref/release`) unless a decision
on it is waiting: sending that releases it. A tab that is killed cannot be sure to send a release, so then the claim lapses on its own after 10 minutes.

**The queue stays still.** The queue is read once, then the hub asks `GET /changes` every 5 seconds while the tab is visible and every
30 while it is hidden, never while the browser is offline, and reads the queue again only when the token changed. New cases wait behind
an "N new cases" pill; a claim arrives in place; a case that closes while the pointer or keyboard focus is in the list (or while it is
the open case) stays in its place, marked "No longer open", until you move away. After two failed polls in a row a banner says the
connection is lost (and polling slows to every 15 seconds); a toast says "Back online." when it recovers. A 401 or 403 is not a lost connection: the
hub stops asking, says "You are signed out" (or "Your role cannot do this") in the banner, and offers Try again. A 429 waits its
`retry-after`. A minute tick (while visible) redraws waits, the 24-hour overdue flip and lapsed claims, which move no token. Viewing and claim lapses
move no change token, so a row's viewers refresh whenever the queue does and your own open case's viewers refresh every 20 seconds.

**Keyboard.** Shortcuts never fire while you are typing in a field, a select or an editable region, or with Ctrl, Cmd or Alt held
(except Ctrl or Cmd+K), and `shortcuts={false}` turns them all off. The hub listens on its own root element, not on the page: it
answers a key pressed while keyboard focus is inside it (a click on its empty space puts focus on the root, so that counts). Two hubs on
one page each answer only their own keys, a key pressed in your own controls is never taken, and the same holds in a shadow root.
With nothing focused (a page that has just loaded), the page's hub answers: the only hub with shortcuts on, or, among several, the one
with `primary`; among several and none marked, none does. Escape is only ever the hub's own, when focus is inside it.

| Key | What it does |
| --- | --- |
| `J` / `K` | Move focus to the next or previous case in the queue. It moves; it does not open or claim. Enter opens the one you are on. |
| `N` | Take the next case. A held key takes one. |
| `Ctrl+K` (`⌘K` on a Mac) | Open the command bar: jump to a person or report in the queue, a term, a screen, or run Take next. |
| `?` | List the shortcuts. |
| `Esc` | Close the window that is open; otherwise go back to the queue. |

**Toasts and Undo.** Toasts pause while the pointer or focus is on them. `useToasts()` (exported) gives `push`, `dismiss` and `hold`:
`hold({ text, run, onUndo })` waits 5 seconds with an Undo button and a progress bar, then runs `run` once; Undo cancels it, and it
runs at once if the toast is dismissed early or the page is closing (`pagehide`, the tab becoming hidden, or the hub unmounting). Releasing a claim uses
`push` with an action; decisions use `hold`.

**Limits.** "On now" lists the people who hold or are viewing a case, and you: the kit has no presence route, so someone signed in and idle is
not shown. Recent actions is read again whenever the queue is read because the change token moved.

### The case and the decision

**The case pane.** A header (the reported person, their short tag, the categories, who is viewing), a claim banner (you, someone else, or
nobody), and tabs. Evidence opens first: the reporter's note and the transcript. The reported line has a red rail, the reported person's
own lines a neutral tint, and **blocked words are hidden until shown**: a bar stands in for the line (and a screen reader hears "Blocked
words, hidden", never the words), with a Show button per line and a "Show blocked words" switch for the case. "Only <name>" filters the
transcript to one person. A box in the margin of the reported person's lines picks which of them the player is shown (up to five). The
AI read has a slot above the transcript (`AiReadSlot`); it renders nothing until a read exists, and none is built yet. Reports lists
every report in the case; History lists the person's record, newest first.

**The context pane** (beside the case): the person's last 90 days with a referee card for each action (yellow warning, half yellow and
half red restriction, red ban, dashed note), the lines they tried to send in the last 7 days that were blocked (hidden until shown; needs
`blocked.read`), how the people who reported have fared (reports filed, how many were upheld, bad faith, suspension; at most five are read)
and who is in the case.

**The decision bar** is docked under the evidence and opens **pre-filled**: the ladder's suggestion as the reported person's action, the
report's Community Rule, and their own lines chosen (never a verdict: that is yours). Keys: `1` Fair, `2` Not a problem, `3` Bad faith;
Ctrl or Cmd with Enter decides and takes the next case. A saved reason (`GET /reasons`) is one chip. "Change" opens the full action editor
(the conduct level, every field, more actions, up to 20), and the menu is built from your profile's own ladder (`GET /policy`
`profile`), with the suggestion always on it; a length the form cannot send is said so, not hidden. It refuses what the server would
refuse before sending: no action on the reported person unless the report is fair, bad-faith evidence of 1 to 500 characters, a gap note
for an uncovered rule, at most five lines that are the person's own, one action of a kind per person. Only a permanent **ban** needs
`sanctions.apply.ban_permanent`, as on the server. The role's `can` map decides what is offered, never the role name. Without
`policy.read`, or when the rules cannot be loaded, the bar still decides: verdict, reason and no actions.

**Held for five seconds.** Pressing Decide does not send. The decision waits for `UNDO_MS` (5 s) with an Undo toast, the case leaves the
queue at once, and the bar shows "Decision queued". Undo cancels with nothing sent and gives the form back. The decision is sent at once
if the page hides, the tab is hidden or the hub unmounts, and it always goes with `keepalive` (`fetchTransport` sets it on `fetch`; do the
same in your own transport). If the send fails, the case comes back with the error and what you entered (when you have moved on to
another case, a toast says so, with a button that opens it). "Decide and take next" queues the decision, takes the next case
(`POST /cases/next`) and opens it; with none left it opens the team view. A decision does not read the report, the person or the rules
again.

There is no idempotency key to send: the server recognises a repeated decision by its content and answers `replay: true`, which the
bar shows as a success. A `409 already_decided` reloads the report and says someone else decided it. A network failure keeps everything
typed and offers "Try again", which sends the same body at once. A 400 names no field on the server, so the message is one sentence per
code (`invalid_request`, `invalid_sanction`, `invalid_excerpt`); the form's own checks, which hold the server's rules, give field-level
messages first. Results are announced in a polite live region.

**What a case costs in audited reads.** Opening a case writes `report.view` once for that report, `history.view` for the reported person
and for each reporter shown (a reporter's record is kept for 5 minutes, so a reporter in several cases is read once), `blocked.view`
when the role can read blocked lines (kept 5 minutes), and `policy.view` once per session (the rules are kept until the hub closes).
Deciding writes `report.decide` and nothing else about the case. The queue list is one `report.view` row with no target, as before.

**What the Overview and All actions cost in audited reads.** `GET /sanctions` writes one `history.view` row with no target each time it is read. The Overview's Recent actions is read once when the Overview opens and not again by itself: it does not follow the live queue, so a teammate's decision shows there the next time the Overview is opened, or in "See all". All actions reads when it opens, once for each page a moderator asks for with "Load more", and once more when the filter changes. Nothing reads on a timer: the only repeating call is `GET /changes`, which is not audited.

### Terms, Blocked, Rule gaps, Audit and the Guide

**Words stay hidden.** A blocked word is hidden until a moderator chooses to see it, on every screen that holds one. On Terms, "Show words" (off by default)
shows the words, and until then each row is named by its place ("Edit term 3", never by the word) so a screen reader hears none. On Blocked, the term and the
blocked text of a line show behind that line's Show button, or all at once with "Show blocked words". A hidden word is not in the page at all (a test checks
the markup), and showing one reads nothing again. A word that is already in a form (an edit, or a blocked line sent over to add an exception) is held in the form's state and
shown as a mask with its own Show button until that is pressed or Show words is on; saving works without showing it, and the lines a dry run finds hide behind the same Show. A note is
staff text, so it shows as written (it can mention a word; that is the owner's ruling, not an oversight).

**Adding a term.** The form asks for the word, its language and an optional note. A new or changed word is first checked with a dry run (`POST /terms/check`,
which writes nothing). If it would also block lines that are fine today, the lines are listed (twenty, then a count) and the save waits for "Save anyway", an
in-page confirm. Turning a term back on runs the same dry run, and its hits ask for the same confirm inline on that row. An exception is saved at once, since it only lets things through. A flat 400 `invalid_term` reads "The list refused this word (it may be a
duplicate, malformed, or the last active word)." The same sentence covers a switch that would turn off the last active term. A network failure keeps what you typed and offers Try again.

**Blocked to Terms.** "Add exception" and "View term" go to Terms through the hub's session, not the address, so nothing but `#/terms` is in the URL. The exception
form opens with the blocked line (cut to 200 characters) and its language filled in; cut it down to the phrase that should be allowed.

**What they cost in audited reads.** Terms writes nothing to the trail by reading (the kit audits each change: `term.add`, `term.update`, `term.toggle` and the
exception forms). Blocked writes one `blocked.view` each time it opens and each time the window changes. Rule gaps reads no rules until an owner opens a close form
(then the session reads them once: one `policy.view`). The Guide reads the policy once per hub session. Audit writes nothing.

**Audit shows ids, not text.** A person or report is a short tag and a link; a term or exception is only "A term" or "An exception", because the id of a row can be
the word itself. The trail never holds chat text.

**The Guide draws each thing once.** The Community Rules and the ladder (with the notes on which rules turn a restriction into a ban and which always read the High column) are drawn from the
policy data. The generated guide is asked for without those two sections (`GET /policy?format=markdown&omit=rules,ladder`; `omitSections` in core's `moderatorGuide`), so nothing is shown twice and the rest keeps the kit's order.

**The guide is rendered safely.** `Markdown` (internal) draws headings, paragraphs, lists, emphasis, code, tables and links, and nothing else. Raw HTML, images,
quotes and entities are shown as the text they are. A link is drawn only for `https:` or a relative address on this site (no backslash, no `//` or `/ ` start, no whitespace or control character); any other link keeps its words and loses its address. A line is read for block syntax in its first 2,000 characters only, and the scans are linear, so a hostile guide cannot stall the page.
No string is ever turned into HTML.

### `HubClient`

`createHubClient(transport)` returns one method per staff route. Each resolves with the parsed answer or rejects with a `HubError`
(`status`, `code`, `message`, `retryAfter`; for a 409 `claimed`, also `heldBy` and `heldUntil`; for a 400 `invalid_profile`, the `path` of the field). Codes are the kit's (`forbidden`, `not_found`, `already_decided`, ...), plus `network`
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
| `policy({ format?, omit? })` | `GET /policy` (`omit`: `['rules', 'ladder']` leaves those sections out of the generated guide) |
| `listAudit({ cursor?, limit?, actor?, action? })` | `GET /audit` |
| `policyProfile()` | `GET /policy/profile` (audited on every call) |
| `savePolicyProfile({ layer, version, reason })` | `PUT /policy/profile` (a stale `version` is a 409 `conflict`; a refused layer is a 400 `invalid_profile` with `error.path`) |
| `previewPolicyProfile({ layer, rule? })` | `POST /policy/profile/preview` |
| `resetPolicyProfile({ section?, reason, version? })` | `DELETE /policy/profile?section=` |
| `changes(since?)` | `GET /changes` |
| `claimCase(person, { takeOver? })` | `POST /cases/:ref/claim` |
| `releaseCase(person)` | `POST /cases/:ref/release` |
| `takeNext({ reason?, category? })` | `POST /cases/next` (`reason` is an id, or `null` for reports that gave none; `category` still works and is deprecated: the queue has no Category filter any more) |
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
- **Re-theme it.** Set a token on any element above the hub (`body`, a wrapper, the `<chatwarden-hub>` element), on `.cw-hub`, or on
  the `className` you pass: `body { --cw-accent: #7a2e8a }` themes a `<Hub>`, every piece and the element alike. The stylesheet never
  declares a public `--cw-*` name on `.cw-hub` (that would hide what you set above it): its defaults sit under private `--cwd-*` names
  at zero specificity (`:where(.cw-hub)`), and every rule reads `var(--cw-x, var(--cwd-x))`, your value if there is one, ours if not.
  Set `--cw-*` names only; the `--cwd-*` ones are not part of the contract.
- **A host page's headings.** Under `.cw-hub`, `h1` to `h6` set their own font (`--cw-font`), `text-transform: none`, `letter-spacing:
  normal` and weight, at (0,1,1), so a site that styles its own `h1`/`h2` (a display font, capitals) does not restyle the hub. To change
  them on purpose, use a more specific selector (`.my-theme .cw-hub h2`), a rule in a sheet that loads after this one, or the tokens.
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

## Headless (any framework)

`@chatwarden/hub-react/headless` is the hub's behaviour with no React: the live queue, claims, the Undo hold on a
decision and the toasts. The React hub is built on it, so a Vue, Svelte or Solid dashboard, or a plain script, gets the same
behaviour. Every store has `subscribe(listener)` and `getSnapshot()`, and a snapshot is the same object until something changes
(so it works with `useSyncExternalStore`, a Vue `shallowRef`, a Svelte store, or a bare callback).

The headless entry needs no React. `react` and `react-dom` are optional peer dependencies of this package (`peerDependenciesMeta`),
so a Vue, Svelte or plain-JS project that imports only `@chatwarden/hub-react/headless` installs without them, and its bundle holds
no React. It does need the kit peers, `@chatwarden/core` and `@chatwarden/http` (types).

The controller's timers and page awareness default to `browserTimers` and `browserPage`, which use `document` and `window` when they run
(the page's visibility, `pagehide`, online and offline events); where there is no `document` they say the page is visible and online. They
are optional and injectable: pass your own `schedule` and `page` to `createHubController` for a worker, Node or a native shell. Its type
declarations need no DOM lib, so a project with `lib: ["ES2023"]` and no `@types/node` compiles an import of it.

```ts
import { createHubClient, createHubController, fetchTransport, personTag } from '@chatwarden/hub-react/headless';

const controller = createHubController({ client: createHubClient(fetchTransport({ baseUrl: '/admin' })) });

// Asks GET /me, then loads the queue and keeps it fresh (it asks GET /changes every 5 seconds, 30 while the tab is hidden).
const started = await controller.start();
if (!started.ok) throw new Error(`Not signed in: ${started.error.code}`);

// List the cases. New ones wait behind `incoming` until you call `controller.queue.showIncoming()`.
const stopList = controller.queue.subscribe(() => {
  const { visible, incoming } = controller.queue.getSnapshot();
  console.log(visible.map((row) => `${personTag(row.group.person)}: ${row.group.open} open`), `${incoming} new`);
});
const first = controller.queue.getSnapshot().visible[0];

if (first !== undefined) {
  const reportId = first.group.reportIds[0] as string;

  // Open one. You become its handler if nobody is, the claim is renewed while the tab is visible, and it is let go on leave().
  await controller.open(reportId); // resolves once the first claim has answered

  // Toasts are plain records: draw them yourself. A held decision has one, with the Undo.
  controller.toasts.subscribe(() => console.log(controller.toasts.getSnapshot().map((toast) => toast.text)));

  // Decide it. The decision is held for 5 seconds (the toast offers Undo), then sent; the promise says how it ended.
  const outcome = controller.decide({
    reportId,
    person: first.group.person,
    input: { verdict: 'no_action', reason: 'Banter between friends.', actions: [] },
  });
  controller.undo(reportId); // changed my mind: nothing is sent, the case comes back
  console.log(await outcome); // { status: 'undone' }
}

// Done: stops every timer and listener, lets the open case go, and sends a decision that is still held.
stopList();
controller.dispose();
```

`controller.start()` is a hold on the queue: its answer carries `release`, and `controller.queue.acquire()` takes another (`{ release, ready }`). The
queue loads and polls while any hold is unreleased, so several parts can share it and none stops it from under another; `queue.start()` and
`queue.stop()` still work (`start()` is a hold that only `stop()` lets go of, and `stop()` ends every hold).

Nothing in it throws for an outcome it expects: `start`, `decide`, `retry`, `claim`, `takeOver`, `release` and `takeNext` answer a
typed result (a 409, a 404 or a dropped connection is `{ ok: false, error }` or `{ status: 'failed' | 'conflict' }`).

| Part | What it is |
| --- | --- |
| `controller.queue` | The live queue: `status`, `rows`, `visible`, `incoming`, `connection` (`live`, `lost`, `offline`, `signedOut`), filters, and `showIncoming()`, `reload()`, `retryNow()`. |
| `controller.decisions` | One entry per report in flight (`held`, `sending`, `done`, `failed`, `conflict`, `undone`), with the form to give back on a failure. |
| `controller.opened` | The case that is open, and the person it is about. |
| `controller.toasts` | The toast records and their timers. How they look is yours. |
| `decide(command, { hold })`, `undo(id)`, `retry(id)` | `hold` is `true` (5 s, the default), a number of milliseconds, or `false` (send at once). `retry` sends a failed decision again with the same body. |
| `open(id)`, `leave()`, `takeNext()`, `claim(person)`, `takeOver(person)`, `release(person)` | Claims. Leaving a case releases it, unless a decision on it is waiting or the claim is someone else's. |
| `dispose()` | Safe to call twice. A closing page sends a held decision at once (`pagehide`, a hidden tab, `dispose`), and only once. |

A dashboard with its own router tells the controller where the moderator is looking, so that an Undo (or a failed decision) on a
case they have left can bring them back to it. This is `@experimental`, like the other names marked so in the type declarations, and
may change before 0.2:

```ts
import { createHubClient, createHubController, fetchTransport } from '@chatwarden/hub-react/headless';

let looking: string | null = null; // the report your own router shows, or null

const show = (reportId: string): void => {
  looking = reportId;
  // ...and tell your router to open it.
};

export const controller = createHubController({
  client: createHubClient(fetchTransport({ baseUrl: '/admin' })),
  host: { openReport: () => looking, show },
});
```

Without `host`, "what is open" is the case opened with `controller.open(id)`, and `show` does nothing. `controller.configure({ t })`
changes the words the toasts use; it is the only thing `configure` takes.

To run it without a DOM (a test, a worker, Node), hand it the timers and the page: `createHubController({ client, schedule, page })`.
`schedule` is `{ setTimeout, clearTimeout, setInterval, clearInterval, now }` and `page` is `{ visible, online, onVisibilityChange,
onPageHide, onOnline, onOffline }`; both default to the browser's, and outside a browser the page is always visible and online.
Keys, focus and the toasts' markup are the UI's, so they are not in it.

## Security notes

- **No identifiers reach the page beyond the staff API's own.** The hub shows a person as the first 8 characters of their opaque
  ref and never the full ref. It shows a reported person's handle (staff only, from the queue) and a reporter's handle where a report recorded one (the case's Who reported list), else their tag.
- **The full person ref is in the link.** The page shows only the 8 character tag, but a link to a person (`#/people/:ref`) has to
  carry the whole ref, because the server route needs it. It is staff-only, like the queue, but the address bar, the history and the
  paths `onNavigate` receives all hold it, so do not forward those to analytics.
- **The case shows chat as typed, with blocked words hidden by default.** The excerpt is for staff: it holds the raw lines and the
  reporter's note. Blocked words are hidden until a moderator shows them (and never put in a screen-reader label). That is for the
  moderator's sake, not a privacy boundary: the raw text is in the answer the hub already has. What a player sees is only the lines the moderator chose for them, as the server masks them.
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
- **Blocked words are not in the page until shown.** The Terms and Blocked screens do not put a term or a blocked line in the markup, a label or a screen-reader
  name until a moderator shows it. That is for the moderator's sake, not a privacy boundary: the words are in the answer the hub already has.
- **Opening Blocked is an audited read.** It writes one `blocked.view` each time it opens and each time the window changes. Term text needs `terms.read`
  (without it the term column says so). Add exception and View term pass a handoff in memory, never in the address.
- **Server text is not echoed.** Error messages come from the hub's own catalog, not from the response body.

## Links

- [Apache-2.0 license](https://github.com/hainix/chatwarden/blob/main/LICENSE)
- [Staff API routes](https://github.com/hainix/chatwarden/tree/main/packages/http#the-routes)
- [Source and other packages](https://github.com/hainix/chatwarden)
- [Issues](https://github.com/hainix/chatwarden/issues)
