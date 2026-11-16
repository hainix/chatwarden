// The plan: what init would do, as pure data (design 5.2). No file system, no clock, no randomness: the same answers give the same plan, byte
// for byte, on every machine. Applying it is apply.ts's job.
import type { Answers, AppLayout, EnvName, FileSpec, PackageManager, Plan, Project, TodoItem, Versions } from './types.js';

/** The shared and framework templates (Tasks 3, 5 and 6), as `renderAll` or as the list it returns. Injected so this file is tested with stubs. */
export type Templates = FileSpec[] | ((answers: Answers, versions: Versions) => FileSpec[]);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const INSTALL_VERBS: Record<PackageManager, string> = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add', bun: 'bun add' };
/** The command that makes a value for CHATWARDEN_SECRET and CHATWARDEN_ADMIN_TOKEN: the same on every shell (double quotes outside, single inside). */
export const SECRET_COMMAND = `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`;

/**
 * What must never be in a generated file: a carriage return, a machine path, a timestamp, a key-like run of characters (design 5.5 and
 * Review Focus 2). Returns the kinds found; an empty list is clean. The plan tests run every template through it.
 */
export function contentProblems(content: string): string[] {
  const found: string[] = [];
  if (content.includes('\r')) found.push('carriage-return');
  if (/(?:^|[\s'"`(=,])(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|root|private)\/)/m.test(content)) found.push('absolute-path');
  if (/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(content) || /\b1[5-9]\d{11}\b/.test(content)) found.push('timestamp');
  const hex = /\b[0-9a-fA-F]{32,}\b/.test(content);
  const mixed = (content.match(/[A-Za-z0-9+/]{32,}/g) ?? []).some((run) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run));
  if (hex || mixed) found.push('long-secret-like-run');
  return found;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function installPackages(answers: Answers, versions: Versions, project: Project): string[] {
  const names = ['core', 'http', answers.store === 'sqlite' ? 'store-sqlite' : 'store-memory', 'matcher', 'profanity'];
  if (answers.discord) names.push('discord');
  if (answers.hub === 'element') names.push('hub-element');
  if (answers.hub === 'react') names.push('hub-react');
  if (answers.chat === 'box') names.push('player-react');
  const packages = names.map((name) => `@chatwarden/${name}@^${versions.chatwarden}`);
  if ((answers.hub === 'react' || answers.chat === 'box') && !project.react) packages.push('react', 'react-dom');
  // The box's socket client. The server side (socket.io) is the game's own and is not touched: an install of it could move the game's version.
  if (answers.chat === 'box' && answers.chatTransport === 'socketio') packages.push('socket.io-client');
  return packages;
}

/** The environment variables the generated code reads, in the order the env example lists them. Names only. */
export function envNames(answers: Answers): EnvName[] {
  const routes = answers.framework !== 'none';
  const env: EnvName[] = [{ name: 'CHATWARDEN_SECRET', required: true }];
  if (routes) env.push({ name: 'CHATWARDEN_ADMIN_TOKEN', required: true });
  if (answers.store === 'sqlite') env.push({ name: 'CHATWARDEN_DB', required: false });
  if (answers.discord) {
    env.push({ name: 'DISCORD_WEBHOOK_URL', required: true }, { name: 'DISCORD_MENTION_ROLE_ID', required: false }, { name: 'CHATWARDEN_PUBLIC_URL', required: false });
  }
  if (answers.framework === 'next' || answers.framework === 'fetch') env.push({ name: 'CHATWARDEN_TRUST_PROXY', required: false });
  return env;
}

/**
 * Where a Next.js project keeps its routes. An `app` folder at the root wins; a `src` folder with no `app` beside it means `src/app` (Next ignores a
 * root `app` once `src` holds the routes). Only when the root listing says neither does the `--dir` prefix decide: `src/...` goes under `src/app`.
 */
export function nextAppRoot(answers: Answers, layout: AppLayout = {}): string {
  if (layout.appDir === true) return 'app';
  if (layout.srcDir === true) return 'src/app';
  return answers.dir.startsWith('src/') ? 'src/app' : 'app';
}

function entryLine(answers: Answers, layout: AppLayout, moduleType: 'module' | 'commonjs'): string {
  const line = frameworkEntryLine(answers, layout, moduleType);
  if (answers.chat === 'box' && answers.chatTransport === 'socketio') {
    return `${line} Then attach the chat to your Socket.IO server: attachChat(io, kit) (from ${answers.dir}/socketio).`;
  }
  return line;
}

/** Where the mount comes from, and the await: a CommonJS file has no top-level await, and its JavaScript mount is an .mjs file that only `import()` loads. */
function mountLine(answers: Answers, moduleType: 'module' | 'commonjs', before: string): string {
  const file = `${answers.dir}/${answers.framework}`;
  if (moduleType === 'module') return `Add one line to your app${before}: await mountChatwarden(app) (from ${file}).`;
  const from = answers.lang === 'js' ? `${file}.mjs, loaded with a dynamic import` : file;
  return `Add one line to your app${before}, inside an async function (CommonJS has no top-level await): await mountChatwarden(app) (from ${from}).`;
}

function frameworkEntryLine(answers: Answers, layout: AppLayout, moduleType: 'module' | 'commonjs'): string {
  const { dir, base } = answers;
  switch (answers.framework) {
    case 'express':
      return mountLine(answers, moduleType, ', before any body parser');
    case 'fastify':
      return mountLine(answers, moduleType, '');
    case 'next':
      return `Next serves the route handler under ${nextAppRoot(answers, layout)}${base}/ by itself: there is nothing to add to your code. This recipe needs Next running as a Node process, not serverless (next start, a container or a VM): the database file and the open chat streams need one long-lived process.`;
    case 'fetch':
      return `Call the handler from ${dir}/handler for each request under ${base}: const response = await handler(request).`;
    case 'none':
      return `Create the kit once at startup with createKit() from ${dir}/kit, and keep it for the life of the server.`;
  }
}

function nextSteps(answers: Answers, command: string, layout: AppLayout, moduleType: 'module' | 'commonjs'): string[] {
  const library = answers.framework === 'none';
  const variables = library ? 'CHATWARDEN_SECRET' : 'CHATWARDEN_SECRET and CHATWARDEN_ADMIN_TOKEN';
  const setLine = `Set ${variables} (make a value with: ${SECRET_COMMAND}).`;
  let last: string;
  if (library) last = 'Call the check from your chat handler before you broadcast a line (the hook below).';
  else if (answers.hub === 'none') last = `Start your server and open http://localhost:3000${answers.base}/healthz (use your server's port).`;
  else last = `Start your server and open http://localhost:3000${answers.base}/mod (use your server's port).`;
  return [`Install the packages: ${command}`, entryLine(answers, layout, moduleType), setLine, last];
}

function todoOf(files: readonly FileSpec[]): TodoItem[] {
  const todo: TodoItem[] = [];
  for (const file of files) {
    if (!file.markers?.length) continue;
    const lines = file.content.split('\n');
    lines.forEach((text, index) => {
      for (const marker of file.markers ?? []) {
        if (text.includes(marker)) todo.push({ file: file.path, line: index + 1, marker });
      }
    });
  }
  return todo;
}

/**
 * Build the plan. `templates` is `renderAll` (or what it returned); `project` is what detection found beyond the answers: the package manager
 * and whether React is already a dependency. Throws only on a programming error: a malformed version (it would reach a command line) or two
 * templates writing the same path.
 */
export function buildPlan(answers: Answers, versions: Versions, templates: Templates, project: Project): Plan {
  if (!VERSION_PATTERN.test(versions.chatwarden)) throw new Error('the version for the install line must be a plain version such as 1.2.3');

  const rendered = typeof templates === 'function' ? templates(answers, versions) : templates;
  const files: FileSpec[] = rendered
    .map((file) => ({ ...file, content: file.content.replaceAll('\r\n', '\n'), ...(file.markers ? { markers: [...file.markers] } : {}) }))
    .sort((a, b) => compare(a.path, b.path));
  for (let i = 1; i < files.length; i += 1) {
    if (files[i]?.path === files[i - 1]?.path) throw new Error(`two templates write the same path: ${files[i]?.path}`);
  }

  const packages = installPackages(answers, versions, project);
  // cmd.exe reads a bare ^ as its escape character; inside double quotes it is literal, and sh and PowerShell take the quotes in their stride.
  const shown = project.platform === 'win32' ? packages.map((spec) => `"${spec}"`) : packages;
  const command = `${INSTALL_VERBS[project.manager]} ${shown.join(' ')}`;
  const warnings: string[] = [];
  if (answers.chat === 'box' && !project.react) {
    warnings.push('The chat box is a React component and this project has no React: react and react-dom are on the install line; without React, use the ChatTransport seam (see the recipe).');
  }

  return {
    answers: { ...answers },
    files,
    install: { manager: project.manager, command, packages },
    env: envNames(answers),
    nextSteps: nextSteps(answers, command, project, project.moduleType ?? 'module'),
    warnings,
    todo: todoOf(files),
  };
}
