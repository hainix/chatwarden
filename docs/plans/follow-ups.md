# Follow-ups

Things found while building, not yet done. Each one names where it came from.

## Done: `@chatwarden/matcher` shipped obscenity's English word list to browsers (issue #8)

Found building the landing-page demo (K8b, 2026-11-10). Fixed in 0.1.3.

- **Problem.** `@chatwarden/matcher` was built on `obscenity`. Its CommonJS build has no `sideEffects` flag, so a browser bundler kept
  `englishDataset` (obscenity's ready-made English list, which holds real slurs) even though the matcher never used it: the matcher
  builds its own dataset from the term pack.
- **Fix.** The matcher carries the few pieces it used (`src/vendored/wordEngine.ts`), so `obscenity` is a devDependency, used only by
  the parity and version-pin tests. `scripts/browser-bundle.test.ts` and `site/test/dist.test.ts` check that a browser bundle and the
  built page hold no trace of the preset. The site workaround (`withoutObscenityWordList`) was removed.

## Open: landing-page follow-ups after the copy rewrite (2026-11-11)

Found writing the copy rewrite (`docs/design/2026-11-11-site-copy-rewrite.md`, built in `site/`).

- **Hero visual.** Replace the chat-only mock with a two-frame visual: a chat line with a Report tap, then the one-card hub view
  ("Restrict chat, 24 hours"). The copy does not need it. (Ruling 11.)
- **Hub wording.** The hub's own suggestion text in the demo is jargon ("Standard profile: severe conduct is acted on at once, never
  below the first-offense outcome or the ladder step for the record: restrict chat 7 days"). It is hub-react's `en` catalogue and wants
  the same plain-words pass. The hub also shows two Undo controls at once (the card's and the toast). Both are hub-react, not site, work.
- **Hub in the demo's frame.** The hub's light theme inside the dark demo frames looks pasted in. Give it its dark theme inside the
  demo, or frame the hub pane light.
- **"In about 15 minutes".** Someone times a fresh install against `examples/tiny-chat`; if it is under 15 minutes, add it to the
  "Add it to your game" lead. Until then the page makes no time claim. (Ruling 5.)
- **Chat box.** A `<ChatBox>` in player-react and a room broadcaster in http, so the page can promise chat. The headline changes only
  after it ships. (Ruling 1.)
- **AI section.** It comes back as a section when level 1 ships (the work is on branch `ai-levels`); today it is one FAQ answer. (Ruling 4.)
- **Moxgate mention.** Cut until the Moxgate adoption ships, then "Used in Moxgate" with a link and a screenshot. (Ruling 8.)
- **Non-Node servers.** A chat-check HTTP route would give other server languages a ready path; the FAQ says plainly that there is none.

## Open: left from the review of the landing-page rewrite (2026-11-11)

- **Tour card.** Skip or Close removes the 124 or 184px strip and the panes jump up; reserve the height (or show a slim "Restart the tour"
  strip). The finished card still says "That's the whole loop" and "That's what you add to your game"; "Done. A player reported, you decided,
  and Bo was told why." is plainer.
- **Chat overlay padding.** `.chat-wrap:has(.chat-overlay > *) .chat` adds 96px of bottom padding while an overlay row shows; when the last
  row goes, a chat scrolled to the bottom is clamped and slides down. Keep the padding always, or use `scroll-padding`.
- **Pause** only holds the replies now, which makes it nearly dead UI in a finite room; consider removing it.
- **Phone swipe test.** `.is-stacked .chat` no longer traps a swipe (`overscroll-behavior: auto`); add a 360x640 Chromium test that a swipe
  starting over the chat moves the page.
- **Headline wrap.** "MODERATOR / HUB INCLUDED." splits "Moderator hub"; a non-breaking space would keep it whole. The copy also mixes
  "recognise" and "Licence" (UK) with US spellings elsewhere.
- **FAQ screenshots** show a band of hero-style grid under the sticky header at y 66 to 85 (`faq-1440-light.png`, `faq-390-dark.png`);
  check it is only the screenshot and not a visible seam.
- **Contrast.** Measure the hero fine print (small muted text on the lavender light background) against 4.5:1. The phone tour bar sets its
  title in the display face, all caps, over three lines; consider a shorter title there.

## Triage speed (0.1.5), parked

Found building the triage-speed plan (2026-11-11). Left for later:

- **Server-side reopen** of a dismissed report. The bulk Undo is held on the client before the send; after it there is no undo.
- **Drop `kit_reports_by_reporter`** in a minor: it is now a prefix of `kit_reports_by_reporter_outcome` (migration 19).
- **Tune the accuracy thresholds**: the window (30 days), the minimum sample (5) and the 0.6 and 0.8 rates could move into `limits.reports`.
- **An owner view of reporter accuracy** (a per-reporter list) is deliberately not built: the workbench note forbids per-person leaderboards.
- **Bulk by room, by reason, or by a selection of cases.**
- **J/K open-on-move in the `CaseList` piece** (it has no router, so pieces keep focus-only movement).
- **A keyup arm for the act keys.** Some remote-desktop hosts send repeated keydowns with `repeat: false`; ignoring digits until one `keyup` has been seen after a case mounts would close that.
- **Held-toast progress bar** restarts from full when an older held toast comes back into view (it needs a start time on `ToastRecord`).
- **A cache-busting retry** (`?retry=`) for a lazy window that failed to load; today the README says to reload the page.

