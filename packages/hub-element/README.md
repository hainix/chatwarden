# @chatwarden/hub-element

The moderator hub for Chatwarden, the open-source chat moderation kit for games, as one custom element: `<chatwarden-hub>`. One
script tag and one element put the full hub on any page: plain HTML, Vue, Svelte, or a server-rendered admin page. React is inside
the script, so the page needs no build step and no framework.

Status: pre-release, as-is, no support promise.

## Quick start

On your server you already mount the kit's staff routes at `/admin` (see `@chatwarden/http`). On the page that moderators open,
add the script and the element:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@chatwarden/hub-element@0.1/dist/hub-element.js"></script>
<chatwarden-hub base-url="/admin"></chatwarden-hub>
```

That is the whole integration. The hub asks `GET /admin/me` first and shows only what the signed-in role can use. The page's
cookies go along with each call to the page's own origin, so whatever signs your moderators in to `/admin` signs them in here. A signed-out visitor (401) or
an account with no access (403) gets a plain message inside the element.

The hub fills the height of the window by default. Give the element a height of your own with `--cw-hub-height` (see "Theming").

To serve the script yourself instead of from a CDN, install the package (below) and copy `node_modules/@chatwarden/hub-element/dist/hub-element.js`
to your static files. It is one file with no imports, so it works from any path.

## Install

```sh
npm install @chatwarden/hub-element
```

You need this only to self-host the script, to use the element from a bundler, or to get its types. It has no required peer
dependency: React, react-dom, `@chatwarden/hub-react` and the part of `@chatwarden/core` the hub uses are bundled into the script.
`@chatwarden/hub-react` is an optional peer, for TypeScript users who want the `client` property's type
(`npm install @chatwarden/hub-react`). Node 22.13 or newer for the tooling; the script itself runs in a browser and imports
no `node:` module.

## Attributes

Changing an attribute draws the hub again; the hub keeps its place. A value that is not allowed falls back to the default and logs
one `console.warn` that names the attribute.

| Attribute | Values | Default | What it does |
| --- | --- | --- | --- |
| `base-url` | an address | `/admin` | Where the kit's staff routes are mounted: `/admin` on your origin (or a full address, see below). Ignored when the `client` property is set. |
| `mode` | `simple`, `detailed` | the moderator's last choice, else `simple` | `simple` is one card per case, for a team of one or two; `detailed` is the full workbench. Set it to fix the mode and hide the switch. |
| `theme` | `auto`, `light`, `dark` | `auto` | `auto` follows the visitor's `prefers-color-scheme`. |
| `locale` | a language tag such as `en` or `pt-BR` | `en` | The language of dates, times and numbers. The words stay English unless you give a `t` function. |
| `game-name` | text | none | Your game's name, shown beside the product name in the top bar. |
| `shortcuts` | `true`, `false` | `true` | `shortcuts="false"` turns every keyboard shortcut off, for a page that has its own. |
| `primary` | present, `true`, `false` | off | Which element answers keys when nothing on the page has focus, if there are several (see "Keyboard shortcuts"). |
| `router` | `hash`, `memory` | `hash` | `hash` keeps the hub's place in the page's URL hash, so the back button and a bookmark work. `memory` keeps it inside the element and never touches the URL. |

Calls go with `credentials: 'same-origin'`: cookies are sent to the page's own origin only, so a `base-url` on another origin carries no
cookies. For another origin, set the `client` property with `credentials: 'include'` (see "Properties"). `base-url` is trusted and not
checked: whoever can set the attribute chooses where the staff calls go. That is no extra boundary, since any script on the page already
controls the hub.

Several hubs on one page: hubs on `router="hash"` share the page's one URL hash, so they all show the same screen. Put `router="memory"` on all but one.

## Properties

Two things cannot be attributes, so they are properties of the element.

| Property | Type | What it does |
| --- | --- | --- |
| `client` | `HubClient` | A ready staff client. When set, it is used instead of `base-url`. Use it for another origin, a CSRF header, or a custom transport. Set it back to `null` to return to `base-url`. |
| `t` | `HubT` | The words. Build one with `createT({ ...en, ...yours }, locale)` from `@chatwarden/hub-react`. Left unset, the hub is in English. |

```js
import { createHubClient, fetchTransport } from '@chatwarden/hub-react';

