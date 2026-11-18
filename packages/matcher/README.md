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

`@chatwarden/core` is a peer dependency, so your project has one copy of it. Node 22.13 or newer. The matching engine is a small
copy of the regexp matcher and the English-preset text handling of [`obscenity`](https://www.npmjs.com/package/obscenity) (MIT, see
`src/vendored`). It does not carry obscenity's own English word list: the words come only from your term pack.

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

A shared, community-kept list of terms is a separate project. The data is hosted separately from the code, so it is not in this
repository and not in this package. **This package ships no terms at all, and nothing here is on by default.** It ships the
loader. The list is a precision-first list that many communities keep together: every term has lines it must block and lines it
must never block. It is published as signed, versioned releases. Your server downloads a release, checks its signature, keeps it
on disk and loads it as a term pack. No real slur is in this repository or in any package.

Everything in this section is `@experimental` until 0.2. Until the first release exists, the loader has no trusted keys and answers
`no_trusted_keys`, and your own list is untouched.

### Turn it on

Import the loader from its own subpath, on the server only. The root of `@chatwarden/matcher` never imports it, so a browser bundle
holds none of it.

```ts
import { LiveTerms, loadTermPack } from '@chatwarden/matcher';
import { startCorpus } from '@chatwarden/matcher/corpus/node';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { openStore } from '@chatwarden/store-sqlite';

const store = openStore({ path: './chatwarden.db' });
const terms = new LiveTerms({ store, pack: loadTermPack(syntheticTermPack()), clock: { now: () => Date.now() } });
await terms.load();

// Reads the cache in ./corpus-cache, asks the service for news (at most 10 seconds at start), then checks again about once a day.
const corpus = await startCorpus({
  dir: './corpus-cache',
  select: { languages: ['en'] },
  pin: '2026.12.0', // or follow: 'stable'
  terms, // the live list: needed for `pending`, for `apply: 'auto'` and to put the applied list back after a restart
});
console.log(corpus.status().state); // 'ready' once a release has verified; 'failed' (lastError.code 'no_trusted_keys') while the kit has no keys

// The owner decides when a release goes in. A summary first (a dry run), then the change.
console.log(corpus.status().pending); // { added, deactivated, reactivated, changed, keptYours, skipped }, or null
const applied = corpus.applyTo(terms);
if (applied?.ok) console.log('in use:', applied.version);
corpus.stop();
```

Pass the loader to `adminRoutes` as `community: { loader: corpus, live: terms }` to get the Community list in the hub (see the
`@chatwarden/http` and `@chatwarden/hub-react` READMEs). Without that the hub shows nothing about it.

