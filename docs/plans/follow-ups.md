# Follow-ups

Things found while building, not yet done. Each one names where it came from.

## 0.1.2: `@chatwarden/matcher` ships obscenity's English word list to browsers

Found building the landing-page demo (K8b, 2026-11-10).

- **Problem.** `@chatwarden/matcher` is built on `obscenity`. Its CommonJS build has no `sideEffects` flag, so a browser bundler keeps
  `englishDataset` (obscenity's ready-made English list, which holds real slurs) even though the matcher never uses it: the matcher
  builds its own dataset from the term pack. Anyone who bundles the matcher for a browser carries that list in their page.
- **Workaround, site only.** `site/vite/withoutObscenityWordList.ts` cuts the list out of `obscenity/dist/preset/english.js` at build
  time. It fails the build if the file's layout changes or if it never meets the file, and `site/test/dist.test.ts` and
  `site/test/browser.test.ts` check the built page. The kit's own `scripts/browser-bundle.test.ts` does not look for the list.
- **Fix to do.** In the matcher, stop pulling the list in: import only what is used from a path that does not load
  `preset/english.js`, or vendor the few transformers, or lazy-load it; then add a check to `scripts/browser-bundle.test.ts` that the
  browser bundle contains no word of obscenity's list. Drop the site plugin once the matcher no longer needs it.
- Tracked as: a GitHub issue (to be opened by the maintainer) and the 0.1.2 changeset.
