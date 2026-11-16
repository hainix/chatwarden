// Applying a plan (design 5.2 and 5.3). Per file: absent means create, byte-identical means unchanged, differing is a conflict that is skipped,
// overwritten, or written beside, as asked. Nothing is ever edited or deleted, no path leaves the project, and a write goes to a temporary
// name in the same folder and is renamed into place, so an interrupted run never leaves half a file.
import type { ConflictAsker, ConflictChoice } from './conflict.js';
import type { CliEnv } from './env.js';
import { safePath } from './paths.js';
import type { OnConflict, Plan } from './types.js';

export interface ApplyOptions {
  /** What a conflict does when nobody is asked. */
  onConflict: OnConflict;
  /** Decide everything and report it, but write nothing (and ask nothing). */
  dryRun: boolean;
  /** Asked once per conflicting file, instead of `onConflict`. */
  ask?: ConflictAsker;
}

export type FileAction = 'created' | 'unchanged' | 'skipped' | 'overwritten' | 'created-new';

export interface FileResult {
  /** Relative, posix. */
  path: string;
  action: FileAction;
  /** Present when the file existed and differed. */
  reason?: 'differs';
  /** With `created-new`: where the new version went. */
  writtenTo?: string;
}

export interface Result {
  dryRun: boolean;
  /** In plan order. After an error, only the files done before it. */
  files: FileResult[];
  error?: { kind: 'unsafe' | 'io'; path?: string; message: string };
  /** Filled by the install step (Task 7), if it ran. */
  install?: { ran: boolean; failed?: boolean };
}

/** 0 done, 1 an unsafe path, 2 some files skipped because they differ, 3 could not write or install (a failed install is the louder result). */
export function exitCodeOf(result: Result): 0 | 1 | 2 | 3 {
  if (result.error) return result.error.kind === 'unsafe' ? 1 : 3;
  if (result.install?.failed) return 3;
  return result.files.some((file) => file.action === 'skipped') ? 2 : 0;
}

function codeOf(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,20}$/.test(code) ? code : undefined;
}

function ioError(path: string, cause: unknown, what = 'write'): NonNullable<Result['error']> {
  const code = codeOf(cause);
  return { kind: 'io', path, message: `Could not ${what} ${path}${code ? ` (${code})` : ''}.` };
}

/** `src/kit.ts` to `src/kit.chatwarden-new.ts`; `.env.example` to `.env.chatwarden-new.example`; `Dockerfile` to `Dockerfile.chatwarden-new`. */
function besideName(path: string): string {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${folder}${name}.chatwarden-new`;
  return `${folder}${name.slice(0, dot)}.chatwarden-new${name.slice(dot)}`;
}

type Existing = { kind: 'absent' } | { kind: 'file'; text: string };

async function readExisting(env: CliEnv, absolute: string): Promise<Existing> {
  let stat;
  try {
    stat = await env.fs.lstat(absolute);
  } catch (cause) {
    const code = codeOf(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    throw cause;
  }
  if (stat.isDirectory()) throw Object.assign(new Error('a folder is in the way'), { code: 'EISDIR' });
  return { kind: 'file', text: await env.fs.readFile(absolute, 'utf8') };
}

async function writeAtomic(env: CliEnv, absolute: string, content: string): Promise<void> {
  const folder = env.path.dirname(absolute);
  await env.fs.mkdir(folder, { recursive: true });
  const temp = env.path.join(folder, `.${env.path.basename(absolute)}.chatwarden-tmp`);
  try {
    // A stale or planted entry at the temp name (a symbolic link in a cloned repo) is removed, never followed: `rm` does not follow a link, and
    // `wx` fails rather than open an existing name.
    await env.fs.rm(temp, { force: true });
    await env.fs.writeFile(temp, content, { flag: 'wx' });
    await env.fs.rename(temp, absolute);
  } catch (cause) {
    try {
      await env.fs.rm(temp, { force: true });
    } catch {
      // The write already failed; the original error is the one to report.
    }
    throw cause;
  }
}

async function choose(options: ApplyOptions, info: { path: string; existing: string; incoming: string }): Promise<ConflictChoice> {
  if (!options.ask || options.dryRun) return options.onConflict;
  try {
    const answer = await options.ask(info);
    return answer === 'overwrite' || answer === 'new' || answer === 'skip' ? answer : 'skip';
  } catch {
    return 'skip';
  }
}

/** Apply the plan under `env.cwd`. Never throws for a problem with the files: that is `result.error`. */
export async function applyPlan(env: CliEnv, plan: Plan, options: ApplyOptions): Promise<Result> {
  const root = env.cwd;
  const result: Result = { dryRun: options.dryRun, files: [] };

  // Every path is checked before the first write, so an unsafe plan changes nothing.
  const targets: Array<{ path: string; absolute: string; content: string }> = [];
  const seen = new Set<string>();
  for (const file of plan.files) {
    if (seen.has(file.path)) return { ...result, error: { kind: 'unsafe', message: 'Two files in the plan have the same path.' } };
    seen.add(file.path);
    const absolute = await safePath(env, root, '', file.path);
    if (typeof absolute !== 'string') return { ...result, error: { kind: 'unsafe', message: absolute.error } };
    targets.push({ path: file.path, absolute, content: file.content.replaceAll('\r\n', '\n') });
  }

  for (const target of targets) {
    try {
      const existing = await readExisting(env, target.absolute);
      if (existing.kind === 'absent') {
        if (!options.dryRun) await writeAtomic(env, target.absolute, target.content);
        result.files.push({ path: target.path, action: 'created' });
        continue;
      }
      // Line endings alone do not make a conflict: a Windows checkout with autocrlf turns an untouched file into CRLF. The file is never rewritten.
      if (existing.text.replaceAll('\r\n', '\n') === target.content) {
        result.files.push({ path: target.path, action: 'unchanged' });
        continue;
      }

      const choice = await choose(options, { path: target.path, existing: existing.text, incoming: target.content });
      if (choice === 'overwrite') {
        if (!options.dryRun) await writeAtomic(env, target.absolute, target.content);
        result.files.push({ path: target.path, action: 'overwritten', reason: 'differs' });
      } else if (choice === 'new') {
        const beside = besideName(target.path);
        const besideAbsolute = await safePath(env, root, '', beside);
        const taken = typeof besideAbsolute === 'string' ? (await readExisting(env, besideAbsolute)).kind === 'file' : true;
        if (typeof besideAbsolute !== 'string' || taken) {
          result.files.push({ path: target.path, action: 'skipped', reason: 'differs' });
        } else {
          try {
            if (!options.dryRun) await writeAtomic(env, besideAbsolute, target.content);
          } catch (cause) {
            result.error = ioError(beside, cause);
            return result;
          }
          result.files.push({ path: target.path, action: 'created-new', reason: 'differs', writtenTo: beside });
        }
      } else {
        result.files.push({ path: target.path, action: 'skipped', reason: 'differs' });
      }
    } catch (cause) {
      result.error = ioError(target.path, cause);
      return result;
    }
  }
  return result;
}
