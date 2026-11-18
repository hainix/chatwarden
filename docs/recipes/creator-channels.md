# Creator channels: a scope per creator

A guide for the person who runs the game's moderation. A game with creator channels, clubs or hosted servers can let each creator's own moderators handle the reports from that creator's rooms, and
nobody else's. Chatwarden calls this a **scope**: a label on a room, and a list of labels on a moderator. It is the game's to assign.

This is not legal advice, and a scope is a limit on what a moderator sees and does in the hub and the staff API, not a legal or contractual arrangement with the creator.

## How it works

- **A room carries its creator.** The reserved tag `scope` (for example `creator:alice`) is set at `cw.rooms.seat`, next to the `context` tag: `^[a-z0-9][a-z0-9:_.-]{0,63}$`. A room's `scope` cannot change while it is open.
  A report stores the room's scope when it is filed.
- **A moderator carries a list.** Your `authorize` hook for the staff API returns `{ actor, role, scope: ['creator:alice'] }`. A caller with no `scope` sees everything, as before. A caller with one is scoped.
- **The query is filtered.** A scoped moderator reads and acts only on reports filed in their rooms. The filter is in the store query, not in the page. A report from a room with no scope is invisible to a
  scoped moderator, and a list that matches nothing matches nothing.

Which creator a moderator works for is your decision. The kit trusts the hook: it does not check that Alice's moderator is Alice's, or that a label means what you think it means.

## What a scoped moderator can do

Take the next case, read the queue and a case, claim and release, decide, see the history of a person (the reports in their scope and the sanctions that came from them), read the reasons and ask for a suggestion.
`GET /me` answers `scope` and a `can` trimmed to what a scoped caller may do, so the hub hides everything else.

## What a scoped moderator cannot do

- **See another creator's case.** A report outside the scope answers 404 `not_found`, the same as an id that does not exist, so a case's existence is not confirmed.
- **Reach the rest of the staff API.** Everything else (settings, terms, the audit trail, appeals, the AI, rule gaps, comments, bulk dismissal, the community routes and any route a later version adds until it opts in)
  answer 403 `forbidden`. The hub does not offer them.
- **See what is not theirs.** A scoped person history has no account ids, no signals, no links between accounts and no other room's transcript.
- **Be an owner.** The owner role cannot be scoped: an `authorize` result with `role: 'owner'` and a `scope` is refused 401, so a mistake fails closed.
- **Apply a heavy sanction.** A scoped moderator may apply only a warning or a chat restriction, for at most 7 days, never permanent, and only for a report in their scope (`reportId` in the body of `POST /sanctions`).
  Revoking is limited to a sanction that came from a report in their scope.

## What you wire

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { createMemoryStore } from '@chatwarden/store-memory';
import { adminRoutes, createRouter, type KitRequest } from '@chatwarden/http/admin';
```

The kit, and a room tagged with its creator.

```ts
const platform: Platform = { identify: (ctx) => ({ clientKey: String(ctx) }) };
const cw = await createChatwarden({ store: createMemoryStore(), secret: 'a-long-random-secret-for-this-run', platform });
cw.rooms.seat('alice-lobby', 'seat-1', { clientKey: 'player-1' }, 'Mia', { scope: 'creator:alice' });
```

The staff hook returns the moderator's scope, and `scopedLimits` widens or narrows the sanction limits above (the default is a warning and a chat restriction, for 7 days).

```ts
const authorize = async (req: KitRequest) => {
  const staff = await yourLogin(req); // your code: who is this, and which creator do they moderate
  return staff && { actor: staff.email, role: 'moderator' as const, scope: [`creator:${staff.creator}`] };
};
const handle = createRouter(adminRoutes(cw, { authorize, scopedLimits: { kinds: ['warning', 'chat'], maxDurationMs: 7 * 86_400_000 } }));
```

1. Tag every creator room at `cw.rooms.seat`. A room with no `scope` is seen by global staff only.
2. Give each creator's moderators the `moderator` role. A `senior` may be scoped too, which only matters for the permissions you raise to senior.
3. Keep a global team for what is not a creator's: the settings, the terms and appeals. A creator's moderator cannot reach them.
4. `guard()` and your own routes do not read `scope`. If you mount one for scoped callers, check the scope yourself.
5. Check `GET /me` in staging with a scoped login before you hand it to a creator.

## What it does not do

A scope does not make a creator's moderator a member of your staff, and it does not stop a creator's moderator from being wrong: the decisions are theirs, audited like any other, and a global moderator can read
and change them. It does not offer follower-only chat or any other creator feature beyond the limit on who sees which reports. It does not promise a response time.
