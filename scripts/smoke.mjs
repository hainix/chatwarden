// Consumer smoke test. Packs every published @chatwarden/* package (a real `npm pack`, so `prepack` runs), installs the
// tarballs into a fresh ESM project and a fresh CommonJS project (the kit-only packages into a third, headless one with no React, and the React packages into a fourth with React 18.3), typechecks each, and runs a real scenario in each
// (scripts/smoke/scenario.ts). The tarballs are what an adopter, Moxgate first, vendors; they are left in `.smoke/tarballs/`.
// The two projects are created in the OS temp directory (chatwarden-smoke-*), never inside the repository: from there Node
// cannot fall back on the monorepo's node_modules, so a package that imports something it forgot to declare fails here.
// They are deleted afterwards unless SMOKE_KEEP=1. Every child process has a timeout (5 minutes to install, 60 s to run).
//   ESM: type "module", NodeNext, TypeScript 5.9. It also runs the packed `chatwarden` bin (`init --yes ... --json`), type-checks and compiles what it wrote
//        with the rest of the project, starts the generated server on port 0 and checks it (scripts/smoke/init-check.mjs).
//   CJS: module commonjs, moduleResolution node, esModuleInterop, strict, TypeScript 5.7 (Moxgate's server). The compiled
//        scenario `require()`s the ESM packages, so Node's require(esm) path runs for real, and `runCli` is required from `@chatwarden/http/cli`.
// The pure helpers are exported and unit-tested in scripts/smoke.test.ts; the end-to-end run is at the bottom.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-project settings. `typescript` is the pinned `typescript@<spec>` installed into the project; `scenario` is the file under
 * scripts/smoke/ that becomes its src/index.ts; `extras` are installed beside the tarballs.
 * `only` limits the tarballs to those packages: the headless project holds just what `@chatwarden/hub-react/headless` needs and no React
 * (react and react-dom are optional peers of hub-react, so npm does not fetch them; player-react and hub-element would bring React in).
 */
export const PROJECTS = {
  esm: { typescript: '5.9', scenario: 'scenario.ts', extras: ['express@5', '@types/express@5', '@types/react@19', '@types/react-dom@19'], init: true },
  cjs: { typescript: '5.7', scenario: 'scenario.ts', extras: ['express@5', '@types/express@5', '@types/react@19', '@types/react-dom@19'], requireCli: true },
  headless: { typescript: '5.9', scenario: 'headless.ts', extras: [], only: ['@chatwarden/core', '@chatwarden/http', '@chatwarden/hub-react'] },
  // React 18.3 (the other end of the peer range `^18.3.0 || ^19.0.0`; the projects above get React 19). It server-renders the hub and the player
  // components and imports the headless entry. hub-element is left out: it bundles its own React.
  react18: {
    typescript: '5.9',
    scenario: 'react18.tsx',
    extras: ['react@18.3', 'react-dom@18.3', '@types/react@18', '@types/react-dom@18'],
    only: ['@chatwarden/core', '@chatwarden/http', '@chatwarden/hub-react', '@chatwarden/player-react'],
  },
};

/** The packed packages a project installs: all of them, or the `only` list of the project. A name on that list that was not packed throws. */
export function packagesFor(project, packages) {
  const settings = PROJECTS[project];
  if (settings === undefined) throw new Error(`unknown smoke project: ${project}`);
  if (settings.only === undefined) return packages;
  return settings.only.map((name) => {
    const found = packages.find((p) => p.name === name);
    if (found === undefined) throw new Error(`smoke project ${project} needs ${name}, which was not packed`);
    return found;
  });
}