**Pin or follow.** You choose, and `pin` is shown first. `pin: '2026.12.0'` keeps that release until you change it. `follow: 'stable'`
moves to the newest stable release the index offers, and never goes back to an older one. With `apply: 'manual'` (the default) a new
release waits as `pending` until `applyTo` is called (the hub's Apply button does that for an owner). With `apply: 'auto'` it is
applied as soon as it verifies.

**Offline first.** The last good release is kept on disk and verified again every time it is read. If the network is down, the cache
is damaged or the signature fails, the list in use stays exactly as it is, and `status()` says why with a code and a stage (never a
term, a path or a URL). A restart hands the applied release to the live list again. That needs the loader to hold `terms`: pass
`terms` to `startCorpus`, or call `applyTo(terms)` once. A host that wires `community.live` into the routes but not `terms` into the
loader gets no restart sync. `minKit` in a release is checked against the loader's `kit`, which `startCorpus` sets to this package's
version. If you call `createCorpusLoader` yourself, pass `kit`, or `minKit` is not enforced.

**A seed.** To ship a release inside an image, pass `seed: { zip, sig }`. It is verified exactly like a download and is used only
while nothing better has verified.

**Which rows load.** `select` takes `languages` (required), and optionally `categories`, `minSeverity` (default `hostile`) and
`statuses` (default `accepted` and `provisional`). A row whose status is outside the selected statuses is excluded: it is not
carried in as an inactive row. Narrowing a selection later does not switch off rows you already have. Disputed and withdrawn rows
always load, switched off, so a release can take a term out of use.

### What a release may and may not change in your list

`LiveTerms.syncPack(pack, { actor, dryRun? })` is what applies a release. It is browser-safe and does no I/O. It adds rows,
switches them on and off, renames and re-words them, in one transaction. It never deletes a row. It never changes a row a person
has edited: a row is yours as soon as `updatedBy` is set to anything that does not start with `corpus:`. Rows the list added or
changed carry `addedBy` or `updatedBy` of `corpus:<version>`. That prefix belongs to the corpus: `change()` and `changeSync()`
refuse an actor that starts with `corpus:`. A refusal (`SyncResult` with `ok: false`) changes nothing: the pack would leave no
active term, or an exception of yours would unblock a line the release says must stay blocked. The summary counts what was or would
be done: `added`, `deactivated`, `reactivated`, `changed`, `keptYours` and `skipped`.

### Sharing a term back

A server that wants to offer one of its own terms builds a share client with its installation key. The hub's Share action and the
"Report a problem with this community term" action call it through the staff routes; the browser never contacts the service.

```ts
import { createCommunityShare } from '@chatwarden/matcher/corpus';
import { installationKey } from '@chatwarden/matcher/corpus/node';

const key = await installationKey('./corpus-cache'); // a random key kept in a file: it identifies this server, not a person or a game
const share = createCommunityShare({ sign: key.sign, publicKey: key.publicKey, clock: { now: () => Date.now() } });

// One term at a time. The payload is built from a closed list of keys: the word, its language, a category, a target, a note, the
// day (never a time) and the kit version. Never a chat line, a name, an id, an address, a room or an excerpt.
const sent = await share.share({ term: 'zorbak', language: 'en', category: 'abuse' });
console.log(sent.ok ? sent.status : sent.code); // 'received', or a closed code such as 'offline' or 'rate_limited'

// A report of a problem with a community term is a term id and a closed kind. No word, no free text.
const report = await share.report({ termId: 'CWT-2026-00001', kind: 'innocent_sense' });
console.log(report.ok);
```

Every call has a 15 second deadline and is aborted at it, reads at most 8 KiB of the answer and never throws. A share also costs a
small piece of work (a 16-bit hash stamp, well under a second) so that sending junk is not free. Nothing the service says is passed
on: an answer becomes a closed code.

### The attribution sentence

The list is released under CC BY 4.0. Put this sentence in your docs, or wherever you credit your data: "Contains the Chatwarden
community term list (chatwarden.dev), CC BY 4.0." The same sentence is in each release's manifest (`manifest.license.attribution`).

### The names (`@experimental` until 0.2)

From `@chatwarden/matcher`: `LiveTerms.syncPack`, `SyncResult`, `SyncSummary`.

From `@chatwarden/matcher/corpus/node`: `fileCache`, `installationKey`, `startCorpus`, `StartCorpusOptions`, `StartedCorpus`,
`StartedEvalCorpus`.

From `@chatwarden/matcher/corpus` (it imports nothing from Node): `CorpusError`, `CorpusErrorCode`, `CorpusStage`, `CORPUS_BASE_URL`,
`CORPUS_KEYS`, `CORPUS_REVOKED_KEY_IDS`, `CORPUS_ZIP_PASSWORD`, `CorpusKey`, `signedMessage`, `verifySignature`, `ZIP_LIMITS`,
`readZip`, `ZipLimits`, `parseTermsRelease`, `ExceptionRow6`, `NegativeFile`, `ReleaseManifest`, `TermRow6`, `TermsRelease`,
`releaseToPack`, `PackSelection`, `parseEvalSet`, `ConductLevelName`, `EvalCaseFile`, `EvalExpectFile`, `EvalLineFile`,
`EvalManifest`, `EvalMeta`, `EvalSet`, `chooseRelease`, `parseIndex`, `revokedKeyIdsOf`, `ChooseOptions`, `CorpusIndex`, `CorpusKind`,
`CorpusLanguageCounts`, `CorpusMirror`, `CorpusReleaseEntry`, `CorpusRevokedRelease`, `CorpusRevokeReason`, `createCorpusLoader`,
`CorpusCache`, `CorpusEvalLoader`, `CorpusLoader`, `CorpusLoaderOptions`, `CorpusState`, `CorpusStatus`, `RefreshResult`, `Schedule`,
`COMMUNITY_ENDPOINT`, `checkStamp`, `createCommunityShare`, `mintStamp`, `CommunityShare`, `CommunityShareOptions`, `ReportInput`,
`ReportKind`, `ReportResult`, `ShareInput`, `ShareResult`.

The options of the loader are `select`, `pin`, `follow`, `apply`, `kind`, `baseUrl`, `mirrors`, `keys`, `fetch`, `seed`, `kit`,
`logger`, `terms`, `schedule`, `cache` and `clock`; `startCorpus` takes `dir` in place of `cache`, and `clock` is optional there. The
options of the share client are `endpoint`, `sign`, `publicKey`, `fetch`, `clock`, `kit`, `logger`, `schedule` and `stampBits`.

A release is a signed zip with `terms.json`, `exceptions.json`, `positive.json`, `negative.<lang>.json` and a manifest. See the
[design note](https://github.com/hainix/chatwarden/blob/main/docs/design/2026-11-12-k7-term-corpus.md) for the formats.

### Reserved names

New in 0.2.0. A game can protect names (`admin`, `moderator`, `game master`) so a player cannot take one, or something that only looks like one. `@chatwarden/core` calls this through `names.reserved`; the two functions are exported for a game that checks names itself.

- **`skeleton(text)`** reduces a name to the letters and digits it looks like: invisible characters and combining marks are removed (NFKD), the same look-alike and leet folding the matcher applies to chat is applied (`M0d3rat0r` reads as `moderator`, and full-width letters read as plain ones), and everything that is not `a-z` or `0-9` is dropped. Two names that look the same have the same skeleton.
- **`matchReserved(name, entries, allow)`** answers whether a name is one of the protected `entries`. A name matches when its whole skeleton is an entry's, or when any run of consecutive words of the name is: a space, an underscore, a camel-case hump, a digit run and a punctuation mark are word breaks, so `Mod_Anna`, `ModAnna`, `M0d_Anna` and `Moderator` match the entries `mod` and `moderator` while `xXmodXx`, `Sodmin` and `Moderately` do not. It compares whole words, like chat matching, not a substring. A name whose whole skeleton is one of `allow` never matches (a real player who is called like staff). It never throws (anything that is not text is no match), reads at most 256 characters of a name, and an entry with no letter or digit is ignored rather than matching every name. The compiled list is cached per array, so pass the same array each time. A short entry is a broad net (`mod` also catches `Mod Squad` and `M o D`, not `Mood` or `Mad`), and an entry in a script with no Latin skeleton matches nothing: ask `matchReserved(entry, entries, [])` to see whether an entry protects anything.
- **What it is for.** Names only, never the chat: the chat matcher and its terms are unchanged, and a name is not checked against the term list by this function. `LiveTerms` and the matcher `buildMatcher` returns expose it as `matchReserved(name, entries, allow)` so the core's `Matcher` can ask without a second import.

## Terms in scripts written without spaces (0.2.0)

A term in Chinese, Japanese, Thai, Lao, Khmer or Burmese has no spaces to read whole words by, so these scripts have their own path (`@chatwarden/matcher` reads Han, Hiragana, Katakana, Thai, Lao, Khmer and Myanmar; any other script, Cyrillic, Arabic and Hangul included, is a `MatcherBuildError` "not supported yet", naming the row and never the term). A Latin term is exactly what it was.

| Row field | Rule |
| --- | --- |
| `term` | Letters of one script family and nothing else: no space, punctuation, digit or Latin letter. Han, Hiragana and Katakana may mix for Japanese; Han with Thai is refused. 2 to 24 code points (3 to 24 for `contains`). |
| `language` | `zh`, `ja`, `th`, `lo`, `km` or `my`, and one that fits the script (kana is `ja`, Han alone is `zh` or `ja`, Thai is `th`). It picks the segmenter. |
| `matchMode` | `segment` (the default for such a term), `contains`, or for a plain a-z term `word` (the only mode it has). A mode that does not fit the script is refused at build. |

- **segment.** The term must occupy whole segments: the text is cut into runs of those letters (a space, punctuation, a digit, a Latin letter or an emoji ends a run) and each run is cut by `Intl.Segmenter(language, { granularity: 'word' })`; a hit starts and ends on segment edges, so the same characters inside a longer dictionary word do not hit, and a slang term the dictionary splits into single characters still does. A runtime without `Intl.Segmenter` and an active `segment` term fails `buildMatcher` (a missing capability is not silently weaker).
- **contains.** Hits anywhere inside a run, for a severe term an owner would rather match everywhere than risk missing. It never cuts a grapheme cluster (a Thai letter is not read without its tone mark).
- **Reading text.** NFKC, not NFKD (decomposing would turn a voiced Japanese kana into an unvoiced one and Thai vowel signs and tone marks are marks that carry the word); only format characters, the blank fillers and variation selectors are removed; hiragana and katakana are one spelling (`foldKana`, `normaliseUnspaced`). `spans()` still gives exact ranges on the text as typed.
- **Exceptions.** An exception phrase in these scripts suppresses a hit inside it only when its own edges are segment edges; one that mixes Latin and Han is refused at build.
- **Honest limits.** Segmentation is a dictionary algorithm and moves between ICU versions, so the corpus gate (every term ships with lines it must and must not match) runs on both Node versions in CI, and the hub's dry run shows a term's effect before it is saved. Characters inserted between letters, homophones, pinyin and simplified/traditional conversion are not read: add the term in each form that matters. `isUnspacedTerm`, `UNSPACED_SCRIPTS` and `UNSPACED_LANGUAGES` are exported; `@chatwarden/matcher/fixtures` gains `SYNTHETIC_UNSPACED_TERMS` (invented transliterations, never a real term).

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
| `LiveTerms.loadSync()`, `LiveTerms.changeSync(actor, fn)` | `load()` and `change()` without a promise, for a host that cannot await (a relay boot). `load()` and `change()` are thin async wrappers over them and return the same results. `fn` must be synchronous: an async `fn` throws `TypeError` (and is rolled back). |
| `LiveTerms.usingPack` | True while the matcher runs on the pack because the store could not be read. |
| `LiveTerms.rows`, `LiveTerms.records()` | `rows` are the matcher's rows (`id`, the word, `language`, `active`). `records()` adds `note`, `addedBy`, `addedAt`, `updatedBy` and `updatedAt` from the store (all `null` while the pack stands in for it), for a staff list. |
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

A refusal is a returned value. Two things are thrown (or, for `change()`, rejected) instead, because they come from your own
function: an error that `fn` throws, and a store error raised by an editor call inside `fn` (for example `insertTerm` failing).
Both roll the change back, write nothing and rethrow the error as it was. So the same SQLite failure is a `build_failed` result
when it happens while the change is checked or committed, but a throw when it happens inside `fn`: a synchronous caller of
`changeSync` still wants a `try`/`catch` around it. `fn` must be synchronous. An async `fn` throws a `TypeError`, and its promise
is left handled, so a later rejection does not crash the process.

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
word. The before and after JSON of a row stay in the store's `kit_audit` table (`before_json` and `after_json`; a custom TermStore receives them as `entry.beforeJson` and `entry.afterJson`); for a toggle,
`after_json.active` says which way it went. Rows an earlier release wrote with the raw names (`add`, `edit`, `enable`, `disable`)
still read through `audit.list` under the closed names.

## Upgrading from 0.1.0

0.1.1 changes no public signature, with one behaviour change for a **custom `TermStore`**.

- **Audit names.** `LiveTerms` used to call `writeAudit` with the raw names `add`, `edit`, `enable` and `disable`. It now writes
  `term.add`, `term.update`, `term.toggle`, `exception.add`, `exception.update` and `exception.toggle`, the closed names that
  `cw.audit.list` filters on. If your own `TermStore` stores or switches on `entry.action` (a SQL `WHERE action = 'add'`, an
  exhaustive `switch`, a `Record<AuditEntry['action'], ...>`), update it: match both the new names and, for the rows already
  written, the old ones. The raw names stay in the `AuditEntry['action']` type for that reason, and the type is wider than in
  0.1.0, so a `never` check or a `Record` over it needs the new members. A store that only saves and returns the entry as it is
  needs no change. `@chatwarden/store-sqlite` reads old and new rows alike. A toggle no longer says enabled or disabled in its
  name: read `after_json.active` (and `before_json.active`).
- **New, optional.** `positiveCorpus` on a term pack, the refusal `code`, and `loadSync()` and `changeSync()`. Nothing you wrote
  for 0.1.0 has to change to keep working.
- **Browsers.** Term ids are generated without `node:` imports, so the package bundles for a browser. Since 0.1.3 a browser bundle
  also holds no third-party word list: the matcher no longer imports `obscenity`, whose root module loads its English list.

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
