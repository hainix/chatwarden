---
status: draft, awaiting controller rulings (section 18)
updated: 2026-11-12
release: the release after flood control and signals (0.1.8; versions are assigned in merge order)
---

# K4b: making adoption fast (init, recipes, a test kit)

Chatwarden has the parts: an engine, a store, routes, a hub, a chat box. What it does not have is a short road from "I have a game
server" to "moderation works". Today that road is the root README's quick start plus `examples/tiny-chat`: about 60 lines of wiring an
adopter must read, understand and adapt, in a framework we only half cover (Express has an adapter; Fastify, Next.js and anything else
get "use `createRouter` and write your own"). This note adds the short road: an `init` command that writes the wiring, one more HTTP
adapter so the other frameworks stop being second class, recipes that are tested code rather than prose, and a test kit so an adopter can
write "under my profile this conversation yields these outcomes" in their own CI.

It fills the K4b row of `docs/design/2026-11-09-product-scope.md` (section 8: "Socket.IO, Colyseus, Fastify, Next.js recipes; `npx
chatwarden init`; service mode (Docker); Claude Code plugin; `llms.txt`", and the "Test kit for adopters" row), and it is the "adopt at
any depth" promise of `docs/design/2026-11-10-hub-simple-mode-and-embedding.md` ("adoption to be chill") applied to the server side.
Three of the rows are cut or deferred (sections 11 and 12), each with its reason.

## 1. Why

**The first hour decides adoption.** A studio with chat and no trust-and-safety staff (the product scope's test for "complete") will give
a library an hour. In that hour they must: install five packages, learn that the term matcher, the store, the secret and the platform
hooks are separate things, mount three route tables in the right order (before any body parser), write two auth hooks, serve the hub, and
only then see a blocked line. Every step is documented; none of it is automatic. The kit's rules (no identifier to a player, raw body
before parsers, a real client address) are enforced by the adopter's discipline, and a template that is right once is worth more than a
paragraph that is right every time.

**Frameworks other than Express are second class.** The FAQ on the site says it plainly: "any other framework can use `createRouter` ...
If your server is written in another language, there's no ready-made bridge yet." A Fastify or Next.js adopter writes the adapter
themselves, including the two parts that are easy to get wrong: the raw body (no framework JSON parser may touch it) and the Server-Sent
Events stream of the chat box. The Web `Request`/`Response` pair is what Next.js route handlers, Hono, Bun, Deno, SvelteKit and Remix all
speak, and Fastify 5 accepts a `Response` from a handler (checked against 5.12.8's `Reply.md`). One adapter for that pair covers all of
them.

**Adopters cannot test their policy.** The kit's own tests use fixtures (`reportingWorld.ts`, `chat.test.ts`'s stub matcher and a fake
clock) that an adopter cannot import. So "does my `strict` profile with my term pack refuse what I think it refuses, and time out whom I
think it times out?" is checked by hand, in a browser, once. The first profile change breaks it silently. A game that can write that as a
test keeps its policy.

**Agents adopt too.** The owner's direction (2026-11-09) is "completely turnkey", and in 2026 a good share of adoption is an agent
running a command in someone's repo. An agent needs the properties a CI job needs: flags for every answer, machine-readable output, no
prompt that hangs, no overwrite, no network, deterministic files.

## 2. Goals and non-goals

### Goals
- One command takes a Node project from nothing to a working, moderated server: `chatwarden init`. It asks at most seven questions, every
  one with a detected or safe default, and every one also a flag.
- It works the same for a person, a CI job and an agent: `--yes`, `--json`, `--dry-run`, exit codes that mean something.
- It never overwrites a file that differs without being told to, is idempotent (a second run changes nothing), writes no secret, makes no
  network request and reads and writes only under the project.
- Fastify, Next.js route handlers and anything on Web `Request`/`Response` get a first-class adapter, `@chatwarden/http/fetch`.
- The recipes for Express, Fastify, Next.js, Socket.IO and Colyseus are real files that are type-checked and run in CI, not snippets that
  rot. Init writes the first four's wiring; the Colyseus page is tested code a person copies (section 9).
- An adopter's test can drive a scripted conversation through the real kit on a fake clock and assert the outcomes, in any test runner.
- No new npm package, so the release workflow's OIDC trusted publishing works unchanged (section 4).

### Non-goals
- No service mode (Docker image, server-to-server check API) in this release (section 11).
- No generator that edits the adopter's own files: not `package.json`, not their app entry, not `.gitignore`, not any `.env`. Init
  writes new files and prints what to add by hand (section 5.5).
- No real term list, ever. The generated kit uses the synthetic pack and says so loudly (section 7.3).
- No auth system. The generated `authorize`, `identify` and `join` are a starter that works for the first run and warns in production.
- No docs CLI, agent eval or Claude Code plugin with commands or hooks (section 12).
- No runtime dependency anywhere, and no network call by the CLI.

## 3. Rulings (decided; the details below follow from them)

1. **Ruling: nothing new is published as a package in this release.** The init CLI is a `bin` of `@chatwarden/http`; the test kit is a
   subpath of `@chatwarden/store-memory`; the fetch adapter is a subpath of `@chatwarden/http`. The release is the ten packages through
   OIDC, exactly as 0.1.6's. The nicer `npm create chatwarden` is a documented, one-manual-step follow-up that the owner can choose later
   (section 4).
2. **Ruling: the command is `chatwarden init`.** An adopter runs it as `npx chatwarden init` after installing `@chatwarden/http` (which
   they do anyway), or as `npx -p @chatwarden/http chatwarden init` / `npm exec --package=@chatwarden/http -- chatwarden init` before
   installing anything. The package also exports `@chatwarden/http/cli` (`runCli`, `@experimental`) so a future `create-chatwarden` shim is
   a three-line file.
3. **Ruling: zero runtime dependencies, no network.** `node:util` `parseArgs`, `node:readline/promises`, `node:fs/promises`, `node:path`.
   The only `child_process` use is the opt-in `--install`, in one file, with a fixed argument list. A test fails the build if a CLI source
   file imports a network module.
4. **Ruling: init writes new files under one directory and never edits an existing file.** Default `src/chatwarden/` when `src/` exists,
   else `chatwarden/` (`--dir`). Framework entry points that must live elsewhere (Next's `app/chatwarden/[...path]/route.ts`) are the only
   files outside it, and each is new. A file that exists and differs is a conflict: skipped by default, never overwritten without
   `--on-conflict overwrite` (or `--force`) or an interactive "overwrite". The only exit code that is not 0 for an otherwise fine run is
   `2`: "some files were skipped because they differ".
5. **Ruling: everything lives under one URL prefix, `/chatwarden`.** `/chatwarden/admin` (staff), `/chatwarden/api` (player),
   `/chatwarden/chat` (the chat box), `/chatwarden/mod` (the hub page), `/chatwarden/healthz` and `/readyz`. An existing game has its own
   `/api` and `/admin`; tiny-chat's bare prefixes would collide with them on the first run. `--base` changes it.
6. **Ruling: two framework adapters, one new.** Express keeps `toExpress`. A new `toFetch` at `@chatwarden/http/fetch` serves Next.js,
   Fastify (through a 25-line bridge the template writes), Hono, Bun, Deno, SvelteKit and Remix. No Fastify-specific adapter, no Next
   package, no dependency on any framework.
7. **Ruling: init generates Express, Fastify, Next.js (route handlers), generic Web-fetch and library-only wiring, and the Socket.IO
   transport; Colyseus is a tested docs page.** Reasons in section 9: Colyseus is a large, fast-moving dependency whose room API changed
   between 0.15 and 0.16, and the page's code is tested against a structural fake, not a running Colyseus.
8. **Ruling: the generated code is the recipe.** There is one source of recipe code: the init templates. Their output for a fixed set of
   answers is committed as golden files under `examples/recipes/cases/`, type-checked and run in CI against the real frameworks, and the
   recipe pages in `docs/recipes/` embed those files (a test fails if a page and a golden differ).
9. **Ruling: the test kit is `@chatwarden/store-memory/testing`.** It cannot be in `@chatwarden/core` (core has no store, and
   `store-memory` peers on core, so core would import its own peer). A separate `@chatwarden/testing` package would need the owner's manual
   first publish (section 4). It is browser-safe (no `node:` import), has no dependency, and is framework-neutral (no vitest or jest
   import; assertions throw plain errors and outcomes are plain strings).
10. **Ruling: the starter is safe by default and visibly a starter.** With no `CHATWARDEN_ADMIN_TOKEN` set, every staff route answers 401,
    including the hub page. A missing `CHATWARDEN_SECRET` stops the server in production and uses a loudly logged development secret
    otherwise. The synthetic term pack logs a warning in production. Each starter hook carries a `TODO(auth)` or `TODO(terms)` marker that
    `chatwarden init --check` (section 5.7) lists, so "I forgot to replace the starter" is findable.
11. **Ruling: service mode is deferred to its own phase.** Reasons and the minimal sketch are in section 11.
12. **Ruling: `llms.txt` is refreshed now (it is stale: it says the kit "is not a chat system"); a skill-only Claude Code plugin ships in
    the repo; the docs CLI and the agent eval are deferred.** Section 12.
13. **Ruling: the owner's UI rule applies to the CLI.** The default path is: run, press Enter through the questions, see one next-steps
    block. No prompt is asked when it can be detected, and advanced choices (`--base`, `--dir`, `--lang`, `--on-conflict`) are flags, not
    questions.
14. **Ruling: the site does not promise speed until someone has timed it.** The copy changes in its own PR after the release is on npm
    (section 13), and the "in about 15 minutes" claim waits for a timed run, as `docs/plans/follow-ups.md` already says.

## 4. Packaging, and the publish constraint

**The constraint.** The release workflow publishes through npm trusted publishing (OIDC): no token, a signed provenance statement. npm
lets an owner add a Trusted Publisher only to a package that already exists. So a package that has never been on npm cannot be published
by the workflow. Before the tag that carries a new package, the owner must: (1) publish that package by hand once, from a machine
signed in with 2FA, at exactly the version the fixed group will release (the workflow skips a package whose exact version is already on
npm, which is how a hand-published version and the rest of the run fit together); (2) on npmjs.com open the new package, Settings,
Trusted Publisher, GitHub Actions, repository `hainix/chatwarden`, workflow `release.yml`. The hand-published version has no provenance
badge. (RELEASING.md's "New packages: the first publish" describes the older, token-based version of this; the token is gone, so the
hand publish replaces it.) Until the owner has done both, the release fails at that package. That is a manual step on the critical path
of every release that adds a package, and a package that is added to the repository but forgotten fails the run.

**Options for the init CLI**

| | A. `bin` in `@chatwarden/http` | B. unscoped `create-chatwarden` | C. `@chatwarden/create` |
| --- | --- | --- | --- |
| Command | `npx chatwarden init` (after `npm i @chatwarden/http`), or `npx -p @chatwarden/http chatwarden init` | `npm create chatwarden@latest` (also `npm init chatwarden`) | `npm create @chatwarden` (npm expands `@scope` to `@scope/create`) |
| Manual owner step | none | publish by hand once, add Trusted Publisher, then every release | the same as B |
| Where it is owned | the `@chatwarden` org, like the rest | the owner's personal npm account (an unscoped name belongs to a user or a maintainer list, not the org) | the org |
| New package in the fixed group, `publish-order`, `check-pack`, manifests tests, RELEASING.md counts ("ten" becomes eleven) | no | yes | yes |
| Discoverability | the README says it; an agent reading `--help` finds it | the command a person or agent guesses | less guessed than B |
| Name risk | none (the bin is `chatwarden`) | `create-chatwarden` is free today (E404 on 2026-11-12) and stays free until someone takes it; the name is not reserved until the owner publishes | `@chatwarden/create` is free today and is protected by the scope |
| Works before anything is installed | `npx -p ...` form | yes | yes |

**Recommendation: A now.** It needs no owner step, ships with the release it is merged in, and covers what a person does anyway: install
`@chatwarden/http` (every route-using adopter does), then run the bin npx finds in `node_modules/.bin`. The first-ever command is longer
(`npx -p @chatwarden/http chatwarden init`), and that is the plain cost: it is not what a person would guess. The trade is a longer
first command now against a manual step and an eleventh package in every release for a shorter one later. The shim stays cheap: the CLI
is exported at `@chatwarden/http/cli`, so `create-chatwarden` (or `@chatwarden/create`) is a package of one file,

```js
#!/usr/bin/env node
import { runCli } from '@chatwarden/http/cli';
process.exitCode = await runCli(process.argv.slice(2));
```

with `@chatwarden/http` as its one dependency, and a `bin` name that is not `chatwarden` (the shim's bin is `create-chatwarden`) so the
two never fight over `node_modules/.bin/chatwarden`. The owner can choose B or C at any time; question 1 in section 18 asks, with this
recommendation: not yet, revisit after the release has had real adopters.

**Why `http` and not another package.** The CLI is Node code (`node:fs`, `node:readline`), so it cannot live in a browser-safe package
(`core`, `matcher`, `store-memory`, `hub-*`, `player-react` all forbid `node:` imports by lint). `http` is the package every adopter that
mounts routes installs, it already imports `node:crypto` and `node:` modules in its Express and webhook code, and the CLI scaffolds
http's own routes. `src/cli/` is a new directory of `http`, reached only by the `bin` and the `./cli` export; it is not imported by
`@chatwarden/http/chat` or `/admin`, so their browser-safety proofs (`scripts/browser-bundle.test.ts`) are untouched, and a test asserts
that no browser-safe entry reaches `src/cli/`.

**The test kit.** `@chatwarden/testing` as a package is the product scope's name and needs the same manual step. `@chatwarden/core/testing`
is impossible (core cannot import a store; see ruling 9). `@chatwarden/store-memory/testing` needs nothing and has the right
dependency direction (it already peers on core, and a memory store is the thing every test needs). The cost is discoverability: the
import path says "store-memory". The READMEs of core and store-memory both point at it, and if the owner later publishes
`@chatwarden/testing`, it re-exports this subpath.

**What changes in the repository for packaging** (section 17): `http/package.json` gains `bin`, `./fetch` and `./cli` in `exports` and
`typesVersions`; `store-memory/package.json` gains `./testing`; vitest gets the matching aliases (the more specific ones before the base
names, as the file already orders them); `scripts/check-pack.mjs` learns `bin` (the file exists in the tarball, begins with the
`#!/usr/bin/env node` line, and `exportTargets` counts it); the smoke test runs the packed bin.

## 5. The init CLI

```
chatwarden init [options]        write the wiring for a Chatwarden-moderated server
chatwarden --help | -h
chatwarden --version | -v
```

Run from the project root (the folder with `package.json`). It never searches parent folders, never touches anything outside the project
and the directory it was told to write.

### 5.1 What it asks

Seven questions at most. Each has a flag, a detected default, and is skipped when its flag is given or when it can be detected without
doubt. Enter accepts the default.

| # | Question | Flag | Values | Default and detection |
| --- | --- | --- | --- | --- |
| 1 | Which server framework? | `--framework` | `express`, `fastify`, `next`, `fetch` (anything on Web Request/Response), `none` (library only: no routes) | from `package.json` dependencies (`next` wins over `express`); else `express` |
| 2 | Where should it keep moderation data? | `--store` | `sqlite` (a file, survives restarts), `memory` (tests and demos; lost on restart) | `sqlite` |
| 3 | Do you already have chat? | `--chat` | `none` (yes, I have chat; I will call the check), `box` (add the kit's chat box) | `none` |
| 3b | (only for `box`, only when `socket.io` is a dependency) Reach the box over | `--chat-transport` | `sse` (HTTP, works anywhere), `socketio` (your Socket.IO server) | `socketio` when `socket.io` is installed, else `sse` and no question |
| 4 | How will moderators open the hub? | `--hub` | `element` (one HTML page), `react` (a component), `none` | `react` for `next`, else `element` |
| 5 | Post reports to a Discord forum? | `--discord` / `--no-discord` | yes or no | no |
| 6 | Which standard? | `--profile` | `relaxed`, `standard`, `strict` | `standard` |

Not questions, flags only: `--base` (default `/chatwarden`), `--dir`, `--lang ts|js` (default from `tsconfig.json`), `--on-conflict
skip|overwrite|new` (default `skip`; `--force` is `overwrite`), `--install`, `--dry-run`, `--json`, `--yes` / `-y`, `--check`.

Rules for the answers:
- `--framework none` with `--chat box` or `--hub` is a usage error (nothing to mount them on). `--framework next` with `--hub element` is a
  usage error (Next serves no script file from a route handler without extra work; use `react`). `--chat box` with `--chat-transport
  socketio` needs a framework other than `none`. Every usage error is one sentence that names the flag and says what to pass, exit 1.
- The chat box is a React component. With `--chat box` and no React in the project, init still writes the server half and prints one line:
  "The box is a React component; without React, use the `ChatTransport` seam (see the recipe)".
- When `--yes` is given or stdin is not a terminal, no question is asked: detected values and defaults are used, and a non-terminal run
  says so once on stderr ("stdin is not a terminal: using detected answers"). A non-terminal run never hangs waiting for input.

### 5.2 What happens: plan, then apply

Init builds a plan first and applies it second. The plan is pure data: the answers, the list of files with their full content, the
install command, the environment variables, the next steps. `--dry-run` prints the plan and stops. `--json` prints the same plan (and
the result of applying it) as one JSON document. A test runs every combination of answers through `plan()` with no filesystem at all.

Applying a plan, per file:
- does not exist: create it (and its parent folders), write `\n` line endings, write to a temporary name in the same folder and rename it,
  so an interrupted run never leaves half a file;
- exists and is byte-identical: `unchanged` (this is what makes a second run a no-op);
- exists and differs: a conflict. `--on-conflict skip` (the default) leaves it and lists it; `overwrite` replaces it; `new` writes the
  content beside it as `name.chatwarden-new.ts` (a second conflict on that name is skipped). Interactively, a conflict asks
  `[s]kip  [o]verwrite  [n]ew file beside it  [d]iff` (default `s`) once per file, and `d` shows at most 40 changed lines and asks again.

Path rules: every path written is computed from `--dir` and the template's relative name; the resolved path must stay inside the project
root (`--dir ../x` and a symlinked folder that leaves the project are refused, exit 1); `--base` must match `^/[A-Za-z0-9_/-]*$` with no
`//` and no trailing slash. Output paths are printed with forward slashes on every platform.

### 5.3 What it never does
- Never edits or deletes an existing file, including `package.json`, `.gitignore`, `.env*`, `tsconfig.json` and the app's entry.
- Never writes a secret or a real credential: `.env.example` holds placeholders.
- Never makes a network request, never checks for updates, never sends telemetry. (The optional `--install` runs the project's package
  manager, which has its own network access; that is the only outward step and it is named in the output.)
- Never runs a script from the project or reads a file outside the project.
- Never installs unless `--install` is given; the default prints the exact command for the project's package manager.

### 5.4 Install and next steps

The install line is built from the answers and the project's package manager (`pnpm-lock.yaml` gives `pnpm add`, `yarn.lock` `yarn add`,
`bun.lock` or `bun.lockb` `bun add`, anything else `npm install`), with the kit packages pinned to a caret range of the version that
shipped the CLI (`^0.1.8`, taken from `@chatwarden/http`'s own `VERSION`: the group is fixed, so one number is right for all):

`@chatwarden/core @chatwarden/http` always; `@chatwarden/store-sqlite` or `@chatwarden/store-memory`; `@chatwarden/matcher`;
`@chatwarden/profanity`; `@chatwarden/discord` for the feed; `@chatwarden/hub-element` or `@chatwarden/hub-react` (with `react react-dom`
when the project has neither) for the hub; `@chatwarden/player-react` (with React) for the box. Types the framework needs (`@types/express`)
are named in the next steps, not installed.

With `--install` it runs that command in the project folder, by spawning the package manager without a shell where it can (the path npm
puts in `npm_execpath` run with `process.execPath`) and with `shell: true` on Windows only for the fixed, validated argument list, never
for any value the user typed. A failure prints the command and exits 3.

The next-steps block is always the same four lines in the same order: the install command (if not run), the one line to add to the
app's entry (a framework-specific `app.register(...)`), "set `CHATWARDEN_SECRET` and `CHATWARDEN_ADMIN_TOKEN`" with the command that makes
a value (`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`), and the URL to open.

### 5.5 Idempotency, determinism and Windows

- **Deterministic.** No timestamp, no random value, no machine path in any generated file. The same answers write the same bytes on every
  machine. The header of each file says "Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a
  file you changed."
- **Idempotent.** Running init twice with the same answers: every file `unchanged`, exit 0. Running it again with an added answer (`--chat
  box`) writes the new files, reports the changed ones as conflicts (exit 2) and says which ones, with `--on-conflict new` available to
  see the difference beside them.
- **Windows.** All path logic goes through an injected `path` module, and the tests run it with `path.win32` and a fake file system;
  generated import specifiers are always POSIX (`./kit.js`); line endings are `\n`; a `.cmd` shim from npm runs the bin; no file name is
  longer than 60 characters; the printed commands avoid shell quoting that differs between `cmd`, PowerShell and sh (an env example, not an
  `export`). A CI job runs the CLI tests on `windows-latest`.
- **No hang.** Every readline question has an end-of-input handler that falls back to its default.

### 5.6 Exit codes and `--json`

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do, or `--dry-run`/`--check` found nothing wrong |
| 1 | Usage error: an unknown flag or a value that is not allowed, a bad combination, an unsafe path |
| 2 | Applied, but one or more files were skipped because they differ (re-run with `--on-conflict new` to compare) |
| 3 | Could not write or install (permission, full disk, a failing package manager) |

`--json` writes one document to stdout and nothing else (human text, warnings and prompts go to stderr, and `--json` implies `--yes`):

```json
{
  "version": 1,
  "chatwarden": "0.1.8",
  "ok": true,
  "answers": { "framework": "express", "store": "sqlite", "chat": "box", "chatTransport": "sse", "hub": "element", "discord": false, "profile": "standard", "base": "/chatwarden", "dir": "src/chatwarden", "lang": "ts" },
  "files": [
    { "path": "src/chatwarden/kit.ts", "action": "created" },
    { "path": "src/chatwarden/auth.ts", "action": "skipped", "reason": "differs" }
  ],
  "install": { "manager": "npm", "command": "npm install @chatwarden/core@^0.1.8 @chatwarden/http@^0.1.8 ...", "ran": false },
  "env": [ { "name": "CHATWARDEN_SECRET", "required": true }, { "name": "CHATWARDEN_ADMIN_TOKEN", "required": true } ],
  "todo": [ { "file": "src/chatwarden/auth.ts", "line": 12, "marker": "TODO(auth)" } ],
  "nextSteps": [ "..." ],
  "warnings": []
}
```

The shape is versioned (`version: 1`); a field is added, never repurposed. It carries no secret, no absolute path and no file content.

### 5.7 `chatwarden init --check`

Reads the files init writes (never anything else) and reports what is still starter: each `TODO(auth)`, `TODO(terms)` and
`TODO(identity)` marker, the synthetic term pack, a missing env name from `.env.example` that the environment does not define (it reads
`process.env` names only, never values into the output). Exit 0 when none remain, 1 otherwise: usable as a pre-deploy check in CI and by
an agent ("is this ready for production?"). It makes no change.

### 5.8 Transcripts

An interactive first run (Express project with `src/`, no `tsconfig` paths worth noting, defaults accepted except the chat box):

```text
$ npx -p @chatwarden/http chatwarden init
Chatwarden init. This writes new files into ./src/chatwarden and touches nothing else.

1. Server framework       express (detected)   [express/fastify/next/fetch/none]  >
2. Moderation data        sqlite               [sqlite/memory]                    >
3. Chat                   none                 [none = I have chat / box = add the kit's chat]  > box
4. Moderator hub          element              [element/react/none]               >
5. Discord forum feed     no                   [y/N]                              >
6. Standard               standard             [relaxed/standard/strict]          >

  create   src/chatwarden/kit.ts
  create   src/chatwarden/auth.ts
  create   src/chatwarden/terms.ts
  create   src/chatwarden/express.ts
  create   src/chatwarden/hub.ts
  create   src/chatwarden/ChatPanel.tsx
  create   src/chatwarden/.env.example

Next:
  1. npm install @chatwarden/core@^0.1.8 @chatwarden/http@^0.1.8 @chatwarden/store-sqlite@^0.1.8 @chatwarden/matcher@^0.1.8 \
       @chatwarden/profanity@^0.1.8 @chatwarden/hub-element@^0.1.8 @chatwarden/player-react@^0.1.8 react react-dom
  2. In your server entry, after `const app = express()`:
       import { mountChatwarden } from './chatwarden/express.js';
       await mountChatwarden(app);
  3. Set CHATWARDEN_SECRET and CHATWARDEN_ADMIN_TOKEN (see src/chatwarden/.env.example). A value:
       node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
  4. Start your server and open http://localhost:3000/chatwarden/mod

Not production-ready yet: src/chatwarden/terms.ts uses invented test words, and src/chatwarden/auth.ts has a starter
sign-in. Run `npx chatwarden init --check` to list what is left.
```

A re-run after the person edited `auth.ts` and wants Discord:

```text
$ npx chatwarden init --discord
...
  unchanged  src/chatwarden/terms.ts
  skipped    src/chatwarden/auth.ts      (differs from what init would write; yours is kept)
  skipped    src/chatwarden/kit.ts       (differs: adds the Discord feed)
  create     src/chatwarden/.env.example.chatwarden-new  ...
```
(and exit code 2; the next-steps block says "Re-run with `--on-conflict new` to write the new versions beside yours".)

An agent or CI, no prompts, structured result:

```text
$ npx chatwarden init --yes --framework fastify --store sqlite --chat none --hub element --profile strict --json
{"version":1,"chatwarden":"0.1.8","ok":true,"answers":{...},"files":[{"path":"src/chatwarden/kit.ts","action":"created"}, ...], ...}
$ echo $?
0
```

A dry run and a usage error:

```text
$ npx chatwarden init --dry-run --framework none --hub react
chatwarden: --hub needs a server framework to mount on; use --framework express, fastify, next or fetch, or --hub none.
$ echo $?
1
```

## 6. What init writes

Generated files are small and meant to be read. Sizes are lines at the time of writing.

### 6.1 Files, by answers

| File (under `--dir` unless noted) | When | What it is |
| --- | --- | --- |
| `kit.ts` (~55) | always | `createKit()`: opens the store, builds the matcher, calls `createChatwarden`, wires the Discord feed and the broadcaster when asked. Exports `Kit` (`{ cw, chat?, hooks, base, close() }`). The one place the engine is configured. |
| `auth.ts` (~60) | framework is not `none` | `authorize(req)` for staff, `identify(req)` for players, `join(req, room)` for the chat. The starter versions (section 7.2). |
| `terms.ts` (~20) | always | `loadMatcher()`: `LiveTerms` over the store, seeded from `syntheticTermPack()`. `TODO(terms)`. |
| `.env.example` (~12) | always | `CHATWARDEN_SECRET`, `CHATWARDEN_ADMIN_TOKEN`, `CHATWARDEN_DB` (sqlite), `DISCORD_WEBHOOK_URL` and `DISCORD_MENTION_ROLE_ID` (Discord), `CHATWARDEN_TRUST_PROXY` (Next, fetch). Placeholders only. |
| `express.ts` (~45) | `express` | `mountChatwarden(app)`: the prefix mounts through `toExpress`, with `fallthrough: false`, before any body parser, the hub page and script (`element`), the chat routes (`box`). |
| `fastify.ts` (~60) | `fastify` | A Fastify plugin: removes the body parsers inside its own encapsulation, bridges to `toFetch`, registers at `base`. |
| `handler.ts` (~35) | `next`, `fetch` | Builds the kit once (cached on `globalThis` so Next's dev reloads do not open the database twice) and returns `toFetch(mounts, { prefix: base })`. |
| `app/chatwarden/[...path]/route.ts` (~12; `src/app/...` when the project uses it) | `next` | Exports `GET POST PUT PATCH DELETE HEAD` from the handler; `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`. |
| `hub.ts` (~50) | `hub: element` | The `/mod` page (one `<chatwarden-hub base-url=...>`, strict CSP), the script route (the file `@chatwarden/hub-element/standalone` resolves to), the sign-in form that sets the starter cookie. |
| `HubPage.tsx` (~15), plus `app/chatwarden/mod/page.tsx` (~5) for Next | `hub: react` | `<Hub client={createHubClient(fetchTransport({ baseUrl: '<base>/admin', credentials: 'same-origin' }))} />`. |
| `ChatPanel.tsx` (~30) | `chat: box`, React present | A client component: lazy `ChatBox` over `sseTransport({ baseUrl: '<base>/chat' })` (or `socketTransport`), with the two stylesheet imports and `NoticeQueue`. |
| `socketio.ts` (~55), `socketTransport.ts` (~60) | `chatTransport: socketio` | Server: `attachChat(io, kit)`. Client: a `ChatTransport` over a `socket.io-client` socket (section 9.4). |

With `--lang js` the same files are written as ESM JavaScript (`.js` when `package.json` has `"type": "module"`, else `.mjs`), without
type annotations; `.tsx` becomes `.jsx`.

### 6.2 The server module, in outline

`kit.ts` for Express, SQLite, the chat box and a Discord feed (type annotations kept; the real file is longer only in comments):

```ts
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createProfanityFilter } from '@chatwarden/profanity';
import { createRoomBroadcaster } from '@chatwarden/http/chat';
import type { RoomBroadcaster } from '@chatwarden/http/chat';
import { discordFeed } from '@chatwarden/discord';
import { loadMatcher } from './terms.js';
import * as hooks from './auth.js';

export const BASE = '/chatwarden';
export interface Kit { cw: Chatwarden; chat: RoomBroadcaster; hooks: typeof hooks; close(): Promise<void>; }

export async function createKit(): Promise<Kit> {
  const secret = secretFromEnv(); // production without CHATWARDEN_SECRET throws; development logs once and uses a fixed development secret
  const store = openStore({ path: process.env.CHATWARDEN_DB ?? './chatwarden.db' });
  const matcher = await loadMatcher(store);
  let chat: RoomBroadcaster | undefined;
  const cw = await createChatwarden({
    store, secret, matcher, profile: 'standard', profanityPackage: { createProfanityFilter },
    platform: { identify: () => ({}), notify: (subject) => chat?.noticePending(subject) }, // `identify` is used only for seatConnection; the routes identify with hooks.identify
  });
  chat = createRoomBroadcaster(cw);
  if (process.env.DISCORD_WEBHOOK_URL) {
    discordFeed(cw, { webhookUrl: process.env.DISCORD_WEBHOOK_URL, hubLink: (kind, id) => `${hubOrigin()}${BASE}/mod#/${kind}s/${id}` /* ... */ });
  }
  return { cw, chat, hooks, async close() { chat?.close(); await cw.close(); } };
}
```

`express.ts` mounts what the README's quick start mounts, in the order it prescribes (kit routes before any body parser, probes last,
`fallthrough: false` so an unknown path under the prefix is the kit's 404 and never a hang):

```ts
export async function mountChatwarden(app: Express): Promise<Kit> {
  const kit = await createKit();
  app.use(`${BASE}/admin`, toExpress(adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: /* LiveTerms */ }), { fallthrough: false }));
  app.use(`${BASE}/api`, toExpress(playerRoutes(kit.cw, { identify: kit.hooks.identify }), { fallthrough: false }));
  app.use(`${BASE}/chat`, toExpress(chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }), { fallthrough: false }));
  mountHub(app, kit); // from hub.ts
  app.use(BASE, toExpress(healthRoutes(kit.cw), { fallthrough: false }));
  return kit;
}
```

The returned `Kit` lets the adopter reach `kit.cw.chat.accept(...)` for their own chat (the "I already have chat" answer), and `kit.close()` on
shutdown.

### 6.3 The "library only" and "I already have chat" outputs

`--framework none` writes `kit.ts`, `terms.ts` and `.env.example` and prints the six-line hook for the adopter's own chat handler:

```ts
const kit = await createKit();
kit.cw.rooms.seat(roomId, seatId, { clientKey, accountId, ip }, handle);   // when a player joins a room
const r = kit.cw.chat.accept(roomId, seatId, text);                        // before broadcasting a line
if ('refuse' in r) tellOnlyThisPlayer(r.refuse.reason, r.refuse.until);    // never broadcast a refused line
else broadcast(r.deliver.text);                                            // starred text when the profile stars swearing
```

`--chat none` with a framework prints the same hook beside the next steps, because "I already have chat" is the common case and the
mounted routes alone moderate nothing until the check is called.

## 7. The starter: auth, secret, terms

These are the three places a first run needs something and a production run needs the adopter's own. Each is a small, named file with a
marker, and each fails closed.

### 7.1 Secret

`createChatwarden` keys every client-key and IP hash with `secret`; changing it unlinks every stored hash. `secretFromEnv()` reads
`CHATWARDEN_SECRET`. In production (`NODE_ENV === 'production'`) a missing or shorter than 32 characters value throws at startup with a
message that names the variable and the generating command. Outside production it logs once ("using a development secret; hashes will
not survive a change") and uses a fixed string. `.env.example` has `CHATWARDEN_SECRET=` and nothing after the equals sign.

### 7.2 Hooks (`auth.ts`)

- **`authorize(req)`** (staff). Reads `CHATWARDEN_ADMIN_TOKEN`; when it is unset or shorter than 24 characters, returns `null` for every
  request (401). When set, accepts the header `x-admin-token` or the starter cookie, compares with `timingSafeEqual`, and returns `{ actor:
  'admin', role: 'owner' }`. The starter cookie (set by the `/mod/login` form in `hub.ts`) holds an HMAC of the token under the secret,
  `HttpOnly`, `SameSite=Strict`, `Path=<base>`, `Secure` in production, never the token itself. In production it logs once per start:
  "starter staff sign-in is on; replace authorize() with your own". `TODO(auth)`. (A small shop with one or two moderators can keep a
  shared token; a team replaces it with its own session and roles.)
- **`identify(req)`** (players). Returns `{ clientKey: <header x-chatwarden-key>, ip: req.remoteAddress }`, with `accountId` when the
  adopter fills it. `TODO(identity)`: "your game's own session or account id goes here; a client-chosen key lets one person make many
  identities". With `CHATWARDEN_TRUST_PROXY=1` it takes the client address from the first `x-forwarded-for` entry for the frameworks whose
  adapter cannot see the socket (Next, fetch); the kit's rule, that an adapter never reads a header for the address, holds because this
  is the adopter's hook, not the adapter, and the comment says "only behind your own proxy".
- **`join(req, roomId)`** (chat). Returns `{ name: 'Player N' }` for the room `lobby` only, N counted per key (never any part of the key),
  bounded to 400 names, and `null` for any other room, as tiny-chat does. `TODO(identity)`.

### 7.3 Terms (`terms.ts`)

`loadMatcher(store)` builds `LiveTerms` over the store and seeds it from `syntheticTermPack()` of `@chatwarden/matcher/fixtures`. The
comment: "TEST WORDS ONLY. Replace the pack with your own term list before launch; `LiveTerms` keeps edits in the store, so moderators
change words in the hub's Words screen". In production it logs one warning per start while the store still holds only the synthetic
pack's ids. The memory-store variant uses `MemoryTermStore` from the same fixtures module for the term list (the list is lost on restart
like everything else). The kit has no real term list to ship (a product rule), so this is the honest default and the reason `--check`
exists.

## 8. The fetch adapter: `@chatwarden/http/fetch`

The one new public API in `http` apart from the CLI. It makes Next.js, Fastify (through the template's bridge), Hono, Bun, Deno, Workers,
SvelteKit and Remix "first class" with one adapter. No `node:` import; no dependency; browser-safe like `@chatwarden/http/chat` (a Web
adapter has no reason to be Node-only, and the site can test it in a page). `@experimental` until 0.2.

```ts
import type { Logger } from '@chatwarden/core';
import type { RouteTable } from '@chatwarden/http';

