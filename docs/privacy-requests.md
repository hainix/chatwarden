# Privacy requests and legal hold: a runbook for adopters

> Not legal advice, not a compliance claim. This page describes what Chatwarden stores and what its privacy and legal-hold tools do. It does not say whether a request is valid, whether
> a retention period is right, or whether any law is met. You decide those things; the kit gives you the mechanism.

Everything here is `@experimental` in 0.2.0. The tools are `cw.privacy` and `cw.legal` in `@chatwarden/core`, the owner's staff routes in `@chatwarden/http`, and "Data requests", "Privacy
requests" and "Legal hold" in the hub. None of it is on a player route: a player cannot export or erase anything, and the kit never contacts the person who asked.

## Who checks who is asking

You do. The kit has no way to tell that the person writing to you is the person they say they are, or that an authority asking for a bundle is one. Verify the requester with your own
means (the account they are signed in with, a reply to the address on file, whatever your policy says) before anything below. The kit's part starts after you have decided.

## 1. Find the person

A request is about one person: the canonical subject and every account and key merged into it. Find them by what your game knows:

```js
const person = cw.privacy.find({ accountId: 'acct-123' }); // or { clientKey }
// null for an unknown caller. It never creates anyone. An address alone finds nobody.
```

Over HTTP, `POST /privacy/find { accountId }` (the owner's) answers `{ ref }` or `{ ref: null }`, and the hub's Settings, Advanced, "Privacy requests" panel does the same and opens the
person's page. The lookup is audited as `privacy.find` with no target: the account id is never written down.

## 2. Export

`cw.privacy.export(person)` (or "Export data..." on the person's page, or `GET /people/:ref/privacy/export`) returns everything the kit holds about the person as one JSON file: the
account ids as your game gave them, counts of keys and addresses (a hash never leaves the store), their sanctions, notices, the reports they filed and the reports about them (only the
lines they wrote), blocked lines, appeals, signals, mutes as counts, the "do not automate" mark, the staff actions about them (what and when, never who), and any report held for legal
reasons. It never contains another player's id, name or lines, a reporter's identity or a staff reference. A section is cut at 5000 rows and named in `truncated`.

The export is audited (`privacy.export`) before it is returned: if the audit row cannot be written, nothing is exported.

## 3. Erase

`cw.privacy.erase(person, { keep, actor })` (or "Erase data..." on the person's page, or `POST /people/:ref/privacy/erase`). The hub's dialog counts first, in words, and asks for the word
`ERASE`; over HTTP the body repeats the person's ref as `confirm`, and `dryRun: true` returns the same counts and writes nothing.

What goes, in one database transaction, then in memory:

- The person's subject, accounts, keys and addresses, strikes, notices, mutes (both ways), blocked names, appeals, signals (about them and caused by them), AI marks and reads, claims,
  Discord thread entry.
- Reports about them, with their decisions, AI rows and links. A report they filed stays for the person it is about, with their id, seat, name and note removed. Their lines inside other
  players' reports become the marker `[erased]`.
- In memory: their seats become guests, their evidence lines lose text, name and subject, and every cache forgets them. A player who is still connected and speaks again makes a new,
  unlinked person, never a row under the old id.

What stays:

- The **staff audit trail** (ids and codes only). The person's reference in it is replaced by the receipt id once nothing keeps the person.
- **Reports held for legal reasons**, whole (see "Legal hold" below). A hold is a duty the kit cannot weigh.
- With `keep: 'safety'` (the default), when the person has a sanction in force: their subject, their identifiers and that sanction with its notice (its quoted lines cleared). That is what
  lets a ban still refuse the same player at the door. This is the **safety remainder**, a mechanism with a stated meaning: enforce a sanction that is in force and honour a hold. It is not a
  legal conclusion. The erase **finishes itself**: when retention removes the sanction (by default 90 days after it ended or was revoked), the next `purge()` deletes the subject and the
  identifiers and points the audit rows at the receipt. `keep: 'none'` deletes the sanctions too: a ban the person is under stops applying.

The receipt (`{ id, at, mode, removed, kept }`) holds counts and words only: no subject, no line, no account. You can send it to the requester. It is kept on the audit clock (a year by
default). If the audit row of the erase could not be written, the receipt says `auditFailed: true`; the erase stands.

## 4. When several processes share a database

Another process still has the person in memory. Every erase moves a counter in the database; each process reads it at most every 30 seconds, on its next lookup, and forgets people the database
no longer has. A write that process makes for the erased person in the meantime does nothing (an identifier is only written for a subject that exists), and a strike or signal row it might add
is removed by the next `purge()` (rows of a subject that does not exist, older than ten minutes). Plan for a window of up to 30 seconds.

## 5. Legal hold

A senior can hold one report (`cw.legal.hold`, `PUT /reports/:id/hold`, "Hold for legal..." on the case) with one of five codes: `law_enforcement_request`, `legal_proceeding`,
`platform_request`, `safety_review`, `other`. There is no free text. A hold keeps the report with its decisions, the sanctions decided from it (every row), their notices, the appeals on them, the
AI reads and outcomes for it and its audit rows out of every retention purge and out of an erase, at any age. Only the owner releases a hold. The case shows a quiet "Held for legal reasons" line.

A hold emits `report.escalated` (ids and the code, never text). The kit forwards it to no one. Your game finds the player with `cw.people.accountIds(target)`, or opt a webhook in to
`includeAccounts`. What your game or your counsel does next is yours.

## 6. The evidence bundle

`cw.legal.bundle(reportId, { actor })` (the owner's; `GET /reports/:id/bundle`) is one JSON file: the report, the people involved by index (a staff reference and the name the report kept; account
ids only with `includeAccounts` / `?accounts=1`), the lines, the decision, the sanctions, notices and appeals (no notice text; an appeal statement only while the kit still holds it), the audit rows
of the report and its groups, and the hold. It never contains a hash, a key, an address or another player's id outside the people index. It is audited as `legal.bundle` before it is returned.

It says so itself: *Generated by Chatwarden. It records what the kit held. It does not say whether any content is unlawful and is not legal advice.*

**Verification.** Set `bundleSecret` (at least 32 characters, the same rule as a webhook secret) when you create the kit and keep it out of your code and logs. The bundle's `integrity` holds a SHA-256
of its canonical JSON (`chatwarden-json-1`: keys sorted, no whitespace) and an HMAC-SHA256 of the same bytes under your secret. Anyone with the file can check the SHA-256; you can check the HMAC:

```js
import { verifyBundle } from '@chatwarden/core';
const bundle = JSON.parse(fileText);
verifyBundle(bundle, process.env.BUNDLE_SECRET); // { sha256: true, hmac: true }
```

One changed byte in any field fails both. The signature proves the file came from your kit and was not edited since. It is **not** a timestamp authority and not a notarisation. Without a `bundleSecret`
the bundle is produced unsigned (`hmacSha256: null`) and the hub says "not signed".

## 7. What the kit does not do

It does not judge legality, report to anyone (no law enforcement, no regulator), verify a requester or an authority, tell the player, or run a step you did not ask for. It stores no refused text and
no filter counter by person.

## Templates

Both are starting points for your own words. Neither is advice, and neither is a claim that any law is met.

### A reply to a requester

> **Not legal advice, not a compliance claim.**
>
> Hello,
>
> We have checked that this request came from the account holder. As you asked, we erased the data we held about your account in <game name>. The attached receipt lists, in counts only, what was
> removed and what was kept. We kept <what the receipt says: for example "the record of a ban that applies to you, until it ends and its retention period passes"> because <your own reason,
> in your own words>. If anything on the receipt is unclear, reply to this message.
>
> <your name and contact>

### A hold note (for your own records)

> **Not legal advice, not a compliance claim.**
>
> Report <report id> was held on <date> by <role, not a name if your policy says so> for the reason code <code>. The request or reason on file is <your reference>. The hold is released by the
> owner when <your own condition>. The evidence bundle was downloaded on <date> by <role> and its integrity was checked with `verifyBundle`.