/** The file name `npm pack` gives a package: `@scope/name` + `0.1.0` becomes `scope-name-0.1.0.tgz`. */
export function tarballName(name, version) {
  if (typeof name !== 'string' || name === '') throw new Error('tarballName: a package name is required');
  if (typeof version !== 'string' || version === '') throw new Error('tarballName: a version is required');
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

/** The non-private manifests, sorted by name, as `{ name, version, tarball }`. Throws when there are none. */
export function publishedPackages(manifests) {
  const out = manifests
    .filter((m) => m.private !== true)
    .map((m) => ({ name: m.name, version: m.version, tarball: tarballName(m.name, m.version) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (out.length === 0) throw new Error('no published packages found');
  return out;
}

/** The `npm install` arguments for one project: the tarballs, what Moxgate has beside them, and the pinned TypeScript. */
export function installArgs(project, tarballPaths) {
  const settings = PROJECTS[project];
  if (settings === undefined) throw new Error(`unknown smoke project: ${project}`);
  if (tarballPaths.length === 0) throw new Error('installArgs: no tarballs to install');
  return [
    'install',
    '--no-audit',
    '--no-fund',
    ...tarballPaths,
    ...settings.extras,
    '@types/node@22',
    `typescript@${settings.typescript}`,
  ];
}

/** Fills `{{name}}` placeholders. A placeholder with no value throws; a substituted value is not expanded again. */
export function renderTemplate(text, vars) {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`renderTemplate: no value for {{${key}}}`);
    return vars[key];
  });
}

/** The answers the init step gives, as flags. Every one is given, so nothing is asked, and there is no `--install` and no `--force`. */
const INIT_ANSWERS = ['--framework', 'express', '--store', 'memory', '--chat', 'box', '--hub', 'element'];

/** The command line of the init step: the packed bin, by `npx --no-install` (the project has the tarballs, and nothing may reach the registry). */
export function initCommand() {
  return { command: 'npx', args: ['--no-install', 'chatwarden', 'init', '--yes', ...INIT_ANSWERS, '--json'] };
}

/** The files the init step must have created (the project has a `src` folder, so the default folder is src/chatwarden). */
const INIT_FILES = ['src/chatwarden/kit.ts', 'src/chatwarden/express.ts', 'src/chatwarden/auth.ts'];

/**
 * What is wrong with the output of the init step (empty array = good): it must be JSON, ok, not a dry run, from the packed version, with the answers
 * that were given, and each file in `INIT_FILES` created at a relative path.
 * @param {string} text what the bin printed on standard output
 * @param {string} version the version of the packed @chatwarden/http
 */
export function initProblems(text, version) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ['the init step did not print JSON on standard output'];
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['the init step JSON is not an object'];
  const problems = [];
  if (doc.ok !== true) problems.push(`ok is ${JSON.stringify(doc.ok)}${doc.error ? `: ${doc.error.message}` : ''}`);
  if (doc.dryRun !== false) problems.push('the run was a dry run: nothing was written');
  if (doc.chatwarden !== version) problems.push(`the bin reports version ${JSON.stringify(doc.chatwarden)}, the packed package is ${version}`);
  const expected = { framework: 'express', store: 'memory', chat: 'box', hub: 'element' };
  for (const [key, value] of Object.entries(expected)) {
    if (doc.answers?.[key] !== value) problems.push(`answers.${key} is ${JSON.stringify(doc.answers?.[key])}, expected ${value}`);
  }
  const files = Array.isArray(doc.files) ? doc.files : [];
  for (const file of files) {
    if (typeof file?.path !== 'string' || file.path.startsWith('/') || /^[A-Za-z]:/.test(file.path) || file.path.includes('\\')) problems.push(`a file path is not relative with /: ${JSON.stringify(file?.path)}`);
  }
  for (const wanted of INIT_FILES) {
    const found = files.find((f) => f?.path === wanted);
    if (found === undefined) problems.push(`${wanted} is not in the report`);
    else if (found.action !== 'created') problems.push(`${wanted} was ${found.action}, expected created`);
  }
  return problems;
}

/** The CommonJS check: `require` the CLI entry (Node's require(esm) path) and ask it for its version. */
export function cliRequireCommand() {
  return {
    command: 'node',
    args: ['-e', "const { runCli } = require('@chatwarden/http/cli'); runCli(['--version']).then((code) => process.exit(code));"],
  };
}

/** The prefix of the temp directory holding the consumer projects. */
export const TEMP_PREFIX = 'chatwarden-smoke-';

const TIMEOUTS = { install: 5 * 60_000, run: 60_000 };

/** The child-process timeout in ms: `install` (also build and pack) 5 minutes, `run` (typecheck, compile, scenario) 60 s. */
export function timeoutFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(TIMEOUTS, kind)) throw new Error(`timeoutFor: unknown kind ${String(kind)}`);
  return TIMEOUTS[kind];
}

/** True when the temp projects should survive the run (SMOKE_KEEP=1), for debugging a failure. */
export function keepTemp(env) {
  return env.SMOKE_KEEP === '1';
}

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const WIN = process.platform === 'win32';

function run(cmd, args, cwd, label, kind) {
  console.log(`\n[smoke] ${label}: ${cmd} ${args.join(' ')}`);
  // npm and npx are .cmd shims on Windows and need a shell; node itself is spawned directly (its path may hold spaces).
  const shimmed = WIN && (cmd === 'npm' || cmd === 'npx');
  const timeout = timeoutFor(kind);
  const res = spawnSync(shimmed ? `${cmd}.cmd` : cmd, args, { cwd, stdio: 'inherit', shell: shimmed, timeout });
  if (res.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out after ${timeout / 1000} s`);
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status ?? res.signal ?? 'unknown'})`);
}