/** Route tables by the path they live under: `{ '/admin': adminTable, '/api': playerTable, '': healthTable }`. A key is '' or starts with '/' and has no trailing '/'. */
export type Mounts = Record<string, RouteTable>;

export interface FetchOptions {
  /** Where the mounts are rooted in the URL, e.g. '/chatwarden'. Default ''. A request outside it is not this adapter's (see `unmatched`). Same key rule as above. */
  prefix?: string;
  /** The largest request body read, in bytes. Whole number, default 65536 (BODY_MAX_BYTES), at most 16 MiB (RangeError above). More is the kit's 413. */
  maxBody?: number;
  /** The socket peer's address if the host can tell, for `KitRequest.remoteAddress` (Bun: `server.requestIP`; Next: nothing). Never a header. Default: absent. */
  remoteAddress?: (request: Request) => string | undefined;
  /** A path no mount owns: `'not_found'` (default) answers the kit's JSON 404; `'pass'` resolves `null` so the host can answer. */
  unmatched?: 'not_found' | 'pass';
  /** Where the adapter logs (event and error class only). Default `console.warn`. */
  logger?: Logger;
}

export function toFetch(mounts: Mounts, options: FetchOptions & { unmatched: 'pass' }): (request: Request) => Promise<Response | null>;
export function toFetch(mounts: Mounts, options?: FetchOptions): (request: Request) => Promise<Response>;
```

Behaviour, each pinned by a test (section 14):
- Longest matching mount key wins; the matched prefix is stripped before the route table sees the path, so the same tables `toExpress` takes
  work unchanged (`adminRoutes` at `'/admin'`).
- The `KitRequest` is built from the `Request`: method, path (no query), query (first value of each key, strings only), lower-cased
  headers, `rawBody` the exact text of the body (read with a byte cap while streaming; a declared `content-length` over the cap is refused
  before reading), `body` left `undefined`, `remoteAddress` only from the option.
- Handler errors go through `withErrors` exactly as in `toExpress`: the kit's error shapes, never a stack, never a thrown rejection.
- A response with `stream` becomes a `ReadableStream`: `write` enqueues and returns `false` when the stream's `desiredSize` is not positive
  (the backpressure signal `KitStream` documents), `end` closes it, the returned cancel runs exactly once when the stream is cancelled
  or `request.signal` aborts, and the same default headers `toExpress` adds (`cache-control: no-store, no-transform`, `x-accel-buffering:
  no`, `content-type: text/event-stream; charset=utf-8`) are added unless the route set them.
- HEAD: the status and headers of the GET handler, no body, `start` not called. A string body is sent raw with `text/plain` unless the
  response sets a type; anything else is JSON; the same rule as `send` in `express.ts`.
- `prefix` or a mount key that is malformed is a `RangeError` when `toFetch` is called, never a request-time surprise.

## 9. Recipes

A recipe is what an adopter on a given stack needs to wire the kit. This release has five. Where code appears, it is a golden file
(ruling 8): produced by init, committed, type-checked and run.

| Stack | Written by init | Docs page | Tested how |
| --- | --- | --- | --- |
| Express | yes (`--framework express`) | `docs/recipes/express.md` | golden, type-check (NodeNext), run over a real Express and `fetch`: the hub 401s without a token, a blocked line is refused with rule 1, the chat stream's first frame is `hello` |
| Fastify | yes (`--framework fastify`) | `docs/recipes/fastify.md` | golden, type-check, run over a real Fastify 5 (`app.inject` for the JSON routes, a real listening server for the stream); the bridge keeps the raw body; a client abort cancels the stream |
| Next.js (route handlers) | yes (`--framework next`) | `docs/recipes/nextjs.md` | golden, type-check under `moduleResolution: bundler`, run by calling the exported handlers with Web `Request`s (no `next` dependency); the layout is pinned by a file-list test |
| Web fetch (Hono, Bun, Deno, SvelteKit, Remix) | yes (`--framework fetch`) | in `docs/recipes/nextjs.md` (the handler is the same) | the same handler test |
| Socket.IO | yes (`--chat box --chat-transport socketio`) | `docs/recipes/socketio.md` | golden, type-check, run over a real `socket.io` server and `socket.io-client` |
| Colyseus | no: a docs page | `docs/recipes/colyseus.md` | its code is a file under `examples/recipes/cases/colyseus/`, type-checked against structural stand-ins for `Room` and `Client` and run against fakes; not run in a real Colyseus (risk, section 15) |

### 9.1 Express
Today's wiring, in the generated shape: `toExpress` mounts with `fallthrough: false`, the kit before any body parser. `examples/tiny-chat`
stays the runnable, richer example (a WebSocket protocol, a demo page); the Express page links to it and to the golden.

### 9.2 Fastify
Fastify parses JSON before a handler runs, and the kit must see the raw body. The plugin is encapsulated, so removing the parsers does not
touch the adopter's other routes:

```ts
export const chatwarden: FastifyPluginAsync<{ kit: Kit }> = async (app, { kit }) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body)); // the kit reads the exact text itself
  const peers = new WeakMap<Request, string>();
  const handle = toFetch(mountsOf(kit), { prefix: BASE, unmatched: 'pass', remoteAddress: (r) => peers.get(r) });
  app.all('/*', async (request, reply) => {
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    const req = new Request(new URL(request.url, `${request.protocol}://${request.host}`), {
      method: request.method, headers: headersOf(request.headers), signal: gone.signal,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: String(request.body ?? '') }),
    });
    peers.set(req, request.socket.remoteAddress ?? '');
    const res = await handle(req);
    return res === null ? reply.callNotFound() : reply.send(res);
  });
};
```
registered with `app.register(chatwarden, { kit, prefix: BASE })`. Two facts the plan verifies before it relies on them (Task 4's first
step): that `reply.send(res)` with a streaming `Response` delivers each SSE frame as it is enqueued and stops the producer when the client
aborts (Fastify 5.12.8's `Reply.md` documents `Response` in `reply.send`; the abort path is not documented), and that
`removeAllContentTypeParsers` inside a plugin is encapsulated. If the first fails, the bridge pipes `res.body` to `reply.raw` after
`reply.hijack()` instead; the recipe's behaviour tests do not change.

### 9.3 Next.js
The route handler is the adapter: Next calls `GET(request: Request)`. The catch-all `app/chatwarden/[...path]/route.ts` hands every method
to `handler.ts`'s `toFetch` (which owns the kit for the process). The hub is a client component page at `app/chatwarden/mod/page.tsx`
(the static `mod` segment wins over the catch-all). Honest limits, in the page and in `--help`: the chat box's rooms are in memory and its
streams are long-lived, and the SQLite file must survive restarts, so this recipe is for a Next that runs as a Node process
(`next start`, a container, a VM), not for serverless functions (a Vercel-style host kills the process between requests and has no durable
disk). Moderation without the box also needs the durable store. A Postgres store is K14.

### 9.4 Socket.IO
A game with a Socket.IO server already has a socket; it needs the box over it, with every line still through `cw.chat.accept`. The chat box
design (section 5.3) already specifies the server seam (`chat.session(...)`, `ChatSink`) and the client seam (`ChatTransport`); this
recipe is their first concrete use:

```ts
// socketio.ts (server): one line in the adopter's code, attachChat(io, kit)
export function attachChat(io: Server, kit: Kit): void {
  io.of(`${BASE}/chat`).use(identifySocket(kit)).on('connection', (socket) => {
    const room = String(socket.handshake.auth.room ?? '');
    const member = kit.hooks.join(handshakeRequest(socket), room);                      // the same join hook the HTTP routes use
    if (member === null) return void socket.disconnect(true);
    const session = kit.chat.session(room, whoOf(socket), member);
    if ('refused' in session) { socket.emit('chat:refused', session.refused); return void socket.disconnect(true); }
    const stream = session.open({ write: (frame) => { socket.emit('chat:frame', frame); return socket.connected; } });
    socket.on('chat:send', (input, ack) => ack(session.send({ text: String(input?.text ?? '') })));
    socket.on('chat:mute', (input, ack) => ack(session.mute(input)));
    socket.on('chat:report', async (input, ack) => ack(await session.report(input)));
    socket.on('disconnect', () => stream.close());
  });
}
```
(The outline keeps the shape; the real file adds the stream limits and is covered by the tests.) The client file,
`socketTransport.ts`, implements `ChatTransport.open(room, events)` over a `socket.io-client` socket (`frame` events become
`events.frame`, `connect_error` and `disconnect` map to `events.status`, `send`/`mute`/`report` are acks), so the same `<ChatBox>` works. A
namespace, not the default one, keeps the game's own events apart; the identity hook is the same `identify` as the routes.

### 9.5 Colyseus
A Colyseus `Room` has `onAuth`, `onJoin`, `onLeave`, `onMessage`. The recipe is a small `ModeratedChat` helper a room calls
(`attach(room, kit)`): `onAuth` is where the game identifies the player (the `who`), `onJoin` opens a session whose sink does
`client.send('chat:frame', frame)`, a `'chat:send'` message answers with `client.send('chat:result', ...)`, `onLeave` closes the stream. The
page states which Colyseus major version the shape follows and that it was checked against fakes (section 15); it is not generated by init
because a generated file that imports Colyseus types would have to be tested against a real Colyseus on every release, and that
dependency is heavy and moves.

### 9.6 Where recipes live and how they stay true
`docs/recipes/*.md` are short (one screen of prose each) and embed the golden files with a marker, `<!-- golden: express/kit.ts -->`,
that `scripts/recipes.test.ts` expands and compares byte for byte, the way `scripts/readme.test.ts` already checks the READMEs. The goldens
are `examples/recipes/cases/<case>/...` (a private workspace, not published; section 17), and `golden.test.ts` renders the CLI for each
case's answers and compares. `UPDATE_GOLDEN=1` rewrites them on purpose, in the same commit as the template change.

## 10. The test kit: `@chatwarden/store-memory/testing`

What exists today and what is missing: `packages/core/test/reportingWorld.ts` (a kit over `MemoryStore`, a fake clock, a two-person table,
`submit`), `chat.test.ts`'s `stubMatcher` and `filter`, and the clock literals every test repeats. They are private to the repo and
shaped for core's tests. The kit takes their shape and makes it a public, small, documented API.

Everything is browser-safe (no `node:` import), has no runtime dependency beyond `@chatwarden/core` (a peer, as for `store-memory`), imports
no test runner, and is `@experimental` until 0.2. Nothing in it is for production: it is named `testing`, it uses the memory store, and the
README says so first.

### 10.1 API

```ts
import type { Chatwarden, ChatwardenOptions, ChatResult, Clock, ConductLevel, KitEvent, Logger, Matcher, ProfanityFilter, RuleRef, Store, Suggestion } from '@chatwarden/core';

/** A number of ms, or '250ms' | '5s' | '30m' | '2h' | '7d'. Anything else is a RangeError. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;
export function durationMs(d: Duration): number;

/** A clock you move by hand. `now()` is what `createChatwarden` reads. Starts at 1_800_000_000_000 (the repo's tests' constant). */
export interface FakeClock extends Clock {
  now(): number;
  set(epochMs: number): void;
  /** Moves forward (never back) and returns the new time. */
  advance(by: Duration): number;
}
export function createFakeClock(startMs?: number): FakeClock;

