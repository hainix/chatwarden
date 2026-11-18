# Translating Chatwarden: the Spanish and Portuguese drafts, and how to add a language

The Spanish and Portuguese words that ship with Chatwarden are machine-drafted (by an AI model) and have not been reviewed by a person. This guide is not legal advice.
This guide is for the person who runs the game's moderation: what ships, how to turn a language on, which words a native-level reader should check first, and how a community adds a language.

## What ships

| Language | Player components (`@chatwarden/player-react/locales/es`, `/pt`) | Moderator hub (`@chatwarden/hub-react/locales/es`, `/pt`) |
| --- | --- | --- |
| Spanish (neutral Latin American, informal `tu`) | 235 keys: the player words, the chat box and the default report reasons and thank-you | 1,955 hub keys, 202 for the AI parts and 104 for the privacy parts |
| Portuguese (Brazilian, `voce`; `pt-PT` is matched to it) | the same 235 keys | the same 2,261 keys |

Each file exports the words and a `meta`: `{ locale, status: 'machine-draft', reviewedBy: [], reviewedAt: null }`. A key left out of a language reads in English: nothing shows as a bare key.
The catalogues are lazy chunks. A page that never asks for one does not download it.

## Turning a language on

The safe choice is English. A moderation word (a refusal, a ban notice, an appeal outcome) that is a little off can mislead a player, so leave a language off until a person who speaks it has read the words below.

- Players: `const t = await loadPlayerT(navigator.language)` from `@chatwarden/player-react`, then pass `t` and the same `locale` to the components. It returns the English `t` for any other language.
- Moderators: `<Hub locale="es" />`, or `<chatwarden-hub locale="pt-BR">`. With no `t` of your own, the hub loads the catalogue for a language it ships and shows a quiet loading state until the words arrive. A `t` you give always wins.
- The owner's own text stays the game's: the rule titles and text, the summary, and any report reason or thank-you you edited in Settings are shown as you wrote them. Only the default report reasons and the default thank-you follow the player's language, and only while they are still the English the kit sends.

## Read these first

Before a language is turned on for players, have a person who speaks it read at least these. They are listed by key, so you can search the catalogue file for each.

- Notices, what a player is told: `player.notice.title.*`, `player.notice.body.*`, `player.notice.todo.warning`, `player.restricted.*`, `player.record.kind.*`.
- Refusals, what the chat box and the dialogs say when something is not sent: `player.chat.refused.*`, `player.chat.closed.*`, `player.chat.locked`, `player.pace.*`, `player.report.refused.*`, `player.appeal.refused.*`, `player.name.not_allowed`, `player.name.profane`, `player.name.reserved`.
- Appeals, on both sides: `player.appeal.*`, `player.notice.title.appeal_upheld`, `hub.appeals.decide.*`, `hub.appeals.decided.*`, `hub.settings.appeals.*`.
- The words for sanctions, what a moderator reads before it acts: `hub.sanction.kind.*`, `hub.decide.verdict.*`, `hub.decide.choice.length.*`, `hub.preview.effect.*`, `hub.person.form.*`, `hub.guide.ladder.*`, `hub.simple.apply.*`.
- Safety and urgent cases: `player.report.reason.welfare.label`, `player.report.reason.welfare.hint`, `player.report.resources`, `hub.safety.*`, `hub.settings.safety.*`, `hub.urgent.*`.

Two words are typed by the person, not read: `ACT` (`hub.settings.ai.act.dialog.word`) and `ERASE` (`hub.privacy.erase.word`). A translation keeps them as typed.

## The glossary

The moderator guide defines a few terms. Each has one Spanish and one Portuguese word, used everywhere, and the glossary sits in a comment at the top of `packages/hub-react/src/locales/es.ts` and `pt.ts`:

| Term | Spanish | Portuguese |
| --- | --- | --- |
| Community Rule | Regla de la comunidad | Regra da comunidade |
| ladder | escala (de sanciones) | escada (de sanções) |
| sanction | sanción | sanção |
| strike | falta | falta |
| appeal | apelación | apelação |

A test reads that comment and checks every string whose English holds the term. A different word fails the test.

## The test, and the allowlist

```sh
npx vitest run packages/player-react/test/locales.complete.test.ts packages/hub-react/test/locales.complete.test.ts
```

It names every key that is missing, outside the English catalogue, has a different `{placeholder}`, is empty, is still the English, holds markup, or lacks a `.one` or `.other` plural form.
A string that is the same in English on purpose (a key name, a format such as `{name} ({tag})`, a loanword such as `API`) goes on the allowlist in that test file, in a pull request, with the key and no more.
`locales.review-claims.test.ts` fails if a locale file says "reviewed", "verified", "native", "official" or "approved" (or the Spanish and Portuguese words) outside its header.

## When a person has read it

`status` changes only in a pull request that names the reviewer. Set `reviewedBy` to the names, `reviewedAt` to the date and `status` to the new word, and change the test that pins `machine-draft` in the same pull request. The three fields move together: one without the others fails `locales.meta.test.ts`.
Do not edit the header to claim a review the pull request does not show.

## Adding a language

1. Copy `es.ts` (player) and `es.ts` (hub) to the new tag, keep the header, and write `meta` with `status: 'machine-draft'` until a person has read it.
2. Translate every key. Keep `{placeholders}`, plural suffixes (`.one`, `.other`, and any category the language needs), and the punctuation that carries meaning.
3. Add the tag to `SHIPPED_LOCALES` in `locales/match.ts`, a line to the loaders in `locales/load.ts`, an `exports` and `typesVersions` entry in `package.json`, and the language to the loops in the three locale tests.
4. Run the test above. It is the checklist.

Without a pull request, your own catalogue works as it always has: `createT({ ...en, ...yours }, 'de')` for the players, and `createT({ ...en, ...(await loadAiWords()), ...(await loadPrivacyWords()), ...yours }, 'de')` for the hub.
