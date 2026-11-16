// `chatwarden init --check` (design 5.7): is the starter still in place? Reads the files init writes under `--dir` (and nothing else), lists each
// `TODO(auth)`, `TODO(identity)` and `TODO(terms)` marker with its file and line, and names the required environment variables the environment does not
// define. It only reads, and it never prints a value: a variable is looked at for being set, and only its name goes into the report.
import type { CliEnv } from './env.js';
import { safePath } from './paths.js';
import { envNames } from './plan.js';
import { MARKERS } from './templates/header.js';
import type { Answers, TodoItem } from './types.js';

export interface CheckResult {
  /** Nothing is left: no marker, no missing required name, no problem. */
  ok: boolean;
  /** The files that were read, relative to the project, with `/` separators. */
  files: string[];
  markers: TodoItem[];
  /** Names (never values) of required variables that are unset or empty. */
  missingEnv: string[];
  /** Why the check could not look (an unsafe folder, no files). */
  problems: string[];
}

const SCRIPT = /\.(ts|tsx|js|jsx|mjs)$/;

function failed(problem: string): CheckResult {
  return { ok: false, files: [], markers: [], missingEnv: [], problems: [problem] };
}

export async function checkProject(env: CliEnv, answers: Answers): Promise<CheckResult> {
  // The folder gets init's own path rules (inside the project, no link out of it): a made-up file name in it is checked, and its folder is read.
  const probe = await safePath(env, env.cwd, answers.dir, 'kit.ts');
  if (typeof probe !== 'string') return failed(probe.error);
  const dir = env.path.dirname(probe);

  let names: string[];
  try {
    names = (await env.fs.readdir(dir)).sort();
  } catch {
    return failed(`No chatwarden files found in ${answers.dir}: run chatwarden init first.`);
  }

  const files: string[] = [];
  const markers: TodoItem[] = [];
  for (const name of names) {
    if (!SCRIPT.test(name)) continue;
    const absolute = env.path.join(dir, name);
    try {
      // lstat: a link is not followed, and a folder is not entered.
      if (!(await env.fs.lstat(absolute)).isFile()) continue;
      const text = await env.fs.readFile(absolute, 'utf8');
      const relative = `${answers.dir}/${name}`;
      files.push(relative);
      text.split('\n').forEach((line, index) => {
        for (const marker of MARKERS) if (line.includes(marker)) markers.push({ file: relative, line: index + 1, marker });
      });
    } catch {
      // A file that cannot be read is not a marker; the missing-files problem below covers an empty folder.
    }
  }
  if (files.length === 0) return failed(`No chatwarden files found in ${answers.dir}: run chatwarden init first.`);

  const missingEnv = envNames(answers)
    .filter((entry) => entry.required && (env.env[entry.name] ?? '') === '')
    .map((entry) => entry.name);
  return { ok: markers.length === 0 && missingEnv.length === 0, files, markers, missingEnv, problems: [] };
}

/** The report for a person. */
export function renderCheck(result: CheckResult): string {
  const lines: string[] = [];
  if (result.problems.length > 0) lines.push(...result.problems, '');
  if (result.markers.length > 0) {
    lines.push('Starter code still in place');
    for (const item of result.markers) lines.push(`  ${item.file}:${item.line} ${item.marker}`);
    lines.push('');
  }
  if (result.missingEnv.length > 0) {
    lines.push('Required environment variables that are not set (names only)');
    for (const name of result.missingEnv) lines.push(`  ${name}`);
    lines.push("These are read from this shell's environment. A .env file is not loaded for you: export the names, or start your server with node --env-file=.env.", '');
  }
  if (result.ok) lines.push('Nothing left to replace: no starter marker remains and the required environment variables are set.');
  else if (result.problems.length === 0) lines.push('Replace the starter code (see the comment at each marker), set the variables, then run this check again.');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The `--check --json` document: `version: 1`, no value, no absolute path, no file content. */
export function renderCheckJson(result: CheckResult, version: string): string {
  const document = {
    version: 1,
    chatwarden: version,
    ok: result.ok,
    check: { files: result.files.length, markers: result.markers, missingEnv: result.missingEnv, problems: result.problems },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