/** A matcher that blocks whole words, case-insensitively, with spans for masking. The words are yours (invented ones in the docs). Not the real matcher: it does not resist evasion. */
export function wordMatcher(words: readonly string[]): Matcher;
/** A profanity filter that stars whole words (`hit` true when any matched). */
export function wordFilter(words: readonly string[]): ProfanityFilter;

export interface TestKitOptions extends Partial<Omit<ChatwardenOptions, 'store' | 'platform' | 'clock' | 'logger' | 'secret'>> {
  /** Shorthand for `matcher: wordMatcher(blocked)`. Ignored when `matcher` is given. Pass your real `LiveTerms` or `buildMatcher` result as `matcher` to test your own term pack. */
  blocked?: readonly string[];
  /** Shorthand for `profanity: wordFilter(swears)`. Ignored when `profanity` or `profanityPackage` is given. */
  swears?: readonly string[];
  /** Another store (a failing subclass, a SQLite store). Default: a fresh MemoryStore. */
  store?: Store;
  /** Clock start. Default 1_800_000_000_000. */
  start?: number;
}

export interface TestKit {
  readonly cw: Chatwarden;
  readonly store: Store;
  readonly clock: FakeClock;
  /** Every kit event, in order (one `cw.on` subscription per event type in `KIT_EVENT_TYPES`). */
  readonly events: readonly KitEvent[];
  /** Every warning the kit logged, in order (`event` and `detail`, never text). */
  readonly logged: ReadonlyArray<{ event: string; detail?: Record<string, string | number | boolean> }>;
  /** A room whose players are named by you: `kit.room('lobby')`. Created on first use. */
  room(id?: string): TestRoom;
  /** Run a script (section 10.2) and return what happened. Throws `ScriptMismatch` at the first step whose `expect` is not met. */
  play(steps: readonly Step[], opts?: { room?: string }): Promise<Run>;
  /** What the profile suggests for this player now, at this conduct level and rule (`cw.suggest` by name). */
  suggest(player: string, level: ConductLevel | null, rule?: RuleRef, room?: string): Suggestion;
  close(): Promise<void>;
}

