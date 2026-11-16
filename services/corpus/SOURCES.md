# Sources of the data the gates use

Status: maintainers' draft; filled in by the owner as each source is loaded. **Nothing is loaded yet**, and no source is listed as approved.

The corpus service judges a word against two kinds of data that are not the list itself:

- **dictionary and frequency data** (`innocent_words`): ordinary words of each language, with a rank. They decide which submitted words are
  auto-declined as "a common word" and which languages a spelling is an ordinary word in (the cross-language collision gate);
- **sentence sources** (`negative_lines`, and the eval sets' paraphrases): lines the list must never block.

These are **internal inputs**. They are not part of any release, they are not redistributed, and the repository holds none of them (design 15,
16): they live in the database and in the owner's `.corpus-data/`, outside git. What a release does publish, `negative.<lang>.json`, is capped at
2 000 lines a language and made of the two kinds of lines this page allows: public-domain or CC-licensed sentences, and reviewers' own writing.

## The rule for a source

A source is loaded only after this page has a row for it that says all four things:

1. **Name and where it comes from**, with a version or a date.
2. **Licence** (the licence text or the terms of use, by name), and where the terms were read.
3. **The internal-use check**: whether those terms allow it to be used as an input to a service that publishes a derived result (a yes or a no,
   by whom, on what date). A word list that is only a *check* (a gate answers "this word is common") is a different use from republishing the list;
   say which one this is.
4. **Not redistributed**: a confirmation that the loaded data is not copied into a release, a test, a fixture, a doc or the repository. A release
   holds the dictionary words that contain a *term* as that term's `negative` lines (at most 50 a row): a word, not the list; say if a source's
   terms forbid even that, and then it is not used for those lines.

No source whose terms forbid internal use, or whose terms cannot be found, is loaded. No sentence is copied from a chat, a forum or a person's
message. Eval cases are synthetic (written with invented words), or paraphrased by a reviewer from a real report so that no wording, name or
contact detail is left (`checkCase` enforces the shape; the reviewer checks the rest).

## The register

| Source | Kind | Language | Licence and where read | Internal-use check | Redistributed? | Loaded on |
| --- | --- | --- | --- | --- | --- | --- |
| *(none yet)* | | | | | no | |

When a row is added, the same pull request records in the owner's notes (not in git) the command that loaded it (`tools/seed.mjs --dictionary
<language>=<file>`, which ranks the words by their position in the file, or `--negatives`), and how many words or lines it loaded.
