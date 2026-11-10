# @chatwarden/matcher

## 0.1.1

### Patch Changes

- Adds an optional flat positiveCorpus on a term pack: an edit that would unblock one of its lines is refused, inside the same transaction as the edit. A refusal now carries a typed code (duplicate, unblocks_known, invalid, not_found, not_loaded, build_failed). Adds LiveTerms.loadSync() and changeSync() for hosts that cannot await; an async function passed to changeSync throws a TypeError and its promise is left handled. Term ids no longer need node:crypto, so the package bundles for a browser. Behaviour change for a custom TermStore: LiveTerms now calls writeAudit with the names term.add, term.update, term.toggle, exception.add, exception.update and exception.toggle instead of add, edit, enable and disable. If your store filters or switches on entry.action, match both the new names and the old ones already in your rows; the old names stay in the AuditEntry action type, which is now wider. A toggle's direction is in entry.afterJson (active), stored as after_json by store-sqlite. A refusal object now also carries a code key, so a test that compares refusals with strict equality will see it. @chatwarden/store-sqlite already reads both.
- Updated dependencies
  - @chatwarden/core@0.1.1

## 0.1.0

### Minor Changes

- First public release.

### Patch Changes

- Updated dependencies
  - @chatwarden/core@0.1.0