const hub = document.querySelector('chatwarden-hub');
// Cookies go to another origin, and a CSRF header goes with every call.
hub.client = createHubClient(
  fetchTransport({ baseUrl: 'https://ops.example/admin', credentials: 'include', headers: { 'x-csrf-token': token } }),
);
```

You can set a property before the script has loaded; the element picks it up when it is defined.

## Events

Both events bubble and are composed, so they cross the shadow root: listen on the element, on `body` or on `document`.

| Event | `detail` | When |
| --- | --- | --- |
| `cw-navigate` | `{ route, path }` | When the hub first shows, and each time it moves to another screen. `path` is the hub's own path (`/reports/abc`); `route` is the same thing parsed (`{ name: 'report', id: 'abc' }`). |
| `cw-decided` | `{ reportId, verdict }` | When the server has taken a decision. `verdict` is `upheld`, `noted`, `no_action` or `bad_faith`. |

```js
const hub = document.querySelector('chatwarden-hub');

hub.addEventListener('cw-decided', (event) => {
  console.log(`report ${event.detail.reportId}: ${event.detail.verdict}`);
});
hub.addEventListener('cw-navigate', (event) => {
  document.title = `Moderation ${event.detail.path}`;
});
```

The `cw-navigate` detail, and the URL hash the `hash` router keeps, carry full person references (`/people/<ref>`), not the 8-character tags the
hub shows. The hash lands in browser history and in anything that records `location.hash`, so keep the page to your own moderators.

A decision is held for five seconds so the moderator can press Undo. `cw-decided` fires when it is sent and accepted, not when the
button is pressed. A decision the server refused, or one it had already recorded (a replay), fires nothing. If the element is
removed while a decision is held, the hub sends it at once (see "Lifecycle") and the event fires on the element, which is no longer
in the page, so listen on the element itself to catch that one.

## Lifecycle

The hub draws when the element is connected to the page and takes itself down when the element is removed. Removing it disposes the
hub's controller, which sends any decision still held for Undo at once, with `keepalive`, so a moderator who closes the panel does
not lose it. Moving the element to another place in the DOM is not a removal: the same hub carries on, with its Undo hold intact.

## Theming

The hub lives in a shadow root, so no CSS from your page reaches it (a `button { color: red }` rule does nothing here) and none of
its CSS reaches your page. What does pass in is CSS custom properties: they inherit through the shadow boundary. Set `--cw-*`
values on the element, or on any ancestor, in your page's CSS:

```css
chatwarden-hub {
  --cw-accent: #0a7d5c;
  --cw-radius-m: 4px;
  --cw-hub-height: 720px;
}
```

| Property | What it sets |
| --- | --- |
| `--cw-bg`, `--cw-surface`, `--cw-surface-sunken` | The page behind the hub, its panels, and the sunken wells. |
| `--cw-border`, `--cw-border-strong` | Lines between things, and the border of a control. |
| `--cw-ink`, `--cw-ink-muted`, `--cw-ink-faint` | Text, at three strengths. |
| `--cw-accent`, `--cw-accent-ink`, `--cw-accent-soft` | The one accent (the primary button, a selection, focus), the text on it, and its tint. |
| `--cw-red`, `--cw-yellow`, `--cw-live` | Overdue and bans, warnings, and the connection dot. |
| `--cw-font`, `--cw-font-mono` | The typefaces. |
| `--cw-radius-s`, `--cw-radius-m`, `--cw-space-1` to `--cw-space-6` | Corner radius and spacing. |
| `--cw-hub-height` | The height of the hub. Default `100dvh`; use a length such as `720px` to make it a panel. |

Every token in `@chatwarden/hub-react`'s `styles.css` works the same way. A value you set is one value for both schemes: to theme
light and dark differently, set the property inside `@media (prefers-color-scheme: dark)`, or use the `theme` attribute and your own
selector. The element is `display: block` and `hidden` hides it.

**The font.** The hub uses the system UI font. A `@font-face` rule inside a shadow root is ignored by browsers, so to use Instrument
Sans, load `@chatwarden/hub-react/font.css` in your page (the page's own CSS) and set `--cw-font: 'Instrument Sans', system-ui, sans-serif` on the element.

## Keyboard shortcuts

The hub's shortcuts (J and K to move between cases, N to take the next, `?` for help, Ctrl or Cmd+K for the command bar) work while
focus is inside the element, and never while focus is on a control of your own. Typing in one of the hub's fields never triggers one.

With nothing focused (a page that has just loaded), the element that is the page's hub answers: the only one with shortcuts on, or,
with several, the one with the `primary` attribute. With several and none marked, none does until focus is in one of them. Escape is
only ever the hub's own, when focus is inside it.

Each hub hears only its own keys. With several hubs on one page, a key pressed in one reaches that hub and no other, and
`shortcuts="false"` turns the keys off for one hub without touching the rest (it is not counted when the page's hub is chosen). A `<chatwarden-hub>` inside another shadow root (your own
web component's) works the same way: its focus, its keys and the focus return after a window closes are read from the element's own
shadow root, not from your component's.

## Content Security Policy

The script has no `eval` and loads nothing else. Under a strict policy, allow:

- `script-src`: the place you load the script from (`https://cdn.jsdelivr.net`, or `'self'` when you serve it yourself).
- `connect-src`: your staff routes (`'self'` for `/admin` on the same origin).