export function createTestKit(options?: TestKitOptions): Promise<TestKit>;
```

`TestRoom` (what a hand-written test uses; `play` is built on it). Players are named strings; the first mention seats them with
`{ clientKey: 'test-key:' + name }` and the seat id is the name:

```ts
export interface TestRoom {
  readonly id: string;
  /** Seat a player (idempotent). Optional: `say` and the rest seat on first use. */
  join(player: string, who?: RawWho): void;
  say(player: string, text: string): SayOutcome;
  report(player: string, target: string, input?: { reason?: string; note?: string }): Promise<ReportOutcome>;
  mute(player: string, target: string, on?: boolean): void;
  leave(player: string): void;
  /** True when `viewer` is shown what `sender` sent (mutes applied): `cw.chat.visibleTo`. */
  sees(viewer: string, sender: string): boolean;
}

export type SayLabel = 'delivered' | 'starred' | `refused:${string}`;   // starred: delivered with different text; refused:<reason> is the kit's reason, incl. slow_mode, flood, duplicate once flood control has shipped
export interface SayOutcome {
  kind: 'say'; player: string; text: string; at: number;
  result: ChatResult;                 // exactly what cw.chat.accept returned
  label: SayLabel;
  /** Set when this line earned an automatic timeout (`auto.restricted`): 'first' (30 min) or 'second' (24 h). */
  autoRestricted?: 'first' | 'second';
}
export type ReportLabel = 'filed' | `refused:${string}`;
export interface ReportOutcome { kind: 'report'; player: string; target: string; at: number; result: ReportResult; label: ReportLabel }
```

### 10.2 The script and the assertion

A script is data, so it can be read as a specification, kept in a table and shared between tests:

```ts
export type Step =
  | { player: string; say: string; expect?: SayLabel | readonly SayLabel[] }
  | { player: string; report: string; reason?: string; note?: string; expect?: ReportLabel }
  | { player: string; mute: string; on?: boolean }
  | { wait: Duration }
  | { suggest: string; level: ConductLevel | null; rule?: RuleRef; expect: string };   // compares Suggestion.label, e.g. 'Warning'

