# K4b: fast adoption (init, recipes, test kit) (the release after flood control and signals (0.1.8)) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** an adopter runs `chatwarden init` and gets the wiring for a moderated server (Express, Fastify, Next.js route handlers, anything on
Web `Request`/`Response`, or library-only), optionally with the kit's chat box (over HTTP or over their Socket.IO server), the moderator hub
and a Discord feed; an agent or CI can do the same with flags and `--json`. `@chatwarden/http` gains a `chatwarden` bin, the `./cli` export
and a Web fetch adapter (`@chatwarden/http/fetch`). `@chatwarden/store-memory` gains a test kit at `./testing` (fake clock, scripted chat
simulator, outcome assertions). Recipes are the generated files, committed as goldens, type-checked and run in CI.

**Architecture:**
- `@chatwarden/http` gets `src/cli/` (`env.ts`, `args.ts`, `answers.ts`, `detect.ts`, `paths.ts`, `plan.ts`, `apply.ts`, `conflict.ts`,
  `report.ts`, `prompts.ts`, `install.ts`, `check.ts`, `index.ts` = `runCli`, `bin.ts` = the shebang entry, and `templates/`), `src/fetch.ts`
  (`toFetch`), `bin` and the subpaths `./fetch` and `./cli` in `package.json`. Nothing browser-safe (`./chat`, `./admin`) imports `src/cli/`.
  `src/fetch.ts` imports no `node:` module.
- `@chatwarden/store-memory` gets `src/testing/` (`duration.ts`, `clock.ts`, `words.ts`, `kit.ts`, `room.ts`, `script.ts`, `index.ts`) behind
  the subpath `./testing`. The main entry does not import it.
- A new private workspace `examples/recipes` (not published) holds the goldens (`cases/<case>/...`), the type-check configs and the
  run tests, with `fastify`, `socket.io`, `socket.io-client`, `react` and their types as devDependencies.
- `docs/recipes/*.md` embed the goldens (checked byte for byte). `agent/claude-plugin/` and `.claude-plugin/marketplace.json` hold the
  skill-only plugin. `site/public/llms.txt` is refreshed in the site PR (Task 13).
- No core change, no store change, no migration, no new published package, no peer-floor rise.

**Spec:** `docs/design/2026-11-12-k4b-adoption.md` (section numbers below refer to it), including its closing Rulings section. Also binding:
`docs/design/2026-11-12-chat-box.md` (sections 5.3 and 6 for the Socket.IO seam), `docs/design/2026-11-09-product-scope.md` (sections 8 and
10), `docs/design/2026-11-10-hub-simple-mode-and-embedding.md` (adopt at any depth), and `RELEASING.md` (OIDC publishing; the hand-publish
steps for a new package, which this release does not need).

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly` (no parameter properties, no enums),
  every timestamp from an injected clock in package code (the test kit's clock is injected; the CLI has no timestamps), synthetic terms only
  in code, tests, templates and docs (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn; player names in examples are these
  too), test-first, targeted runs only, `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree:
  commit by pathspec, `git add` new files first. Branch `k4b-adoption`, worktree `C:\dev\chatwarden-wt\k4b-adoption`.
- **No new published package.** If a task seems to need one, stop: the answer is a subpath or a bin of an existing package (design section 4). A
  package added to the repo that is not on npm at the release version fails the release run.
