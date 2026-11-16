---
"@chatwarden/matcher": patch
---

The share client's note rules now match the term-corpus service's. A note that holds a C1 control character, a line or paragraph separator, a bidirectional control, an `@`, a run of digits (in any script) or a link, read in its NFKC form, is refused before anything is sent, as the service would refuse it. The note that is sent is still the one you wrote, not the normalised form, and ordinary non-ASCII notes still go. Nothing else changes.
