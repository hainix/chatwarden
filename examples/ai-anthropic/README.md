# ai-anthropic

A reference `ModerationAI` for the Anthropic API, on Claude Haiku 5.5 (`claude-haiku-5-5`). It is under 200 lines, private to this
repo and never published: **copy `src/anthropic.ts` and `src/prices.ts` into your server** and own them.

Core does the hard part once, for every provider: it chooses and redacts the lines, renders the prompt, and validates the answer.
This adapter only sends the rendered prompt and maps what comes back. It never edits prompt text and never throws anything but an
`AIError`.

## Use it (copy and run)

1. Copy `src/anthropic.ts` and `src/prices.ts` into your server (for example `src/ai/`). Keep the `.ts` import between them, or change
   it to `.js` to match your build.
2. Add the SDK to your own `package.json`: `npm install @anthropic-ai/sdk` (this example pins 1.8.0, the version it was tested on).
3. Put the key in the server's environment, never in code or in the repo: `ANTHROPIC_API_KEY=...`. With no key (option or environment) every read fails as `fatal`, which opens the kit's breaker at once and shows "bad key" in Settings. (Credential profiles and config files that the SDK can also read are not looked for: build the client yourself and pass it as `client`.) Set a spend limit with the provider
   too; the kit's daily cap is the first guard, the provider's limit is the second.
4. Pass the adapter to the kit:

```ts
import { createChatwarden } from '@chatwarden/core';
import { createAnthropicAI } from './ai/anthropic';

const cw = createChatwarden({
  store,
  ai: { adapter: createAnthropicAI(), maxLevel: 2 },
});
```

Then choose the level in the hub (Settings, owner role). The default is Off.

`createAnthropicAI()` takes `apiKey`, `model` (`claude-haiku-5-5`), `effort` (`low`), `cache` (`5m`, `1h` or `off`), `timeoutMs` (20 000),
`maxRetries` (2), `maxTokens` (1024), `thinking` (`off` sends `thinking: { type: 'disabled' }`), `prices` and `client`. Changing `model`
means passing a `prices` table for it.

## What is sent to Anthropic

Per read, one request carrying only:

- the chosen chat lines (at most 40) as text, with aliases `P1`, `P2`, ... for speakers, line refs, seconds since the first line, and
  whether the word filter blocked the line;
- the reporter's reason label and note, redacted and cut to 300 characters;
- your Community Rules, the conduct-level meanings and the profile's standard (`aiContext`);
- at most two pseudonymised casebook examples.

Never sent: subject ids, staff refs, client keys, account ids, IPs, hashes, handles, seat ids, room ids, tags, anyone's history,
flags, mutes, counts of reports, or the API key. No `metadata.user_id` is set. Emails, phone numbers, IPs, links, tags and mentions are
replaced by `[email]`, `[phone]`, `[ip]`, `[link]`, `[tag]` and `[mention]` before the text leaves the process.

## Blocked lines go as raw text

A line your word filter blocked never reached the room, but a read needs the words to judge intent, so **by default the raw text of
a blocked line is sent to Anthropic**. If you do not want abusive text to leave your servers, set `blockedLines: 'mask'` in the
`ai` options of `createChatwarden`; core masks the text before the adapter sees it. Anthropic's own safety layer may also decline a
request that quotes abusive text: that read is stored as declined, the case shows nothing, and nothing else changes.

## Cost

Prices in `src/prices.ts` are integer micro-dollars per million tokens (Haiku 5.5, prompts up to 100K tokens). Check the live pricing
page before relying on them.

| | Per million tokens |
| --- | --- |
| Input | $0.10 |
| Output | $0.50 |
| 5-minute cache write | $0.125 |
| 1-hour cache write | $0.20 |
| Cache read | $0.01 |

A typical report (about 2 000 stable tokens, 900 variable, 360 output):

| Case | Cost |
| --- | --- |
| Cache hit | about $0.00029 |
| Cache miss (first call of a burst) | about $0.00052 |
| No caching | about $0.00047 |

A hundred reports a day is about three cents. Output dominates, which is why `effort` defaults to `low` and the answer is short.

## Check that the cache works

Every read records `cacheReadTokens` and `cacheWriteTokens` (the usage on each stored read). On repeated reads inside five minutes,
`cacheReadTokens` should be about the size of the stable prompt (2 000 or more). If it is 0 on repeat calls, the cache is not
working: the stable prompt must be at least 512 tokens and byte-identical between calls (do not edit the rules between them), and
the docs do not say whether `cache_control` is honoured together with `output_config.format`, so the eval checks it. With
`cache: 'off'` there is no cache and each read costs about $0.00047.

## Run the eval (opt-in, spends a little money)

`eval/cases.json` holds 43 synthetic cases (banter to severe, threats, a complaint that quotes a term, a lying note, long rooms, six
prompt-injection attacks). The script runs them through core's real pipeline and this adapter, then prints severity agreement, rule
and verdict agreement, over-escalation of banter, refusal rate, injection handling (the model's own flag and core's pattern tripwire, reported apart and together), ceiling violations, cache hit rate, mean cost
and a table of failures.

```sh
npm run build   # once, from the repo root: the eval imports @chatwarden/core from its build
ANTHROPIC_API_KEY=... npm run eval:ai --workspace @chatwarden/example-ai-anthropic
ANTHROPIC_API_KEY=... npm run eval:ai --workspace @chatwarden/example-ai-anthropic -- --thinking off   # the cost experiment
```

With no key it prints `skipped: ANTHROPIC_API_KEY is not set` and exits 0 (the build is not needed for that). It prints the case count and the expected spend (about
one cent for 40 cases) before the first call. It is never part of `npm test` and never runs in CI.

## Promote it to a package

When you want `@chatwarden/ai-anthropic` on npm: `git mv examples/ai-anthropic packages/ai-anthropic`, rename it, drop `private`, make
`@chatwarden/core` and `@anthropic-ai/sdk` peers, add the package to `scripts/publish-order.mjs`, `scripts/manifests.test.ts` and
the release notes, and remove it from the changeset `ignore`. A new package cannot be published through npm trusted publishing: its
first version is published by hand by the owner, who then adds a Trusted Publisher. The steps are in the AI plan's Release section.
