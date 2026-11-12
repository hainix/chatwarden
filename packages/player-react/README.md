# @chatwarden/player-react

The player side of Chatwarden, the open-source chat moderation kit for games: a few small React components a game embeds so a
player can see what happened to them. A dialog for notices (a warning, a restriction, a ban, a thank-you for a report), a "My
record" list, the community rules, a dialog to report another player, and one line that says why the chat is off. They talk to the
kit's player routes through a small injected transport, so the same components run against a real server (`fetch`) or against the
real routes running in the page (a demo). It is the counterpart of `@chatwarden/hub-react`, which is for your moderators.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/player-react @chatwarden/core react react-dom
```

`react` and `react-dom` (18.3 or 19) are peer dependencies, so your game has one copy of React. The components use only APIs that
exist in 18.3 (`useId`, `useRef`). The unit and interaction tests run on React 19; the consumer smoke test installs React 18.3, type-checks against
`@types/react` 18 and renders every component on the server, but clicks and focus have not been exercised on 18. `@chatwarden/core` is a peer too, for its types
only: no run-time import of it, or of the HTTP package, is in the bundle. Node 22.13 or newer for the tooling; the components
themselves run in a browser and import no `node:` module.

Your server needs `@chatwarden/http` for the routes the components call (`playerRoutes`). The JavaScript is under 11 KB gzipped
with React external, and the stylesheet under 6 KB.

## Quick start

On the server you already mount the kit's player routes (see `@chatwarden/http`). In the game, make a client once and render what you need.

```ts
import { fetchTransport, createPlayerClient } from '@chatwarden/player-react';

// The player routes are mounted at /player on this origin. Cookies go along with each call: the server decides who is asking.
export const client = createPlayerClient({ transport: fetchTransport({ baseUrl: '/player', credentials: 'same-origin' }) });

const notices = await client.notices(); // what is waiting for this player, oldest first
console.log(notices.length);
```

```tsx
import '@chatwarden/player-react/styles.css';
import { MyRecord, NoticeQueue, RulesPage } from '@chatwarden/player-react';
import { client } from './client';

export function GameShell({ inMatch }: { inMatch: boolean }) {
  return (
    <>
      {/* Notices wait while a match is on, and open when it ends. */}
      <NoticeQueue client={client} canShow={!inMatch} appealUrl="https://example.com/appeal" />
      <MyRecord client={client} appealUrl="https://example.com/appeal" />
      <RulesPage client={client} />
    </>
  );
}
```

Reporting is one step. The dialog asks "Report this message?", shows the line, and has an optional "Why?" (one select, the reasons in
groups) and a Report button; a note is behind "Add a note". How it works is the studio's setting (the Reporting section of the moderator
hub, or `reporting` in code): which reasons, their groups and hints, whether a reason is required, and the thank-you. Read it from
`GET /rules` and pass it to the dialog. Your server adds the room and the seats and calls the kit:

```ts
import type { ReportResult } from '@chatwarden/core';
import type { ReportDraft } from '@chatwarden/player-react';

// `cw` is your createChatwarden(...) instance. Call this behind your own route, for example POST /report: `roomId` and the seats come
// from your session, never from the client. The draft is the kit's own `reason` and `note`, so it spreads straight in.
export function takeReport(roomId: string, mySeat: string, theirSeat: string, draft: ReportDraft): Promise<ReportResult> {
  return cw.reports.submit({ roomId, reporterSeat: mySeat, targetSeat: theirSeat, ...draft });
}
```

Load the settings before the dialog is drawn, so it opens in the right flow and never changes under the player's hands. A failed load
should still give the studio's default (one tap). That is also what the dialog does when it gets no `reporting`, so the fallback below only
spells it out, with the dialog's own words:

```ts
import { useEffect, useState } from 'react';
import type { PlayerClient, PlayerReporting } from '@chatwarden/player-react';

/** One tap, no reasons to offer, the dialog's own thank-you: what a player gets when the settings cannot be loaded. */
const ONE_TAP: PlayerReporting = { flow: 'one_tap', thanks: '', reasons: [] };

