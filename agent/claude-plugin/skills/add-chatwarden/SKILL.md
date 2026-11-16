---
name: add-chatwarden
description: Add Chatwarden chat moderation to a Node game server with `chatwarden init`: detect the stack, write the wiring, mount it, check it, and test the policy.
---

# Add Chatwarden to a game server

Use this when a user wants chat moderation (blocked words, reports, mutes, a moderator hub) in a Node server. Chatwarden is a set of npm packages. `chatwarden init` writes the wiring. You do not write it by hand.

## The three commands

1. Install and write the files. Run from the folder with `package.json`:
   `npm install @chatwarden/http @chatwarden/core`, then `npx chatwarden init --dry-run --json` to see the plan and write nothing, then `npx chatwarden init --yes --json`.
   The JSON lists each file, the packages to install, the variable names, the starter markers and the next steps.
2. Edit the one line the report names, for example `await mountChatwarden(app)` in the server file. Install the packages in `install.command`.
3. Run `npx chatwarden init --check`. It lists the starter code still in place and the required variables that are not set. Exit 1 means something is left.

## Choose flags from what you find

Read `package.json` and the project root first. `--yes` takes the detected answers, so pass a flag only to change one.

- `--framework express`, `fastify` or `next` when that package is a dependency. `--framework fetch` for Hono, Bun, Deno or any server on Web `Request`. `--framework none` for the library only.
- `--store memory` for a demo or a test. The default, `sqlite`, keeps a database file.
- `--chat box` only when the game has no chat. Keep the game's own chat otherwise (`--chat none`). With `socket.io` in the dependencies add `--chat-transport socketio`.
- `--hub element` for a plain page or any framework. `--hub react` for Next or a React app. `--hub none` for no hub.
- `--dir` and `--base` only when the user asks. Never `--force`: init never overwrites a file, and a conflict is exit code 2.

## Rules

- Never put a secret in `kit.ts` or any file init wrote. `CHATWARDEN_SECRET` (at least 32 characters in production) and `CHATWARDEN_ADMIN_TOKEN` (at least 24) come from the environment. Init writes names only in `.env.example`. A `.env` file is not loaded for you: use `node --env-file=.env`.
- Do not print or log secret values. Do not paste a real credential into a file.
- The starter is not finished. Replace each marker before going live: `TODO(auth)` (who may use the staff routes), `TODO(identity)` (who a player is) and `TODO(terms)` (the synthetic term pack is for trying it out; the user brings their own terms).
- Do not use real slurs or real player data in code or tests. Use invented words such as zorbak and snerp.
- The Next.js recipe needs a Node process (`next start`), not serverless. The generated hub needs an ESM project.

## Write a test with the test kit

Prove the policy with `@chatwarden/store-memory/testing`. It needs no database and no test runner. Put it in the project's own test file:

```ts
import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';

const kit = await createTestKit({ blocked: ['zorbak'] });
const run = await kit.play([
  { player: 'tarvo', say: 'good game', expect: 'delivered' },
  { player: 'fenrisk', say: 'zorbak', expect: 'refused:blocked' },
]);
expectOutcomes(run, ['delivered', 'refused:blocked']);
```

Then run the user's test command, then `npx chatwarden init --check`, and tell the user which markers remain.
