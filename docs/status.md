# Status

Updated 2026-11-12. The full roadmap and the reasoning behind it: [design/2026-11-09-product-scope.md](design/2026-11-09-product-scope.md).

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
| Triage speed | One-click "Nothing wrong here" with no typed reason, auto-advance with Undo after the move, bulk dismiss, reporter accuracy and the habitual-reporter ranking, keyboard queue mode. Releases as 0.1.5 | PR #20 (plan: [plans/2026-11-11-triage-speed.md](plans/2026-11-11-triage-speed.md)) |

## Chat box (0.1.6; version prepared, not merged or published: the owner tags it, see [RELEASING.md](../RELEASING.md))
A game with no chat adds moderated chat in minutes: `@chatwarden/http` gains a room broadcaster and four routes (Server-Sent Events down, `POST`
up; `@chatwarden/http/chat`), `@chatwarden/player-react` gains `<ChatBox>` and `sseTransport` at the lazy subpath `@chatwarden/player-react/chat`
(its own words, `enChat`, and `chat.css`), and `examples/tiny-chat` has a browser page that uses them. Design:
[design/2026-11-12-chat-box.md](design/2026-11-12-chat-box.md); plan: [plans/2026-11-12-chat-box.md](plans/2026-11-12-chat-box.md). All new names are
`@experimental` until 0.2; no store change, no migration. It needs core 0.1.6, which has `cw.chat.restrictedBySubject`: the `@chatwarden/http` peer floor on core is `^0.1.6` (raised by hand; player-react, hub-react and
hub-element keep theirs). Known limits, written in the READMEs: rooms are per process (sticky rooms, no cross-process bus); every line is announced
politely in the log, with one tab stop per line; a stored automatic chat timeout reads as a moderator's in `hello` until the next refused line.
Not yet: the site demo adopting the box, and the site headline (after the release is on npm); pacing words wait for flood control (plan Task 11).

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

## 0.1.5
Version prepared (`npm run version` run, peer floors raised by hand, `check:pack` and the smoke test green), not merged or published (the owner tags it: see [RELEASING.md](../RELEASING.md)). Faster report triage, all additive (a patch), on branch `triage-speed`:
- **Dismiss.** `reason` is optional for a `no_action` decision with no actions; the kit stores the standard reason `No action needed`
  (`NO_ACTION_DEFAULT_REASON`). The hub's "Nothing wrong here" sends none. Every quick action moves on to the next case; Undo still works
  after the move and `U` undoes the newest waiting decision.
- **Bulk dismiss.** `cw.reports.dismissMany`, `POST /reports/dismiss-open`, new permission `reports.decide.bulk` (moderator), audit actions
  `report.dismiss_case` and `report.dismiss_reporter` beside one `report.decide` row per report. Never marks bad faith. Behind "Close more
  reports at once" in the hub, held for the five-second Undo.
- **Reporter accuracy.** `cw.reports.reporterAccuracy` (30 days, minimum 5 decided), a line on the case, and a lower place in the queue and
  in take-next for habitual false reporters (80% or more; reports over 24 hours old rank normally). Staff only; nothing is hidden.
- **Keyboard queue mode.** J/K and the arrow keys, 1/2/3 act, U undoes; "Quick keys" (on in Simple, off in Detailed).
- SQLite migration 19 adds one index. Peer floors rise to 0.1.5 for `store-memory`, `store-sqlite`, `http` and `hub-react` on core, and for
  `hub-react` on `http`. The hub's first load stays under its 76,800 byte budget (the command bar, shortcut sheet and bulk window load on demand).
- Parked (see "Open follow-ups"): a server-side reopen of a dismissed report; dropping `kit_reports_by_reporter` (a prefix of the new
  index) in a minor; putting the accuracy thresholds in `limits.reports`; an owner view of reporter accuracy (deliberately not built: no
  per-person leaderboards); bulk by room or reason; J/K open-on-move in the `CaseList` piece; a keyup arm for act keys for hosts that send
  repeated keydowns with `repeat: false`; the held-toast progress bar restarting when an older toast returns to view.

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