/** Like `run`, but returns what the command printed on standard output (its standard error still goes to the terminal). */
function capture(cmd, args, cwd, label, kind) {
  console.log(`\n[smoke] ${label}: ${cmd} ${args.join(' ')}`);
  const shimmed = WIN && (cmd === 'npm' || cmd === 'npx');
  const timeout = timeoutFor(kind);
  const res = spawnSync(shimmed ? `${cmd}.cmd` : cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: shimmed, timeout, encoding: 'utf8' });
  if (res.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out after ${timeout / 1000} s`);
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status ?? res.signal ?? 'unknown'})`);
  return res.stdout;
}

function copyTemplates(root, project, dest) {
  mkdirSync(join(dest, 'src'), { recursive: true });
  const from = join(root, 'scripts', 'smoke', project);
  for (const f of readdirSync(from)) {
    const text = readFileSync(join(from, f), 'utf8');
    writeFileSync(join(dest, f), renderTemplate(text, { project }));
  }
  // The scenario becomes src/index.ts (src/index.tsx for the one that uses JSX).
  const scenario = PROJECTS[project].scenario;
  cpSync(join(root, 'scripts', 'smoke', scenario), join(dest, 'src', `index${extname(scenario)}`));
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const smoke = join(root, '.smoke');
  const tarballDir = join(smoke, 'tarballs');
  rmSync(smoke, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });

  const base = join(root, 'packages');
  const manifests = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'package.json')))
    .map((d) => JSON.parse(readFileSync(join(base, d.name, 'package.json'), 'utf8')));
  const packages = publishedPackages(manifests);
  const httpVersion = packages.find((p) => p.name === '@chatwarden/http')?.version;
  if (httpVersion === undefined) throw new Error('@chatwarden/http is not among the published packages');

  run('npm', ['run', 'build'], root, 'build', 'install');
  for (const p of packages) {
    // A real pack: `prepack` runs here, so a package whose prepack is broken fails the smoke test.
    run('npm', ['pack', '--workspace', p.name, '--pack-destination', tarballDir], root, `pack ${p.name}`, 'install');
    if (!existsSync(join(tarballDir, p.tarball))) throw new Error(`npm pack did not produce ${p.tarball}`);
  }

  // Absolute paths: the projects are not next to the tarballs.
  const tarballsFor = (project) => packagesFor(project, packages).map((p) => join(tarballDir, p.tarball));
  // Outside the repository on purpose (see the header): no node_modules above these folders.
  const work = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  if (isInside(root, work)) throw new Error(`the temp directory ${work} is inside the repository`);
  console.log(`[smoke] consumer projects in ${work}`);
  try {
    for (const project of Object.keys(PROJECTS)) {
      const dir = join(work, project);
      copyTemplates(root, project, dir);
      run('npm', installArgs(project, tarballsFor(project)), dir, `${project}: install`, 'install');
      if (PROJECTS[project].init === true) {
        // The packed bin writes the starter into src/chatwarden; the type-check and compile below then cover those files with the project's TypeScript.
        const init = initCommand();
        const problems = initProblems(capture(init.command, init.args, dir, `${project}: chatwarden init`, 'run'), httpVersion);
        if (problems.length > 0) throw new Error(`${project}: the init step failed:\n  - ${problems.join('\n  - ')}`);
      }
      run('npx', ['tsc', '--noEmit'], dir, `${project}: typecheck`, 'run');
      run('npx', ['tsc'], dir, `${project}: compile`, 'run');
      run(process.execPath, ['dist/index.js'], dir, `${project}: scenario`, 'run');
      if (PROJECTS[project].init === true) {
        cpSync(join(root, 'scripts', 'smoke', 'init-check.mjs'), join(dir, 'init-check.mjs'));
        run(process.execPath, ['init-check.mjs'], dir, `${project}: the generated server`, 'run');
      }
      if (PROJECTS[project].requireCli === true) {
        const required = cliRequireCommand();
        const printed = capture(process.execPath, required.args, dir, `${project}: require the CLI`, 'run');
        if (printed.trim() !== httpVersion) throw new Error(`${project}: require('@chatwarden/http/cli') printed ${JSON.stringify(printed.trim())}, expected ${httpVersion}`);
      }
    }
  } finally {
    if (keepTemp(process.env)) console.log(`[smoke] SMOKE_KEEP=1: left ${work} in place`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`\n[smoke] ok: ${packages.length} tarballs; the ESM (with the init step), CJS, headless (no React) and React 18.3 consumers typecheck and run`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`\n[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