The hub's CSS is inside the script as a string and is adopted into the shadow root as a constructable stylesheet
(`adoptedStyleSheets`). That needs no `'unsafe-inline'`. A browser too old to have constructable stylesheets (before Chrome 73,
Firefox 101 or Safari 16.4) gets a `<style>` element in the shadow root instead, and that needs `style-src 'unsafe-inline'`; without
it the hub is drawn unstyled. Nothing is ever added to your page's `<head>`.

## Use it from a bundler

If your build already bundles dependencies, import the module and register the element yourself. Nothing is registered until you
call `defineChatwardenHub`. The module is the same self-contained script without the registration, so it also brings its own copy of
React; if your page already runs React, use `@chatwarden/hub-react` and its `<Hub>` component instead, and pay for the hub only.

```ts
import { defineChatwardenHub, VERSION } from '@chatwarden/hub-element';
import { createHubClient, fetchTransport } from '@chatwarden/hub-react';

// Register under the default name, <chatwarden-hub>, or give another. Calling it twice is safe, and so is a tag that is taken:
// the class that owns it is returned.
export const Element = defineChatwardenHub('ops-hub');

// A client for the `client` property.
export const client = createHubClient(fetchTransport({ baseUrl: 'https://ops.example/admin', credentials: 'include' }));
export const version: string = VERSION;
```

```js
import { defineChatwardenHub } from '@chatwarden/hub-element';
import { createHubClient, fetchTransport } from '@chatwarden/hub-react';

defineChatwardenHub();
const hub = document.createElement('chatwarden-hub');
hub.setAttribute('mode', 'detailed');
hub.client = createHubClient(fetchTransport({ baseUrl: 'https://ops.example/admin', credentials: 'include' }));
document.body.append(hub);
```

`@chatwarden/hub-element/standalone` is the self-registering script as a module, for a bundler that should register `<chatwarden-hub>` on
import (its entry is listed under `sideEffects`, so a bare `import '@chatwarden/hub-element/standalone'` is kept). Where there is no
`customElements` (a server), `defineChatwardenHub` registers nothing and returns the class, so importing the package in server code is safe.

## Size

`dist/hub-element.js` is about 640 KB minified, about 175 KB gzipped and about 148 KB with brotli, with React, react-dom, the whole hub and
its stylesheet in it. A test holds it under 185 KB gzipped. The cost is the price of needing nothing else on the page; a team that already ships React
pays far less with `@chatwarden/hub-react`.

## Security notes

- The hub shows opaque person tags (the first 8 characters of a reference), never accounts, keys or IPs. Everything it shows comes
  from your staff routes, so they must stay behind your own sign-in: the element is a view over them and decides nothing about who
  may use them.
- The shadow root is `open`: scripts on your page can reach inside it. It keeps styles apart, not secrets.
- Pin the CDN version (`@0.1` follows patch releases of 0.1; `@0.1.2` is exact), or self-host the file, so a release you have not looked at
  never loads into a moderator's panel.

## Links

- [Hub React components](https://github.com/hainix/chatwarden/tree/main/packages/hub-react): the same hub as a React component, with pieces and a headless controller.
- [HTTP routes](https://github.com/hainix/chatwarden/tree/main/packages/http): the staff API this element calls.
- [Chatwarden](https://github.com/hainix/chatwarden)
