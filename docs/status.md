# Status

Updated 2026-11-11. The full roadmap and the reasoning behind it: [design/2026-11-09-product-scope.md](design/2026-11-09-product-scope.md).

## Shipped
| Phase | What | Where |
| --- | --- | --- |
| K0+K1 | Foundation: hasher, stores, subjects, evidence, matcher, live terms, sanctions, mutes, strikes, chat, reports, doors, retention, facade, tiny-chat | PR #1 |
| K2 | Community Rules, warnings, the ladder, player notices | PR #2 |
| K3a | Moderation standards (conduct levels, profiles relaxed/standard/strict), guidelines, generated documents, profanity package | PR #3 |
| K3b | HTTP staff and player routes, roles and permissions, audit, signed webhooks, Discord feed | PR #4 |
| KR | Release readiness; 0.1.0 published | PR #5 |
| K8a | Browser-ready core, store-memory; 0.1.1 published | PR #7 |
| K8b | chatwarden.dev landing site with a live demo | PR #9, #11 |
| K4 | Moderator hub (`hub-react`: team workbench, Simple mode, settings, four ways to adopt), `player-react`, `hub-element`; editable steps and ladder; configurable one-tap reporting; site demo on the real hub. Releases as 0.1.2 | PR #12 |

## Next
- **K3c: AI levels 1-2** (read and recommend). Every human decision becomes a casebook example; granted appeals become corrective
  false-positive examples and feed a per-rule false-positive rate.
- **K6b-d: Moxgate adopts the hub and player UI.**
- **Roadmap items** chosen 2026-11-10, each to be designed before it is built:
  - offensive names
  - an appeals inbox
  - slow mode and flood control
  - generic game signals (for example `muted_by_player` or `kicked_from_room`), feeding the record, the ladder rules and the AI read.

  Sketches: [design/2026-11-10-editable-ladder-and-roadmap.md](design/2026-11-10-editable-ladder-and-roadmap.md), Part 2.
- **Later phases:** K4b init CLI, K5 Coop adapter, K7 term corpus service.

## 0.1.3
Ready, not published (the owner tags it: see [RELEASING.md](../RELEASING.md)). A hardening patch on branch `hardening-0.1.3`:
- The matcher no longer ships obscenity's English word list to browsers (issue #8), and `obscenity` is a devDependency of the matcher.
- SQLite migration 18: indexes on `kit_sanctions(starts_at)` and `kit_strikes(at)`.
- Hub: a refresh handle (`onController`, `controller.refresh()`, experimental) and the settings and admin screens load on demand.
- Players report in one step (reason and note inline); `onAddDetail` is deprecated and no longer called; the `extra` slot is experimental.
  The "What players see" picture in the hub shows it. Nothing was removed from the exported catalogues (the unused words are deprecated).
- The site demo follows the one-step dialog and no longer scrolls sideways at 320 px; its word-list workaround is gone.

## Open follow-ups
- `/sanctions` makes one reports read per person (bounded at 200).
- Unsaved settings are not guarded against the browser Back button or a typed URL (documented).
- hub-element ships two near-identical bundles (`dist/hub-element.js` and `dist/index.js`, about 684 KB each). Left as it is in 0.1.3:
  making `hub-element.js` a two-line module that imports `./index.js` would break the documented one-file use (the README tells people to
  copy that one file, "no imports, so it works from any path"), add a second request in series on a CDN, and change what a patch ships.
  Do it in a minor, with the README and the CSP notes changed with it.
- Remove the deprecated words from `en` and `PlayerText` (player-react) and the six preview words of the hub's `en`, and the
  `onAddDetail` prop, in a later minor.
- Parked items from earlier phases: [plans/follow-ups.md](plans/follow-ups.md).