- **The CLI is zero-dependency and offline.** Only `node:util`, `node:readline/promises`, `node:fs/promises` (via the injected environment),
  `node:path` (injected), `node:process`, `node:os` (a temp path in tests only) and, in `install.ts` alone, `node:child_process`. It imports
  nothing from `@chatwarden/core` (a template is text; the version comes from `@chatwarden/http`'s own `VERSION`). `cli-static.test.ts` enforces it.
- **The CLI never edits an existing file** and never writes outside the project root (Review Focus 1). It writes no secret and no absolute
  path, and its output is deterministic (Review Focus 2 and 3).
- **Generated code is safe by default and visibly a starter** (design 7): staff routes are 401 until a long `CHATWARDEN_ADMIN_TOKEN` is set,
  production refuses to start without `CHATWARDEN_SECRET`, the synthetic term pack warns in production, and every starter hook carries a
  `TODO(auth)`, `TODO(identity)` or `TODO(terms)` marker.
- **`@chatwarden/http/fetch` and `@chatwarden/store-memory/testing` are browser-safe:** no `node:` import (so no `Buffer`), enforced by the existing
  eslint rule for store-memory and by `scripts/browser-bundle.test.ts` for both. `src/cli/` is the one Node-only directory in `http`.
- **The test kit imports no test runner.** Assertions throw plain errors; outcomes are strings (`cli-static`-style test for the module).
- **Goldens are the single source of recipe code** (design ruling 8). A template change and its golden update land in the same commit
  (`UPDATE_GOLDEN=1`), and a docs page embeds goldens, never retyped code.
- All new public names are `@experimental` in TSDoc and listed so in the READMEs until 0.2.
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no site deploy without the maintainer's go-ahead.

## Review Focus
Five failure modes no task's happy-path tests would otherwise exercise; each has its test in the owning task.
1. **Losing or leaking files.** A conflicting file overwritten without being asked; a path that escapes the project (`..`, an absolute
   `--dir`, a symlinked folder); a half-written file after an interrupted run; a re-run that changes bytes. Tasks 2 and 7.
2. **An unsafe starter.** An admin route or hub page that answers without a long token; a secret or a real credential in a generated file,
   `.env.example` or `--json`; a production start with the development secret or the synthetic pack and no warning; a cookie holding the
   token. Tasks 3, 5 and 7.
3. **Drift.** A template that no longer compiles after an API change; a docs page that differs from its golden; a README example that
   lies; a skill that names a flag that does not exist; a `--help` that differs from the parser. Tasks 5, 6, 9 and 10.
4. **The raw body and the stream.** A framework body parser that reads the body first; an SSE stream buffered until it ends; an aborted client
   whose stream is never cancelled; a body over the cap read into memory; the same request giving different answers through `toExpress` and
   `toFetch`. Tasks 4, 5 and 6.
5. **Windows and "no human".** A path printed with backslashes or a specifier with one; CRLF in a generated file; a prompt that hangs on closed
   or non-terminal input; `spawn` of a `.cmd` without the right options; a shell metacharacter reaching a shell. Tasks 1, 2 and 7.

## Order and parallelism
Step 0 first. Tasks 1, 3 (after the `FileSpec` type from Task 1 is committed), 4 and 8 are independent and can run at once. Task 2 follows 1.
Task 5 follows 2, 3 and 4. Task 6 follows 5. Task 7 follows 1 and 2 (it uses the templates' marker list from 3). Task 9 follows 4, 7 and 8.
Task 10 follows 5, 6, 8 and 9. Task 11 follows 7. Task 12 is last. Task 13 is a separate PR after the release is on npm and is not part of
the tag. Task 14 is optional and last of all.

---

### Step 0: sync and checks
Rebase on `main`. Confirm what has merged: `grep -n "slow_mode" packages/core/src/chat.ts` (flood control, 0.1.7). If present, the test kit's
pacing-label test (Task 8) runs against the real core; if not, it uses the scripted facade the task describes. Confirm `packages/core/package.json` version
and set `VERSION` expectations from it, never from a literal. Run `npm ls @chatwarden/core` once to see the workspace links. No code in this step.

### Task 1: CLI foundations: environment, arguments, answers, detection
Design 5.1, 5.5, 5.6 (shape only). Pure; no templates.
- **Files:** `packages/http/src/cli/env.ts`, `args.ts`, `answers.ts`, `detect.ts`, `types.ts` (all new); tests
  `packages/http/test/cli-args.test.ts`, `cli-answers.test.ts`, `cli-detect.test.ts`; a test helper `packages/http/test/cli-world.ts`
  (an in-memory file system, a fake `stdin`/`stdout`/`stderr`, `env`, `platform`, `path` = `posix` or `win32`, a recorder of writes).
- **Interfaces (Produces):**
  - `CliEnv = { cwd: string; fs: CliFs; path: PathLike; stdin: Readable-like; stdout: Writable-like; stderr: Writable-like; env: Record<string, string | undefined>; platform: string; isTTY: boolean; spawn: Spawner }`;
    `CliFs = { readFile; writeFile; rename; mkdir; stat; lstat; realpath; readdir; rm }` (the promise subset of `node:fs/promises` the CLI uses);
    `nodeEnv(): CliEnv` builds the real one (the only place `node:fs/promises`, `node:path` and `node:process` are imported).
  - `FileSpec = { path: string /* relative, posix */; content: string; markers?: string[] }` and `Plan` (design 5.2) in `types.ts`.
  - `OPTIONS` (the one table of flags: name, type, values, default, help text, `question?`), `parseCli(argv: string[]): Parsed | { error: string }`
    over `node:util` `parseArgs` with `strict: true` and `allowPositionals: false`; `helpText(): string` generated from `OPTIONS`.
  - `Answers = { framework; store; chat; chatTransport; hub; discord; profile; base; dir; lang }` and `resolveAnswers(parsed, detected): Answers | { error: string }`
    (the combination rules of design 5.1); `Detected = { frameworks; react; socketio; manager; ts; moduleType; srcDir; hasDir }`;
    `detect(env): Promise<Detected | { error: string }>`.
- **Behaviour:** `--base` must match `^/[A-Za-z0-9_/-]*$`, with no `//` and no trailing slash (a lone `/` is refused: the health routes need a
  prefix). `--dir` is normalised to posix and validated in Task 2. `--yes` and `--json` imply no prompts. `--force` equals `--on-conflict
  overwrite`; both together is a usage error unless they agree. An unknown flag is `{ error }` with one sentence naming it; no stack is ever shown.
- **Tests (names):**
  - args: `every flag in OPTIONS parses and round-trips`; `an unknown flag, a value outside its set, a repeated singleton, a positional and --on-conflict with --force disagreeing are errors naming the flag`; `--help and --version win over everything`; `helpText lists every option once and matches OPTIONS (generated)`
  - answers: `every legal combination resolves; defaults follow detection`; `none with --chat box or --hub, next with --hub element, and socketio without a framework are rejected with one sentence each`; `--framework next defaults the hub to react, others to element`; `socketio is asked about only when socket.io is a dependency and --chat box`; `--base and --dir validation: //, trailing /, spaces, "..", a drive letter, a NUL`
  - detect: `express, fastify, next (next wins over express), react, socket.io from dependencies and devDependencies`; `pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb, package-lock.json and none give the manager`; `tsconfig.json present means ts, absent means js`; `"type": "module" and its absence`; `src/ present moves the default dir`; `a missing, empty or invalid package.json is an error sentence, never a throw`; `detection reads only package.json, lockfiles, tsconfig.json and the directory listing of the root` (a recording fs)
  - `Windows: the same tests with path.win32 and a C:\ root give the same answers`
- **Run:** `npx vitest run packages/http/test/cli-args.test.ts packages/http/test/cli-answers.test.ts packages/http/test/cli-detect.test.ts`

### Task 2: Plan, apply, conflicts, paths, reports
Design 5.2, 5.3, 5.5, 5.6. Needs Task 1.
- **Files:** `packages/http/src/cli/paths.ts`, `plan.ts`, `apply.ts`, `conflict.ts`, `report.ts` (new); tests `cli-paths.test.ts`,
  `cli-plan.test.ts`, `cli-apply.test.ts`, `cli-conflict.test.ts`, `cli-idempotent.test.ts`, `cli-report.test.ts`, `cli-windows.test.ts`.
- **Interfaces (Produces):**
  - `safePath(env, root, dir, relative): string | { error }`: the resolved path stays under `root` (after `realpath` of the nearest existing
    parent, so a symlinked folder that leaves the project is refused); refuses an absolute `dir`, `..` segments, a Windows reserved name
    (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`, with or without an extension), a trailing dot or space, `:` outside a drive, and a path over 200 characters.
  - `buildPlan(answers, versions, templates): Plan` (pure; `templates` is `renderAll(answers, versions)` from Task 3, injected so this task is
    tested with stubs) with `{ answers, files: FileSpec[], install: { manager, command, packages }, env: EnvName[], nextSteps: string[], warnings: string[], todo }`.
  - `applyPlan(env, plan, options: { onConflict: 'skip' | 'overwrite' | 'new'; dryRun: boolean; ask?: ConflictAsker }): Promise<Result>` with per-file
    `action: 'created' | 'unchanged' | 'skipped' | 'overwritten' | 'created-new'` (and `reason: 'differs'`); atomic write (temp name in the same
    folder, then `rename`; the temp is removed on failure); `exitCodeOf(result): 0 | 2 | 3`.
  - `lineDiff(a: string, b: string, max = 40): string[]` (a small LCS; no dependency), used by the interactive `d` choice.
  - `renderHuman(plan, result): string` and `renderJson(plan, result, version): string` (design 5.6; `version: 1`; never a secret, an absolute path or a
    file's content).
- **Tests (names):**
  - paths: `a path inside the root is accepted, ../x, an absolute dir, a drive-letter dir, C:\\x, a symlinked folder that leaves the root, CON, NUL.txt, "a." and "a " are refused`; `printed paths use / on win32`; `an output path over 200 characters is refused` (Review Focus 1 and 5)
  - plan: `the same answers give a byte-identical plan twice`; `no file content contains \\r, an absolute path, a timestamp or a run of 32 or more hex or base64 characters`; `files are sorted by path`; `the install command is built per manager (npm install, pnpm add, yarn add, bun add) with caret ranges of the http VERSION, and lists only packages the answers need`
  - apply: `creates parent folders and files with \\n endings`; `a byte-identical file is unchanged and is not rewritten (the recorder sees no write)`; `a differing file is skipped by default, overwritten with overwrite, written beside as name.chatwarden-new.ext with new, and a second conflict on that name is skipped`; `an interrupted write (rename throws) leaves no temp file and no partial target and is exit 3 naming the path`; `a permission error is exit 3`; `dryRun records zero writes and returns the same list`
  - `never overwrites: for 200 random existing contents and every onConflict except overwrite, the existing bytes are untouched` (a seeded property test; Review Focus 1)
  - idempotent: `init twice with the same answers: all unchanged, exit 0`; `edit one file, run again: that file skipped, exit 2, no other file touched`; `adding an answer (chat box) creates the new files and reports changed ones as conflicts`
  - conflict: `lineDiff of equal, appended, deleted and replaced text; capped at 40 lines; no ANSI`; `the asker's s, o, n and d choices; EOF and an empty answer mean s`
  - report: `human output lists created, unchanged, skipped with a reason, and the next steps in the fixed order`; `json: version 1, every file with its action, no content, no absolute path, no secret value, env names only`; `--json writes only the document to stdout`
  - windows: `the whole plan and apply run with path.win32 and a C:\\proj root: backslash --dir src\\chatwarden is normalised, specifiers stay posix, output is posix-printed`
- **Run:** `npx vitest run packages/http/test/cli-paths.test.ts packages/http/test/cli-plan.test.ts packages/http/test/cli-apply.test.ts packages/http/test/cli-conflict.test.ts packages/http/test/cli-idempotent.test.ts packages/http/test/cli-report.test.ts packages/http/test/cli-windows.test.ts`

### Task 3: The template engine and the shared templates
Design 6.1 (kit, auth, terms, env example), 6.2, 7. Needs only the `FileSpec` type from Task 1.
- **Files:** `packages/http/src/cli/templates/frag.ts`, `index.ts` (`renderAll`), `kit.ts`, `auth.ts`, `terms.ts`, `envExample.ts`, `header.ts` (new);
  tests `packages/http/test/cli-templates.test.ts`, `cli-templates-js.test.ts`, `cli-starter.test.ts`.
- **Interfaces (Produces):** `Ctx = { answers: Answers; lang: 'ts' | 'js'; ext: string /* '.js' or '' for imports */; versions }`; `t(ctx, tsFragment: string): string`
  (the fragment for `ts`, `''` for `js`), `imp(ctx, names, from)` / `impType(...)` (type imports vanish in `js`), `spec(ctx, './kit')` (adds `.js` or not per
  `ctx.ext`), `header(ctx, what)` (the fixed header comment, design 5.5), `renderAll(answers, versions): FileSpec[]` (everything shared; framework files come in Tasks 5
  and 6 and register themselves in `index.ts`). `kit.ts` renders `createKit()`, `BASE`, `Kit`, `secretFromEnv()`; `auth.ts` renders `authorize`, `identify`,
  `join`, the starter cookie helpers; `terms.ts` renders `loadMatcher` (sqlite: `LiveTerms` over the store; memory: over `MemoryTermStore`);
  `envExample.ts` renders placeholders only. Markers: `TODO(auth)`, `TODO(identity)`, `TODO(terms)`, exported as `MARKERS`.
- **Behaviour:** a template is a function of `Ctx` returning text built from template literals and `t(...)` fragments; a type annotation, a type
  import, an `as` cast and a generic are only ever written through `t`/`impType`, so the JS rendering is mechanical, with no stripping pass.
  Starter semantics exactly as design 7.1 to 7.3 (secret length 32, token length 24, `timingSafeEqual`, HMAC cookie, `HttpOnly; SameSite=Strict`,
  `Secure` in production, the production warnings once per start, `CHATWARDEN_TRUST_PROXY`, names counted per key and bounded to 400).
- **Tests (names):**
  - `every file renders for every legal answers combination, in ts and js`; `the TS rendering parses with no syntax diagnostics (typescript createSourceFile), the JS rendering parses as a script of ESM with none`; `the JS rendering contains no type syntax (no ': Promise<', no 'import type', no ' as ')`
  - `rendering is a pure function: same Ctx, same text; no Date, no Math.random, no process.cwd in the templates (a source scan)`
  - starter (runs the rendered `auth.ts` and `kit.ts` through `ts.transpileModule` and imports them with the real core over `MemoryStore`): `with no CHATWARDEN_ADMIN_TOKEN authorize returns null for a request with the right header, the right cookie and none`; `a token under 24 characters is the same as none`; `with a long token the header and the cookie both authorize, a wrong one does not, a near-miss of the same length does not (timing-safe path taken)`; `the cookie is an HMAC, is not equal to the token, and changes with the secret`; `production without CHATWARDEN_SECRET, or with one under 32 characters, throws a message naming the variable; development logs once and uses the fixed string`; `production with the synthetic pack logs one warning`; `join returns null for any room but lobby, names count per key and never contain any part of it, the table stops at 400`; `identify never reads x-forwarded-for unless CHATWARDEN_TRUST_PROXY=1` (Review Focus 2)
  - `.env.example holds only placeholders: no value after =, no real-looking secret`; `markers: each of TODO(auth), TODO(identity), TODO(terms) appears exactly where designed and nowhere else`
  - `no template contains a word outside the synthetic list that the repo's term scanner flags` (the existing synthetic-only test pattern, applied to the rendered text)
- **Run:** `npx vitest run packages/http/test/cli-templates.test.ts packages/http/test/cli-templates-js.test.ts packages/http/test/cli-starter.test.ts`

### Task 4: `@chatwarden/http/fetch`
Design 8. Independent.
- **Files:** `packages/http/src/fetch.ts` (new), `packages/http/src/index.ts` (re-export `toFetch` and its types), `packages/http/package.json` (`./fetch` in
  `exports` and `typesVersions`), `vitest.config.ts` (the alias `@chatwarden/http/fetch`, before `@chatwarden/http`), `scripts/browser-entry.ts` (so the browser-bundle test covers
  it); tests `packages/http/test/fetch.test.ts`, `fetch-stream.test.ts`, `fetch-parity.test.ts`, additions to `exports.test.ts`.
- **Interfaces (Produces):** `Mounts`, `FetchOptions`, `toFetch` (two overloads) exactly as design 8. Reuses `compileRoutes`, `withErrors`, `errorResponse` and
  `BODY_MAX_BYTES`; shares no code with `express.ts` beyond those (the Express adapter is not refactored).
- **Behaviour:** as design 8. Body: for a method other than `GET`/`HEAD`, a declared `content-length` over `maxBody` is answered 413 before reading;
  otherwise the body is read with `request.body.getReader()`, counting bytes, and abandoned at the cap (413); text decoded as UTF-8 (a bad byte is U+FFFD). A
  request with no body gives whatever `rawBody` `toExpress` gives for the same request (the parity test compares them). `remoteAddress` only from the option, never a header.
- **Tests (names):**
  - routing: `prefix and mount keys are stripped before the table sees the path`; `the longest mount wins`; `404 and 405 with allow, as createRouter`; `unmatched: 'pass' resolves null for a path outside every mount and still answers 404/405 inside one`; `a malformed mount key or prefix (no leading slash, trailing slash, //) is a RangeError at toFetch time`
  - request: `query keeps the first value of each key, strings only; headers are lower-cased; the raw body is the exact text, a bad UTF-8 byte becomes U+FFFD; body stays undefined`; `remoteAddress comes only from the option and is absent otherwise (a spoofed x-forwarded-for never reaches it)`
  - limits: `a declared content-length over the cap is 413 before the body is read (the stream is not touched)`; `a chunked body over the cap is 413 and the reader is cancelled`; `maxBody: 0, 1.5, NaN, "5" and 16 MiB + 1 are RangeErrors that never echo the value`
  - errors: `a handler that throws is the kit's 500 shape with no stack; one that rejects, the same; a response that cannot be serialised is the 500`
  - response: `a string body is raw with text/plain unless the route set a type; an object is JSON; HEAD has the GET headers and no body`
  - stream (Review Focus 4): `the first chunk arrives before the stream ends and the default headers are present, a route's own winning`; `write returns false when desiredSize is not positive and the chunk is still queued`; `the cancel runs once on request.signal abort, once on end(), once on stream cancel, never twice, and a write after cancel returns false and throws nothing`; `HEAD on a stream route does not call start`; `a start that throws before any chunk is the kit's 500; after one, the stream errors and the cancel still runs`
  - parity: `for a table-driven sample (admin me, a report list, a player rules route, a chat open, a chat send, a bad content type, a 404, a 405) the status, headers (minus date and connection) and body equal the toExpress result over a real Express`
  - `the module imports no node: module and no Buffer, and the browser bundle test bundles it`; `exports: toFetch and the three types are exported from the root and from ./fetch`
- **Run:** `npx vitest run packages/http/test/fetch.test.ts packages/http/test/fetch-stream.test.ts packages/http/test/fetch-parity.test.ts packages/http/test/exports.test.ts scripts/browser-bundle.test.ts`

### Task 5: Framework templates, the recipes workspace and the goldens (Express, hub, chat box, Fetch, Next.js, Fastify)
Design 6, 9.1 to 9.3, 9.6, Review Focus 3 and 4. Needs Tasks 2, 3 and 4. Large: three chunks, each its own review.
- **Chunk 5a: the workspace and Express.**
  - **Files:** `examples/recipes/package.json` (private; the ten `@chatwarden/*` pinned to the group version; devDependencies `fastify`, `socket.io`,
    `socket.io-client`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `typescript` follows the root), `examples/recipes/tsconfig.json` (NodeNext, `strict`,
    `erasableSyntaxOnly`, project references like tiny-chat's), `examples/recipes/tsconfig.bundler.json` (`moduleResolution: bundler`, `jsx: preserve`),
    `examples/recipes/cases.ts` (the table of cases: name, answers), `examples/recipes/golden.test.ts`, `examples/recipes/typecheck.test.ts`,
    `examples/recipes/express.test.ts`, `examples/recipes/cases/<case>/...` (generated), `.changeset/config.json` (`ignore`), root `package.json`
    (nothing: `examples/*` is already a workspace glob), `packages/http/src/cli/templates/express.ts`, `hub.ts` (element), `chat.ts` (broadcaster wiring, `ChatPanel`), `discord.ts`.
  - **Lint.** The goldens live in the repo, so `npm run lint` covers them: templates must produce code that is clean under the repo's eslint (a test runs the linter over `cases/`), which is also a fair floor for an adopter's.
- **Cases:** `express-sqlite-box-element` (the full chat), `express-memory-minimal` (no chat, no hub), `express-discord-js` (JS variant), `none-library`.
  - **Behaviour:** the Express and hub-element and box templates of design 6.1 and 6.2; `hub.ts` serves the `/mod` page (strict CSP), the script from
    `@chatwarden/hub-element/standalone`, and the starter sign-in form (a plain post; the body parsed by the template's own `express.urlencoded` on that route only, after
    the kit's mounts); `ChatPanel.tsx` is the lazy box with the two stylesheet imports.
  - **Tests (names):** `golden: each case's CLI output equals examples/recipes/cases/<case> byte for byte (UPDATE_GOLDEN=1 rewrites)`; `typecheck: every case compiles with tsc --noEmit under its config`; `the JS case passes a syntax check`;
    express run (a real Express on port 0, `fetch`): `the hub page and /admin/me are 401 with no token and with a short one`; `with a long token the header and the sign-in cookie reach /admin/me as owner`; `a blocked synthetic word over /chat is refused blocked with rule 1 and reaches no other stream`; `POST /chat/... with text/plain or a form type is 400`; `the stream's first frame is hello with no identifier`; `an unknown path under /chatwarden is the kit's 404 and a path outside it is the app's own`; `a body parser mounted by the app AFTER the kit does not break the kit; one mounted BEFORE it is documented as unsupported in the file's comment (a test reads the comment)`; `shutdown: kit.close() releases the port and every timer`
- **Chunk 5b: Fetch and Next.js.**
  - **Files:** `templates/fetchHandler.ts`, `next.ts`, `hubReact.ts`; cases `next-sqlite-box-react`, `fetch-memory-element-none` (hub none), `next-memory-minimal`;
    tests `examples/recipes/next.test.ts`, `fetch.test.ts`.
  - **Behaviour:** `handler.ts` builds the kit once, cached on `globalThis` (so a dev reload does not open the database twice), returns `toFetch({ '/admin', '/api', '/chat', '' }, { prefix: BASE })`; the Next route file
    exports `GET POST PUT PATCH DELETE HEAD` with `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`; extensionless imports (bundler resolution); `src/app` used when the project has `src/app`; the hub page is a client component; remoteAddress absent (the
    starter `identify` honours `CHATWARDEN_TRUST_PROXY`).
  - **Tests (names):** the golden and typecheck tests for the cases; `the exported handlers answer Web Requests: /admin/me 401 without a token, a blocked line refused, HEAD, a body over the cap 413, an abort cancels the stream`; `the kit is built once across two imports of the module (a counter on the store opener)`; `the file list for next is exactly kit, auth, terms, handler, HubPage, ChatPanel, .env.example under the dir plus the route and the page`; `with src/app the route lands under src/app`; `next with --hub element is exit 1`; `the next-steps text says "Node process, not serverless" (a substring test)`
- **Chunk 5c: Fastify.** Start with a **spike** (a throwaway test, not committed): against the real Fastify in `examples/recipes`, prove (1) `reply.send(response)` with a streaming `Response`
  delivers each enqueued SSE frame as it is enqueued, (2) closing the client socket aborts the `signal` we pass and runs the stream's cancel, (3) `removeAllContentTypeParsers` inside a plugin does not affect a sibling route's JSON body parsing. If (1) or (2) fails, the template pipes
  `res.body` to `reply.raw` after `reply.hijack()` instead (design 9.2); the tests below do not change.
  - **Files:** `templates/fastify.ts`; case `fastify-sqlite-box-element`; test `examples/recipes/fastify.test.ts`.
  - **Tests (names):** golden and typecheck; `the raw body reaches the kit exactly (a JSON body with a duplicate key and a __proto__ key is rejected by the kit, not parsed away by Fastify)`; `a sibling route registered outside the plugin still gets Fastify's JSON parsing`; `an unknown path under the prefix is the kit's 404, outside it Fastify's`; `HEAD`; `the stream: first frame hello arrives while the connection is open; a client abort cancels the stream and stats().streams returns to 0` (Review Focus 4); `the peer address reaches identify (the socket's, not a header)`
- **Run (per chunk):** `npx vitest run examples/recipes/golden.test.ts examples/recipes/typecheck.test.ts examples/recipes/express.test.ts` (5a), `... next.test.ts examples/recipes/fetch.test.ts` (5b), `... fastify.test.ts` (5c); then `npx vitest run packages/http/test/cli-templates.test.ts` once at the end of the task.

### Task 6: Socket.IO template and the Colyseus recipe
Design 9.4, 9.5. Needs Task 5a (the workspace) and the chat box (0.1.6).
- **Files:** `templates/socketio.ts` (`socketio.ts` and `socketTransport.ts` renderers; `ChatPanel` variant), cases `express-sqlite-box-socketio`, `examples/recipes/socketio.test.ts`;
  `examples/recipes/cases/colyseus/room.ts` and `examples/recipes/colyseus.test.ts` (hand-written, not generated), `examples/recipes/colyseus-types.d.ts` (the small structural `Room`/`Client` stand-ins, named as stand-ins).
- **Behaviour:** `attachChat(io, kit)` uses a namespace `${BASE}/chat`, the same `join` and `identify` hooks as the routes (the handshake's headers and `auth` payload adapted to a `KitRequest`), `kit.chat.session`, `session.open` with a sink that emits `chat:frame` and
  returns `socket.connected`, `chat:send`/`chat:mute`/`chat:report` with acks, and `stream.close()` on disconnect. `socketTransport(socket)` implements `ChatTransport.open(room, events)`: `chat:frame` to `events.frame`, `connect`/`connect_error`/`disconnect` to `events.status` (a `forbidden`/`unauthorized` closed
  reason on a refused connect), acks for `send`, `mute`, `report`, and `close()` disconnecting only its own namespace socket. The Colyseus helper `attach(room, kit)` registers `onMessage` handlers and opens and closes a session in `onJoin`/`onLeave`, with the identity taken from what the game's `onAuth` returned.
- **Tests (names):** golden and typecheck; Socket.IO over a real server and client: `two sockets in lobby: a line from one reaches the other with mine only on the sender's copy`; `a blocked line is refused to its author's ack only and no other socket gets it`; `a socket with no identity or a room the join hook refuses is disconnected with the reason`; `no seat, subject, key, hash or ip appears in any emitted frame or ack (seeded values scan)` (Review Focus 2); `disconnect closes the stream and the seat is released after the grace (fake clock via the broadcaster's now and schedule options)`; `the transport drives a real ChatBox in jsdom: send, refusal, report` (a short test using player-react's test world)
  - Colyseus (fakes): `attach registers the documented messages; a message answers on the client; onLeave closes the stream`; `a refused session disconnects the client with the reason`; `the recipe's comment names the Colyseus major version it follows` (a substring test, so the claim cannot be deleted silently)
- **Run:** `npx vitest run examples/recipes/socketio.test.ts examples/recipes/colyseus.test.ts examples/recipes/golden.test.ts examples/recipes/typecheck.test.ts`

### Task 7: Prompts, install, `--check`, `runCli` and the bin
Design 5.1, 5.4, 5.7, 5.8. Needs Tasks 1, 2 and 3 (Tasks 5 and 6 add framework files but are not needed to test the flow with stub templates).
- **Files:** `packages/http/src/cli/prompts.ts`, `install.ts`, `check.ts`, `index.ts` (`runCli(argv, env?) : Promise<number>`), `bin.ts` (shebang `#!/usr/bin/env node`, calls `runCli(process.argv.slice(2))`,
  sets `process.exitCode`); tests `cli-prompts.test.ts`, `cli-install.test.ts`, `cli-check.test.ts`, `cli-run.test.ts`, `cli-static.test.ts`.
- **Interfaces (Produces):** `ask(env, question): Promise<string>` over `node:readline/promises` created from `env.stdin`/`env.stdout` (the readline import is in `prompts.ts` only), each question with its choices and
  default, `EOF` and an empty line giving the default; `installCommand(manager, packages): { command: string; argv: string[] }` and `runInstall(env, spec): Promise<number>` using `env.spawn` (no shell where `npm_execpath`
  is available: `process.execPath` with the script; `shell: true` only when `platform === 'win32'` and only for the fixed `argv`); `checkProject(env, answers?): Promise<CheckResult>` (reads the files init writes under `--dir`, finds
  markers, missing env names from `.env.example` against `env.env` names; never reads values into output); `runCli` ties it together: parse, detect, resolve (asking only what is neither given nor detected), plan, apply, report, exit code.
- **Behaviour:** as design 5.1 to 5.8. `--yes`, `--json`, a non-terminal stdin and `--dry-run` never prompt. A non-terminal run without `--yes` prints one stderr line and uses detected answers.
  `--check` exit 0 when no marker remains and no required env name is missing, else 1. `--install` runs after a successful apply (exit 3 on failure; the command is printed either way).
- **Tests (names):**
  - prompts: `each question shows its choices and default; Enter takes the default; a typed value outside the set re-asks once, then takes the default with a stderr line`; `EOF in the middle of the third question takes the defaults for the rest`; `stdin that is not a terminal never waits` (Review Focus 5); `no ANSI escape and no raw mode is ever written`
  - install: `the command per manager; with npm_execpath the spawner gets process.execPath and the script, never a shell`; `on win32 without npm_execpath the spawner gets shell true and an argv made only of the fixed package names`; `no user-typed value (dir, base) is ever in argv`; `a failing spawner is exit 3 and the command is printed`; `--install is off by default`
  - check: `a fresh golden reports every marker with file and line; after the markers are removed it passes`; `a missing CHATWARDEN_SECRET or CHATWARDEN_ADMIN_TOKEN name is reported, a value is never printed`; `it reads only files under --dir and .env.example`; `exit codes 0 and 1`
  - run (transcripts as snapshots, with the in-memory env): `the interactive first run of design 5.8 prints exactly that transcript shape`; `the re-run after an edited auth.ts and --discord is exit 2 with the skipped lines`; `an agent run with --yes and --json prints only the JSON document on stdout and exits 0`; `usage errors are exit 1 with one sentence and no stack`; `--help and --version`; `an uncaught error inside a template is exit 3 with "chatwarden: something went wrong" and the error class only`
  - static (Review Focus 5 and the "offline" constraint): `no src/cli file imports node:http, node:https, node:net, node:dns, node:tls or uses fetch`; `node:child_process appears only in install.ts`; `with a throwing global fetch installed, a full interactive run completes`; `packages/http/package.json has no dependencies entry`; `no browser-safe entry (./chat, ./admin, ./fetch) reaches src/cli`; `src/cli imports nothing from @chatwarden/core`; `the bin file starts with the shebang line`
- **Run:** `npx vitest run packages/http/test/cli-prompts.test.ts packages/http/test/cli-install.test.ts packages/http/test/cli-check.test.ts packages/http/test/cli-run.test.ts packages/http/test/cli-static.test.ts`

### Task 8: The test kit (`@chatwarden/store-memory/testing`)
Design 10. Independent.
- **Files:** `packages/store-memory/src/testing/duration.ts`, `clock.ts`, `words.ts`, `kit.ts`, `room.ts`, `script.ts`, `index.ts` (new), `packages/store-memory/package.json` (`./testing` in `exports` and `typesVersions`),
  `vitest.config.ts` (alias `@chatwarden/store-memory/testing` before `@chatwarden/store-memory`), `scripts/browser-entry.ts`; tests `packages/store-memory/test/testing-duration.test.ts`, `testing-clock.test.ts`,
  `testing-words.test.ts`, `testing-kit.test.ts`, `testing-script.test.ts`, `testing-policy.test.ts`, `testing-static.test.ts`.
- **Interfaces (Produces):** exactly design 10.1 and 10.2: `Duration`, `durationMs`, `FakeClock`, `createFakeClock`, `wordMatcher`, `wordFilter`, `TestKitOptions`, `TestKit`, `createTestKit`, `TestRoom`, `SayLabel`, `SayOutcome`,
  `ReportLabel`, `ReportOutcome`, `Step`, `Run`, `ScriptMismatch` (a class extending `Error`), `expectOutcomes`, `checkLines`. Implementation notes: `createTestKit` is `reportingWorld.ts`'s `world()` (secret `'testing-secret-do-not-use-in-production'`, `retention: false`, a
  logger that records, `platform.identify` returning the `RawWho` it is given); `events` come from one `cw.on` subscription per entry of `KIT_EVENT_TYPES`; a player's seat id is the name and their key `'test-key:' + name`;
  `autoRestricted` is read from the `auto.restricted` event raised inside that `say` (`second` selects `'second'`); `suggest` calls `cw.suggest(cw.rooms.subjectAt(room, player), level, rule ?? 'uncovered')`.
- **Tests (names):**
  - duration: `every unit; 0; '1.5s' is 1500; '-1s', '5x', '', ' 5s', NaN, Infinity, 1e400 are RangeErrors that do not echo the value`
  - clock: `starts at 1_800_000_000_000; set is exact; advance moves forward and returns the time; advance by a negative or invalid value throws; now() is what the kit reads`
  - words: `wordMatcher: whole words only (zorbakian is not zorbak), case-insensitive, punctuation-adjacent, spans on the original text, an empty list blocks nothing, a regex metacharacter in a word is literal`; `wordFilter stars whole words and reports hit`
  - kit: `defaults are the standard profile, retention off, no matcher; blocked and swears are shorthands and lose to matcher/profanity/profanityPackage; a failing store subclass passes through; two kits share nothing; close stops the kit's timers; logged and events record in order`
  - script: `say, report, mute, wait and suggest steps; expect on say accepts one label or a list`; `labels: delivered, starred (text changed), refused:length, rate, restricted, blocked, profanity, empty, and gate with a closing gate`; `a line that earns the first automatic timeout has autoRestricted 'first', the repeat 'second'`; `after the third blocked line in an hour the next say is refused:restricted and wait past the restriction delivers again` (numbers read from cw.limits, never literals); `report: filed, then refused:duplicate/self/rate as the kit answers; the report's reporter and target are the named players`; `mute hides one player's lines from the muter only (sees)`
  - `a mismatch throws ScriptMismatch naming the step number, expected and actual, and the table lists every step`; `expectOutcomes compares the whole array and reports the first difference`; `checkLines runs every case on a fresh kit and reports ALL differing cases in one error`
  - pacing labels: if flood control has merged (Step 0), `slow_mode`, `flood` and `duplicate` are real refusals and labelled `refused:<reason>`; otherwise a scripted facade whose `accept` returns them gives the same labels
  - policy: `strict, standard and relaxed give the suggestions their profile tables name for the same script` (the expected values are read from `cw.profile`/`cw.policy.preview`, so a preset change updates one place); `a profile override changes exactly one outcome`; `the README example runs and matches (scripts/readme.test.ts picks it up)`
  - static: `the testing entry imports no node: module, no vitest or jest, no @chatwarden/matcher`; `the store-memory main entry does not import src/testing (its bundle size is unchanged)`
- **Run:** `npx vitest run packages/store-memory/test/testing-duration.test.ts packages/store-memory/test/testing-clock.test.ts packages/store-memory/test/testing-words.test.ts packages/store-memory/test/testing-kit.test.ts packages/store-memory/test/testing-script.test.ts packages/store-memory/test/testing-policy.test.ts packages/store-memory/test/testing-static.test.ts`

### Task 9: Packaging, check-pack, smoke, CI
Design 4, 14 (packaging), 17. Needs Tasks 4, 7 and 8.
- **Files:** `packages/http/package.json` (`bin: { "chatwarden": "./dist/src/cli/bin.js" }`, `./cli` in `exports` and `typesVersions`, keywords `cli`, `init`), `packages/http/tsconfig.json` (nothing if `src/cli` is already
  included; confirm the shebang survives `tsc`), `vitest.config.ts` (aliases for `@chatwarden/http/cli`), `scripts/check-pack.mjs` and `check-pack.test.ts` (the `bin` assertions), `scripts/smoke.mjs` and `scripts/smoke/` (the init step),
  `scripts/manifests.test.ts` (the new exports are listed; `examples/recipes` pins; exactly one package declares the `chatwarden` bin; no new peer floor), `scripts/release-workflow.test.ts` (unchanged expectations: still ten, still OIDC), `.github/workflows/ci.yml` (job `cli-windows`), `.changeset/config.json` (`ignore` gains
  `@chatwarden/example-recipes`).
- **Behaviour:** `check-pack` fails when a `bin` target is missing from the tarball, does not start with `#!/usr/bin/env node`, or is under a path that would not ship; it counts `bin` in `exportTargets`. The smoke step, in the fresh ESM consumer project (and the CJS one for `runCli`'s `require`), runs the
  packed bin: `npx --no-install chatwarden init --yes --framework express --store memory --chat box --hub element --json` (the project has express and the packed tarballs), parses the JSON, type-checks the written files with the project's TypeScript, starts the generated server on port 0 with a test token, and checks
  `/chatwarden/healthz` is 200, `/chatwarden/mod` is 401 with no token and the first `/chatwarden/chat/lobby/stream` frame is `hello`. The `cli-windows` job: `windows-latest`, Node 22.13, `npm ci`, then `npx vitest run packages/http/test/cli-*.test.ts packages/store-memory/test/testing-*.test.ts`.
- **Tests (names):**
  - check-pack: `bin target present and starting with the shebang passes; missing, no shebang, and a bin under test/ fail with a named problem`; `exportTargets includes bin`
  - manifests: `the published set is still the ten, none private`; `exactly one published package declares a bin and it is chatwarden`; `the new subpaths are in exports and typesVersions and point at files that exist after a build`; `examples/recipes pins every @chatwarden/* to the group version`; `no peer range moved`; `publish-order is unchanged`
  - cjs-types: `a CommonJS project with moduleResolution node resolves @chatwarden/http/fetch, @chatwarden/http/cli and @chatwarden/store-memory/testing types`
  - smoke (`scripts/smoke.test.ts` for the pure helpers; the real run is the CI job): `the init step's command line and the expected JSON fields are built by exported helpers and unit-tested`
  - ci: `the workflow has a cli-windows job on windows-latest running only the targeted CLI and testing tests` (a text test of the file)
- **Run:** `npx vitest run scripts/manifests.test.ts scripts/check-pack.test.ts scripts/smoke.test.ts scripts/release-workflow.test.ts scripts/publish-order.test.ts scripts/browser-bundle.test.ts packages/http/test/cjs-types.test.ts`, then (by hand, once, at the end of the task) `npm run check:pack` after deleting `dist`, and `node scripts/smoke.mjs`.

### Task 10: Docs: recipes, READMEs, status
Design 9.6, 13. Needs Tasks 5, 6, 8 and 9.
- **Files:** `docs/recipes/express.md`, `fastify.md`, `nextjs.md`, `socketio.md`, `colyseus.md` (new; one screen of prose each; the golden files embedded with `<!-- golden: <case>/<file> -->` markers; each says in
  its first lines which cases init writes and which parts the adopter writes), `scripts/recipes.test.ts` (new; expands the markers and compares), `README.md` (the "I want to" row, a sentence in Quick start, a "Test your policy" section), `packages/http/README.md`
  ("The init command": the flags table generated from `OPTIONS` and checked, exit codes, `--json`; "Other servers: `toFetch`"), `packages/store-memory/README.md` ("Testing your policy"), `packages/core/README.md` (two lines), `docs/status.md`, `docs/plans/follow-ups.md`, `CLAUDE.md`
  (the `http` and `store-memory` rows), `RELEASING.md` (the bin and the new-package note), `examples/tiny-chat/README.md` (one line); tests `scripts/readme.test.ts` (the new blocks compile and the new subpaths map), `packages/http/test/readme.test.ts`,
  `packages/store-memory/test/readme.test.ts`, `scripts/recipes.test.ts`.
- **Tests (names):** `every golden marker in docs/recipes resolves to a committed file and the page contains its exact text`; `no recipe page contains a code block that is not a marker or a short shell line`; `the flags table in the http README equals OPTIONS (generated)`; `the READMEs' code blocks for init, toFetch and the test kit compile and run`; `every documented option and flag exists`;
  `the READMEs list the @experimental names`; `the Colyseus page names the version it follows and says it was checked against fakes`; `the Next.js page says Node process, not serverless`; `no page promises a speed ("in 15 minutes", "five minutes") (a scan)`
- **Run:** `npx vitest run scripts/readme.test.ts scripts/recipes.test.ts packages/http/test/readme.test.ts packages/store-memory/test/readme.test.ts`

### Task 11: The agent skill
Design 12. Needs Task 7.
- **Step 0 of this task:** read the current Claude Code plugin documentation and confirm the layout (`.claude-plugin/plugin.json`, `skills/<name>/SKILL.md` with `name` and `description` front matter, a repository-root `.claude-plugin/marketplace.json` listing a plugin by relative `source`).
  If the layout cannot be confirmed, drop this task and move the skill text into `docs/recipes/agents.md` (design question 8); the rest of the release is unaffected.
- **Files:** `.claude-plugin/marketplace.json`, `agent/claude-plugin/.claude-plugin/plugin.json`, `agent/claude-plugin/skills/add-chatwarden/SKILL.md` (about 60 lines: when to use it; the three commands (`init --yes --json`, edit the one line, `init --check`); which flags to choose from what is detected; never to edit `kit.ts` secrets; to write a test with the test kit; the starter markers), `scripts/agent-skill.test.ts`.
- **Tests (names):** `the JSON files parse and name the plugin and its relative source`; `the skill's front matter has a name and a description under 200 characters`; `every --flag the skill mentions is in OPTIONS and every value it mentions is allowed for that flag`; `the skill mentions --json, --check and --dry-run`; `the skill names no real term and no secret`; `the plugin directory is not in any package's files list (it never ships to npm)`
- **Run:** `npx vitest run scripts/agent-skill.test.ts`

### Task 12: Release prep
See the Release section. Changeset, `npm run version`, the manifests pins (`examples/tiny-chat` and `examples/recipes`), `npm run check:pack` after deleting `dist`, `node scripts/smoke.mjs`. Publishing is the maintainer's.
- **Tests (names):** `manifests: the published set is still the ten, none private`; `no peer floor changed by this release (the sets in manifests.test.ts are as the previous release left them)`; `publish-order is unchanged`; `changelog: the three subpaths and the bin are named`; `check-pack: the bin, ./cli, ./fetch and ./testing resolve from the packed tarballs under ESM and CommonJS`; `smoke: the init step passes`.
- **Run:** `npx vitest run scripts/manifests.test.ts scripts/publish-order.test.ts scripts/release-workflow.test.ts scripts/changelog.test.ts scripts/sync-version.test.ts scripts/check-pack.test.ts scripts/smoke.test.ts packages/http/test/cjs-types.test.ts`

### Task 13: Site copy and `llms.txt` (a separate PR, after the release is on npm; not part of the tag)
Design 13, 12. Do not start before the release is published and the commands in the READMEs work from npm.
- **Files:** `site/src/content.ts` (the "Add it to your game" lead gains the init command as step one, copied from the README; the FAQ answer on other languages), `site/public/llms.txt` (the refresh: summary line, "Adopt fast" section, links to `docs/recipes/*.md`),
  and the site tests that name the old text (`site/test/content.test.ts`, `meta.test.ts`, `copyFix.test.tsx`, `finalReview.test.ts` where they pin the old FAQ or llms lines).
- **Tests (names):** `content.test.ts: the init command in the lead equals the README's`; `every llms.txt link resolves to a real repo path (meta.test.ts) and the new recipe links exist`; `llms.txt no longer says it is not a chat system`; `the FAQ answer names Express, Fastify, Next.js and toFetch, says a service API for another language's game server is planned and not built, and promises no speed`; `no page copy contains "minutes" next to "install" unless the timing record exists` (see below).
- **Run:** `npm test --workspace @chatwarden/site -- test/content.test.ts test/meta.test.ts test/copyFix.test.tsx test/finalReview.test.ts` (the site is its own project), then the site's browser checks as `site/README.md` describes.
- **The timing procedure** (a checklist for the maintainer; the "in about 15 minutes" claim waits for it). On a clean machine with Node 22.13 and no `~/.npm` cache warm-up beyond the registry, start a stopwatch at `mkdir game && cd game && npm init -y && npm install express`. Then: `npm install @chatwarden/http @chatwarden/core`, `npx chatwarden init --yes --chat box`, the printed install, the one line in a 5-line `server.js`, `CHATWARDEN_ADMIN_TOKEN` set, start,
  open `/chatwarden/mod`, send a line with the synthetic word from a second terminal (a one-line `curl` in the README), and stop the stopwatch when the hub shows the blocked line. Record the time, the machine and the Node version in `docs/status.md`. Three runs, the slowest counts. Under 15 minutes: the claim may go on the page.

### Task 14 (optional, last): the kit's own tests use the test kit where it is a straight swap
Design question 10. Only the stub matcher (`chat.test.ts`) and the clock literal pattern in `reportingWorld.ts`. Revert if it touches more.
- **Files:** `packages/core/test/reportingWorld.ts`, `packages/core/test/chat.test.ts` (imports from `@chatwarden/store-memory/testing`; core already has `@chatwarden/store-memory` as a devDependency).
- **Tests:** the existing files, unchanged in meaning. **Run:** `npx vitest run packages/core/test/chat.test.ts packages/core/test/reports.test.ts packages/core/test/reporting-settings.test.ts`

---

## Release

**What ships:** a patch, "the release after flood control and signals" (the number is assigned in merge order: 0.1.8 if this merges after flood control
and before appeals and names, a later patch otherwise), of the ten packages in the fixed group. No new package, so the OIDC publish path is unchanged. No migration.
The `bin` is only usable from the version that contains it: the README's commands name `@chatwarden/http` without a version, and the smoke step proves the packed bin.

### Before the tag (all in the branch)
1. `npx changeset`: patch for the group. First line: "adds a setup command, a Web fetch adapter and a test kit". Then plain sentences: `chatwarden init` (the `bin` of `@chatwarden/http`, flags,
   `--json`, `--check`, exit codes, never overwrites), `@chatwarden/http/fetch` (`toFetch`, for Next.js, Hono, Bun, Deno), `@chatwarden/store-memory/testing` (fake clock, scripted chat simulator,
   outcome assertions), the `@experimental` names, no migration, no new package, no peer-floor change. Name the three subpaths and the bin so `scripts/changelog.test.ts` passes.
2. `npm run version` (bumps the ten, runs `sync-version`, refreshes the lockfile). Then set the `@chatwarden/*` versions in `examples/tiny-chat/package.json` and `examples/recipes/package.json` to
   the new version (RELEASING.md step 2) and run `npm install`.
3. **No peer floor rises** unless a task used a name new in an unmerged release; `grep` the new files for core names introduced after 0.1.5 and, for each, raise only the package that imports it, by hand,
   with the changeset naming the API (RELEASING.md "When a peer floor must rise"). Expectation: none.
4. `npm run check:pack` after deleting `dist`, and `node scripts/smoke.mjs` (it now includes the init run).
5. A dry run: `gh workflow run release.yml -f dry_run=true --ref k4b-adoption`.
6. Merge when CI is green (including `cli-windows`). **Tag and push only on the maintainer's go-ahead.** The release publishes the ten through OIDC with provenance.

### What the adopter does (not part of the tag)
`npm install @chatwarden/http @chatwarden/core`, then `npx chatwarden init`. Or, with nothing installed, `npx -p @chatwarden/http chatwarden init`. Nothing is on by default for an existing adopter: a project that never runs
the command or imports the new subpaths changes nothing.

### If the owner later wants `create-chatwarden` (or `@chatwarden/create`)
A separate change, after this release (design 4): a package of one file calling `runCli` from `@chatwarden/http/cli`, with `@chatwarden/http` as its dependency and a bin named for the package. Before the tag that carries it,
the owner publishes it by hand once at the group's version (with 2FA, from a built checkout), then adds the Trusted Publisher on npmjs.com (repository `hainix/chatwarden`, workflow `release.yml`); the release then skips that
version (already on npm) and publishes the other ten through OIDC. Same change: add the package to `PUBLISH_ORDER`, the manifests tests, `check-pack`, RELEASING.md's counts ("ten" becomes eleven) and the changesets
fixed group (the `@chatwarden/*` glob covers the scoped name only).

### Site and announcement
No site change in the release. After it is on npm: Task 13 (the site PR), then the timing record, then, only if it is under 15 minutes, the claim.

---

## Spec coverage (self-review)
Design 1 and 2 to the Goal and Global Constraints; 3 (rulings) to the Global Constraints, Tasks 1 to 9 and the Release section; 4 (packaging) to Task 9 and the Release section; 5.1 to Task 1; 5.2, 5.3, 5.5 and 5.6 to Task 2;
5.4, 5.7 and 5.8 to Task 7; 6 and 7 to Task 3 and Tasks 5 and 6 (the framework files); 8 to Task 4; 9.1 to 9.3 to Task 5; 9.4 and 9.5 to Task 6; 9.6 to Tasks 5 and 10; 10 to Task 8 (and Task 14); 11 (service mode, deferred) to "Not in
this release" in the design and no task; 12 to Tasks 11 and 13 (the docs CLI and agent eval are deferred); 13 to Tasks 10 and 13; 14 to the per-task tests; 15 (risks) to Review Focus and the spikes in Task 5c and Task 11; 16 to the plan's
omissions; 17 to Tasks 9 and 12 and the Release section. Every name used in more than one task (`CliEnv`, `FileSpec`, `Plan`, `Answers`, `OPTIONS`, `Ctx`, `MARKERS`, `renderAll`, `toFetch`, `Mounts`, `Kit`, `createTestKit`, `FakeClock`,
`Step`, `Run`) is defined once in its owning task and consumed under the same spelling.
