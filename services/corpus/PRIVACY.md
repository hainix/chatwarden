# Privacy: what the corpus service holds

Status: maintainers' draft. **Not legal advice**: have it read by someone who can give it before it is published as the project's privacy page.
It describes what the code in this folder does (design section 15); where the code and this page disagree, the code is the thing to fix.

The service is the Worker behind the shared community term list. It receives a word from a server that chose to share it, reports about a word,
and a reviewer's decisions. It never receives a chat line, a player's name or id, or an IP address that it keeps.

## What it holds, why, and for how long

| What | Why | How long | Where |
| --- | --- | --- | --- |
| The term list: each word, its languages, category, target, severity, status, the number of approvals | It is the list | Kept; a term removed from the list stays as a withdrawn row so that every list that has it can switch it off | D1 `terms`, `term_lines` |
| A submission: the word, language, category, target, the day it arrived, its status and the reason for a decline | To review it | Kept with its decision | D1 `submissions` |
| A submission's **installation hash** (the SHA-256 of the sending server's random public key) | Rate limits, the decline lock, and "nobody reviews a submission from their own installation" | **180 days after the decision**, then emptied by the daily job | D1 `submissions` |
| A submission's **note** (at most 200 characters; no link, `@`, or long number) | Context for the reviewer | **90 days after the decision**, then deleted by the daily job. Never published in a release | D1 `submissions` |
| A rate-limit counter: a count per installation hash, and per **keyed, daily-changing hash of the network address**, per day | To stop floods | **Two days**, then deleted | D1 `counters` |
| A report: the term id, the kind (`innocent_sense`, `wrong_category`, `removal`), the day, and a channel key (an installation hash, or a keyed daily hash of the network for the docs-site form) | To open a ticket for a reviewer | Kept with its decision. **No free text is read or stored** | D1 `reports` |
| A reviewer: an email address, the languages they are fluent in, whether they are active | Cloudflare Access sign-in, and "a second approval by a different reviewer" | While they review | D1 `reviewers` (and Cloudflare Access) |
| A reviewer's votes and the audit trail: who did what to which id, when | Accountability for what goes on a public list | Kept | D1 `reviews`, `audit` |
| Released lists: the signed zips, the index, a Zenodo copy of each | The product | Permanent, by design (a published release is not recalled; a withdrawn term is switched off by the next one) | R2, Zenodo |

## What it never holds

- Chat text, a report excerpt, a player name, an account, a game or room id, the adopter's name or address. The share action does not read them,
  and the wire format has no field for them (design 10.2).
- **An IP address.** The Worker sees the network address of a request while it answers it. It turns it into a keyed hash that changes every day
  (an IPv6 address counts as its /64), uses the hash for a counter that is deleted after two days, and writes the address neither to the database
  nor to its own logs. The service's logs hold a stage and a closed code.
- A secret in a file: the counter key and the Turnstile secret are Worker secrets, set with `wrangler secret put`, and the signing keys are held by
  the owner and are never on the service.

## Things to check before publishing this page

- **Cloudflare's own logs.** `observability` is switched on in `wrangler.jsonc`, and Workers Logs record invocation metadata outside this service's
  code. Confirm in the dashboard whether that includes the client address, and for how long; if it does, either switch it off or say so here.
- **Cloudflare Access** keeps its own sign-in log of the reviewers' emails and addresses; that is Cloudflare's, under the owner's account.
- **Zenodo** publishes the zip, the signature and the manifest for ever, with a DOI. They hold words, never people.
- **Who is the controller, and the contact for a removal or a data request** (the owner's decision), and the lawful basis wording for the reviewers'
  emails and the installation hashes (legitimate interest, probably; for a lawyer).

## A contributor's rights

A contributor can ask for a word to be removed from the list (`docs/community-list.md`). Removal stops it from appearing in future releases and
switches it off in lists that update; it cannot recall a release that is already published. A server's installation hash is random and identifies
a file on a server, not a person: deleting that file makes a new installation. If a hash is needed to find a submission, the 180 days are the
limit; after that there is nothing to look up.
