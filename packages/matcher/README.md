# @chatwarden/matcher

The slur matcher for Chatwarden, the open-source chat moderation kit for games. You give it a list of terms; it tells you
whether a line of chat (or a player's name) contains one, and where. It is built to catch the usual ways people dodge a filter
without blocking innocent words.

- **Whole words only.** A term matches the word, not a piece of another word.
- **Resists Unicode evasion.** Case, accents, full-width letters, look-alike characters, leetspeak (`z0rbak`), repeated letters,
  punctuation stuck to a word (`zorbak!`), and invisible characters dropped into a word are all read through. Spaces and
  hyphens between letters (`z o r b a k`) are not: that is a deliberate choice to protect innocent text, and a report catches
  the rest.
- **Names.** A name such as `Zorbak_99` or `BigZorbak` is read split into words, so it is caught as a name.
- **Exceptions.** A phrase you list (a place name, a game term) cancels a match that falls inside it.
- **Live editing.** `LiveTerms` keeps the list in a store, lets moderators add, change and switch off terms, and checks every
  edit against a corpus of known-innocent lines first ("this term would have blocked these 3 lines").

It passes `@chatwarden/core` what it needs: `LiveTerms` is a drop-in `matcher` for `createChatwarden`.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/matcher @chatwarden/core
```

`@chatwarden/core` is a peer dependency, so your project has one copy of it. Node 22.13 or newer. The one runtime dependency is
[`obscenity`](https://www.npmjs.com/package/obscenity), which does the pattern matching.

## Quick start

The package ships with no terms. This runs on the invented test words from `@chatwarden/matcher/fixtures` (see below); swap in
your own pack for production.

```ts
import { buildMatcher, loadTermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';

// loadTermPack checks an untrusted pack (here, our invented one) and returns a clean copy.
const pack = loadTermPack(syntheticTermPack());
const matcher = buildMatcher(pack.terms, pack.exceptions);

console.log(matcher.match('you zorbak')); // { termId: 'syn:zorbak' }
console.log(matcher.match('ZORBAK!!')); // { termId: 'syn:zorbak' }
console.log(matcher.match('hello everyone')); // null
console.log(matcher.spans?.('you zorbak!')); // [{ start: 4, end: 10, termId: 'syn:zorbak' }]: mask this range of the original text
console.log(matcher.matchName?.('Zorbak_99')); // { termId: 'syn:zorbak' }
```

To let moderators edit the list while the game runs, hold the terms in the store and pass the live matcher to the kit:

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { LiveTerms, loadTermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { openStore } from '@chatwarden/store-sqlite';

const store = openStore({ path: './chatwarden.db' });
const platform: Platform = { identify: (ctx) => ({ clientKey: String(ctx) }) };

// The first time a pack id is seen, its terms are copied into the store; after that the store is the truth.
const terms = new LiveTerms({ store, pack: loadTermPack(syntheticTermPack()), clock: { now: () => Date.now() } });
await terms.load();

const cw = await createChatwarden({ store, secret: process.env.CHATWARDEN_SECRET!, platform, matcher: terms });

// A moderator adds a term. A dry run first shows which known-innocent lines it would have blocked.
const candidate = 'quibbleword';
const dryRun = terms.check(candidate, 'en', []);
if (dryRun.ok && dryRun.hits.length === 0) {
  const done = await terms.change('moderator@example.com', (edit) => edit.addTerm({ term: candidate, language: 'en' }));
  console.log(done.ok ? 'added' : done.error);
}
await cw.close();
```

## Fixtures: invented words for tests and demos

`@chatwarden/matcher/fixtures` exports a small synthetic term pack: `syntheticTermPack()`, the rows behind it
(`SYNTHETIC_TERMS`, `SYNTHETIC_EXCEPTIONS`), `UNLISTED_WORDS`, and `MemoryTermStore`, an in-memory `TermStore` for tests. Every
term in it is an invented word (`zorbak`, `vlemmo`, `quissel`, and so on), each chosen to exercise one mechanism of the matcher,
with lines that must block and lines that must not. There is no real slur, hate term or profanity in this package, and none will
be added: a test or a demo can print its fixtures anywhere. Use them to test your own integration without a real list.

`@chatwarden/matcher/test-fixtures` is the old name of the same thing. It is deprecated, kept for one release, and will be
removed in the next; import `@chatwarden/matcher/fixtures` instead.

## The community term corpus

A real, shared list of terms is a separate project. The data is hosted separately from the code, so it is not in this
repository and not in this package. The plan
is a precision-first list that many communities maintain together, in which every term ships with lines it must block and lines it
must never block. It would be published as signed, versioned releases, and your app would download a release,
check its signature and load it as a term pack. That corpus is not released yet. Until it is, bring your own list: build a term
pack (the shape is `TermPack`, validated by `loadTermPack`) from your moderators' terms, or use the fixtures to try things out.

## Options

The main parts of the API:

| Name | What it does |
| --- | --- |
| `buildMatcher(terms, exceptions)` | Builds a matcher from rows `{ id, term, language, active }` and `{ id, phrase, language, active }`. A malformed active row throws `MatcherBuildError`; a term must be one word of plain letters, at least three once repeated letters are collapsed. |
| `matcher.match(text)` | `{ termId }` for the first hit, or `null`. (`spans` and `matchName` are optional on the `Matcher` type, so call them with `?.`; `buildMatcher` and `LiveTerms` always have them.) |
| `matcher.spans?.(text)` | Every hit as `{ start, end, termId }` on the original text (`end` exclusive, overlaps merged, hidden characters inside a hit included), for masking a blocked line. |
| `matcher.matchName?.(name)` | `match` for a handle or a table or deck name, which also reads the name split into words. |
| `loadTermPack(json)` | Validates an untrusted `TermPack` (strict keys, unique ids, rows that build) and returns a copy. Its errors never quote a term. |
| `new LiveTerms({ store, pack, clock, logger? })` | The live matcher. `load()` seeds the store from `pack` once, then builds from the store. `check(term, language, recentLines)` is the dry run. `change(actor, fn)` edits atomically and refuses an edit that would leave no active term, duplicate a word, or unblock a line the pack requires blocked. A refusal is `{ ok: false, error, code }`. |
| `LiveTerms.loadSync()`, `LiveTerms.changeSync(actor, fn)` | `load()` and `change()` without a promise, for a host that cannot await (a relay boot). `load()` and `change()` are thin async wrappers over them and return the same results. |
| `LiveTerms.usingPack` | True while the matcher runs on the pack because the store could not be read. |
| `TermStore` | The storage `LiveTerms` needs. `@chatwarden/store-sqlite` implements it. |
| `stripInvisible`, `foldTerm`, `collapseLikePreset` | The normalisation steps, if you build tools around the matcher. |

`LiveTerms` fails open: if the store cannot be read, it keeps the previous matcher, or the pack, and logs the event; it never
throws into chat. A term pack has `id`, `version`, `terms` (each with `positive` and `negative` example lines), `exceptions`,
`negativeCorpus` (lines known to be fine) and `knownLosses` (lines the list accepts blocking). It may also have
`positiveCorpus`, a flat list of lines the list must keep blocking (see below).

### Editing terms at runtime

`change()` and `changeSync()` check two lists of lines the pack says must stay blocked: each term's own `positive` lines, and the
pack's flat `positiveCorpus`. Every line that the active terms block on their own must still be blocked once the exceptions
apply, or the edit is refused and nothing is written. Disabling or renaming a term is not a trip (the terms alone no longer block
that line), and a line that no term blocks is ignored. The refusal names the line's index (`exception would unblock positive
corpus line 3`), never the line. `positiveCorpus` is optional, and `loadTermPack` accepts it.

A refusal carries a `code` next to the `error` text, so a caller can branch without reading the message:

| `code` | Meaning |
| --- | --- |
| `duplicate` | The word reads as the same as another term or exception row. |
| `unblocks_known` | An exception would unblock a `positive` or `positiveCorpus` line. |
| `invalid` | A term or exception is malformed, or no active term would remain. |
| `not_found` | The edit named a term or exception id that does not exist. |
| `not_loaded` | A pack is configured and `load()` or `loadSync()` has not run yet. |
| `build_failed` | The store failed while the change was checked and committed; nothing was changed. |

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { LiveTerms, loadTermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { openStore } from '@chatwarden/store-sqlite';

const store = openStore({ path: './chatwarden.db' });
const platform: Platform = { identify: (ctx) => ({ clientKey: String(ctx) }) };
const pack = loadTermPack({ ...syntheticTermPack(), positiveCorpus: ['you zorbak', 'ZORBAK!!'] });
const terms = new LiveTerms({ store, pack, clock: { now: () => Date.now() } });

// A synchronous host (a relay boot) uses the Sync versions: no promise to await.
terms.loadSync();
const result = terms.changeSync('moderator@example.com', (edit) => edit.addException({ phrase: 'zorbak', language: 'en' }));
if (!result.ok && result.code === 'unblocks_known') {
  console.log('refused:', result.error); // "exception would unblock positive corpus line 0" (an index, never the line)
}

// Read term edit history through the core audit trail.
const cw = await createChatwarden({ store, secret: process.env.CHATWARDEN_SECRET!, platform, matcher: terms });
const page = cw.audit.list({ action: 'term.add', limit: 50 });
for (const item of page.items) console.log(item.at, item.actor, item.target?.ref);
await cw.close();
```

Every `LiveTerms` edit writes one audit row under a closed `AuditAction` name: `term.add`, `term.update`, `term.toggle`,
`exception.add`, `exception.update` and `exception.toggle`. The row's target is the term or exception id. A no-op edit writes
nothing. Read term edit history with `cw.audit.list({ action: 'term.add', limit: 50 })`, or with any of the other names, when
`LiveTerms` and `createChatwarden` share the store. The list gives who, when, which action and which row id, and never the
word. The before and after JSON of a row stay in the store's `kit_audit` table (`before_json` and `after_json`); for a toggle,
`after_json.active` says which way it went. Rows an earlier release wrote with the raw names (`add`, `edit`, `enable`, `disable`)
still read through `audit.list` under the closed names.

## Security notes

- **Terms are the sensitive data.** A term list is a list of words you ban. Treat the store, the pack file and the term editor
  like the moderators' tools: staff only. Nothing in this package sends a term to a player.
- **Nothing here logs a term or a line.** Errors name a row id or a path such as `terms[3]`, and the fixed reason a row is
  malformed, never the term itself. `LiveTerms` logs an event name and the error class only (`terms.load_failed`,
  `terms.change_failed`). Log what you like of your own, but never log `check` or `match` input.
- **The term id is for staff.** `match` returns the id of the row that hit. The kit records it on strikes; it never goes to a
  player. Do not echo it back in a refusal.
- **Dry-run lines are chat.** `check` returns the known-innocent and recent lines a new term would have blocked, and `change`
  can keep them (`hits`) in the audit row. Those are lines that players typed. They are kept as long as the audit retention
  (365 days by default), so pass a count, or a few trimmed lines, rather than everything.
- **A match is a signal, not a verdict.** Whole-word matching is precision-first and misses what it was built not to block. A
  report from a player is the second line of defence.

## Links

- [Chatwarden on GitHub](https://github.com/hainix/chatwarden) and the [root README](https://github.com/hainix/chatwarden#readme)
- [`@chatwarden/core`](https://github.com/hainix/chatwarden/tree/main/packages/core): the engine that takes this as its `matcher`
- [`@chatwarden/profanity`](https://github.com/hainix/chatwarden/tree/main/packages/profanity): the optional filter for ordinary swearing
- [`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http): the staff term editor routes
- [Report a problem](https://github.com/hainix/chatwarden/issues)
- [Licence: Apache-2.0](https://github.com/hainix/chatwarden/blob/main/LICENSE)
