# The community term list: how to contribute a word

Status: pre-release, as-is, no support promise. Maintainers' draft; the wording of the consent and the privacy page are the owner's to finalise
(`services/corpus/PRIVACY.md`, `docs/design/2026-11-12-k7-term-corpus.md`, sections 10 and 15).

The community term list is a signed, versioned list of words that moderators of chat games judge to be used as abuse, kept by volunteers and
published under CC BY 4.0. It is **opt-in**: no Chatwarden package ships any terms, and nothing uses the list unless a server's developer turns it
on. This page is for the people who suggest a word, report a word that blocks innocent text, or ask for a word to be removed.

**Content warning.** The list is, by its nature, a list of abusive words. Reviewers see them one at a time and are reminded to take a break.

## Who can contribute, and how

A moderator whose server has turned sharing on (the developer passes `community.share` to the staff routes) opens a term in the editor, opens
"Share with the community list", reads the exact payload and presses Send. One word at a time; there is no "share all". Nobody else can
submit: the web has no submission form.

What is sent: the word, its language, the category you pick (and a target for a slur), an optional short note, the day, the kit's version and a
random public key that identifies **the server, not you or your game**. What is never sent: any chat line, player name, account or game id,
your game's name or address, an exact time. The note is for the reviewer only: at most 200 characters, no link, no `@`, no long number. It is
deleted 90 days after the decision and never published.

## The rules

1. **Words only.** One word of letters (accents allowed) from a supported language (English, Spanish and Portuguese to begin with), at least
   three letters once repeated letters collapse. No phrase, no pattern, no chat.
2. **No personal information**, in the word or in the note. Not a person's name, a handle, a contact, a link.
3. **The word is yours to give.** Do not copy a word list you have no right to copy. There is no bulk import: one word at a time, each judged.
4. **A common word is not a term.** A word in the most common words of a language is declined automatically, whatever its other uses. A word
   that is an ordinary word in *another* language the list serves is not declined: it is marked, and switched off wherever that language is
   installed.
5. **Slurs say who they attack.** A word in the *slur* category needs a target (ethnicity, religion, gender, sexuality, disability, nationality
   or other). Insults not aimed at an identity are *abuse*; sexual harassment words are *sexual*.

## What happens to a submission

A reviewer reads it. One approval makes the word **provisional**; a second approval, by a different reviewer, where one is fluent in the word's
language, makes it **accepted**. A word can be declined with a closed reason (known innocent, not a term, duplicate, needs context, other) and
the reviewer's own note is never sent back. Reviewers cannot review a submission from a server they run. Each action is written to an audit trail.
Releases are monthly, plus a patch within about two days (a target, not a promise) for a confirmed innocent-text block. The owner reads every
release's diff and signs it offline.

## Licence and consent

By sending a word you confirm it is yours to share and that, if accepted, it joins a public list under **CC BY 4.0** that any game can use, and
that it stays in releases that have already been published. Credit, if you use the list, is one sentence: "Contains the Chatwarden community
term list (chatwarden.dev), CC BY 4.0." The service sees your server's network address while it answers and keeps only a hashed rate-limit count
for two days.

## A word that blocks innocent text, or should not be there

Report it: from the term's editor in the hub (a server that has sharing on), or from the docs site's form. A report is a term id, a closed kind
(*innocent sense*, *wrong category*, *removal*) and the day. **No free text is read or kept**, so do not write anything personal in it.

- One reviewer's confirmation of an *innocent sense* or *wrong category* report marks the word **disputed**: it is switched off in lists that
  update, at the next release. Restoring a word takes two reviewers, and not the one who disputed it.
- A *removal* of a slur takes two reviewers; of any other word, one. The word becomes **withdrawn**: it stays in the list's history as a switched-off
  row, so that every list that has it can switch it off, and it is not in any future selection.
- **A published release cannot be recalled.** A zip that is already out stays out, with the word in it. The next release switches the word off.
  A release can be revoked as a whole in the index (for a bad release, a key compromise or a legal reason); a server that pins a version chooses when
  to move.
- Contributors can ask for removal of a word they sent; it stops future releases only, as above. The maintainers can be reached through the
  repository's issues, without any personal information in them.

## For a developer who wants the list

Install nothing new: import `@chatwarden/matcher/corpus/node`, call `startCorpus({ dir, select, pin })` with the version you chose, pass the
loader's list to the staff routes if you want the hub's Community section, and add the attribution sentence to your docs. The loader verifies a
signature before it reads a byte, keeps the previous list on any failure, and never changes a row your moderators edited. See the matcher
package's README.
