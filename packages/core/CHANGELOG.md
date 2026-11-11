# @chatwarden/core

## 0.1.2

### Patch Changes

- The moderator hub, a player UI, and a profile and reporting setup that moderators can edit without a deploy. All ten packages move to 0.1.2 together.
  
  **New packages**
  
  - `@chatwarden/hub-react` is the moderator hub as a React component. It opens in Simple mode, one card per case, for a team of one or two; Detailed is the full workbench for a bigger team, with the queue, the person's record, the blocked words, rule gaps, the audit trail and the guide. Moderators on a team claim a case so two of them do not decide it at once, and see who is on what. There are four ways to adopt it: drop in `<Hub>`; place single pieces (queue, case, person, settings) in your own dashboard; use the headless hooks or controller, which need no React (`@chatwarden/hub-react/headless`); or use the custom element below.
  - `@chatwarden/player-react` is what a player sees: the notice queue (a warning to acknowledge, a restriction, a ban), "My record", the rules page, the report dialog and the line that tells a restricted player what is limited. It follows the reporting setup the kit hands it.
  - `@chatwarden/hub-element` is the hub as `<chatwarden-hub>`, one script tag and one element, for plain HTML, Vue, Svelte or a server-rendered admin page. React is inside the script, so the page needs no build step.
  
  **Kit**
  
  - The warning steps and the ladder of sanctions are editable. An owner changes them in the hub (or through the new `GET /policy/profile` and `PUT /policy/profile` staff routes) and the kit uses the change straight away, with a saved version, a conflict check and a reset to the preset. `cw.policy` reads, previews, saves and resets the editable layer, and `cw.profile` is always the live result.
  - Reporting is configurable, and one tap is the default. A profile can set the flow (one tap, pick a reason first, or reason required), the list of reasons (their names, hints and the Community Rules they map to), and the thank-you text. A report records the reason the player gave as `reportedReason`, and the hub shows it beside the case, filters the queue by it, and says how often a reporter's reasons matched the decision. After a one-tap report the player can add a reason or a note once, within 10 minutes (`cw.reports.addDetail`); a filed report now answers with `detailUntil`, the moment that window ends, so a screen can stop offering the follow-up. Reports about the same person are one case: deciding one keeps the moderator's claim while others are open, and deciding the last one ends it (`cw.cases.releaseWhenDone`).
  - Moderators keep saved reasons for their decisions, and claim cases so two of them do not decide the same person. `POST /cases/next` takes an optional `reason` (a reason id, or `none`), so Take next can hand out the next case a reporter filed under one reason.
  - `GET /policy/profile` (and `cw.policy.get()`) carries `layerError` when the stored layer cannot be read or is invalid. The kit ignores that layer and keeps running on the preset until an owner saves a good one.
  - The SQLite and in-memory stores keep the editable layer, saved reasons, claims and the reason and follow-up of each report. Both stores and `@chatwarden/http` now need core 0.1.2 or newer (see the upgrade notes).
  
  **Upgrade notes**
  
  - Profiles you wrote for 0.1.1 still work as they are. The editable layer sits on top of the profile you pass to `createChatwarden`; nothing is rewritten.
  - `ReportRefusal` gained members, `reason_required` and `reason_unknown`. If you switch on the refusal with an exhaustive `never` check, add the two cases; otherwise nothing changes.
  - `category` is still accepted when a report is filed. It is read as the reason with the same name, and a report still records the 0.1.1 category it belongs to.
  - The hub's keyboard shortcuts answer when focus is inside the hub. On the page body they answer only when that is the only hub on the page, or the one marked `primary`.
  - The SQLite store runs migrations 15, 16 and 17 when it opens: claims and saved reasons (15), the editable profile layer (16), and the reason and follow-up columns on reports, with the old category copied into the reason (17). They run automatically, keep every existing row, and need nothing from you; keep a backup before the first start on a database you care about.
  - `@chatwarden/http`, `@chatwarden/store-memory`, `@chatwarden/store-sqlite`, `@chatwarden/hub-react` and `@chatwarden/player-react` now peer on `@chatwarden/core` `^0.1.2` (and `hub-react` on `@chatwarden/http` `^0.1.2`), because they use what is new in 0.1.2. `core`, `matcher`, `profanity` and `discord` keep their `^0.1.0` ranges.
  - The `Store` interface in `@chatwarden/core` gained 14 required methods: `listSubjectSanctions`, `listStrikes`, `countStrikesByTerm`, `listOpenReports`, `listOpenReportsByPerson`, `reporterTally`, `changeToken`, `claimCase`, `releaseClaim`, `loadClaims`, `listReasons`, `insertReason`, `updateReason` and `setReasonActive`. It also gained four optional ones: `addReportDetail`, `loadPolicyLayer`, `savePolicyLayer` and `loadReporterDecisions`. `@chatwarden/store-memory` and `@chatwarden/store-sqlite` have all of them. If you wrote your own `Store`, it no longer type-checks against 0.1.2 until you add the 14 required methods. Run the store contract suite (`test/contract` in the Chatwarden repository) against it to check each one.
  - New subpath `@chatwarden/http/admin`: the staff routes (`adminRoutes`, `createRouter`, the errors, roles and permissions) without the player routes, the webhooks or the Express adapter. It imports no Node builtin, so a browser or edge bundle can run the staff routes. `@chatwarden/http` itself is unchanged.

## 0.1.1

### Patch Changes

- Runs in a browser: the hashing and random ids no longer import any node: module (node:crypto is used when the runtime has it, a pure-JS SHA-256 and HMAC-SHA256 otherwise), and hashes are byte-identical to 0.1.0. Adds cw.chat.restricted(who, { roomId, seatId }), the same decision as accept without sending a line, for typing indicators. Exports the RestrictedAnswer type for it. A failing restriction lookup on that path is logged at most once a minute.

## 0.1.0

### Minor Changes

- First public release.