/** The studio's reporting settings from `GET /rules`: `undefined` while they load, the one-tap fallback if that fails. */
export function useReporting(client: PlayerClient): PlayerReporting | undefined {
  const [reporting, setReporting] = useState<PlayerReporting>();
  useEffect(() => {
    let live = true;
    client.rules().then(
      (rules) => live && setReporting(rules.reporting ?? ONE_TAP),
      () => live && setReporting(ONE_TAP),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return reporting;
}
```

```tsx
import { ReportDialog } from '@chatwarden/player-react';
import type { PlayerClient } from '@chatwarden/player-react';

export function ReportMessage({ client, line, name, close }: { client: PlayerClient; line: string; name: string; close: () => void }) {
  const reporting = useReporting(client);
  if (reporting === undefined) return <p role="status">Loading…</p>;
  return (
    <ReportDialog
      line={line}
      targetName={name}
      reporting={reporting}
      onClose={close}
      onSubmit={(draft) => fetch('/report', { method: 'POST', body: JSON.stringify(draft) }).then((r) => r.json())}
    />
  );
}
```

- **One step, whatever the flow.** Report with nothing chosen files the report at once. A reason chosen in the select, and a note typed
  behind "Add a note" (shown straight away when the chosen reason asks for one), go in the same report: `onSubmit` gets
  `{ reason?, note? }` once. The dialog then reads "Report sent", shows the studio's thank-you (and how many reports are left today) and
  has Close. There is no second step.
- **Reason required** (`flow: 'reason_required'`): the label is "Why?" and the select is required. Report without a reason shows an inline
  error, puts focus on the select and sends nothing. In the other flows the select is "Why? (optional)".
- **`onAddDetail` is deprecated.** It is still accepted (and `ReportFollowUp` is still exported) so existing code compiles, but the dialog
  never calls it. Remove it. `cw.reports.addDetail` is still there if you want a follow-up screen of your own.
- **A reason is a hint.** The kit stores it as `reportedReason`; the moderators (and later the AI) decide what the report really is.
- **Without `reporting`** the dialog has no reasons to offer: one press files the report, with its own words. That is the same as when
  `GET /rules` cannot be loaded. Pass `reporting` before the dialog opens: one that arrives later changes the flow under the player.
- **Stale settings.** If the studio changes the list while a dialog is open, the kit refuses an unknown reason (`reason_unknown`) or a
  missing one (`reason_required`) and the dialog says so. Read `GET /rules` again before the next report.
- **Your own controls (`extra`, experimental).** A node placed inside the form under the reason and the note, above Report and Cancel,
  for something of your own, such as an "Also mute this player" checkbox. You own its state; the dialog only places it (spacing, no other
  styling), keeps its controls in the Tab order (reason, note, yours, Report, Cancel) and in the focus trap, and drops it once the report
  is sent. It is inside the dialog's form, so give your buttons `type="button"`: a plain `<button>`, or Enter in a text field of
  yours, sends the report. Send what you chose from your own `onSubmit`:

```tsx
import { useState } from 'react';
import { ReportDialog } from '@chatwarden/player-react';
import type { PlayerReporting, ReportResult } from '@chatwarden/player-react';

export function ReportAndMaybeMute(props: { reporting: PlayerReporting; close: () => void; send: (mute: boolean, draft: object) => Promise<ReportResult> }) {
  const [mute, setMute] = useState(false);
  return (
    <ReportDialog
      reporting={props.reporting}
      onClose={props.close}
      onSubmit={(draft) => props.send(mute, draft)}
      extra={
        <label>
          <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} /> Also mute this player
        </label>
      }
    />
  );
}
```

## Put it on your server

The components call the kit's player routes. The simplest way to run them is to **serve the built game page and the player routes under
one origin**: the page's calls go to the same host, the player's cookie or session goes along, and there is no CORS to set up.

With Express, mount the routes with the adapter from `@chatwarden/http`, then your game's built files:

```ts
import express from 'express';
import { playerRoutes } from '@chatwarden/http';
import type { KitRequest } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';

// `cw` is your createChatwarden(...) instance. Your own sign-in decides who is asking: here, the session cookie your login set.
declare function keyFromSession(cookie: string | undefined): string | undefined;

const app = express();
app.use(
  '/player',
  toExpress(
    playerRoutes(cw, {
      identify: (req: KitRequest) => ({ clientKey: keyFromSession(req.headers.cookie), ip: req.remoteAddress ?? null }),
    }),
    { fallthrough: false },
  ),
);
app.use(express.static('dist/game')); // your built game page, which renders the components
app.listen(3000);
```

Any other server works the same way, because the player routes are plain HTTP (`createRouter(playerRoutes(...))` gives you a function from a
request to a response for any framework; see `@chatwarden/http`). Another origin needs the player routes to answer CORS for the page's
origin with credentials, and `credentials: 'include'` in the transport.

## Signing players in

The components send no identity of their own. Who is asking is decided on the server by the `identify` function you give
`playerRoutes`: it returns the player's `clientKey` or `accountId` and the real client address, from your session, never from the page.
Two ways to carry the credential:

- **Cookies.** On the same origin the browser sends the page's cookies with each call (`credentials: 'same-origin'` is the default), and
  `identify` reads the session from `req.headers.cookie`.
- **A header.** `fetchTransport({ baseUrl, headers })` adds the headers to every call (a token your game already has, or a CSRF header).
  The headers are fixed when the transport is made; for a token that changes, make the transport on each call:

```ts
import { fetchTransport, createPlayerClient } from '@chatwarden/player-react';
import type { Transport } from '@chatwarden/player-react';

declare function currentSessionToken(): string;

// A new fetchTransport per call, so the header is always the current token.
const rotating: Transport = (req) => fetchTransport({ baseUrl: '/player', headers: { 'x-chatwarden-key': currentSessionToken() } })(req);

export const client = createPlayerClient({ transport: rotating });
```

The key in a header or cookie is a credential: keep it out of URLs and logs, and have `identify` read it from there (the kit hashes it and
keeps nothing raw). A caller `identify` cannot name gets empty lists and a `200`, never someone else's record.

## Content Security Policy

The components need no `'unsafe-inline'` and no `'unsafe-eval'`. They inject no `<style>`, set no inline `style` attribute, use no
`dangerouslySetInnerHTML` and load no third-party resource. Allow:

- `script-src`: where your game's bundle is served from.
- `style-src`: where `styles.css` is served from (`'self'`, or a hash if you inline it yourself).
- `connect-src`: the origin of the player routes (`'self'` when they are under the same origin, as above).

## Options

Every component also takes `t`, `locale`, `now`, `timeZone`, `theme` and `className` (see [Words and languages](#words-and-languages) and
Theming).

### Components

| Component | What it shows | Props besides the common ones |
| --- | --- | --- |
| `NoticeQueue` | The pending notices, oldest first, one at a time in a modal dialog. A warning has an Acknowledge button; every other notice has Got it. Both call `POST /notices/:id/ack`. Nothing is rendered when there is nothing to show. | `client`, `canShow` (default `true`), `appealUrl`, `refreshKey`, `onAcknowledged(notice)`, `onPendingChange(count)` |
| `MyRecord` | What is on the player's record now, newest first, from `GET /record`; or "Your record is clear". | `client`, `appealUrl`, `refreshKey` |
| `RulesPage` | The summary and the numbered rules from `GET /rules`. The numbers are the kit's: a retired rule leaves a gap. | `client`, `refreshKey` |
| `ReportDialog` | A one-step report: "Report this message?", the line, an optional "Why?" select (the studio's reasons in groups; required in the reason-required flow) and a note behind "Add a note". Maps every refusal the kit has to its own plain message and shows how many reports are left today. | `onSubmit(draft)` returning a `ReportResult`, `onClose`, `reporting` (from `GET /rules`), `line`, `targetName`, `extra` (experimental: your own controls in the form) (`onAddDetail` is deprecated and unused) |
| `RestrictedChatLine` | One line for where a chat box would be: why the player cannot type and until when; or, with `pace`, a pause (slow mode, too many lines, the same line again) and how long to wait, with no referee card. | `until` (epoch ms or `null`), `byModerator`, `refCode`; or `pace` (`{ reason: 'slow_mode' \| 'flood' \| 'duplicate', retryAfterMs }`, `@experimental`, new in 0.1.8: the refusal's own values; the end is worked out once on the first render) |

- **The hold.** `canShow={false}` keeps notices and shows nothing, so a notice never interrupts a match. They are kept, not dropped and
  not acknowledged, and appear in order when `canShow` turns `true`. The list is asked for once more at that moment, so a warning that
  landed during the match is shown before the next one. `onPendingChange(count)` tells your game how many are waiting.
- **Focus.** A dialog moves focus to its heading when it opens and keeps it inside: Tab wraps at the ends (a radio group counts as one
  stop), a click on the backdrop does not move focus, and anything outside that takes focus is sent back. When the last notice closes
  focus goes back to what had it. If that element is gone, focus goes to `returnFocusTo()` when you pass one, and otherwise to the page
  body. Escape does not dismiss a notice (it has to be acknowledged); it closes the report dialog, unless a report is on its way.
- **Acknowledge.** One request at a time: a second click while one is on its way does nothing. A failed request keeps the notice and
  says why, inline; the main button tries again. If it keeps failing, **Close for now** closes the dialog without acknowledging: the
  notices stay pending and come back on the next refresh (`refreshKey`) or the next release of a hold. A 404 means it is already done,
  so the notice closes. A new notice that arrives while the dialog is open is announced to screen readers (`aria-live="polite"`).
- **The appeal link.** `appealUrl` makes "Think this is a mistake?" a link on a warning, restriction or ban. It must be an `https:`
  address or a relative one (`/appeal`); anything else (`http:`, `javascript:`, `//host`, spaces, control characters, a backslash, an
  entity) is left out. It is the same rule hub-react uses for links, and a test runs both on one table.
- **The report dialog.** Render it when the player chooses to report, and unmount it in `onClose`. A refusal is a result, not an
  error: `duplicate`, `rate`, `self`, `not_player`, `off` and `suspended` each have their own message. Reject from `onSubmit` only
  when no answer arrived; the dialog keeps what was typed and offers to send again.
- **Where the dialog is drawn.** It is `position: fixed`, drawn in place. If an ancestor of the component has a `transform`, `filter`,
  `contain` or `will-change: transform`, the browser makes the dialog relative to that ancestor and it can be clipped or off-centre. Pass
  `container={document.body}` (or a layer of your own) to `NoticeQueue` or `ReportDialog` to draw it there instead; the theme and
  `className` still apply, and tokens set on `body` or `:root` reach it (see Theming).
- **Refreshing.** Change `refreshKey` to ask the server again, for example when your own push channel says a notice is pending.

### `PlayerClient`

`createPlayerClient({ transport })` gives four methods over the kit's player routes. They resolve with typed values and reject with a `PlayerError`
(`status`, `code`, `retryAfter`). The types are the kit's own (`PlayerNotice`, `ReportResult`, `ReportRefusal`).

| Method | Route |
| --- | --- |
| `notices()` | `GET /notices` |
| `ack(id)` | `POST /notices/:id/ack` (`true`, or `false` for a notice that is not the caller's or is gone) |
| `record()` | `GET /record` |
| `rules()` | `GET /rules` |

### Transports

A transport is `(request) => Promise<{ status, headers, body }>`. It resolves for any HTTP status and rejects only when no answer
arrived. The type is the same as the one in `@chatwarden/hub-react`, written out here so this package does not depend on that one; a
test keeps the two assignable both ways.

- `fetchTransport({ baseUrl, headers?, credentials?, fetch? })`: `fetch` against the routes your server mounts.
- `routerTransport(handle, { headers? })`: calls `createRouter(playerRoutes(...))` in the same process, for a demo or a test.

### Words and languages

Every word the components show is a key in the English catalog (`en`), named `player.<area>.<thing>`. Plural forms add the plural
category last (`player.report.remaining.one`, `.other`) and are chosen by `Intl.PluralRules` for the `locale`. To translate, spread English
under your text so a gap falls back to English instead of showing a key:

```ts
import { createT, en } from '@chatwarden/player-react';

const de = { 'player.notice.acknowledge': 'Verstanden', 'player.notice.gotIt': 'Okay' };
export const t = createT({ ...en, ...de }, 'de');
```

Pass it as `<NoticeQueue t={t} locale="de" ... />`. Dates and times use `Intl` with the same locale; pass `timeZone="UTC"` to show a
fixed zone, or leave it out to use the player's own. The copy is written for a player in the middle of a game: second person,
plain words, never shaming, and it says what happened, until when, and what the player can do.

## The chat box

`<ChatBox>` is a moderated chat for one room: the list, one input and Send. It lives at its own subpath, `@chatwarden/player-react/chat`
(with `@chatwarden/player-react/chat.css`), so the main entry and its size are untouched; a page that never shows chat never loads it.
The server side is `createRoomBroadcaster` and `chatRoutes` in `@chatwarden/http` (see its README, "Chat"). Every name here is
`@experimental` until 0.2.

```tsx
import '@chatwarden/player-react/styles.css';
import '@chatwarden/player-react/chat.css'; // load both: chat.css adds three tokens and the box's rules on top of styles.css
import { createPlayerClient, fetchTransport, NoticeQueue } from '@chatwarden/player-react';
import { ChatBox, sseTransport } from '@chatwarden/player-react/chat';
import { useEffect, useMemo, useState } from 'react';

export function Lobby() {
  // Make the transport once (useMemo or module scope). The connection opens when the box mounts and when `room` changes.
  const transport = useMemo(() => sseTransport({ baseUrl: '/chat', credentials: 'same-origin' }), []);
  const client = useMemo(() => createPlayerClient({ transport: fetchTransport({ baseUrl: '/player' }) }), []);
  const [reporting, setReporting] = useState<Awaited<ReturnType<typeof client.rules>>['reporting']>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => void client.rules().then((r) => setReporting(r.reporting)), [client]);
  return (
    <>
      <ChatBox transport={transport} room="lobby" reporting={reporting} onNoticePending={() => setRefresh((n) => n + 1)} />
      <NoticeQueue client={client} refreshKey={refresh} />
    </>
  );
}
```

The transport reads the stream with `fetch`, not `EventSource`, so your header-based auth works. **One player may have three streams (tabs)
open in a room by default** (`maxStreamsPerMember` on the server): a fourth ends the oldest, and that box says "Chat is open in another
window." with a "Try again" button instead of reconnecting by itself, so tabs over the limit never push each other out in a loop. A game with its own socket implements
`ChatTransport` (`open(room, events)` returning `{ send, mute, report, close }`) and hands the same frames to `events.frame`.

To load it only when a player opens the chat, import it lazily. It is one chunk and nothing in it runs until `ChatBox` is rendered:

```ts
import type { ChatBoxProps } from '@chatwarden/player-react/chat';

export async function loadChatBox(): Promise<(props: ChatBoxProps) => unknown> {
  const { ChatBox } = await import('@chatwarden/player-react/chat');
  return ChatBox;
}
```

### What the player sees

The always-visible box is the list, one input and Send, and one small control at the corner (Chat options). A line from another player
has one quiet control (visible on hover and focus, and always, dimmed, on a touch screen) that opens Report and Mute. Chat options holds
the muted players (each with Unmute), the profile's one-line standard and, when you pass `onOpenRules`, a Read the rules button. Nothing
else is added.

- **A refusal** is one line under the input, with the draft kept: too long (with the limit), too fast, not allowed here, blocked (with
  "Community Rule N"), swearing, and the pacing reasons with their wait (Send holds until it ends). The line clears on the next
  keystroke or after 8 seconds. A refusal is shown to its author only.
- **A restriction** replaces the input with `RestrictedChatLine` and the input returns by itself when it ends. A ban, a closed room and
  the other ways the stream can end for good show one sentence and no input, with a Try again button (except for a ban).
- **Connection.** A quiet line appears only while reconnecting. The box reconnects with jittered back-off, drops a stream that has gone
  silent for 2.5 heartbeats, and starts over at once when the browser says it is online again.

### Accessibility

Stated plainly, as designed: the list is `role="log"` with a name (`title`, default "Chat") and is focusable. The log is not live until
the first snapshot has rendered, so joining does not read 50 lines aloud; after that **every line that arrives is announced politely,
your own included**. In a very busy room that is a lot of speech, and there is no setting for it in this release. There is one tab stop
per line from another player (its options control), so the Tab order is the log, those controls, the input, Send, Chat options. Escape
closes an open row or panel and returns focus to its control; the report dialog is the existing modal with its focus trap and focus
return. The connection line, the refusal line and the mute line are `role="status"` regions that exist before they have text. Targets are
at least 2.25 rem tall, every colour pair meets 4.5:1 in both schemes, and no information is colour alone. A line is a text node, read as
"name: text"; there is no markup, link detection or markdown.

### Props

| Prop | What it does |
| --- | --- |
| `transport` | `sseTransport({ baseUrl })` or your own `ChatTransport`. A new transport object on a later render does not reopen the stream; change the box's `key` to reconnect with a changed one |
| `room` | The room id your server's `join` understands. A new `room` closes the connection and opens another |
| `reporting` | `(await client.rules()).reporting`, passed to `ReportDialog`. Without it a report is one press |
| `title` | The log's name. Default: the word "Chat" |
| `onNoticePending()` | The server says a notice is waiting, or a refusal points at one: bump your `NoticeQueue` `refreshKey` |
| `onRefused(refusal)` | Each refusal of the player's own line, for sound or telemetry. Never the text |
| `onStatus(status, why?)` | `connecting`, `open`, `reconnecting`, `closed` (with `banned`, `forbidden`, `unauthorized`, `room_closed`, `shutdown`, `not_found` or `unsupported`) |
| `onOpenRules()` | When given, Read the rules appears in Chat options and calls it |
| `maxLines` | Lines kept in the page: 200 by default, at most 5 000 |
| `autoFocus` | Focus the input when the box appears. Default `false`: a chat must not steal focus from a game |
| `readOnly` | No input: a viewer who may read but not speak |
| `container`, `returnFocusTo` | For the report dialog, as on `ReportDialog` |

`sseTransport({ baseUrl, headers?, credentials?, fetch?, retry?, staleMs? })` takes `FetchTransportOptions` plus `retry: { initialMs,
maxMs }` (default 1 000 and 30 000, each retry waits a random time up to double the last, never under 100 ms) and `staleMs` (how long a
silent stream is kept; default 2.5 times the heartbeat the server announces). `401` and `403` are not retried, `404` and an answer that is
not an event stream end the chat with `not_found` and `unsupported`, and `429` and `503` wait for `retry-after`.

### Words

The chat words are `enChat` (keys `player.chat.*`), kept apart from `en` so the main entry does not carry them. **A host that translates
chat spreads `enChat` too:** `createT({ ...en, ...enChat, ...de }, 'de')`. The box falls back to the English chat words for any key the
catalog it is given lacks, so a translation made before the chat existed shows English, not a key. It also reuses the report dialog's and
the restricted line's words.

### Chat theming

`chat.css` follows the contract above: every rule under `.cw-player`, every colour and space a `--cw-*` token read with a private default.
It adds three tokens of its own, and uses the colours of `styles.css`:

| Token | Default | What it is |
| --- | --- | --- |
| `--cw-chat-height` | `20rem` | The height of the list. Set it on the box's `className` to resize the box |
| `--cw-chat-gap` | `0.25rem` | The space between two lines |
| `--cw-chat-name-width` | `auto` | The width of a name, for a game that wants the names aligned |

Colour is used only where it means something: the accent for the player's own name and Send, red for a failure line.

### Size

Measured with React, React DOM and the kit external, minified and gzipped: the chat adds about 8 KB to a page that already has the
player components, the chat entry on its own is about 15 KB, and `chat.css` is about 2 KB. The main entry stays under its own 11 KB budget.

### The chat names

`ChatBox`, `sseTransport`, `chatReducer`, `createChatState`, `initialChatState` and `readFrame` (the pure parts, for a game's own UI),
`enChat`, and the types `ChatBoxProps`, `ChatRefusal`, `ChatTransport`, `ChatConnection`, `ChatTransportEvents`, `ChatStatus`,
`ChatClosedWhy`, `SseTransportOptions`, `ChatFrame`, `WireLine`, `WireMuted`, `WireRefusal`, `WireRestriction`, `SendResult`,
`MuteResult`, `MuteTarget`, `ChatState` and `ChatAction`. All are `@experimental` until 0.2.

## Theming

The components ship one stylesheet, `@chatwarden/player-react/styles.css`. Import it once (a bundler, or a `<link>`). Every colour, size,
radius and space is a `--cw-*` custom property, with a light and a dark value, and every rule is scoped under `.cw-player`.

- **Three inputs make it yours.** Set `--cw-surface` (the base: panels and the dialog), `--cw-accent` (your next action, links and
  the focus ring) and `--cw-radius` (how round things are) on any element above the components, on `.cw-player`, or on the `className` you
  pass (see "Re-theme it"). Every other token has a default that works on them. The font is yours already: the components inherit it, and `--cw-font` is only there if you want another.
- **Light and dark.** By default the components follow the player's `prefers-color-scheme`. The `theme` prop (or `data-cw-theme="light"`
  or `"dark"` on `.cw-player` or any ancestor) forces one. Set it from your game's own setting.
- **Re-theme it.** Set a token on any element above the components (`body`, `:root`, a wrapper around your game's UI), on `.cw-player`, or on
  the `className` you pass: `body { --cw-accent: #7a2e8a }` themes every component alike. The stylesheet never declares a public `--cw-*`
  name on `.cw-player` (that would hide what you set above it): its defaults sit under private `--cwd-*` names at zero specificity
  (`:where(.cw-player)`), so any rule of yours wins whatever its order, and every rule reads `var(--cw-x, var(--cwd-x))`, your value if
  there is one, ours if not. Set `--cw-*` names only; the `--cwd-*` ones are not part of the contract. A dialog drawn into another
  `container` has its own root there, so a value set on a wrapper around the component does not reach it: set the token on `body` or
  `:root`, or on the `className` you pass.
- **Strict CSP.** The stylesheet is a file. The components inject no `<style>`, set no inline `style` and use no `dangerouslySetInnerHTML`.
- **Browsers.** The colours use `light-dark()` (Chrome 123, Firefox 120, Safari 17.5, all 2024). Older browsers that lack
  `light-dark()` get the light colours from a fallback block in the stylesheet, so the components keep their colours; they follow
  neither the player's dark setting nor the `theme` prop.

```css
/* On any element above the components: the whole page, a wrapper around your game's UI, or the className you pass. */
body {
  --cw-surface: light-dark(#fffaf0, #1d1a14);
  --cw-accent: light-dark(#7a2e8a, #d9a3e6);
  --cw-accent-ink: light-dark(#ffffff, #2a0f31);
  --cw-radius: 2px;
}
```

**Colour only where it means something.** The accent is your next action, a link, a choice you made and the focus ring. Red is a failure
and the red side of a referee card. Yellow is the yellow side of a referee card. Everything else is neutral.

The one signature detail is the referee card, the same as in the moderator hub, so a sanction looks the same to staff and to the player:
a yellow card for a warning, half yellow and half red for a restriction, red for a ban. The words always say the same as the card, so
colour is never the only signal. Every text token is at least 4.5:1 against every surface it is drawn on, in both themes; a test computes
it from the values below.

| Token | Default (light, dark) | Used for |
| --- | --- | --- |
| `--cw-surface` | `#ffffff`, `#151c28` | The base: panels, the dialog, buttons. |
| `--cw-surface-sunken` | `#eef0f4`, `#111722` | Hover fill, wells, the player's own lines. |
| `--cw-border` | `#e0e3ea`, `#242d3c` | Hairlines around panels and fields. |
| `--cw-border-strong` | `#7a8397`, `#6b7893` | The border of a field or a button (3:1 against the surface). |
| `--cw-ink` | `#151b27`, `#e8ebf1` | Body text. |
| `--cw-ink-muted` | `#4f5a6e`, `#9ba4b6` | Secondary text, labels. |
| `--cw-accent` | `#2950d3`, `#7d9bff` | Your next action: the primary button, links, a chosen category, the focus ring. |
| `--cw-accent-ink` | `#ffffff`, `#0e131c` | Text on an accent background. |
| `--cw-accent-soft` | `#e7ecfb`, `#1d2847` | The background of the chosen category. |
| `--cw-red` | `#c42f3b`, `#ff6b74` | A failure, and the red side of a referee card. |
| `--cw-red-soft` | `#fbe4e6`, `#3a1a1f` | The background of an error. |
| `--cw-yellow` | `#e5ad00`, `#f2c84b` | The yellow side of a referee card. Nothing else is yellow. |
| `--cw-shadow-ink` | `#151b27`, `#000000` | What the shadow and the dimmed backdrop are made from. |
| `--cw-font` | not set (inherits) | The font. Left unset on purpose, so it is your game's own; set it to use another. |
| `--cw-text-s` | `0.8125rem` | Small text: labels, facts, hints. |
| `--cw-text-m` | `0.9375rem` | Body text. |
| `--cw-text-l` | `1.125rem` | Titles. |
| `--cw-leading` | `1.5` | Body line height. |
| `--cw-radius` | `10px` | Panels and the dialog. |
| `--cw-radius-s` | `6px` | Buttons, fields and lines. |
| `--cw-border-width` | `1px` | Every border. |
| `--cw-space-1` | `0.25rem` | Smallest gap. |
| `--cw-space-2` | `0.5rem` | Small gap. |
| `--cw-space-3` | `0.75rem` | Medium gap. |
| `--cw-space-4` | `1rem` | Standard padding. |
| `--cw-space-5` | `1.5rem` | Large gap, the dialog padding. |
| `--cw-control-height` | `2.5rem` | Minimum height of buttons and choices. |
| `--cw-dialog-width` | `30rem` | The widest a dialog gets (it is never wider than the screen). |
| `--cw-layer` | `1000` | The stacking order of the dialog, above your game. |

## Security notes

- **Nothing else about anyone reaches the page.** The components show only what `GET /notices` and `GET /record` return: the rule, the
  end, the reference code (`M-XXXXX`) and the player's own lines. They keep only those fields and drop the rest, so no person ref, room id,
  moderator, reason or other player's name is in the markup, even if a server sent one. The notice id is a handle for the acknowledge call
  and is never put in the page.
- **The player's lines are text.** They are rendered as text, never as HTML, whatever they contain. The kit has already masked any blocked
  word in them (`******`); the components show that as it is.
- **Rules and the report note are text too.** Markup in a rule title or a summary is shown as the characters it is.
- **The appeal link is checked.** Only an `https:` address or a relative one becomes a link (hub-react's rule: no `http:`, no whitespace or control characters, no backslash, no entity, no `//host`), and it opens with
  `rel="noopener noreferrer"`.
- **Who is asking is the server's job.** The player routes read the caller from your `identify` hook, never from the page. The components
  send no identity of their own. Keep the routes behind your own session, and keep `cache-control: no-store` (the kit sends it) through any proxy.
- **Reports are limited on the server.** The kit refuses a duplicate, a report against yourself, an empty seat and more reports than the
  daily limit, and the dialog says so in plain words; none of this depends on the page.
- **Server text is not echoed.** Error messages come from the components' own catalog, not from the response body.
- **Content-Security-Policy.** Nothing is injected at run time. Allow the stylesheet file and, if the components call another origin,
  that origin in `connect-src`.

## Links

- [Apache-2.0 license](https://github.com/hainix/chatwarden/blob/main/LICENSE)
- [Player API routes](https://github.com/hainix/chatwarden/tree/main/packages/http#the-routes)
- [Source and other packages](https://github.com/hainix/chatwarden)
- [Issues](https://github.com/hainix/chatwarden/issues)
