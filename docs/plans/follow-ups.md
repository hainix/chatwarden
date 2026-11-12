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

