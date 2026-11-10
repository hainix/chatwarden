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
exist in 18.3 (`useId`, `useRef`), but they are tested only on React 19 so far. `@chatwarden/core` is a peer too, for its types
only: no run-time import of it, or of the HTTP package, is in the bundle. Node 22.13 or newer for the tooling; the components
themselves run in a browser and import no `node:` module.

Your server needs `@chatwarden/http` for the routes the components call (`playerRoutes`). The JavaScript is under 15 KB gzipped
with React external, and the stylesheet under 6 KB.

## Quick start

On the server you already mount the kit's player routes (see `@chatwarden/http`). In the game, make a client once and render what you need.

```ts
import { fetchTransport, playerClient } from '@chatwarden/player-react';

// The player routes are mounted at /player on this origin. Cookies go along with each call: the server decides who is asking.
export const client = playerClient({ transport: fetchTransport({ baseUrl: '/player', credentials: 'same-origin' }) });

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

The report dialog gives your code the category and note; your server adds the room and the seats and calls the kit:

```ts
import type { ReportResult } from '@chatwarden/core';
import type { ReportDraft } from '@chatwarden/player-react';

// `cw` is your createChatwarden(...) instance. Call this behind your own route, for example POST /report: `roomId` and the seats
// come from your session, never from the client.
export function takeReport(roomId: string, mySeat: string, theirSeat: string, draft: ReportDraft): Promise<ReportResult> {
  return cw.reports.submit({
    roomId,
    reporterSeat: mySeat,
    targetSeat: theirSeat,
    category: draft.category,
    ...(draft.note === undefined ? {} : { note: draft.note }),
  });
}
```

```tsx
import { ReportDialog } from '@chatwarden/player-react';

export function ReportPlayer({ name, close }: { name: string; close: () => void }) {
  return (
    <ReportDialog
      targetName={name}
      onClose={close}
      onSubmit={(draft) => fetch('/report', { method: 'POST', body: JSON.stringify(draft) }).then((r) => r.json())}
    />
  );
}
```

## Options

Every component also takes `t`, `locale`, `now`, `timeZone`, `theme` and `className` (see [Words and languages](#words-and-languages) and
Theming).

### Components

| Component | What it shows | Props besides the common ones |
| --- | --- | --- |
| `NoticeQueue` | The pending notices, oldest first, one at a time in a modal dialog. A warning has an Acknowledge button; every other notice has Got it. Both call `POST /notices/:id/ack`. Nothing is rendered when there is nothing to show. | `client`, `canShow` (default `true`), `appealUrl`, `refreshKey`, `onAcknowledged(notice)`, `onPendingChange(count)` |
| `MyRecord` | What is on the player's record now, newest first, from `GET /record`; or "Your record is clear". | `client`, `appealUrl`, `refreshKey` |
| `RulesPage` | The summary and the numbered rules from `GET /rules`. The numbers are the kit's: a retired rule leaves a gap. | `client`, `refreshKey` |
| `ReportDialog` | A category picker and an optional note. Maps every refusal the kit has to its own plain message and shows how many reports are left today. | `onSubmit(draft)` returning a `ReportResult`, `onClose`, `targetName`, `categories` |
| `RestrictedChatLine` | One line for where a chat box would be: why the player cannot type and until when. | `until` (epoch ms or `null`), `byModerator`, `refCode` |

- **The hold.** `canShow={false}` keeps notices and shows nothing, so a notice never interrupts a match. They are kept, not dropped and
  not acknowledged, and appear in order when `canShow` turns `true`. `onPendingChange(count)` tells your game how many are waiting.
- **Focus.** A dialog moves focus to its heading when it opens, keeps Tab inside, and gives focus back to what had it when the last
  notice closes. Escape does not dismiss a notice (it has to be acknowledged); it closes the report dialog.
- **Acknowledge.** One request at a time: a second click while one is on its way does nothing. A failed request keeps the notice and
  says why, inline, with Try again. A 404 means it is already done, so the notice closes.
- **The appeal link.** `appealUrl` makes "Think this is a mistake?" a link on a warning, restriction or ban. It must be an `http(s)`
  address or a path starting with a single `/`; anything else (`javascript:`, `//host`, a bare word) is left out.
- **The report dialog.** Render it when the player chooses to report, and unmount it in `onClose`. A refusal is a result, not an
  error: `duplicate`, `rate`, `self`, `not_player`, `off` and `suspended` each have their own message. Reject from `onSubmit` only
  when no answer arrived; the dialog keeps what was typed and offers to send again.
- **Refreshing.** Change `refreshKey` to ask the server again, for example when your own push channel says a notice is pending.

### `PlayerClient`

`playerClient({ transport })` gives four methods over the kit's player routes. They resolve with typed values and reject with a `PlayerError`
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

## Theming

The components ship one stylesheet, `@chatwarden/player-react/styles.css`. Import it once (a bundler, or a `<link>`). Every colour, size,
radius and space is a `--cw-*` custom property, with a light and a dark value, and every rule is scoped under `.cw-player`.

- **Three inputs make it yours.** Set `--cw-surface` (the base: panels and the dialog), `--cw-accent` (your next action, links and
  the focus ring) and `--cw-radius` (how round things are) on `.cw-player`, or on the `className` you pass. Every other token has a
  default that works on them. The font is yours already: `--cw-font` is `inherit`.
- **Light and dark.** By default the components follow the player's `prefers-color-scheme`. The `theme` prop (or `data-cw-theme="light"`
  or `"dark"` on `.cw-player` or any ancestor) forces one. Set it from your game's own setting.
- **Re-theme it.** The defaults sit at zero specificity (`:where(.cw-player)`), so any rule of yours wins whatever its order.
- **Strict CSP.** The stylesheet is a file. The components inject no `<style>`, set no inline `style` and use no `dangerouslySetInnerHTML`.
- **Browsers.** The colours use `light-dark()` (Chrome 123, Firefox 120, Safari 17.5, all 2024). Older browsers that lack
  `light-dark()` get the light colours from a fallback block in the stylesheet, so the components keep their colours; they follow
  neither the player's dark setting nor the `theme` prop.

```css
.cw-player.acme {
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
| `--cw-font` | `inherit` | The font: your game's own. |
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
- **The appeal link is checked.** Only an `http(s)` address or a path starting with a single `/` becomes a link, and it opens with
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
