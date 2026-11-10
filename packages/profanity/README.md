# @chatwarden/profanity

An optional filter for ordinary swearing, for Chatwarden, the open-source chat moderation kit for games. It finds the swear
words in a line of chat and masks them (`****`, `f****` or `#$%@!`). What happens to a line that contains one (let it through,
star it, or refuse it) is the moderation profile's choice; this package only finds the words and masks them.

It is for ordinary swearing only. It is not slur protection. Slurs are the job of
[`@chatwarden/matcher`](https://github.com/hainix/chatwarden/tree/main/packages/matcher), which blocks the line and counts a
strike. Always pass a slur matcher to the kit: starring `damn` does nothing about a slur.

- **Built-in English list** (from [`obscenity`](https://www.npmjs.com/package/obscenity)); more languages are added as they are
  contributed.
- **Make it yours.** Add words, take words out, or replace the whole list.
- **Same evasion handling as the slur matcher.** Case, accents, look-alike characters, leetspeak, repeated letters, punctuation
  stuck to a word and invisible characters are read through. Spaces between letters are not, on purpose.
- **Masks the original text.** Everything around a hit is left exactly as typed.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/profanity @chatwarden/core @chatwarden/matcher
```

`@chatwarden/core` and `@chatwarden/matcher` are peer dependencies (this package reuses the matcher's text handling), so your
project has one copy of each. Node 22.13 or newer.

## Quick start

With the kit, pass the package and let the profile decide the rest. The profile (`relaxed`, `standard` or `strict`) already
chooses the mode and style; `overrides` changes single fields.

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { LiveTerms, loadTermPack } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { createProfanityFilter } from '@chatwarden/profanity';
import { openStore } from '@chatwarden/store-sqlite';

const store = openStore({ path: './chatwarden.db' });
const platform: Platform = { identify: (ctx) => ({ clientKey: String(ctx) }) };
const slurs = new LiveTerms({ store, pack: loadTermPack(syntheticTermPack()), clock: { now: () => Date.now() } });
await slurs.load();

const cw = await createChatwarden({
  store,
  secret: process.env.CHATWARDEN_SECRET!,
  platform,
  matcher: slurs, // slurs are the matcher's job
  profanityPackage: { createProfanityFilter }, // ordinary swearing is this package's
  profile: 'standard', // 'standard' stars swearing; 'strict' refuses the line; override a single field below
  overrides: { profanity: { style: 'keepFirst', add: ['frobnitz'] } },
});

cw.rooms.seat('lobby', 'seat-1', { clientKey: 'some-player-token' }, 'Ada');
const result = cw.chat.accept('lobby', 'seat-1', 'you frobnitz, ok');
console.log('deliver' in result ? result.deliver.text : result.refuse.reason); // "you f*******, ok"

await cw.close();
```

You can also use the filter on its own, anywhere you have text:

```ts
import { createProfanityFilter } from '@chatwarden/profanity';

const filter = createProfanityFilter({
  mode: 'star', // the filter reports and masks; the kit's chat service acts on the mode
  style: 'grawlix',
  add: ['frobnitz'], // an invented word, for the demo
  remove: [],
  only: null,
  languages: ['en'],
});

console.log(filter.apply('you frobnitz, ok')); // { hit: true, text: 'you #$%@!&#$, ok' }
console.log(filter.apply('hello there')); // { hit: false, text: 'hello there' }
```

## Options

`createProfanityFilter(config)` takes the profile's `profanity` section. In the kit you set these through the profile or
`overrides.profanity`, not by calling it yourself.

| Option | What it does |
| --- | --- |
| `mode` | `'allow'`, `'star'` or `'refuse'`. Read by the kit's chat service, not by the filter: `allow` never calls it, `star` delivers the masked text, `refuse` rejects the line with reason `'profanity'`. The presets use `star` (`relaxed`, `standard`) and `refuse` (`strict`). |
| `style` | How a hit is masked: `'full'` (`*****`), `'keepFirst'` (`s****`) or `'grawlix'` (`#$%@!`). The mask is as long as the hit's visible letters. |
| `add` | Extra words to treat as swearing. Each must be one word of plain letters, at least three once repeated letters are collapsed. |
| `remove` | Words from the built-in list that are fine in your game. Case and accents are ignored. A word in both `add` and `remove` is removed. |
| `only` | A fully custom list: when set, only these words count (the built-in list is not used). `add` and `remove` still apply. `null` uses the built-in list. |
| `languages` | Which built-in lists to use. Only `'en'` today; an unknown language throws. |

A config the filter cannot build throws `ProfanityConfigError`. The message names the field (for example `profanity.add[2]`)
and never repeats the word you wrote. The config is copied, so changing your object afterwards changes nothing.
`SUPPORTED_LANGUAGES` lists the built-in language codes.

## Security notes

- **It never logs.** The filter has no logger. A bad config names a field, not the word. The kit that calls it logs an event
  name and the error class only, and if the filter throws, the line goes through unchanged rather than breaking chat.
- **It sees chat text, so keep it on the server.** It runs on the line before delivery; the masked text is what other players
  see. The original is kept only as evidence for a report, in the places `@chatwarden/core` describes.
- **Starring is not protection.** A masked word is still a rude line to its reader, and a determined player can spell around any
  list. Use `refuse` where a game wants no swearing at all, and treat the report button as the real safety net.
- **No identifiers.** The filter takes text and returns text. It never sees a subject id, a client key or an IP address.
- **A hit is not a rule violation.** The kit does not strike or sanction a player for ordinary swearing; only the matcher's slur
  hits count.

## Links

- [Chatwarden on GitHub](https://github.com/hainix/chatwarden) and the [root README](https://github.com/hainix/chatwarden#readme)
- [`@chatwarden/core`](https://github.com/hainix/chatwarden/tree/main/packages/core): the engine that calls the filter
- [`@chatwarden/matcher`](https://github.com/hainix/chatwarden/tree/main/packages/matcher): the slur matcher this package is not
- [`@chatwarden/http`](https://github.com/hainix/chatwarden/tree/main/packages/http): routes for moderators and players
- [Report a problem](https://github.com/hainix/chatwarden/issues)
- [Licence: Apache-2.0](https://github.com/hainix/chatwarden/blob/main/LICENSE)
