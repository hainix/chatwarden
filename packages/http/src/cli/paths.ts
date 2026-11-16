// Where a file may be written. Every path the CLI writes is computed from the folder it was told (`--dir`) and a template's relative name,
// and has to stay inside the project root: no `..`, no absolute path or drive, no name Windows cannot hold, and no symbolic link that
// leads out of the project (design 5.2; Review Focus 1 and 5). Errors are one sentence and never carry the root or what the user typed
// for an absolute path.
import type { CliEnv } from './env.js';
import { show } from './args.js';

type Failure = { error: string };

/** The longest relative output path (folder, `/`, name) the CLI will write. */
export const MAX_PATH_LENGTH = 200;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Characters Windows forbids in a name, and the control characters; `:` is checked on its own for the clearer message.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>"|?*\u0000-\u001f]/;

/** The segments of a relative name, `/` or `\` separated, or an error. `allowEmpty` lets the folder be the root itself (`''`). */
function segmentsOf(raw: string, allowEmpty: boolean): string[] | Failure {
  if (raw === '' && allowEmpty) return [];
  if (raw === '') return { error: 'A file needs a name.' };
  if (raw.includes('\0') || FORBIDDEN.test(raw)) return { error: 'A path contains a character that is not allowed in a file name.' };
  const slashed = raw.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    return { error: 'A path must be inside the project: not an absolute path and not a drive.' };
  }
  const segments = slashed.split('/');
  for (const segment of segments) {
    if (segment === '') return { error: 'A path has an empty part (a doubled slash).' };
    if (segment === '..') return { error: 'A path may not contain .. (it must stay inside the project).' };
  }
  const kept = segments.filter((segment) => segment !== '.');
  for (const segment of kept) {
    if (segment.includes(':')) return { error: `${show(segment)} contains a colon, which is not allowed in a file name.` };
    if (/[. ]$/.test(segment)) return { error: `${show(segment)} ends with a dot or a space, which Windows does not allow.` };
    if (RESERVED.test(segment.split('.')[0] ?? '')) return { error: `${show(segment)} is a reserved name on Windows.` };
  }
  return kept;
}

function isInside(env: CliEnv, root: string, candidate: string): boolean {
  const relative = env.path.relative(root, candidate);
  if (relative === '') return true;
  if (env.path.isAbsolute(relative)) return false; // another drive
  return relative !== '..' && !relative.startsWith(`..${env.path.sep}`) && !relative.startsWith('../');
}

/** `realpath` of the nearest folder at or above `start` that exists. */
async function nearestReal(env: CliEnv, start: string): Promise<string | undefined> {
  let current = start;
  for (;;) {
    try {
      return await env.fs.realpath(current);
    } catch {
      const parent = env.path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * The absolute path to write `relative` inside `dir`, under `root`, or `{ error }`. `dir` and `relative` are posix or Windows spellings of a
 * relative path (`dir` may be `''` for the root). Checks the spelling first, then asks the file system where the nearest existing parent
 * really is, so a symbolic link that leaves the project is refused, and refuses a target that is itself a symbolic link.
 * It reads nothing but link targets and writes nothing.
 */
export async function safePath(env: CliEnv, root: string, dir: string, relative: string): Promise<string | Failure> {
  const dirSegments = segmentsOf(dir, true);
  if ('error' in dirSegments) return dirSegments;
  const nameSegments = segmentsOf(relative, false);
  if ('error' in nameSegments) return nameSegments;
  if (nameSegments.length === 0) return { error: 'A file needs a name.' };

  const posix = [...dirSegments, ...nameSegments].join('/');
  if (posix.length > MAX_PATH_LENGTH) return { error: `A path is longer than ${MAX_PATH_LENGTH} characters.` };

  const target = env.path.join(root, ...dirSegments, ...nameSegments);
  if (!isInside(env, root, target)) return { error: 'A path must stay inside the project.' };

  const realRoot = await nearestReal(env, root);
  const realParent = await nearestReal(env, env.path.dirname(target));
  if (realRoot === undefined || realParent === undefined) return { error: 'The project folder could not be resolved.' };
  if (!isInside(env, realRoot, realParent)) return { error: 'A folder on the path is a symbolic link that leaves the project.' };

  try {
    const stat = await env.fs.lstat(target);
    if (stat.isSymbolicLink()) return { error: `${show(posix)} is a symbolic link, which init will not read or replace.` };
  } catch {
    // Not there yet: the normal case for a new file.
  }
  return target;
}

/** A path under `root` as printed: relative, with `/` on every platform. */
export function displayPath(env: CliEnv, root: string, absolute: string): string {
  return env.path.relative(root, absolute).split(env.path.sep).join('/');
}