export interface Run {
  readonly steps: ReadonlyArray<SayOutcome | ReportOutcome | { kind: 'wait'; at: number } | { kind: 'mute'; at: number } | { kind: 'suggest'; at: number; suggestion: Suggestion }>;
  /** The labels of the say and report steps, in order: the thing to assert on in any runner. */
  readonly outcomes: readonly string[];
  readonly events: readonly KitEvent[];
}

/** Throws a plain `Error` (class `ScriptMismatch`) with a table of expected and actual per step when the labels differ. Runner-neutral. */
export function expectOutcomes(run: Run, expected: readonly string[]): void;
```

An adopter's test (vitest shown; it is the same in Jest or `node:test`):

```ts
import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';

it('strict: a blocked word is refused, three in an hour earn a timeout, a warning is suggested for a first rude line', async () => {
  const kit = await createTestKit({ profile: 'strict', blocked: ['zorbak'], swears: ['snerp'] });
  const run = await kit.play([
    { player: 'tarvo', say: 'good game', expect: 'delivered' },
    { player: 'fenrisk', say: 'snerp that', expect: 'refused:profanity' },       // strict refuses ordinary swearing
    { player: 'fenrisk', say: 'zorbak', expect: 'refused:blocked' },
    { wait: '10m' },
    { player: 'fenrisk', say: 'you zorbak', expect: 'refused:blocked' },
    { player: 'fenrisk', say: 'zorbak zorbak', expect: 'refused:blocked' },
    { player: 'fenrisk', say: 'hello', expect: 'refused:restricted' },           // the third strike in an hour: a 30 minute timeout
    { suggest: 'fenrisk', level: 'hostile', expect: 'Restrict chat 7 days' },    // whatever YOUR profile says: this pins it
  ]);
  expectOutcomes(run, ['delivered', 'refused:profanity', 'refused:blocked', 'refused:blocked', 'refused:blocked', 'refused:restricted']);
  expect(run.events.some((e) => e.type === 'auto.restricted')).toBe(true);
});
```

(The `expect` values in the example are illustrative; the plan's tests assert them against the kit as built, and the README's example is
checked by `scripts/readme.test.ts` so it cannot lie.)

For the table form ("under my profile, these lines yield these outcomes", each independent):

```ts
/** One fresh kit and one player per case; throws a ScriptMismatch listing every case that differs, not only the first. */
export function checkLines(options: TestKitOptions, cases: ReadonlyArray<{ text: string; expect: SayLabel }>): Promise<void>;
```

### 10.3 What it deliberately does not do
- No HTTP: it drives `cw` directly. Testing an adopter's own `identify`/`join`/`authorize` is a different test; the recipes' goldens show
  how (a Request into `toFetch`).
- No decisions: moderator `decide` flows are `kit.cw.reports...` calls the adopter makes directly; a step for them is in "not in this release".
- No real matcher inside: `wordMatcher` is a stub on purpose; the adopter passes their own `matcher` to test their term pack.
- No time passing by itself: nothing moves unless `wait` or `clock.advance` does, so a test is deterministic.

### 10.4 Built from what exists
`createFakeClock` is `reportingWorld`'s `clock` with `set` and `advance`. `createTestKit` is `world()` with the matcher, profanity and
event capture added (`retention: false`, a fixed test secret, `logger` collecting into `logged`, a `platform.identify` that reads the
`RawWho` it is given). `wordMatcher` and `wordFilter` are `chat.test.ts`'s stubs with a word list. The kit's own tests then import from
the new module instead of their private copies where it is a straight swap (a refactor in the same release, behind the same tests; the
plan names the files, and it is optional: nothing else depends on it).

## 11. Service mode: deferred

The K4b row lists "service mode (Docker)" for non-Node stacks. **Ruling: not in this release.** Reasons:

1. **It is a new public API and a new security surface, not a packaging step.** A non-Node game server needs server-to-server calls
   the kit does not have today: seat a player, check a line, report, fetch pending notices, with the service holding the evidence buffer
   and the rate budget. Those are trusted-caller routes (an API key between two backends), a different threat model from the player routes
   (a hostile client) and the staff routes (a signed-in moderator). It deserves its own design note, its own authentication decision and
   its own review, and it should not be squeezed in beside an init command.
2. **It has no publish target the release can use.** A Docker image is a new artifact: a registry, a tag policy, provenance for the image,
   a base image to patch. The release workflow publishes npm packages; an image workflow is new and outward (permanent tags on a public
   registry), which the owner's rules reserve for his go-ahead.
3. **State is per process.** The evidence buffer, rate limits, pacing and the broadcaster's rooms are in memory (stated in the chat-box
   design, section 10, and in flood control's section 4.6). A service that a second instance can be put behind needs shared state first
   (Redis, K14). Shipping a service that is single-instance by construction is fine; shipping one with a horizontal-scaling story would not
   be honest, and that story is a separate phase.
4. **The SDKs are the point, and they are K14.** A service for non-Node stacks is useful with Unity, Godot, Unreal or server-language
   clients; those are listed in K14 on purpose.
5. **There is an honest interim.** A non-Node adopter can already run the generated Express service (a few files, one process) and use
   the chat box over HTTP for the whole chat, which needs no server-to-server API because the player talks to the service directly. The FAQ
   says so (section 13) and says what is not covered: your own game server calling the check from another language.

**What this release does to keep the door open.** The generated `kit.ts` separates the engine (`createKit`) from the framework mount, so a
future `serve` command is `createKit` plus one more route table, in a `Dockerfile` of a dozen lines; `--json`'s plan output is the same
data the service's config would read. A sketch of what the next phase would look at, not a commitment: `chatwarden serve` (an
`http.createServer` over `toFetch`), routes `POST /v1/rooms/:room/seats/:seat`, `POST /v1/rooms/:room/seats/:seat/lines` (the check),
`POST /v1/reports`, `GET /v1/seats/:seat/notices`, a bearer service key from the environment, an OpenAPI file, and an image published by a
new workflow. Question 3 in section 18 asks the owner whether it is the next phase.

## 12. `llms.txt`, the Claude Code skill, and what is deferred

**`llms.txt` (do now, small).** `site/public/llms.txt` exists and is now wrong: it says "It moderates an existing chat; it is not a chat
system", but 0.1.6 ships a chat box. The refresh: the one-line summary says it moderates an existing chat and can add a moderated chat
box; a new "Adopt fast" section names `chatwarden init` (and its two forms), `@chatwarden/http/fetch`, `@chatwarden/store-memory/testing`
and links `docs/recipes/*.md` and the CLI flag list. The site's existing tests keep holding: every link resolves to a real repo path
(`meta.test.ts`), the store-memory npm link stays (`finalReview.test.ts`), and no line promises more than the page does. No `llms-full.txt`.
It ships with the site copy PR (section 13), not with the release, because it links npm pages that exist only after the release.

**A skill-only Claude Code plugin (do now, small).** The repository gets `.claude-plugin/marketplace.json` and one plugin,
`agent/claude-plugin/`, with `.claude-plugin/plugin.json` and one skill, `skills/add-chatwarden/SKILL.md`. The skill teaches HOW (the
single-agent-plus-skills pattern): when a user says "add chat moderation", run `npx chatwarden init --yes --json` with flags chosen from
what is detected, read the JSON, wire the one line, set the two env names, run `chatwarden init --check`, and write a test with the test
kit. It has no hooks, no commands, no MCP server. Installable with `/plugin marketplace add hainix/chatwarden`. A static test checks the
JSON parses, the skill's front matter has `name` and `description`, and every `--flag` the skill mentions is in the CLI's option table
(so the skill cannot drift from the CLI). The plan's first step re-checks the plugin layout against the current Claude Code plugin
documentation before writing it (the format is outside this repo and I could not verify it offline).

**Deferred.**
- **A docs CLI** (`chatwarden docs <topic>`). `--help`, `--json`'s `nextSteps`, the READMEs inside every installed package, `llms.txt` and the
  recipe pages already put the docs where an agent looks; a command that prints them adds a surface to maintain without a reader we have
  evidence for.
- **An agent eval** (does an agent adopt Chatwarden from the docs alone, how often, in how many steps). A real eval needs a harness, a
  budget and a pass criterion; it is its own project. What this release leaves it: `--json` (machine-readable result), `--check` (a pass
  criterion: exit 0 means no starter left), the goldens (the expected files) and the recipe tests (the expected behaviour).

## 13. Docs, the site and the READMEs once it ships

**In the release (the repo):**
- Root `README.md`: the "I want to" table gains a first row, "Set it up fast: write the wiring for my server": `npm install
  @chatwarden/http @chatwarden/core`, then `npx chatwarden init` (and the `npx -p` form for before anything is installed). The Quick start
  keeps its hand-wired code ("what init writes, explained") and gains one sentence pointing at init. A new short section, "Test your
  policy", shows the test kit example.
- `packages/http/README.md`: sections "The init command" (flags table, exit codes, `--json`) and "Other servers: `toFetch`" (Next,
  Fastify, Hono, Bun) beside the existing "Writing another adapter".
- `packages/store-memory/README.md`: "Testing your policy" (the kit, with the example), and `packages/core/README.md` gets a two-line pointer.
- `docs/recipes/{express,fastify,nextjs,socketio,colyseus}.md`.
- `docs/status.md` (a K4b entry), `docs/plans/follow-ups.md` (the "Non-Node servers" item gains the service-mode pointer; the 15 minutes item
  gains the timing procedure), `CLAUDE.md` (the `http` row gains the CLI and fetch adapter; the `store-memory` row the testing subpath),
  `RELEASING.md` (two lines: the bin, and "a package added later needs the hand-publish steps in this note's section 4"),
  `examples/tiny-chat/README.md` (a line: "`chatwarden init` writes the same wiring for your own project").

**After it is on npm (a separate site PR, like the chat box's):**
- The "Add it to your game" lead gains the init command as step one ("or write it by hand below"), and the install step (`INSTALL_KIT`)
  stays the hand-wired path. `site/test/content.test.ts` already checks the site's code against the READMEs, so the command is copied from
  the README.
- The FAQ answer on other languages is rewritten: "Node servers, with any framework (an init command writes the wiring for Express,
  Fastify and Next.js; anything on Web `Request`/`Response` uses `toFetch`). For a server in another language, run the generated service and
  let players talk to it with the chat box; a service API for your own game server's calls is planned (not built)."
- `llms.txt` refreshed (section 12).
- **No speed claim** until someone has timed a fresh Express project from `npm init` to a blocked line with a stopwatch (the follow-up
  already says so). The timing procedure is written in the plan so it is a checklist, not a mood.

## 14. Tests that pin it

Test-first and broad, targeted runs only (no full suite). The CLI is tested with an injected environment (in-memory file system, `path`
module, `stdin`/`stdout`, `env`, platform) so almost nothing touches a disk; a handful of tests use a real temporary folder; the smoke
test uses the packed tarballs. Names are indicative; the plan gives each task its exact list.

**CLI arguments and answers (`cli-args.test.ts`, `cli-answers.test.ts`)**
- Every flag parses; an unknown flag, a value not in its set, a repeated singleton, `--yes --json` combinations and `--help` text are
  exercised; a bad combination (`none` with `--hub`, `next` with `--hub element`) is exit 1 with one sentence naming the flag.
- Detection: `package.json` with express, fastify, next, react, socket.io; lockfiles; `tsconfig.json`; `src/`; `"type": "module"`;
  a missing or invalid `package.json` is exit 1 with a clear sentence, never a stack.
- The answers matrix: every legal combination of framework, store, chat, transport, hub, discord and profile produces a plan (no file
  system); every illegal one is rejected; the option table the skill and `--help` print is derived from the same object.

**Plan and apply (`cli-plan.test.ts`, `cli-apply.test.ts`, `cli-conflict.test.ts`, `cli-idempotent.test.ts`)**
- Two runs of the same answers produce byte-identical plans; no file contains a timestamp, a random value, an absolute path or a
  carriage return; the generated text contains no secret-shaped value (a scan for long hex or base64 runs and for the synthetic words
  that are only allowed in `terms.ts`).
- Apply: create, unchanged, skip, overwrite, new; a conflicting `.chatwarden-new` name is skipped; an interrupted write (a rename that
  throws) leaves no partial file; permission errors are exit 3 and name the path; paths that escape the project (`..`, an absolute
  `--dir`, a symlinked folder) are exit 1 and nothing is written.
- Idempotent: init, then init again: all `unchanged`, exit 0; edit one file, re-run: that file is skipped, exit 2, nothing else changes;
  `--on-conflict new` writes beside; `--force` overwrites and says so.
- Never overwrites: a property test over random existing-file contents asserts a file that differs is untouched unless overwrite was asked.
- `--dry-run` writes nothing (the injected file system records zero writes) and prints the same list `--json` would.

**Safety and portability (`cli-static.test.ts`, `cli-windows.test.ts`)**
- Static: no CLI source imports `node:http`, `node:https`, `node:net`, `node:dns`, `node:tls` or `fetch`; `node:child_process` appears only in
  `install.ts`; no runtime dependency in `http/package.json` (the dependency list stays as it is); no browser-safe entry reaches `src/cli/`;
  the CLI makes no call when a global `fetch` that throws is installed (a poisoned global).
- Windows: the whole CLI runs with `path.win32`, drive-letter roots and backslash input: printed paths use `/`, generated specifiers are
  POSIX, `--dir src\chatwarden` is accepted and normalised, a reserved name (`CON`, `NUL`) as `--dir` is refused, no output path exceeds 200
  characters. The same tests run on `windows-latest` in CI against the real `node:path`.
- Install: the command is built per package manager (npm, pnpm, yarn, bun); with `--install` a fake spawner receives the fixed argument
  list and never a user value; `shell` is used on win32 only; a failing spawner is exit 3 with the command printed.
- No hang: stdin that ends at once, stdin that is not a terminal, and an EOF in the middle of a question each fall back to the default.

**Templates (`cli-templates.test.ts`, `golden.test.ts`, `recipes-run.test.ts` under `examples/recipes/`)**
- Golden: each case's CLI output equals the committed files (byte for byte); a template change without a golden update fails.
- Type-check: every golden compiles (`tsc --noEmit`) under NodeNext (express, fastify, socketio, fetch) or Bundler + JSX (next, hub react,
  ChatPanel), with `strict` and `erasableSyntaxOnly`; the JS variants pass `node --check` (ESM).
- Run: Express (hub 401 without a token, 200 with the cookie; a blocked line is refused with rule 1; `POST` with a form content type is
  rejected; the stream's first frame is `hello`); Fastify (the same, plus the raw body reaches the kit, an unknown path under the prefix is
  the kit's 404 and outside it is Fastify's, a client abort cancels the stream); Next handlers (called with Web `Request`s, including
  `HEAD`, a body over the cap, an abort); Socket.IO (two sockets, a line from one reaches the other, a blocked line is refused to its
  author only, no identifier in any frame, disconnect closes the stream); Colyseus (fakes).
- Defaults are safe: with no `CHATWARDEN_ADMIN_TOKEN` every staff route and the hub page are 401; with a short one, too; production
  with no secret throws; the starter cookie is `HttpOnly; SameSite=Strict` and is not the token.
- Starter markers: `--check` finds every `TODO(auth)`, `TODO(identity)` and `TODO(terms)` in a fresh golden and none after they are removed.

**The fetch adapter (`fetch.test.ts`, `fetch-stream.test.ts`)**
- The same behaviours as `express.test.ts` where they apply: routing and prefix stripping, longest mount wins, 404/405 with `allow`, HEAD,
  query and header normalisation, the raw body exact (including U+FFFD for bad UTF-8, as documented), the cap (declared and streamed),
  a throwing handler, `withErrors` shapes, `unmatched: 'pass'`, bad options are `RangeError`s.
- Streaming: first chunk before the stream ends, the default headers and a route's own winning, `write` false under backpressure, the
  cancel exactly once on abort, on `end()` and on stream cancel, never twice, no write after cancel; HEAD does not call `start`.
- Parity: the same request through `toExpress` and `toFetch` gives the same status, headers and body for a sample of admin, player and chat
  routes (one table-driven test).

**Test kit (`packages/store-memory/test/testing-*.test.ts`)**
- Clock: `durationMs` over every unit, `0`, `'1.5s'`, `'-1s'`, `'5x'`, `NaN`; `advance` never goes back; `set` is exact.
- Matchers: whole word, case, punctuation, substrings not matched (`zorbakian` is not `zorbak`), spans on the original text, an empty list.
- Kit: defaults (`standard`, retention off, the fixed secret), every shorthand and its precedence, a failing store passes through, `close`
  stops timers; two kits do not share state.
- Script: every step type; labels for delivered, starred, each refusal the core produces today (`length`, `rate`, `gate`, `restricted`,
  `blocked`, `profanity`, `empty`) and, with a scripted facade, the three pacing reasons; `autoRestricted` first and second;
  `ScriptMismatch` names the step and shows expected against actual; `expectOutcomes` is runner-neutral (no vitest import in the module:
  a static test).
- Policy: the three presets give the documented suggestions for the same script (read from the profile tables, so a preset change updates
  one place); a `profile` override changes one outcome; the README example runs.
- Isolation: nothing outside `src/testing/` is imported by the main entry (`@chatwarden/store-memory` bundles without it, size unchanged).

**Packaging and repo (`scripts/`, package tests)**
- `exports`/`typesVersions` for `./fetch`, `./cli` (http) and `./testing` (store-memory) resolve under ESM and under CommonJS with
  `moduleResolution: node` (`cjs-types`, `check-pack`, `smoke`); `bin` points at a file in the tarball that begins with the shebang;
  `scripts/browser-bundle.test.ts` bundles `@chatwarden/http/fetch` and `@chatwarden/store-memory/testing` for a browser.
- The published set is still the ten, none private; no peer floor moves; `publish-order` is unchanged; the manifests test lists the new
  exports.
- Smoke (`scripts/smoke.mjs`): in the fresh consumer project, `npx chatwarden init --yes --framework express --json` runs the packed bin,
  the generated files type-check against the packed packages, and the generated server starts and answers `/chatwarden/healthz`.
- `docs/recipes` pages equal their goldens; `scripts/readme.test.ts` compiles the new README blocks; the agent skill's flags all exist.

## 15. Risks

- **Generated code ages.** A template that is right today is wrong after the next API change. Mitigation: goldens are type-checked and
  run in CI on every change, so an API change that breaks a template fails the build, and the version in the next-steps comes from the CLI's
  own package.
- **A starter that ships.** Someone keeps the shared admin token, the client-chosen key or the synthetic pack in production. Mitigation:
  fail-closed defaults, loud production warnings, `TODO` markers, `--check` for CI, and the generated header text. It cannot be made
  impossible; it is made hard to do by accident.
- **The shared-token staff sign-in is weaker than a real login.** It is a starter with an HMAC cookie and a constant-time compare, off
  unless a long token is set. A team that wants roles replaces `authorize` (the permissions table is in the http README).
- **Fastify's `Response` support is documented but the abort behaviour is not.** The plan verifies the stream and abort behaviour before
  committing the template, and carries a `hijack` fallback with identical tests.
- **Next.js route handlers are not a fit for serverless.** Stated in the page and the CLI output. An adopter on such a host gets the
  moderation routes only with a durable store, which waits for K14.
- **Colyseus untested against a real server.** A fake is a claim about an API. Mitigation: the page names the version, says so, and the
  skeleton is small; the plan lists a real-server smoke as optional follow-up work.
- **`http` carries a CLI.** The package grows by about 25 KB of source (not shipped to browsers: no entry reaches it) and gains a `bin` that
  another package could also claim. Mitigation: the `./cli` export lets a future unscoped shim have a different bin name; a test pins
  that exactly one package declares `chatwarden` as a bin.
- **Windows.** The CLI is cross-platform by construction and tested on `windows-latest`, but real terminals differ (readline over
  ConPTY, a locked file). Mitigation: no raw mode, no ANSI, atomic writes with a clear error.
- **The test kit's `wordMatcher` is not the real matcher.** An adopter could believe their evasion handling is tested when it is not.
  Mitigation: the doc comment and README say so first, and the example passes the real matcher.
- **Two chat-box paths in docs** (SSE and Socket.IO). One extra recipe is more to read; the table in section 9 says which to pick.
- **A per-prefix mount that collides.** `/chatwarden` is unlikely to collide, and `--base` exists. A route under it that the adopter already
  owns is theirs to move.

## 16. Not in this release

- Service mode, the Docker image, the server-to-server check API and the engine SDKs (section 11).
- A docs CLI and an agent eval (section 12).
- `@chatwarden/testing`, `create-chatwarden` and `@chatwarden/create` as packages (section 4), and any other new package.
- Init writing or editing the adopter's `package.json`, entry file, `.gitignore` or `.env`.
- A Fastify-specific adapter package, a Next.js package, a Hono or Bun wrapper (`toFetch` is the seam).
- A Colyseus template in init, and a recipe tested against a running Colyseus.
- A hub or chat template for a non-React front end beyond the element and the `ChatTransport` seam.
- Test-kit steps for moderator decisions, signals, appeals and names (they are `cw` calls the adopter makes; steps can follow when they
  settle), an HTTP test client, and a vitest or jest matcher package.
- Postgres or Redis templates (K14), multi-room or multi-process chat scaffolding, a Vercel-style serverless recipe.
- A `chatwarden migrate-config` command (the product scope lists it under upgrade safety, separately).
- Telemetry of any kind.

## 17. Rollout and release mechanics

- **One changeset, patch, in the fixed group.** First line: "adds a setup command, a Web fetch adapter and a test kit". Notes: the `bin`
  `chatwarden` and `@chatwarden/http/cli`, `@chatwarden/http/fetch`, `@chatwarden/store-memory/testing`, `@experimental` names, no migration,
  no new package, no peer-floor rise. `scripts/changelog.test.ts` is satisfied by naming the three subpaths.
- **`@experimental` until 0.2:** `toFetch` and its types, `runCli`, everything in `/testing`, the `--json` shape's `version: 1` (it is
  additive by rule, but marked).
- **Peer floors.** None rises: the CLI imports no core API; `toFetch` uses `compileRoutes`, `withErrors`, `errorResponse` and `BODY_MAX_BYTES`
  that http already has; the test kit uses only API that core 0.1.5 has, so it needs no floor of its own (store-memory's is whatever the
  flood-control release left it). If flood control's refusal reasons
  appear in `ChatResult`, the kit's label type is already `refused:${string}`, so nothing is imported from it.
- **New private workspace `examples/recipes`.** Listed in `.changeset/config.json` `ignore`, not published. Its `package.json` pins the ten
  `@chatwarden/*` versions like tiny-chat's (RELEASING.md step 2 gains it; `scripts/manifests.test.ts` checks it), and holds the devDependencies
  `fastify`, `socket.io`, `socket.io-client`, `react`, `react-dom` and their types, so `npm ci` stays one install.
- **CI.** The package job runs the new targeted tests as part of `npm test` (the whole suite runs there); a new job `cli-windows` runs
  the CLI tests on `windows-latest` with Node 22.13; the smoke job gains the init run.
- **Release mechanics** follow `RELEASING.md`. There is no new package, so OIDC publishing is unchanged. Tag and push only on the
  maintainer's go-ahead; the site PR and the `llms.txt` refresh follow the release's appearance on npm.

## 18. Open questions

Each has a recommendation; the controller rules.

1. **Do the manual npm step now for `create-chatwarden` (or `@chatwarden/create`)?** *Recommended: no, not yet.* Ship option A (section 4)
   and look at how the first adopters run it. The shim is a one-file package the owner can add at any release; doing it now puts a manual
   step on this release's critical path and adds an eleventh package to every later one for a shorter command.
2. **The scoped or unscoped name, if and when: `create-chatwarden` or `@chatwarden/create`?** *Recommended: `create-chatwarden`,* because it
   is the command people and agents type (`npm create chatwarden`), at the price of an unscoped name owned by the owner's account. If the
   org-owned name matters more, take `@chatwarden/create` (`npm create @chatwarden`).
3. **Is service mode the next phase after K4b?** *Recommended: yes, as its own design first (K4d),* ahead of K9, because the FAQ's "no
   bridge for other languages" is the largest remaining adoption gap and the chat box already covers games that have no chat.
4. **Where does the test kit live: `@chatwarden/store-memory/testing`, or wait for a package?** *Recommended: the subpath now.* It has the right
   dependency direction and needs no owner step; a later `@chatwarden/testing` can re-export it.
5. **Is the shared-token starter sign-in acceptable as the generated `authorize`?** *Recommended: yes, fail-closed and loudly a starter.* The
   alternative, an `authorize` that always returns `null` with a TODO, is safer and makes the first run show a 401 and nothing else, which
   is the opposite of "adoption to be chill". The risk is accepted with `--check`, warnings and the cookie design.
6. **Default URL prefix `/chatwarden` for every route family.** *Recommended: yes* (no collision with the game's own `/api` and `/admin`).
   tiny-chat keeps its bare prefixes (it owns its whole server).
7. **Should init generate the Colyseus wiring?** *Recommended: not yet;* a docs page with tested fakes. Revisit if an adopter asks and a real
   Colyseus can be added to the recipes' tests at acceptable cost.
8. **Ship the Claude Code skill plugin in this release?** *Recommended: yes, skill only.* It is a few files, drift-checked against the CLI,
   and the skill is the cheapest way to make an agent's adoption reliable. If the plugin format cannot be verified when the plan reaches that
   task, the task is dropped and the skill text moves into the recipes' `docs/recipes/agents.md` instead.
9. **Add a `windows-latest` CI job?** *Recommended: yes,* limited to the CLI and test-kit tests (about two minutes). A cross-platform CLI that
   is only tested on Linux is a claim.
10. **Should the kit's own tests adopt `@chatwarden/store-memory/testing` where it is a straight swap?** *Recommended: yes, but as a separate
    commit at the end of the branch,* optional and reverted if it touches more than the stub matcher and the clock; it proves the kit
    on the repo's own tests without making the release depend on it.

## 19. Rulings

*(To be filled by the controller when the questions above are answered.)*
